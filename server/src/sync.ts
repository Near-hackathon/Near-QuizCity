import type { Sql, TransactionSql } from "postgres";
import { compareQc, differenceQc, subtractQc, sumQc } from "./amount.js";
import { sql } from "./db.js";
import {
  viewAllBusinesses,
  viewAllProperties,
  viewAllWallets,
  viewContract,
  type ContractBusiness,
  type ContractProperty,
  type ContractStats,
  type ContractWallet,
} from "./near.js";
import { rebuildLockKey, syncLockKey } from "./locks.js";
import { config } from "./runtime-config.js";

export function classify(walletId: string): { ownerType: string; ownerId: string } {
  const [prefix, ...rest] = walletId.split(":");
  const ownerId = rest.join(":");
  if (prefix === "player") return { ownerType: "player", ownerId };
  if (prefix === "npc") return { ownerType: "npc", ownerId };
  if (prefix === "gov") return { ownerType: "gov", ownerId };
  if (prefix === "biz") return { ownerType: "business", ownerId };
  return { ownerType: "player", ownerId: walletId };
}

export type SyncDeps = {
  db: Sql;
  viewContract: <T>(method: string, args?: Record<string, unknown>) => Promise<T>;
  viewAllProperties: (stats?: ContractStats) => Promise<ContractProperty[]>;
  viewAllBusinesses: (stats?: ContractStats) => Promise<ContractBusiness[]>;
  viewAllWallets: () => Promise<ContractWallet[]>;
  networkId: string;
  contractId: string;
};

export type SyncResult = {
  skipped: boolean;
  wallets: number;
  properties: number;
  businesses: number;
  canonicalSupply: string;
  mirroredWalletSum: string;
  difference: string;
};

function defaultSyncDeps(): SyncDeps {
  return {
    db: sql,
    viewContract,
    viewAllProperties,
    viewAllBusinesses,
    viewAllWallets,
    networkId: config.networkId,
    contractId: config.contractId,
  };
}
export type WalletSql = Sql | TransactionSql;

export async function getMirroredBalance(walletId: string): Promise<string> {
  const [row] = await sql<{ balance: string }[]>`select balance from wallets where wallet_id = ${walletId}`;
  return row?.balance ?? "0";
}

export async function readChainBalance(walletId: string, atLeast?: string): Promise<string> {
  let balance = await viewContract<string>("get_balance", { wallet: walletId });
  for (
    let attempt = 0;
    atLeast !== undefined && compareQc(balance, atLeast) < 0 && attempt < 6;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    balance = await viewContract<string>("get_balance", { wallet: walletId });
  }
  return balance;
}

export async function setMirroredBalance(
  client: WalletSql,
  walletId: string,
  balance: string,
): Promise<void> {
  const { ownerType, ownerId } = classify(walletId);
  await client`
    insert into wallets (wallet_id, owner_type, owner_id, balance, updated_at)
    values (${walletId}, ${ownerType}, ${ownerId}, ${balance}, now())
    on conflict (wallet_id) do update set
      balance = excluded.balance,
      owner_type = excluded.owner_type,
      owner_id = excluded.owner_id,
      updated_at = now()
  `;
}

export async function refreshWallet(walletId: string, atLeast?: string): Promise<string> {
  const balance = await readChainBalance(walletId, atLeast);
  await setMirroredBalance(sql, walletId, balance);
  return balance;
}

export async function syncEconomy(overrides: Partial<SyncDeps> = {}): Promise<SyncResult> {
  const deps: SyncDeps = { ...defaultSyncDeps(), ...overrides };
  const scope = { networkId: deps.networkId, contractId: deps.contractId };
  const rebuildKey = rebuildLockKey(scope);
  const lockKey = syncLockKey(scope);
  const reserved = await deps.db.reserve();
  let rebuildGuardHeld = false;
  let syncLockHeld = false;

  const emptyResult: SyncResult = {
    skipped: true,
    wallets: 0,
    properties: 0,
    businesses: 0,
    canonicalSupply: "0",
    mirroredWalletSum: "0",
    difference: "0",
  };

  try {
    const [rebuildGuard] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(
        hashtext(current_schema() || ':' || ${rebuildKey})
      ) as locked
    `;
    if (!rebuildGuard?.locked) {
      await reserved`
        insert into sync_runs (network_id, contract_id, status, finished_at, error_message)
        values (
          ${deps.networkId}, ${deps.contractId}, 'skipped', now(),
          'mirror rebuild is in progress'
        )
      `;
      return emptyResult;
    }
    rebuildGuardHeld = true;

    const [lock] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(
        hashtext(current_schema() || ':' || ${lockKey})
      ) as locked
    `;
    if (!lock?.locked) {
      await reserved`
        insert into sync_runs (network_id, contract_id, status, finished_at)
        values (${deps.networkId}, ${deps.contractId}, 'skipped', now())
      `;
      return emptyResult;
    }
    syncLockHeld = true;

    try {
      // Fetch and validate the complete authoritative snapshot outside any
      // database transaction, then merge it in one short transaction.
      const stats = await deps.viewContract<ContractStats>("get_stats");
      const [properties, businesses, wallets] = await Promise.all([
        deps.viewAllProperties(stats),
        deps.viewAllBusinesses(stats),
        deps.viewAllWallets(),
      ]);
      if (properties.length !== Number(stats.properties) || businesses.length !== Number(stats.businesses)) {
        throw new Error("chain snapshot counts do not match contract stats");
      }
      const propertyIds = new Set<string>();
      const businessIds = new Set<string>();
      const walletIds = new Set<string>();
      for (const property of properties) {
        const id = String(property.id);
        if (propertyIds.has(id)) throw new Error(`duplicate property id ${id}`);
        propertyIds.add(id);
      }
      for (const business of businesses) {
        const id = String(business.id);
        if (businessIds.has(id)) throw new Error(`duplicate business id ${id}`);
        businessIds.add(id);
      }
      for (const wallet of wallets) {
        if (walletIds.has(wallet.wallet_id)) {
          throw new Error(`duplicate wallet id ${wallet.wallet_id}`);
        }
        walletIds.add(wallet.wallet_id);
      }

      await reserved.unsafe("begin");
      try {
        const result = await (async () => {
          const transaction = reserved;
          for (const property of properties) {
            await transaction`
            insert into properties (
              id, district, x, y, owner_wallet, property_type, price, for_sale,
              transfer_count, updated_at, active, archived_at
            ) values (
              ${property.id}, ${property.district}, ${property.x}, ${property.y},
              ${property.owner}, ${property.kind}, ${property.price}, ${property.for_sale},
              ${property.transfer_count}, now(), true, null
            )
            on conflict (id) do update set
              district = excluded.district,
              x = excluded.x,
              y = excluded.y,
              owner_wallet = excluded.owner_wallet,
              property_type = excluded.property_type,
              price = excluded.price,
              for_sale = excluded.for_sale,
              transfer_count = excluded.transfer_count,
              updated_at = now(),
              active = true,
              archived_at = null
          `;
          }

          for (const business of businesses) {
            await transaction`
            insert into businesses (
              id, name, owner_account, property_id, treasury_wallet, revenue_total, active, archived_at
            ) values (
              ${business.id}, ${business.name}, ${business.owner}, ${business.property_id},
              ${business.treasury}, ${business.revenue_total}, true, null
            )
            on conflict (id) do update set
              name = excluded.name,
              owner_account = excluded.owner_account,
              property_id = excluded.property_id,
              treasury_wallet = excluded.treasury_wallet,
              revenue_total = excluded.revenue_total,
              active = true,
              archived_at = null
          `;
          }

          for (const wallet of wallets) {
            const { ownerType, ownerId } = classify(wallet.wallet_id);
            await transaction`
            insert into wallets (
              wallet_id, owner_type, owner_id, balance, updated_at, active, archived_at
            ) values (${wallet.wallet_id}, ${ownerType}, ${ownerId}, ${wallet.balance}, now(), true, null)
            on conflict (wallet_id) do update set
              balance = excluded.balance,
              owner_type = excluded.owner_type,
              owner_id = excluded.owner_id,
              updated_at = now(),
              active = true,
              archived_at = null
          `;
          }

          await transaction`
          update properties set active = false, archived_at = now()
          where active = true and id::text <> all(${transaction.array([...propertyIds])})
        `;
          await transaction`
          update businesses set active = false, archived_at = now()
          where active = true and id::text <> all(${transaction.array([...businessIds])})
        `;
          await transaction`
          update wallets set active = false, archived_at = now()
          where active = true and wallet_id <> all(${transaction.array([...walletIds])})
        `;

          const canonicalSupply = subtractQc(stats.total_issued, stats.total_burned);
          const mirroredWalletSum = sumQc(wallets.map((wallet) => wallet.balance));
          const fingerprint = [
            stats.tx_count,
            stats.total_issued,
            stats.total_burned,
            stats.players,
            properties.length,
            businesses.length,
            wallets.length,
            mirroredWalletSum,
          ].join(":");

          await transaction`
          insert into economy_snapshots (
            total_issued, total_burned, tx_count, players, properties, businesses, payload, fingerprint
          ) values (
            ${stats.total_issued}, ${stats.total_burned}, ${stats.tx_count}, ${stats.players},
            ${stats.properties}, ${stats.businesses}, ${transaction.json(stats)}, ${fingerprint}
          )
          on conflict (fingerprint) do nothing
        `;

          await transaction`
          insert into sync_runs (
            network_id, contract_id, status, finished_at,
            expected_properties, expected_businesses, expected_wallets,
            actual_properties, actual_businesses, actual_wallets,
            canonical_supply, mirrored_wallet_sum
          ) values (
            ${deps.networkId}, ${deps.contractId}, 'success', now(),
            ${stats.properties}, ${stats.businesses}, ${wallets.length},
            ${properties.length}, ${businesses.length}, ${wallets.length},
            ${canonicalSupply}, ${mirroredWalletSum}
          )
        `;

          return {
            skipped: false,
            wallets: wallets.length,
            properties: properties.length,
            businesses: businesses.length,
            canonicalSupply,
            mirroredWalletSum,
            difference: differenceQc(canonicalSupply, mirroredWalletSum),
          };
        })();
        await reserved.unsafe("commit");
        return result;
      } catch (error) {
        await reserved.unsafe("rollback");
        throw error;
      }
    } finally {
      if (syncLockHeld) {
        await reserved`
          select pg_advisory_unlock(
            hashtext(current_schema() || ':' || ${lockKey})
          )
        `;
        syncLockHeld = false;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "sync failed";
    await reserved`
      insert into sync_runs (network_id, contract_id, status, finished_at, error_message)
      values (${deps.networkId}, ${deps.contractId}, 'failed', now(), ${message})
    `;
    throw error;
  } finally {
    if (syncLockHeld) {
      await reserved`
        select pg_advisory_unlock(
          hashtext(current_schema() || ':' || ${lockKey})
        )
      `.catch(() => {});
    }
    if (rebuildGuardHeld) {
      await reserved`
        select pg_advisory_unlock(
          hashtext(current_schema() || ':' || ${rebuildKey})
        )
      `.catch(() => {});
    }
    reserved.release();
  }
}
