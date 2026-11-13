import type { Sql } from "postgres";
import { compareQc, subtractQc, sumQc } from "./amount.js";
import type { ContractBusiness, ContractProperty, ContractStats } from "./near.js";

export type ReconcileMismatch = {
  kind: string;
  id: string;
  expected: string;
  actual: string;
};

export type ReconcileReport = {
  ok: boolean;
  mismatches: ReconcileMismatch[];
  canonicalSupply: string;
  mirroredWalletSum: string;
};

export type ReconcileDeps = {
  viewContract: <T>(method: string, args?: Record<string, unknown>) => Promise<T>;
  viewAllProperties: (stats?: ContractStats) => Promise<ContractProperty[]>;
  viewAllBusinesses: (stats?: ContractStats) => Promise<ContractBusiness[]>;
};

async function defaultDeps(): Promise<ReconcileDeps> {
  const near = await import("./near.js");
  return {
    viewContract: near.viewContract,
    viewAllProperties: near.viewAllProperties,
    viewAllBusinesses: near.viewAllBusinesses,
  };
}

export async function reconcileMirror(db: Sql, deps?: ReconcileDeps): Promise<ReconcileReport> {
  const { viewContract, viewAllProperties, viewAllBusinesses } = deps ?? (await defaultDeps());
  const stats = await viewContract<ContractStats>("get_stats");
  const mismatches: ReconcileMismatch[] = [];

  const [counts] = await db<{ players: number; properties: number; businesses: number }[]>`
    select
      (select count(*)::int from players) as players,
      (select count(*)::int from properties) as properties,
      (select count(*)::int from businesses) as businesses
  `;
  for (const [kind, expected, actual] of [
    ["players", stats.players, counts.players],
    ["properties", stats.properties, counts.properties],
    ["businesses", stats.businesses, counts.businesses],
  ] as const) {
    if (expected !== actual) {
      mismatches.push({ kind, id: "*", expected: String(expected), actual: String(actual) });
    }
  }

  const wallets = await db<{ wallet_id: string; balance: string }[]>`
    select wallet_id, balance::text as balance from wallets order by wallet_id
  `;
  for (const wallet of wallets) {
    const chain = await viewContract<string>("get_balance", { wallet: wallet.wallet_id });
    if (compareQc(chain, wallet.balance) !== 0) {
      mismatches.push({
        kind: "wallet",
        id: wallet.wallet_id,
        expected: chain,
        actual: wallet.balance,
      });
    }
  }

  const chainProperties = await viewAllProperties(stats);
  const mirrorProperties = await db<{ id: string; owner_wallet: string }[]>`
    select id::text as id, owner_wallet from properties order by id
  `;
  const mirrorPropertyMap = new Map(mirrorProperties.map((row) => [row.id, row.owner_wallet]));
  for (const property of chainProperties) {
    const actual = mirrorPropertyMap.get(String(property.id));
    if (actual !== property.owner) {
      mismatches.push({
        kind: "property_owner",
        id: String(property.id),
        expected: property.owner,
        actual: actual ?? "missing",
      });
    }
  }

  const chainBusinesses = await viewAllBusinesses(stats);
  const mirrorBusinesses = await db<{ id: string; owner_account: string }[]>`
    select id::text as id, owner_account from businesses order by id
  `;
  const mirrorBusinessMap = new Map(mirrorBusinesses.map((row) => [row.id, row.owner_account]));
  for (const business of chainBusinesses) {
    const actual = mirrorBusinessMap.get(String(business.id));
    if (actual !== business.owner) {
      mismatches.push({
        kind: "business_owner",
        id: String(business.id),
        expected: business.owner,
        actual: actual ?? "missing",
      });
    }
  }

  const canonicalSupply = subtractQc(stats.total_issued, stats.total_burned);
  const mirroredWalletSum = sumQc(wallets.map((wallet) => wallet.balance));
  if (compareQc(canonicalSupply, mirroredWalletSum) !== 0) {
    mismatches.push({
      kind: "supply",
      id: "*",
      expected: canonicalSupply,
      actual: mirroredWalletSum,
    });
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    canonicalSupply,
    mirroredWalletSum,
  };
}
