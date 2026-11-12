import { sql } from "./db.js";
import { viewContract, type ContractBusiness, type ContractProperty, type ContractStats } from "./near.js";

export function classify(walletId: string): { ownerType: string; ownerId: string } {
  const [prefix, ...rest] = walletId.split(":");
  const ownerId = rest.join(":");
  if (prefix === "player") return { ownerType: "player", ownerId };
  if (prefix === "npc") return { ownerType: "npc", ownerId };
  if (prefix === "gov") return { ownerType: "gov", ownerId };
  if (prefix === "biz") return { ownerType: "business", ownerId };
  return { ownerType: "player", ownerId: walletId };
}

let lastFingerprint = "";

export async function getMirroredBalance(walletId: string): Promise<number> {
  const [row] = await sql<{ balance: string }[]>`select balance from wallets where wallet_id = ${walletId}`;
  return Number(row?.balance ?? 0);
}

export async function refreshWallet(walletId: string, atLeast?: number): Promise<string> {
  let balance = await viewContract<string>("get_balance", { wallet: walletId });
  for (let attempt = 0; atLeast !== undefined && Number(balance) < atLeast && attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    balance = await viewContract<string>("get_balance", { wallet: walletId });
  }
  const { ownerType, ownerId } = classify(walletId);
  await sql`
    insert into wallets (wallet_id, owner_type, owner_id, balance, updated_at)
    values (${walletId}, ${ownerType}, ${ownerId}, ${balance}, now())
    on conflict (wallet_id) do update set
      balance = excluded.balance,
      owner_type = excluded.owner_type,
      owner_id = excluded.owner_id,
      updated_at = now()
  `;
  return balance;
}

export async function syncEconomy(): Promise<{ wallets: number; properties: number; businesses: number }> {
  const [stats, properties, businesses] = await Promise.all([
    viewContract<ContractStats>("get_stats"),
    viewContract<ContractProperty[]>("get_properties"),
    viewContract<ContractBusiness[]>("get_businesses"),
  ]);

  const walletRows = await sql<{ wallet_id: string }[]>`
    select wallet_id from npc_state
    union select 'player:' || account_id from players
    union select 'gov:council'
    union select owner_wallet from properties
    union select treasury_wallet from businesses
  `;

  // Businesses and properties are written first so their wallet ids are discoverable next tick.
  for (const business of businesses) {
    await sql`
      insert into businesses (id, name, owner_account, property_id, treasury_wallet, revenue_total)
      values (${business.id}, ${business.name}, ${business.owner}, ${business.property_id},
              ${business.treasury}, ${business.revenue_total})
      on conflict (id) do update set
        name = excluded.name,
        owner_account = excluded.owner_account,
        property_id = excluded.property_id,
        treasury_wallet = excluded.treasury_wallet,
        revenue_total = excluded.revenue_total
    `;
  }

  for (const property of properties) {
    await sql`
      insert into properties (id, district, x, y, owner_wallet, property_type, price, for_sale, transfer_count, updated_at)
      values (${property.id}, ${property.district}, ${property.x}, ${property.y}, ${property.owner},
              ${property.kind}, ${property.price}, ${property.for_sale}, ${property.transfer_count}, now())
      on conflict (id) do update set
        district = excluded.district,
        x = excluded.x,
        y = excluded.y,
        owner_wallet = excluded.owner_wallet,
        property_type = excluded.property_type,
        price = excluded.price,
        for_sale = excluded.for_sale,
        transfer_count = excluded.transfer_count,
        updated_at = now()
    `;
  }

  const ids = new Set(walletRows.map((row) => row.wallet_id));
  ids.add("gov:council");
  for (const property of properties) ids.add(property.owner);
  for (const business of businesses) ids.add(business.treasury);

  const balances = await Promise.all(
    [...ids].map(async (walletId) => ({
      walletId,
      balance: await viewContract<string>("get_balance", { wallet: walletId }),
    })),
  );

  for (const { walletId, balance } of balances) {
    const { ownerType, ownerId } = classify(walletId);
    await sql`
      insert into wallets (wallet_id, owner_type, owner_id, balance, updated_at)
      values (${walletId}, ${ownerType}, ${ownerId}, ${balance}, now())
      on conflict (wallet_id) do update set
        balance = excluded.balance,
        owner_type = excluded.owner_type,
        owner_id = excluded.owner_id,
        updated_at = now()
    `;
  }

  const fingerprint = `${stats.tx_count}:${stats.total_issued}:${stats.total_burned}:${stats.players}`;
  if (fingerprint !== lastFingerprint) {
    lastFingerprint = fingerprint;
    await sql`
      insert into economy_snapshots (total_issued, total_burned, tx_count, players, properties, businesses, payload)
      values (${stats.total_issued}, ${stats.total_burned}, ${stats.tx_count},
              ${stats.players}, ${stats.properties}, ${stats.businesses}, ${sql.json(stats)})
    `;
  }

  return {
    wallets: balances.length,
    properties: properties.length,
    businesses: businesses.length,
  };
}
