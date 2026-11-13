import type { TransactionSql } from "postgres";
import { AppError } from "./errors.js";

export type ProjectionResult = {
  applied: boolean;
  replay: boolean;
};

/**
 * Shared projection for a verified job_reward event.
 *
 * The job row is locked before deciding so a repeated finalizer, ingester
 * replay, or rebuild replay cannot increment reconciliation counters twice.
 */
export async function projectJobReward(
  transaction: TransactionSql,
  input: { jobId: string; txHash?: string | null },
): Promise<ProjectionResult> {
  const [job] = await transaction<
    {
      payment_attempts: number;
      status: string;
      chain_tx: string | null;
    }[]
  >`
    select payment_attempts, status, chain_tx
    from jobs
    where id = ${input.jobId}
    for update
  `;
  if (!job) return { applied: false, replay: false };

  const [attempt] = await transaction<{ state: string; tx_hash: string | null; check_count: number }[]>`
    select state, tx_hash, check_count
    from job_payment_attempts
    where job_id = ${input.jobId} and attempt = ${Number(job.payment_attempts)}
    for update
  `;

  if (attempt?.tx_hash && input.txHash && attempt.tx_hash !== input.txHash) {
    throw new AppError("CONFLICT", "job reward conflicts with the stored transaction hash", 409);
  }
  if (job.chain_tx && input.txHash && job.chain_tx !== input.txHash) {
    throw new AppError("CONFLICT", "job reward conflicts with the finalized transaction hash", 409);
  }

  if (job.status === "paid") {
    if (attempt && !attempt.tx_hash && input.txHash) {
      await transaction`
        update job_payment_attempts set tx_hash = ${input.txHash}, updated_at = now()
        where job_id = ${input.jobId} and attempt = ${Number(job.payment_attempts)}
      `;
    }
    return { applied: false, replay: true };
  }

  let attemptApplied = false;
  if (attempt && attempt.state !== "confirmed") {
    await transaction`
      update job_payment_attempts set
        state = 'confirmed',
        tx_hash = coalesce(${input.txHash ?? null}, tx_hash),
        next_check_at = null,
        check_count = check_count + 1,
        updated_at = now()
      where job_id = ${input.jobId} and attempt = ${Number(job.payment_attempts)}
    `;
    attemptApplied = true;
  } else if (attempt && !attempt.tx_hash && input.txHash) {
    await transaction`
      update job_payment_attempts set tx_hash = ${input.txHash}, updated_at = now()
      where job_id = ${input.jobId} and attempt = ${Number(job.payment_attempts)}
    `;
  }

  const [updated] = await transaction<{ id: string }[]>`
    update jobs set
      status = 'paid',
      chain_tx = coalesce(${input.txHash ?? null}, chain_tx),
      paid_at = coalesce(paid_at, now()),
      last_error = null,
      payment_error_code = null,
      payment_next_check_at = null,
      payment_reconciliation_reason = null
    where id = ${input.jobId} and status <> 'paid'
    returning id
  `;
  return { applied: Boolean(updated) || attemptApplied, replay: !updated };
}

/**
 * Shared projection for a verified reward_issued event.
 *
 * Pool accounting moves only when the reward claim transitions from an unpaid
 * state to paid. Replays and convergence paths never touch the pool totals.
 */
export async function projectQuizReward(
  transaction: TransactionSql,
  input: { attemptId: string; txHash?: string | null; amount: string },
): Promise<ProjectionResult> {
  const [attempt] = await transaction<
    {
      quiz_id: string;
      reward_state: string;
      reward_amount: string | null;
      reward_paid: string | null;
      reward_tx: string | null;
    }[]
  >`
    select quiz_id, reward_state, reward_amount, reward_paid, reward_tx
    from quiz_attempts
    where id = ${input.attemptId}
    for update
  `;
  if (!attempt) return { applied: false, replay: false };

  if (attempt.reward_amount !== null && String(attempt.reward_amount) !== input.amount) {
    throw new AppError("CONFLICT", "quiz reward conflicts with the attempt snapshot amount", 409);
  }
  if (attempt.reward_tx && input.txHash && attempt.reward_tx !== input.txHash) {
    throw new AppError("CONFLICT", "quiz reward conflicts with the stored transaction hash", 409);
  }

  const [claim] = await transaction<{ id: string; status: string }[]>`
    select id, status from quiz_reward_claims
    where attempt_id = ${input.attemptId}
    for update
  `;
  if (!claim) {
    throw new AppError("CONFLICT", "quiz reward has no reservation claim", 409);
  }

  const convergeAttempt = async () => {
    await transaction`
      update quiz_attempts set
        status = 'rewarded',
        reward_state = 'paid',
        reward_paid = ${input.amount},
        reward_tx = coalesce(${input.txHash ?? null}, reward_tx),
        rewarded_at = coalesce(rewarded_at, now()),
        last_error = null,
        reward_error_code = null,
        reward_next_check_at = null
      where id = ${input.attemptId} and reward_state <> 'paid'
    `;
  };

  if (attempt.reward_state === "paid" || claim.status === "paid") {
    if (claim.status !== "paid") {
      await transaction`
        update quiz_reward_claims set status = 'paid', paid_at = coalesce(paid_at, now())
        where id = ${claim.id}
      `;
    }
    await convergeAttempt();
    return { applied: false, replay: true };
  }

  const [quiz] = await transaction<{ reward_reserved: string; reward_paid: string }[]>`
    select reward_reserved, reward_paid from quizzes where id = ${attempt.quiz_id} for update
  `;
  if (!quiz) {
    throw new AppError("CONFLICT", "quiz reward reservation points at a missing quiz", 409);
  }
  if (BigInt(quiz.reward_reserved) < BigInt(input.amount)) {
    throw new AppError("CONFLICT", "quiz reward exceeds reserved pool funds", 409);
  }

  const [updatedClaim] = await transaction<{ id: string }[]>`
    update quiz_reward_claims set status = 'paid', paid_at = coalesce(paid_at, now())
    where id = ${claim.id} and status <> 'paid'
    returning id
  `;
  if (!updatedClaim) {
    await convergeAttempt();
    return { applied: false, replay: true };
  }

  await transaction`
    update quizzes set
      reward_reserved = reward_reserved - ${input.amount}::numeric,
      reward_paid = reward_paid + ${input.amount}::numeric
    where id = ${attempt.quiz_id}
  `;
  await convergeAttempt();
  return { applied: true, replay: false };
}
