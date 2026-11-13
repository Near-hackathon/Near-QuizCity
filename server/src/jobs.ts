import type { Sql, TransactionSql } from "postgres";
import { appendJobPresentation } from "./world-projection.js";

export type JobRow = Record<string, unknown>;

export function jobPaymentReference(jobId: string): string {
  return `job:${jobId}`;
}

/**
 * Compare-and-set reservation. Exactly one concurrent caller moves a verified
 * job into payment_pending and receives the row. The attempt row is written in
 * the same caller-owned transaction.
 */
export async function reserveJobPayment(client: TransactionSql, jobId: string): Promise<JobRow | null> {
  const [job] = await client<JobRow[]>`
    update jobs
    set status = 'payment_pending',
        payment_reference = coalesce(payment_reference, ${jobPaymentReference(jobId)}),
        payment_attempts = payment_attempts + 1,
        payment_started_at = now(),
        payment_first_checked_at = coalesce(payment_first_checked_at, now()),
        payment_next_check_at = now() + interval '2 minutes',
        payment_reconciliation_reason = 'reserved',
        payment_error_code = null
    where id = ${jobId} and status = 'verified'
    returning *
  `;
  if (!job) return null;
  await client`
    insert into job_payment_attempts (job_id, attempt, reference, state)
    values (${jobId}, ${Number(job.payment_attempts)}, ${String(job.payment_reference)}, 'pending')
    on conflict (job_id, attempt) do nothing
  `;
  await appendJobPresentation(client, { jobId, status: "payment_pending" });
  return job;
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}

export async function markJobPaymentAttempt(
  client: TransactionSql,
  input: {
    jobId: string;
    attempt: number;
    state: "pending" | "unknown" | "confirmed" | "rejected" | "failed";
    txHash?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    nextCheckAt?: string | null;
    reason?: string | null;
    incrementCheck?: boolean;
  },
): Promise<void> {
  await client`
    update job_payment_attempts set
      state = ${input.state},
      tx_hash = coalesce(${input.txHash ?? null}, tx_hash),
      error_code = ${input.errorCode ?? null},
      error_message = ${input.errorMessage ?? null},
      next_check_at = ${input.nextCheckAt ?? null},
      check_count = check_count + ${input.incrementCheck ? 1 : 0},
      updated_at = now()
    where job_id = ${input.jobId} and attempt = ${input.attempt}
  `;
  await client`
    update jobs set
      status = coalesce(
        ${
          input.state === "unknown"
            ? "payment_unknown"
            : input.state === "failed" || input.state === "rejected"
              ? "payment_failed"
              : null
        },
        status
      ),
      chain_tx = coalesce(${input.txHash ?? null}, chain_tx),
      last_error = ${input.errorMessage ?? null},
      payment_error_code = ${input.errorCode ?? null},
      payment_next_check_at = ${input.nextCheckAt ?? null},
      payment_reconciliation_reason = ${input.reason ?? null}
    where id = ${input.jobId}
  `;
  const presentationStatus =
    input.state === "unknown"
      ? "payment_unknown"
      : input.state === "failed" || input.state === "rejected"
        ? "payment_failed"
        : null;
  if (presentationStatus) {
    await appendJobPresentation(client, {
      jobId: input.jobId,
      status: presentationStatus,
      txHash: input.txHash ?? null,
    });
  }
}

/**
 * Claims due reconciliation rows with SKIP LOCKED. The caller must not hold a
 * transaction open while calling NEAR; this only marks the next check time.
 */
export async function claimDueJobReconciliations(db: Sql, limit = 10): Promise<JobRow[]> {
  return db.begin(async (transaction) => {
    const rows = await transaction<JobRow[]>`
      select * from jobs
      where status in ('payment_pending', 'payment_unknown', 'payment_failed')
        and payment_attempts > 0
        and (payment_next_check_at is null or payment_next_check_at <= now())
      order by coalesce(payment_next_check_at, payment_started_at) asc
      limit ${limit}
      for update skip locked
    `;
    for (const row of rows) {
      await transaction`
        update jobs set
          payment_next_check_at = now() + interval '5 minutes',
          payment_reconciliation_reason = 'checking'
        where id = ${String(row.id)}
      `;
    }
    return rows;
  });
}

export function nextCheckAt(now: Date, attemptCount: number): string {
  const base = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(attemptCount, 7));
  const jitter = Math.floor(Math.random() * 0.2 * base);
  return new Date(now.getTime() + base + jitter).toISOString();
}
