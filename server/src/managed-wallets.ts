import { randomUUID } from "node:crypto";
import { KeyPair } from "near-api-js";
import type { Sql, TransactionSql } from "postgres";
import type { AppConfig } from "./config.js";
import { assertManagedWalletConfigurationIsSafe } from "./config.js";
import { AppError } from "./errors.js";
import {
  openWalletKey,
  sealWalletKey,
  walletContext,
  walletRequestHash,
  canonicalWalletArgs,
} from "./wallet-vault.js";
import { validateManagedWalletCall } from "./managed-wallet-methods.js";
import type { ManagedWalletChain } from "./managed-wallet-chain.js";
import type { ProfileRow } from "./profiles.js";
export type ManagedWallet = Record<string, any> & {
  profile_id: string;
  account_id: string;
  public_key: string;
  encrypted_key: string;
  stage: string;
  last_nonce: string;
};
export type ManagedTransaction = Record<string, any> & {
  id: string;
  profile_id: string;
  request_hash: string;
  tx_hash: string;
  signed_transaction: string;
  state: "pending" | "confirmed" | "rejected";
  method: string;
  args: Record<string, unknown>;
};
export function requireManagedWallets(cfg: AppConfig) {
  assertManagedWalletConfigurationIsSafe(cfg);
  if (!cfg.autoTestnetWallets)
    throw new AppError("NOT_FOUND", "Automatic testnet wallets are not enabled.", 404);
}
export function allocateManagedWallet(cfg: AppConfig) {
  requireManagedWallets(cfg);
  return async (tx: TransactionSql, profile: ProfileRow) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':managed-wallet-quota',0))`;
    const [quota] =
      await tx`select count(*)::int as n from managed_wallets where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'`;
    if (quota.n >= cfg.testnetWalletDailyLimit)
      throw new AppError(
        "SIGNUP_LIMIT",
        "Today’s testnet account allocation is full. Try again tomorrow.",
        429,
      );
    const accountId = `qc-${profile.id.replaceAll("-", "")}.${cfg.testnetWalletAccountSuffix}`,
      key = KeyPair.fromRandom("ed25519");
    const encrypted = sealWalletKey(
      cfg.testnetWalletEncryptionKey!,
      key.toString(),
      walletContext(profile.id, accountId),
    );
    await tx`insert into managed_wallets(profile_id,account_id,network_id,public_key,encrypted_key,registration_request,starter_request) values (${profile.id},${accountId},'testnet',${key.getPublicKey().toString()},${encrypted},${randomUUID()},${randomUUID()})`;
    await tx`update resident_profiles set wallet_kind='embedded' where id=${profile.id}`;
    await tx`insert into managed_wallet_audit(profile_id,action) values (${profile.id},'allocated')`;
  };
}
export async function getManagedWallet(sql: Sql | TransactionSql, profileId: string) {
  const [row] = await sql<ManagedWallet[]>`select * from managed_wallets where profile_id=${profileId}`;
  return row ?? null;
}
export function managedWalletStatus(row: ManagedWallet | null, enabled: boolean) {
  return {
    enabled,
    accountId: row?.account_id ?? null,
    stage: row?.stage ?? "not_requested",
    errorCode: row?.last_error_code ?? null,
    retryAt: row?.next_attempt_at?.toISOString() ?? null,
  };
}
export async function assertOwnedManagedProfile(sql: Sql, profileId: string, deviceToken: string | null) {
  const { hashToken } = await import("./auth/service.js");
  if (!deviceToken) throw new AppError("NOT_FOUND", "This resident is not saved in this browser.", 404);
  const [profile] = await sql<
    ProfileRow[]
  >`select p.* from resident_profiles p join browser_profile_access a on a.profile_id=p.id join browser_devices d on d.token_hash=a.device_hash where p.id=${profileId} and d.token_hash=${hashToken(deviceToken)} and d.expires_at>now()`;
  if (!profile) throw new AppError("NOT_FOUND", "This resident is not saved in this browser.", 404);
  return profile;
}
export async function signManagedTransaction(
  sql: Sql,
  cfg: AppConfig,
  chain: ManagedWalletChain,
  profileId: string,
  requestId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<ManagedTransaction> {
  requireManagedWallets(cfg);
  validateManagedWalletCall(method, args);
  const digest = walletRequestHash(method, args),
    token = randomUUID();
  const reserved = await sql.begin(async (tx) => {
    const [w] = await tx<
      ManagedWallet[]
    >`select * from managed_wallets where profile_id=${profileId} for update`;
    if (!w) throw new AppError("NOT_FOUND", "Managed wallet not found.", 404);
    const [prior] = await tx<
      ManagedTransaction[]
    >`select * from managed_wallet_transactions where id=${requestId}`;
    if (prior) {
      if (prior.profile_id !== profileId || prior.request_hash !== digest)
        throw new AppError("CONFLICT", "This request identifier belongs to another wallet action.", 409);
      return { prior, w };
    }
    const [pending] =
      await tx`select id from managed_wallet_transactions where profile_id=${profileId} and state='pending'`;
    if (pending || (w.signing_until && w.signing_until > new Date()))
      throw new AppError(
        "WALLET_BUSY",
        "A saved wallet action is still being checked. Recheck it before starting another.",
        409,
      );
    await tx`update managed_wallets set signing_token=${token},signing_until=now()+interval '45 seconds' where profile_id=${profileId}`;
    return { prior: null, w };
  });
  let transaction = reserved.prior;
  if (!transaction) {
    try {
      const secret = openWalletKey(
        cfg.testnetWalletEncryptionKey!,
        reserved.w.encrypted_key,
        walletContext(profileId, reserved.w.account_id),
      );
      const signed = await chain.sign(reserved.w.account_id, secret, method, args, reserved.w.last_nonce);
      transaction = await sql.begin(async (tx) => {
        const [w] =
          await tx`select signing_token,signing_until from managed_wallets where profile_id=${profileId} for update`;
        if (w.signing_token !== token || w.signing_until < new Date())
          throw new AppError(
            "WALLET_BUSY",
            "Wallet signing was interrupted. Recheck before continuing.",
            409,
          );
        const [saved] = await tx<
          ManagedTransaction[]
        >`insert into managed_wallet_transactions(id,profile_id,request_hash,method,args,signed_transaction,tx_hash,nonce) values (${requestId},${profileId},${digest},${method},${tx.json(args as Parameters<typeof tx.json>[0])},${signed.bytes},${signed.hash},${signed.nonce}) returning *`;
        await tx`update managed_wallets set last_nonce=${signed.nonce},signing_token=null,signing_until=null where profile_id=${profileId}`;
        return saved;
      });
    } finally {
      await sql`update managed_wallets set signing_token=null,signing_until=null where profile_id=${profileId} and signing_token=${token}`;
    }
  }
  if (transaction.state === "pending") {
    // The signed bytes/hash already exist durably. Any rebroadcast is exactly the same transaction.
    try {
      await chain.broadcast(transaction.signed_transaction);
    } catch {
      /* Unknown execution is reconciled by hash, never by signing another payment. */
    }
    await sql`update managed_wallet_transactions set broadcast_at=coalesce(broadcast_at,now()) where id=${transaction.id}`;
    try {
      await chain.verify(transaction.tx_hash, { signerId: reserved.w.account_id, method, args });
      await sql`update managed_wallet_transactions set state='confirmed',checked_at=now() where id=${transaction.id}`;
      transaction.state = "confirmed";
    } catch (error) {
      if (error instanceof AppError && error.code === "TX_FAILED") {
        await sql`update managed_wallet_transactions set state='rejected',checked_at=now() where id=${transaction.id}`;
        transaction.state = "rejected";
      }
    }
  }
  return transaction;
}
/** Commands tied to server quotes cannot be altered by the browser signer endpoint. */
export async function assertManagedIntent(
  sql: Sql,
  accountId: string,
  method: string,
  args: Record<string, unknown>,
) {
  if (
    [
      "fund_escrow",
      "pay_charge",
      "cancel_charge",
      "pay_rent",
      "pay_admission",
      "refund_order",
      "refund_admission",
      "sponsor_quiz",
      "pay_business_tax",
      "cancel_order",
    ].includes(method)
  ) {
    const rows =
      await sql`select args from city_operations where actor_account=${accountId} and method=${method} and status in ('awaiting','unknown') order by created_at desc limit 20`;
    if (!rows.some((r) => canonicalWalletArgs(r.args) === canonicalWalletArgs(args)))
      throw new AppError("CONFLICT", "Save this action in the phone before approving its payment.", 409);
  }
  if (method === "pay_order") {
    const [o] =
      await sql`select id from business_orders where buyer_account=${accountId} and reference=${String(args.reference)} and business_id=${String(args.business_id)} and total=${String(args.amount)} and status in ('reserved','confirming','paid')`;
    if (!o) throw new AppError("CONFLICT", "Reserve the priced order in your phone before paying.", 409);
  }
}

export async function ensureManagedWalletForProfile(sql: Sql, cfg: AppConfig, profileId: string) {
  if (!cfg.autoTestnetWallets) return;
  await sql.begin(async (tx) => {
    const [p] = await tx<ProfileRow[]>`select * from resident_profiles where id=${profileId} for update`;
    if (p && p.account_id.startsWith("guest-") && p.wallet_kind === "browser")
      await allocateManagedWallet(cfg)(tx, p);
  });
}
