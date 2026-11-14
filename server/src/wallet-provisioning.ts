import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import type { ManagedWalletChain } from "./managed-wallet-chain.js";
import { requireManagedWallets, signManagedTransaction, type ManagedWallet } from "./managed-wallets.js";
import { confirmPlayerFact } from "./player-confirmation.js";
import { startWorker } from "./worker.js";

const safeCode = (e: unknown) =>
  e instanceof AppError &&
  [
    "FAUCET_RATE_LIMITED",
    "FAUCET_UNAVAILABLE",
    "CHAIN_TIMEOUT",
    "CHAIN_UNAVAILABLE",
    "CONTRACT_UPGRADE_REQUIRED",
    "ACCESS_KEY_MISMATCH",
    "TX_FAILED",
    "TX_MISMATCH",
    "WALLET_BUSY",
  ].includes(e.code)
    ? e.code
    : "WALLET_SETUP_PENDING";
export async function processManagedWallet(
  sql: Sql,
  cfg: AppConfig,
  chain: ManagedWalletChain,
  profileId: string,
) {
  requireManagedWallets(cfg);
  const token = randomUUID();
  const [w] = await sql<
    ManagedWallet[]
  >`update managed_wallets set lease_token=${token},lease_until=now()+interval '90 seconds',attempt_count=attempt_count+1 where profile_id=${profileId} and stage<>'ready' and (lease_until is null or lease_until<now()) and next_attempt_at<=now() returning *`;
  if (!w) return;
  const update = async (stage: string, action?: string) =>
    sql.begin(async (tx) => {
      const [saved] =
        await tx`update managed_wallets set stage=${stage},last_error_code=null,next_attempt_at=now(),lease_token=null,lease_until=null where profile_id=${profileId} and lease_token=${token} returning profile_id`;
      if (saved && action)
        await tx`insert into managed_wallet_audit(profile_id,action) values(${profileId},${action})`;
    });
  try {
    if (w.stage === "creating_account") {
      let keys = await chain.accountKeys(w.account_id);
      if (!keys) {
        if (w.faucet_requested_at && Date.now() - w.faucet_requested_at.getTime() < 60000)
          throw new AppError("CHAIN_UNAVAILABLE", "Account creation is being checked.", 503);
        const attempt = await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':wallet-sponsor-budget',0))`;
          const [budget] =
            await tx`select count(*)::int as n from managed_wallet_audit where action='faucet_requested' and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'`;
          if (
            budget.n >= cfg.testnetWalletDailyLimit ||
            (w.faucet_attempts >= 3 &&
              w.faucet_requested_at &&
              w.faucet_requested_at.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10))
          )
            throw new AppError("FAUCET_RATE_LIMITED", "The testnet sponsor budget will renew tomorrow.", 503);
          const [held] =
            await tx`update managed_wallets set faucet_requested_at=now(),faucet_attempts=case when faucet_requested_at is not null and (faucet_requested_at at time zone 'UTC')::date<(now() at time zone 'UTC')::date then 1 else faucet_attempts+1 end where profile_id=${profileId} and lease_token=${token} returning profile_id`;
          if (held)
            await tx`insert into managed_wallet_audit(profile_id,action) values(${profileId},'faucet_requested')`;
          return held;
        });
        if (!attempt) return;
        await chain.createAccount(w.account_id, w.public_key);
        keys = await chain.accountKeys(w.account_id);
      }
      if (!keys) throw new AppError("CHAIN_UNAVAILABLE", "Account creation is awaiting confirmation.", 503);
      if (keys.length !== 1 || keys[0].publicKey !== w.public_key || keys[0].permission !== "FullAccess")
        throw new AppError("ACCESS_KEY_MISMATCH", "The new account access policy needs review.", 409);
      await update("registering", "created");
      return;
    }
    if (!(await chain.supportsGame()))
      throw new AppError(
        "CONTRACT_UPGRADE_REQUIRED",
        "The city contract upgrade must be deployed before game registration can finish.",
        503,
      );
    const [profile] = await sql`select username,account_id from resident_profiles where id=${profileId}`;
    const starter = w.stage === "claiming",
      method = starter ? "claim_starter" : "register_player",
      args = starter ? {} : { username: profile.username };
    const tx = await signManagedTransaction(
      sql,
      cfg,
      chain,
      profileId,
      starter ? w.starter_request : w.registration_request,
      method,
      args,
    );
    if (tx.state === "rejected")
      throw new AppError(
        "TX_FAILED",
        "The saved setup transaction was rejected. Review its receipt before retrying.",
        409,
      );
    const proof = await chain.verify(tx.tx_hash, {
      signerId: w.account_id,
      method,
      args,
      events: [
        starter
          ? {
              name: "starter_allowance",
              entityId: `player:${w.account_id}`,
              walletFrom: null,
              walletTo: `player:${w.account_id}`,
              amount: "500",
            }
          : { name: "player_registered", entityId: `player:${w.account_id}` },
      ],
    });
    const player = await chain.view<{ username: string; starter_claimed: boolean } | null>("get_player", {
      account: w.account_id,
    });
    if (!player || player.username !== profile.username || (starter && !player.starter_claimed))
      throw new AppError("TX_MISMATCH", "Game registration is not confirmed.", 409);
    const balance = await chain.balance(`player:${w.account_id}`);
    await sql.begin(async (db) => {
      const [held] =
        await db`select lease_token,lease_until from managed_wallets where profile_id=${profileId} for update`;
      if (held.lease_token !== token || held.lease_until < new Date()) return;
      await confirmPlayerFact(db, cfg, {
        accountId: w.account_id,
        username: profile.username,
        txHash: tx.tx_hash,
        events: proof.events,
        balance,
        starter,
      });
      if (!starter) {
        await db`update managed_wallets set stage='claiming',last_error_code=null,next_attempt_at=now(),lease_token=null,lease_until=null where profile_id=${profileId}`;
        await db`insert into managed_wallet_audit(profile_id,action) values(${profileId},'registered')`;
        return;
      }
      const [old] = await db`select account_id from resident_profiles where id=${profileId} for update`;
      await db`update player_presence set player_account=${w.account_id} where player_account=${old.account_id}`;
      await db`update auth_sessions set revoked_at=now() where account_id=${old.account_id}`;
      await db`update resident_profiles set account_id=${w.account_id},wallet_kind='embedded',wallet_linked=true where id=${profileId}`;
      await db`update managed_wallets set stage='ready',ready_at=now(),last_error_code=null,lease_token=null,lease_until=null where profile_id=${profileId}`;
      await db`insert into managed_wallet_audit(profile_id,action) values(${profileId},'starter_confirmed')`;
    });
  } catch (error) {
    const code = safeCode(error),
      delay =
        code === "FAUCET_RATE_LIMITED"
          ? 3600
          : code === "CONTRACT_UPGRADE_REQUIRED"
            ? 60
            : Math.min(3600, 15 * 2 ** Math.min(w.attempt_count, 7));
    await sql`update managed_wallets set last_error_code=${code},next_attempt_at=now()+${delay}*interval '1 second',lease_token=null,lease_until=null where profile_id=${profileId} and lease_token=${token}`;
  }
}
export async function reconcileManagedTransactions(sql: Sql, chain: ManagedWalletChain) {
  const due = await sql.begin(async (tx) => {
    const rows =
      await tx`select t.*,w.account_id from managed_wallet_transactions t join managed_wallets w on w.profile_id=t.profile_id where t.state='pending' and (t.checked_at is null or t.checked_at<now()-interval '30 seconds') order by t.created_at limit 10 for update of t skip locked`;
    for (const row of rows)
      await tx`update managed_wallet_transactions set checked_at=now() where id=${row.id}`;
    return rows;
  });
  for (const tx of due) {
    try {
      await chain.broadcast(tx.signed_transaction);
    } catch {
      /* Rebroadcast only the durable signed bytes. */
    }
    try {
      await chain.verify(tx.tx_hash, { signerId: tx.account_id, method: tx.method, args: tx.args });
      await sql`update managed_wallet_transactions set state='confirmed' where id=${tx.id}`;
    } catch (error) {
      if (error instanceof AppError && error.code === "TX_FAILED")
        await sql`update managed_wallet_transactions set state='rejected' where id=${tx.id}`;
    }
  }
}
export async function tickWalletProvisioning(sql: Sql, cfg: AppConfig, chain: ManagedWalletChain) {
  if (!cfg.autoTestnetWallets) return;
  requireManagedWallets(cfg);
  await reconcileManagedTransactions(sql, chain);
  const due =
    await sql`select profile_id from managed_wallets where stage<>'ready' and next_attempt_at<=now() and (lease_until is null or lease_until<now()) order by next_attempt_at limit 4`;
  for (const row of due) await processManagedWallet(sql, cfg, chain, row.profile_id);
}
export function startWalletProvisioning(
  sql: Sql,
  cfg: AppConfig,
  chain: ManagedWalletChain,
  onError: (error: unknown) => void,
) {
  return startWorker({ intervalMs: 3000, run: () => tickWalletProvisioning(sql, cfg, chain), onError });
}
