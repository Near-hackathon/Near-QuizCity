import type { Sql } from "postgres";

export type OwnershipRepair = {
  assetType: "property" | "business";
  assetId: string;
  expectedOwner: string;
  actualOwner: string;
  reference: string | null;
  blockHeight: string | null;
};

type LatestHistory = {
  asset_type: "property" | "business";
  asset_id: string;
  new_owner: string;
  reference: string | null;
  block_height: string | null;
};

/**
 * Read-only comparison of current owners against the latest immutable transfer
 * history. Repair only touches rows that exist locally; it never creates rows.
 */
export async function planOwnershipRepairs(db: Sql): Promise<OwnershipRepair[]> {
  const latest = await db<LatestHistory[]>`
    select distinct on (asset_type, asset_id)
      asset_type, asset_id, new_owner, reference, block_height
    from asset_ownership_history
    order by asset_type, asset_id, block_height desc nulls last, event_index desc
  `;
  const repairs: OwnershipRepair[] = [];
  for (const history of latest) {
    if (history.asset_type === "property") {
      const [current] = await db<{ owner_wallet: string }[]>`
        select owner_wallet from properties where id = ${history.asset_id}::bigint
      `;
      const actual = current?.owner_wallet ?? "missing";
      if (actual !== history.new_owner) {
        repairs.push({
          assetType: "property",
          assetId: history.asset_id,
          expectedOwner: history.new_owner,
          actualOwner: actual,
          reference: history.reference,
          blockHeight: history.block_height,
        });
      }
    } else {
      const [current] = await db<{ owner_account: string }[]>`
        select owner_account from businesses where id = ${history.asset_id}::bigint
      `;
      const actual = current?.owner_account ?? "missing";
      if (actual !== history.new_owner) {
        repairs.push({
          assetType: "business",
          assetId: history.asset_id,
          expectedOwner: history.new_owner,
          actualOwner: actual,
          reference: history.reference,
          blockHeight: history.block_height,
        });
      }
    }
  }
  return repairs;
}

export async function applyOwnershipRepairs(db: Sql, repairs: OwnershipRepair[]): Promise<number> {
  let changed = 0;
  await db.begin(async (transaction) => {
    for (const repair of repairs) {
      if (repair.actualOwner === "missing") continue;
      const rows =
        repair.assetType === "property"
          ? await transaction`
              update properties set owner_wallet = ${repair.expectedOwner}, updated_at = now()
              where id = ${repair.assetId}::bigint and owner_wallet = ${repair.actualOwner}
              returning id
            `
          : await transaction`
              update businesses set owner_account = ${repair.expectedOwner}
              where id = ${repair.assetId}::bigint and owner_account = ${repair.actualOwner}
              returning id
            `;
      changed += rows.length;
    }
  });
  return changed;
}
