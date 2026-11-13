import type { Sql } from "postgres";
import { nextCheckAt, safeErrorMessage, type JobRow } from "./jobs.js";
import { insertLedgerEntries, type LedgerSql } from "./ledger.js";
import { ledgerEntriesFromEvents } from "./record-chain-events.js";
import { consumeTransaction } from "./transaction-context.js";
import { requireExpectedEvent, type ExpectedCall } from "./verify.js";
import { projectQuizReward } from "./projections.js";
import type { ValidatedEvent } from "./event-validation.js";
import { startWorker, type WorkerHandle } from "./worker.js";

export type QuizRewardDeps = {
  db: Sql;
  operatorAccount: string;
  verifyExpectedFunctionCall: (
    txHash: string,
    expectation: ExpectedCall,
  ) => Promise<{
    events: ValidatedEvent[];
  }>;
  readChainBalance: (walletId: string, atLeast?: string) => Promise<string>;
  setMirroredBalance: (client: LedgerSql, walletId: string, balance: string) => Promise<void>;
  insertLedgerEntries: typeof insertLedgerEntries;
  viewContract: <T>(method: string, args?: Record<string, unknown>) => Promise<T>;
  now: () => Date;
};

function expectationFor(attempt: JobRow, operatorAccount: string) {
  const wallet = `player:${String(attempt.player_account)}`;
  const amount = String(attempt.reward_amount);
  return {
    wallet,
    amount,
    reference: `quiz:${String(attempt.id)}`,
    expectation: {
      signerId: operatorAccount,
      method: "credit_reward",
      args: { wallet, amount, reference: `quiz:${String(attempt.id)}` },
      events: [
        {
          name: "reward_issued",
          entityId: wallet,
          walletFrom: null,
          walletTo: wallet,
          amount,
          reference: `quiz:${String(attempt.id)}`,
        },
      ],
    },
  };
}

export async function finalizeQuizReward(
  attempt: JobRow,
  txHash: string,
  events: ValidatedEvent[],
  deps: QuizRewardDeps,
): Promise<JobRow> {
  const { wallet, amount, reference } = expectationFor(attempt, deps.operatorAccount);
  const proof = requireExpectedEvent(events, {
    name: "reward_issued",
    entityId: wallet,
    walletTo: wallet,
    amount,
    reference,
  });
  const balance = await deps.readChainBalance(wallet);
  const finalized = await deps.db.begin(async (transaction) => {
    await consumeTransaction(transaction, {
      txHash,
      commandType: "credit_reward",
      entityType: "quiz_attempt",
      entityId: String(attempt.id),
      signerId: deps.operatorAccount,
      receiptId: proof.receiptId as string,
      eventIndex: proof.eventIndex as number,
    });
    await deps.setMirroredBalance(transaction, wallet, balance);
    await deps.insertLedgerEntries(transaction, ledgerEntriesFromEvents(events));
    await projectQuizReward(transaction, {
      attemptId: String(attempt.id),
      txHash,
      amount,
    });
    const [updated] = await transaction<JobRow[]>`
      select * from quiz_attempts where id = ${String(attempt.id)}
    `;
    if (!updated) throw new Error("quiz reward finalization lost the attempt");
    return updated;
  });
  return finalized;
}

export async function reconcileQuizReward(
  attempt: JobRow,
  deps: QuizRewardDeps,
): Promise<{ reconciled: boolean; reason?: string }> {
  if (attempt.reward_state === "paid") return { reconciled: true };
  const { reference, expectation } = expectationFor(attempt, deps.operatorAccount);
  let txHash = typeof attempt.reward_tx === "string" ? attempt.reward_tx : null;
  if (!txHash) {
    const [event] = await deps.db<{ tx_hash: string | null }[]>`
      select tx_hash from transactions
      where reference = ${reference} and event_name = 'reward_issued'
      order by seq desc limit 1
    `;
    txHash = event?.tx_hash ?? null;
  }

  if (txHash) {
    try {
      const verified = await deps.verifyExpectedFunctionCall(txHash, expectation);
      await finalizeQuizReward(attempt, txHash, verified.events, deps);
      return { reconciled: true };
    } catch (error) {
      const message = safeErrorMessage(error);
      await deps.db`
        update quiz_attempts set
          reward_state = 'unknown', status = 'reward_pending',
          reward_error_code = 'TX_MISMATCH', last_error = ${message},
          reward_next_check_at = ${nextCheckAt(deps.now(), Number(attempt.reward_check_count ?? 0) + 1)},
          reward_check_count = reward_check_count + 1
        where id = ${String(attempt.id)}
      `;
      return { reconciled: false, reason: message };
    }
  }

  const processed = await deps.viewContract<boolean>("is_reference_processed", { reference });
  const reason = processed
    ? "reference processed but no verified reward event is available"
    : "reward reference is not yet visible";
  await deps.db`
    update quiz_attempts set
      reward_state = 'unknown', status = 'reward_pending',
      reward_error_code = ${processed ? "TX_MISMATCH" : "TX_PENDING"},
      last_error = ${reason},
      reward_next_check_at = ${nextCheckAt(deps.now(), Number(attempt.reward_check_count ?? 0) + 1)},
      reward_check_count = reward_check_count + 1
    where id = ${String(attempt.id)}
  `;
  return { reconciled: false, reason };
}

export async function claimDueQuizRewards(db: Sql, limit = 10): Promise<JobRow[]> {
  return db.begin(async (transaction) => {
    const rows = await transaction<JobRow[]>`
      select * from quiz_attempts
      where reward_state in ('pending', 'unknown', 'failed')
        and (reward_next_check_at is null or reward_next_check_at <= now())
      order by coalesce(reward_next_check_at, reward_first_checked_at) asc
      limit ${limit}
      for update skip locked
    `;
    for (const row of rows) {
      await transaction`
        update quiz_attempts set reward_next_check_at = now() + interval '5 minutes'
        where id = ${String(row.id)}
      `;
    }
    return rows;
  });
}

export async function reconcileDueQuizRewards(
  deps: QuizRewardDeps,
  limit = 10,
): Promise<{ claimed: number; reconciled: number; pending: number }> {
  const attempts = await claimDueQuizRewards(deps.db, limit);
  let reconciled = 0;
  let pending = 0;
  for (const attempt of attempts) {
    const result = await reconcileQuizReward(attempt, deps);
    if (result.reconciled) reconciled += 1;
    else pending += 1;
  }
  return { claimed: attempts.length, reconciled, pending };
}

export function startQuizReconciler(
  deps: QuizRewardDeps,
  options: { intervalMs?: number; limit?: number; onError?: (error: unknown) => void } = {},
): WorkerHandle {
  return startWorker({
    intervalMs: options.intervalMs ?? 60_000,
    run: async () => {
      await reconcileDueQuizRewards(deps, options.limit ?? 10);
    },
    onError: options.onError,
  });
}
