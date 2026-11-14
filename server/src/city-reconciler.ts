import { refreshPropertyServices } from "./property-services.js";
import { refreshShopHours } from "./commerce.js";
import type { Sql } from "postgres";
import { confirmCityOperation } from "./city-economy-routes.js";
import { startWorker } from "./worker.js";
export function startCityReconciler(sql: Sql, onError: (error: unknown) => void) {
  return startWorker({
    intervalMs: 30000,
    onError,
    run: () => tickCityReconciliation(sql),
  });
}

/** A due batch only verifies existing proofs; it never submits a payment. */
export async function tickCityReconciliation(
  sql: Sql,
  confirm = (actor: string, id: string, hash: string) => confirmCityOperation(sql, actor, id, hash),
) {
  await refreshPropertyServices(sql);
  await refreshShopHours(sql);
  await sql`update property_leases set status='expired' where status='active' and grace_ends_at<=now()`;
  await sql`update quizzes q set status='closed' from quiz_drafts d where q.creator_draft_id=d.id and d.closes_at<=now() and q.status='live'`;
  const due = await sql.begin(async (tx) => {
    const rows =
      await tx`select o.*,coalesce(o.tx_hash,(select t.tx_hash from transactions t where t.reference=coalesce(o.expected_events->0->>'reference',o.reference) order by t.seq limit 1)) as known_hash from city_operations o where status in ('awaiting','unknown') and (next_check_at is null or next_check_at<=now()) order by created_at limit 10 for update skip locked`;
    for (const row of rows)
      await tx`update city_operations set next_check_at=now()+least(3600,30*power(2,least(check_count,7))) * interval '1 second',check_count=check_count+1 where id=${row.id}`;
    return rows;
  });
  for (const row of due) {
    if (!row.known_hash) continue;
    try {
      await confirm(row.actor_account, row.id, row.known_hash);
    } catch {
      await sql`update city_operations set error_code='RECONCILIATION_PENDING',status='unknown' where id=${row.id} and status<>'confirmed'`;
    }
  }
}
