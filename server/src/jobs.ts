import type { Sql, TransactionSql } from "postgres";

export type JobRow = Record<string, unknown>;

export function jobPaymentReference(jobId: string): string {
  return `job:${jobId}`;
}

/**
 * Compare-and-set reservation. Exactly one concurrent caller moves a verified
 * job into payment_pending and receives the row.
 */
export async function reserveJobPayment(client: Sql | TransactionSql, jobId: string): Promise<JobRow | null> {
  const [job] = await client<JobRow[]>`
    update jobs
    set status = 'payment_pending',
        payment_reference = coalesce(payment_reference, ${jobPaymentReference(jobId)}),
        payment_attempts = payment_attempts + 1,
        payment_started_at = now()
    where id = ${jobId} and status = 'verified'
    returning *
  `;
  return job ?? null;
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}
