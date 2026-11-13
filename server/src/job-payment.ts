import type { Sql } from "postgres";
import { config } from "./runtime-config.js";
import { AppError } from "./errors.js";
import { insertLedgerEntries, type LedgerSql } from "./ledger.js";
import { ledgerEntriesFromEvents } from "./record-chain-events.js";
import { consumeTransaction, type TransactionContext } from "./transaction-context.js";
import { projectJobReward } from "./projections.js";
import {
  claimDueJobReconciliations,
  jobPaymentReference,
  markJobPaymentAttempt,
  nextCheckAt,
  safeErrorMessage,
  type JobRow,
} from "./jobs.js";
import { requireExpectedEvent, type ExpectedCall } from "./verify.js";
import type { ValidatedEvent } from "./event-validation.js";
import { startWorker, type WorkerHandle } from "./worker.js";

export type JobPaymentDeps = {
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

export function jobPaymentExpectation(
  job: JobRow,
  operatorAccount: string,
): {
  employeeWallet: string;
  reference: string;
  expectation: ExpectedCall;
} {
  const employeeWallet = `player:${String(job.employee_account)}`;
  const reference = String(job.payment_reference ?? jobPaymentReference(String(job.id)));
  return {
    employeeWallet,
    reference,
    expectation: {
      signerId: operatorAccount,
      method: "pay_job",
      args: {
        employer_wallet: String(job.employer_wallet),
        employee_wallet: employeeWallet,
        amount: String(job.payment),
        reference,
      },
      events: [
        {
          name: "job_reward",
          entityId: employeeWallet,
          walletFrom: String(job.employer_wallet),
          walletTo: employeeWallet,
          amount: String(job.payment),
          reference,
        },
      ],
    },
  };
}

function consumptionFor(
  job: JobRow,
  txHash: string,
  event: ValidatedEvent,
  operatorAccount: string,
): TransactionContext {
  return {
    txHash,
    commandType: "pay_job",
    entityType: "job",
    entityId: String(job.id),
    signerId: operatorAccount,
    receiptId: event.receiptId as string,
    eventIndex: event.eventIndex as number,
  };
}

export async function finalizeJobPayment(
  job: JobRow,
  txHash: string,
  events: ValidatedEvent[],
  deps: JobPaymentDeps,
): Promise<{ job: JobRow; balance: string }> {
  const { employeeWallet } = jobPaymentExpectation(job, deps.operatorAccount);
  const employerWallet = String(job.employer_wallet);
  const employeeBalance = await deps.readChainBalance(employeeWallet);
  const employerBalance = await deps.readChainBalance(employerWallet);
  const proof = requireExpectedEvent(events, {
    name: "job_reward",
    entityId: employeeWallet,
  });
  const consumption = consumptionFor(job, txHash, proof, deps.operatorAccount);

  const finalized = await deps.db.begin(async (transaction) => {
    await consumeTransaction(transaction, consumption);
    await deps.setMirroredBalance(transaction, employeeWallet, employeeBalance);
    await deps.setMirroredBalance(transaction, employerWallet, employerBalance);
    await deps.insertLedgerEntries(transaction, ledgerEntriesFromEvents(events));
    await projectJobReward(transaction, { jobId: String(job.id), txHash });
    const [current] = await transaction<JobRow[]>`
      select * from jobs where id = ${String(job.id)}
    `;
    if (current?.status === "paid" && current.chain_tx === txHash) return current;
    throw new AppError("CONFLICT", "job payment state changed before finalization", 409);
  });
  return { job: finalized, balance: employeeBalance };
}

export async function reconcileJob(
  job: JobRow,
  deps: JobPaymentDeps,
): Promise<{ reconciled: boolean; job: JobRow; reason?: string }> {
  const attempt = Number(job.payment_attempts || 1);
  const { reference, expectation } = jobPaymentExpectation(job, deps.operatorAccount);

  let txHash = typeof job.chain_tx === "string" ? job.chain_tx : null;
  if (!txHash) {
    const [event] = await deps.db<{ tx_hash: string | null }[]>`
      select tx_hash from transactions
      where reference = ${reference} and event_name = 'job_reward'
      order by seq desc limit 1
    `;
    txHash = event?.tx_hash ?? null;
  }

  if (txHash) {
    try {
      const verified = await deps.verifyExpectedFunctionCall(txHash, expectation);
      const finalized = await finalizeJobPayment(job, txHash, verified.events, deps);
      return { reconciled: true, job: finalized.job };
    } catch (error) {
      const message = safeErrorMessage(error);
      await deps.db.begin(async (transaction) => {
        await markJobPaymentAttempt(transaction, {
          jobId: String(job.id),
          attempt,
          state: "unknown",
          txHash,
          errorCode: error instanceof AppError ? error.code : "CHAIN_UNAVAILABLE",
          errorMessage: message,
          reason: "stored transaction could not be verified",
          nextCheckAt: nextCheckAt(deps.now(), attempt),
          incrementCheck: true,
        });
      });
      return { reconciled: false, job, reason: message };
    }
  }

  const processed = await deps.viewContract<boolean>("is_reference_processed", { reference });
  const reason = processed
    ? "reference processed but no verified event is available"
    : "reference is not yet visible";
  await deps.db.begin(async (transaction) => {
    await markJobPaymentAttempt(transaction, {
      jobId: String(job.id),
      attempt,
      state: "unknown",
      errorCode: processed ? "TX_MISMATCH" : "TX_PENDING",
      errorMessage: reason,
      reason,
      nextCheckAt: nextCheckAt(deps.now(), attempt),
      incrementCheck: true,
    });
  });
  return { reconciled: false, job, reason };
}

export async function reconcileDueJobs(
  deps: JobPaymentDeps,
  limit = 10,
): Promise<{ claimed: number; reconciled: number; pending: number }> {
  const jobs = await claimDueJobReconciliations(deps.db, limit);
  let reconciled = 0;
  let pending = 0;
  for (const job of jobs) {
    const result = await reconcileJob(job, deps);
    if (result.reconciled) reconciled += 1;
    else pending += 1;
  }
  return { claimed: jobs.length, reconciled, pending };
}

export function defaultJobPaymentDeps(overrides: Partial<JobPaymentDeps> = {}): JobPaymentDeps {
  return {
    operatorAccount: config.operatorAccount,
    now: () => new Date(),
    ...overrides,
  } as JobPaymentDeps;
}

export function startJobReconciler(
  deps: JobPaymentDeps,
  options: { intervalMs?: number; limit?: number; onError?: (error: unknown) => void } = {},
): WorkerHandle {
  return startWorker({
    intervalMs: options.intervalMs ?? 60_000,
    run: async () => {
      await reconcileDueJobs(deps, options.limit ?? 10);
    },
    onError: options.onError,
  });
}
