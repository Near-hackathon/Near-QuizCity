import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { advanceQuizMatchLocked } from "./quiz-matches.js";
import { confirmCityOperation } from "./city-economy-routes.js";
import { submitCityPayment } from "./operator.js";
import { startWorker } from "./worker.js";
export type MatchWorkerDeps = {
  operator: string;
  now: () => Date;
  submit: typeof submitCityPayment;
  confirm: (actor: string, id: string, hash: string) => Promise<unknown>;
};
/** Clock transitions never wait for RPC, even while another room is settling. */
export async function tickQuizMatchRooms(sql: Sql, operator: string, now = new Date()) {
  await sql.begin(async (tx) => {
    const rooms =
      await tx`select * from quiz_matches where state in ('waiting','countdown','playing','settling') and next_tick_at<=${now} order by next_tick_at,id limit 40 for update skip locked`;
    for (const room of rooms) {
      await advanceQuizMatchLocked(tx, room, operator, now);
      await tx`update quiz_matches set next_tick_at=${new Date(now.getTime() + 2000)} where id=${room.id}`;
    }
  });
}

export async function tickQuizMatches(sql: Sql, deps: MatchWorkerDeps) {
  await tickQuizMatchRooms(sql, deps.operator, deps.now());
  await tickQuizMatchPayments(sql, deps);
}

/** Short row locks reserve one submission. An expired lease remains unknown, never requeued. */
async function tickQuizMatchPayments(sql: Sql, deps: MatchWorkerDeps) {
  const now = deps.now();
  const due = await sql.begin(async (tx) => {
    const rows =
      await tx`select t.*,o.actor_account,o.args,o.tx_hash,o.status as operation_status from quiz_match_transfers t join city_operations o on o.id=t.operation_id where t.state in ('queued','unknown','submitting') and t.next_check_at<=${now} and (t.lease_until is null or t.lease_until<=${now}) order by t.next_check_at,t.id limit 8 for update of t skip locked`;
    for (const row of rows) {
      row.shouldSubmit = row.state === "queued" && row.operation_status === "awaiting";
      row.token = randomUUID();
      await tx`update quiz_match_transfers set state=${row.shouldSubmit ? "submitting" : "unknown"},lease_token=${row.token},lease_until=${new Date(now.getTime() + 90000)},next_check_at=${new Date(now.getTime() + 30000)} where id=${row.id}`;
    }
    return rows;
  });
  for (const row of due) {
    let hash = row.tx_hash;
    try {
      if (row.shouldSubmit) {
        await sql`update city_operations set status='unknown' where id=${row.operation_id} and status='awaiting'`;
        // A throw can mean submission occurred. Persist unknown and do not send a second call.
        const result = await deps.submit("settle_escrow", row.args);
        hash = result.txHash ?? hash;
        if (hash)
          await sql`update city_operations set tx_hash=${hash} where id=${row.operation_id} and status<>'confirmed'`;
        if (result.kind === "rejected") {
          await sql`update quiz_match_transfers set state='rejected',last_error_code='TX_FAILED',lease_token=null,lease_until=null where id=${row.id} and lease_token=${row.token} and state<>'confirmed'`;
          await sql`update city_operations set error_code='TX_FAILED' where id=${row.operation_id} and status<>'confirmed'`;
          continue;
        }
      }
      if (!hash) {
        const [proof] =
          await sql`select t.tx_hash from transactions t join city_operations o on o.reference=t.reference where o.id=${row.operation_id} order by t.seq limit 1`;
        hash = proof?.tx_hash;
      }
      if (hash) await deps.confirm(row.actor_account, row.operation_id, hash);
    } catch {
      /* A verified receipt or the independent ingester is the only path to confirmation. */
    }
    await sql`update quiz_match_transfers set state='unknown',lease_token=null,lease_until=null,last_error_code='RECONCILIATION_PENDING' where id=${row.id} and lease_token=${row.token} and state<>'confirmed'`;
  }
  // Recover a managed player's deposited escrow even when their HTTP confirmation was lost.
  const deposits =
    await sql`select o.id,o.actor_account,coalesce(o.tx_hash,(select t.tx_hash from transactions t where t.reference=o.reference limit 1),(select t.tx_hash from managed_wallet_transactions t join managed_wallets w on w.profile_id=t.profile_id where w.account_id=o.actor_account and t.method='fund_escrow' and t.args=o.args limit 1)) as known_hash from city_operations o where o.payload ? 'matchPlayerId' and o.status in ('awaiting','unknown') and (o.next_check_at is null or o.next_check_at<=${now}) order by o.created_at limit 10`;
  for (const op of deposits) {
    await sql`update city_operations set next_check_at=${new Date(now.getTime() + 30000)} where id=${op.id} and status<>'confirmed'`;
    if (op.known_hash)
      try {
        await deps.confirm(op.actor_account, op.id, op.known_hash);
      } catch {
        /* Keep the exact proof for the next bounded check. */
      }
  }
}
export function startQuizMatchWorker(sql: Sql, operator: string, onError: (error: unknown) => void) {
  const deps: MatchWorkerDeps = {
    operator,
    now: () => new Date(),
    submit: submitCityPayment,
    confirm: (actor, id, hash) => confirmCityOperation(sql, actor, id, hash),
  };
  const clock = startWorker({
    intervalMs: 1000,
    onError,
    run: () => tickQuizMatchRooms(sql, operator, deps.now()),
  });
  const payments = startWorker({ intervalMs: 2000, onError, run: () => tickQuizMatchPayments(sql, deps) });
  return {
    async stop() {
      await Promise.all([clock.stop(), payments.stop()]);
    },
  };
}
