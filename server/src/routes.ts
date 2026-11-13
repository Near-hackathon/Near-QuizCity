import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import type { Static } from "@sinclair/typebox";
import { addQc, compareQc, parseQc } from "./amount.js";
import { config } from "./runtime-config.js";
import { sql } from "./db.js";
import { appErrorFromStatus } from "./errors.js";
import { requireAuth, requireRole } from "./auth/plugin.js";
import { decodeJobCursor, encodeJobCursor, pageParams, pageResult, PageQuery } from "./cursor.js";
import { ensureRole } from "./auth/repository.js";
import { viewAllBusinesses, viewContract } from "./near.js";
import { jobPaymentExpectation, finalizeJobPayment, type JobPaymentDeps } from "./job-payment.js";
import { creditReward, payJob, type PayoutSubmission } from "./operator.js";
import {
  jobPaymentReference,
  markJobPaymentAttempt,
  nextCheckAt,
  reserveJobPayment,
  safeErrorMessage,
} from "./jobs.js";
import { getMirroredBalance, readChainBalance, setMirroredBalance } from "./sync.js";
import { propertySaleFromReceipts, ReceiptError, servicePaymentReceipt } from "./event-ledger.js";
import type { ValidatedEvent } from "./event-validation.js";
import { ledgerEntriesFromEvents } from "./record-chain-events.js";
import { recordOwnershipHistory } from "./chain-ingester.js";
import { projectQuizReward } from "./projections.js";
import { insertLedgerEntries } from "./ledger.js";
import { consumeTransaction, type TransactionContext } from "./transaction-context.js";
import {
  attemptExpired,
  reserveQuizReward,
  scoreSnapshot,
  snapshotQuestions,
  startQuizAttempt,
  QuizError,
  type SnapshotQuestion,
} from "./quiz.js";
import { requireExpectedEvent, verifyExpectedFunctionCall, verifyOperatorOutcome } from "./verify.js";
import {
  AcceptJobBody,
  BuyPropertyBody,
  ClaimBody,
  ClaimResponse,
  CompleteJobBody,
  CompleteJobResponse,
  CreateBusinessBody,
  ErrorResponses,
  JobParams,
  JobsPage,
  LooseObject,
  PayServiceBody,
  PayServiceResponse,
  PlayerParams,
  PlayerResponse,
  PropertyParams,
  BusinessParams,
  BuyPropertyResponse,
  QuizParams,
  QuizzesPage,
  RegisterBody,
  RegisterResponse,
  RetryJobBody,
  StartQuizBody,
  StartQuizResponse,
  SubmitJobBody,
  SubmitQuizBody,
  SubmitQuizResponse,
  TransferBusinessBody,
  TransferBusinessResponse,
  VerifyJobBody,
} from "./schemas/index.js";

type ChainPlayer = {
  username: string;
  created_at: number;
  starter_claimed: boolean;
};

type ChainProperty = {
  id: number;
  kind: string;
  district: string;
  x: number;
  y: number;
  owner: string;
  price: string;
  for_sale: boolean;
  transfer_count: number;
};

const STARTER_ALLOWANCE = "500";

function fail(message: string, status = 400): never {
  throw appErrorFromStatus(status, message);
}

function playerWallet(accountId: string): string {
  return `player:${accountId}`;
}

function numericId(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${name} must be a positive integer`);
  return parsed;
}

function rewardDayOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function attemptResult(attempt: Record<string, unknown>, alreadySubmitted: boolean) {
  return {
    score: Number(attempt.score),
    total: Number(attempt.total),
    reward: String(attempt.reward_paid),
    txHash: (attempt.reward_tx as string | null) ?? null,
    alreadySubmitted,
    status: attempt.status as string,
  };
}

export type RouteDeps = {
  db: Sql;
  viewContract: typeof viewContract;
  viewAllBusinesses: typeof viewAllBusinesses;
  creditReward: typeof creditReward;
  payJob: typeof payJob;
  readChainBalance: typeof readChainBalance;
  setMirroredBalance: typeof setMirroredBalance;
  getMirroredBalance: typeof getMirroredBalance;
  verifyExpectedFunctionCall: typeof verifyExpectedFunctionCall;
  verifyOperatorOutcome: typeof verifyOperatorOutcome;
  insertLedgerEntries: typeof insertLedgerEntries;
};

const defaultDeps: RouteDeps = {
  db: sql,
  viewContract,
  viewAllBusinesses,
  creditReward,
  payJob,
  readChainBalance,
  setMirroredBalance,
  getMirroredBalance,
  verifyExpectedFunctionCall,
  verifyOperatorOutcome,
  insertLedgerEntries,
};

export function registerRoutes(app: FastifyInstance, deps: RouteDeps = defaultDeps): void {
  const {
    db,
    viewContract,
    viewAllBusinesses,
    creditReward,
    payJob,
    readChainBalance,
    setMirroredBalance,
    getMirroredBalance,
    verifyExpectedFunctionCall,
    verifyOperatorOutcome,
    insertLedgerEntries,
  } = deps;

  const jobDeps: JobPaymentDeps = {
    db,
    operatorAccount: config.operatorAccount,
    verifyExpectedFunctionCall,
    readChainBalance,
    setMirroredBalance,
    insertLedgerEntries,
    viewContract,
    now: () => new Date(),
  };

  function consumptionContext(
    txHash: string,
    commandType: string,
    entityType: string,
    entityId: string,
    signerId: string,
    event: ValidatedEvent,
  ): TransactionContext {
    if (typeof event.receiptId !== "string" || !Number.isInteger(event.eventIndex)) {
      fail("verified event is missing transaction identity", 409);
    }
    return {
      txHash,
      commandType,
      entityType,
      entityId,
      signerId,
      receiptId: event.receiptId,
      eventIndex: event.eventIndex as number,
    };
  }
  app.get<{ Params: Static<typeof PlayerParams> }>(
    "/players/:account",
    {
      schema: {
        params: PlayerParams,
        response: { 200: PlayerResponse, ...ErrorResponses },
      },
    },
    async (request) => {
      const { account } = request.params;
      const [player] =
        await db`select account_id, username, reputation, created_at from players where account_id = ${account}`;
      if (!player) fail("player not found", 404);
      const [wallet] =
        await db`select balance, updated_at from wallets where wallet_id = ${playerWallet(account)}`;
      return { ...player, wallet: wallet ?? null };
    },
  );

  app.post<{ Body: Static<typeof RegisterBody> }>(
    "/players/register",
    {
      schema: {
        body: RegisterBody,
        response: { 200: RegisterResponse, ...ErrorResponses },
      },
    },
    async (request) => {
      const { txHash, username } = request.body;
      const accountId = requireAuth(request).accountId;

      const verified = await verifyExpectedFunctionCall(txHash, {
        signerId: accountId,
        method: "register_player",
        args: { username },
        events: [{ name: "player_registered", entityId: `player:${accountId}` }],
      });
      const chainPlayer = await viewContract<ChainPlayer | null>("get_player", { account: accountId });
      if (!chainPlayer) fail("player is not registered on chain", 409);
      if (chainPlayer.username !== username) fail("chain username does not match the request", 409);

      const wallet = playerWallet(accountId);
      const balance = await readChainBalance(wallet);
      const proof = requireExpectedEvent(verified.events, {
        name: "player_registered",
        entityId: `player:${accountId}`,
      });
      const consumption = consumptionContext(
        txHash,
        "register_player",
        "player",
        accountId,
        accountId,
        proof,
      );
      await db.begin(async (transaction) => {
        await consumeTransaction(transaction, consumption);
        await transaction`
        insert into players (account_id, username)
        values (${accountId}, ${chainPlayer.username})
        on conflict (account_id) do update set username = excluded.username
      `;
        await ensureRole(transaction, accountId, "player");
        await setMirroredBalance(transaction, wallet, balance);
        await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
      });
      return { accountId, username: chainPlayer.username, starter_claimed: chainPlayer.starter_claimed };
    },
  );

  app.post<{ Body: Static<typeof ClaimBody> }>(
    "/players/claim",
    {
      schema: {
        body: ClaimBody,
        response: { 200: ClaimResponse, ...ErrorResponses },
      },
    },
    async (request) => {
      const { txHash } = request.body;
      const accountId = requireAuth(request).accountId;
      const wallet = playerWallet(accountId);

      const verified = await verifyExpectedFunctionCall(txHash, {
        signerId: accountId,
        method: "claim_starter",
        args: {},
        events: [{ name: "starter_allowance", entityId: wallet }],
      });
      const chainPlayer = await viewContract<ChainPlayer | null>("get_player", { account: accountId });
      if (!chainPlayer?.starter_claimed) fail("starter allowance not confirmed on chain", 409);
      const balance = await readChainBalance(wallet, STARTER_ALLOWANCE);
      const proof = requireExpectedEvent(verified.events, {
        name: "starter_allowance",
        entityId: wallet,
      });
      const consumption = consumptionContext(txHash, "claim_starter", "player", accountId, accountId, proof);
      await db.begin(async (transaction) => {
        await consumeTransaction(transaction, consumption);
        await setMirroredBalance(transaction, wallet, balance);
        await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
      });
      return { balance };
    },
  );

  app.get<{ Querystring: Static<typeof PageQuery> }>(
    "/jobs",
    {
      schema: {
        querystring: PageQuery,
        response: { 200: JobsPage, ...ErrorResponses },
      },
    },
    async (request) => {
      const { limit, cursor } = pageParams(request.query);
      const decoded = decodeJobCursor(cursor);
      const rows = await db`
        select * from jobs
        where (${decoded?.createdAt ?? null}::timestamptz is null or
               (created_at, id) < (${decoded?.createdAt ?? null}::timestamptz, ${decoded?.id ?? null}))
        order by created_at desc, id desc limit ${limit + 1}
      `;
      return pageResult([...rows], limit, (row) =>
        encodeJobCursor(row as { created_at: string | Date; id: string }),
      );
    },
  );

  app.post<{ Params: Static<typeof JobParams>; Body: Static<typeof AcceptJobBody> }>(
    "/jobs/:id/accept",
    {
      schema: {
        params: JobParams,
        body: AcceptJobBody,
        response: { 200: LooseObject, ...ErrorResponses },
      },
    },
    async (request) => {
      const { id } = request.params;
      const accountId = requireAuth(request).accountId;
      const [job] = await db`
      update jobs set employee_account = ${accountId}, status = 'accepted', accepted_at = now()
      where id = ${id} and status = 'open'
      returning *
    `;
      if (!job) fail("job is not open", 409);
      return job;
    },
  );

  app.post<{ Params: Static<typeof JobParams>; Body: Static<typeof SubmitJobBody> }>(
    "/jobs/:id/submit",
    {
      schema: {
        params: JobParams,
        body: SubmitJobBody,
        response: { 200: LooseObject, ...ErrorResponses },
      },
    },
    async (request) => {
      const { id } = request.params;
      const { deliverable } = request.body;
      const accountId = requireAuth(request).accountId;
      const [job] = await db`
        update jobs
        set status = 'submitted', deliverable = ${deliverable}, submitted_at = now()
        where id = ${id} and status = 'accepted' and employee_account = ${accountId}
        returning *
      `;
      if (!job) fail("job is not ready to submit", 409);
      return job;
    },
  );

  app.post<{ Params: Static<typeof JobParams>; Body: Static<typeof VerifyJobBody> }>(
    "/jobs/:id/verify",
    {
      schema: {
        params: JobParams,
        body: VerifyJobBody,
        response: { 200: LooseObject, ...ErrorResponses },
      },
    },
    async (request) => {
      const { id } = request.params;
      const notes = request.body.notes ?? null;
      requireRole(request, ["operator", "admin"]);
      const [job] = await db`
        update jobs
        set status = 'verified', verification_notes = ${notes}, verified_at = now()
        where id = ${id} and status = 'submitted'
        returning *
      `;
      if (!job) fail("job is not awaiting verification", 409);
      return job;
    },
  );

  app.post<{ Params: Static<typeof JobParams>; Body: Static<typeof CompleteJobBody> }>(
    "/jobs/:id/complete",
    {
      schema: {
        params: JobParams,
        body: CompleteJobBody,
        response: { 200: CompleteJobResponse, ...ErrorResponses },
      },
    },
    async (request) => {
      const { id } = request.params;
      const accountId = requireAuth(request).accountId;
      const [job] = await db`select * from jobs where id = ${id}`;
      if (!job) fail("job not found", 404);
      if (job.employee_account !== accountId) fail("you did not accept this job", 403);
      if (job.status === "paid") return { job, txHash: job.chain_tx, alreadyPaid: true };
      if (job.status === "payment_pending") {
        return { job, txHash: null, paymentPending: true };
      }
      if (job.status === "payment_unknown" || job.status === "payment_failed") {
        fail("job payment is unresolved; reconcile before retrying", 409);
      }
      if (job.status !== "verified") fail("job must be verified before payment", 409);

      const reserved = await db.begin((transaction) => reserveJobPayment(transaction, id));
      if (!reserved) {
        const [current] = await db`select * from jobs where id = ${id}`;
        if (current?.status === "paid") {
          return { job: current, txHash: current.chain_tx, alreadyPaid: true };
        }
        return { job: current, txHash: null, paymentPending: true };
      }

      const attempt = Number(reserved.payment_attempts || 1);
      const { employeeWallet, reference, expectation } = jobPaymentExpectation(
        reserved,
        config.operatorAccount,
      );
      let result: PayoutSubmission;
      try {
        result = await payJob(
          String(reserved.employer_wallet),
          employeeWallet,
          String(reserved.payment),
          reference,
        );
      } catch (error) {
        await db.begin(async (transaction) => {
          await markJobPaymentAttempt(transaction, {
            jobId: id,
            attempt,
            state: "unknown",
            errorCode: "CHAIN_UNAVAILABLE",
            errorMessage: safeErrorMessage(error),
            reason: "operator submission threw an unclassified error",
            nextCheckAt: nextCheckAt(new Date(), attempt),
            incrementCheck: true,
          });
        });
        fail("job payment outcome is unknown; reconciliation will retry", 502);
      }

      if (result.kind === "unknown") {
        await db.begin(async (transaction) => {
          await markJobPaymentAttempt(transaction, {
            jobId: id,
            attempt,
            state: "unknown",
            txHash: result.txHash ?? null,
            errorCode: result.code,
            errorMessage: "payout outcome is unknown",
            reason: "operator outcome unknown",
            nextCheckAt: nextCheckAt(new Date(), attempt),
            incrementCheck: true,
          });
        });
        fail("job payment outcome is unknown", 502);
      }
      if (result.kind === "rejected") {
        await db.begin(async (transaction) => {
          await markJobPaymentAttempt(transaction, {
            jobId: id,
            attempt,
            state: "rejected",
            txHash: result.txHash ?? null,
            errorCode: result.code,
            errorMessage: result.safeMessage,
            reason: "operator rejected the payout",
            nextCheckAt: null,
            incrementCheck: true,
          });
        });
        fail("job payment was rejected", 409);
      }

      // Persist the hash immediately so a local finalization failure remains
      // recoverable without calling pay_job again.
      try {
        await db`
        update jobs set chain_tx = ${result.txHash}
        where id = ${id} and status = 'payment_pending'
      `;
      } catch {
        // The atomic finalizer below also stores the hash. Continuing here closes
        // the one-statement failure window without issuing another chain call.
      }

      try {
        const verified = await verifyOperatorOutcome(result.outcome, result.txHash, expectation);
        const finalized = await finalizeJobPayment(reserved, result.txHash, verified.events, jobDeps);
        return { job: finalized.job, txHash: result.txHash, balance: finalized.balance };
      } catch (error) {
        await db.begin(async (transaction) => {
          await markJobPaymentAttempt(transaction, {
            jobId: id,
            attempt,
            state: "unknown",
            txHash: result.txHash,
            errorCode: "CHAIN_UNAVAILABLE",
            errorMessage: safeErrorMessage(error),
            reason: "chain succeeded but local finalization failed",
            nextCheckAt: nextCheckAt(new Date(), attempt),
            incrementCheck: true,
          });
        });
        fail("job payment could not be finalized", 502);
      }
    },
  );

  app.post<{ Params: Static<typeof JobParams>; Body: Static<typeof RetryJobBody> }>(
    "/jobs/:id/retry-payment",
    {
      schema: {
        params: JobParams,
        body: RetryJobBody,
        response: { 200: LooseObject, ...ErrorResponses },
      },
    },
    async (request) => {
      const { id } = request.params;
      requireRole(request, ["operator", "admin"]);
      const [job] = await db`select * from jobs where id = ${id}`;
      if (!job) fail("job not found", 404);
      if (job.status === "paid") return { job, reconciled: true, alreadyPaid: true };
      if (!["payment_failed", "payment_unknown", "payment_pending"].includes(String(job.status))) {
        fail("job is not awaiting payment reconciliation", 409);
      }

      const { reference, expectation } = jobPaymentExpectation(job, config.operatorAccount);
      const [ledgerEvent] = await db`
      select tx_hash from transactions
      where reference = ${reference} and event_name = 'job_reward'
      order by seq desc limit 1
    `;
      const txHash = (job.chain_tx as string | null) ?? (ledgerEvent?.tx_hash as string | null) ?? null;

      if (txHash) {
        try {
          const verified = await verifyExpectedFunctionCall(txHash, expectation);
          const finalized = await finalizeJobPayment(job, txHash, verified.events, jobDeps);
          return { job: finalized.job, reconciled: true };
        } catch (error) {
          await db`
          update jobs set last_error = ${safeErrorMessage(error)}
          where id = ${id} and status in ('payment_failed', 'payment_unknown', 'payment_pending')
        `;
          fail("job payment reconciliation could not verify the chain event", 502);
        }
      }

      const processed = await viewContract<boolean>("is_reference_processed", { reference });
      if (processed) {
        await db`
        update jobs
        set last_error = ${"reference processed but transaction outcome is unavailable"}
        where id = ${id} and status in ('payment_failed', 'payment_unknown', 'payment_pending')
      `;
        fail("reference is processed but the transaction outcome is unavailable", 409);
      }

      if (job.status === "payment_pending") {
        await db`
        update jobs
        set last_error = ${"payment outcome is still unresolved"}
        where id = ${id} and status = 'payment_pending'
      `;
        fail("job payment outcome is still unresolved", 409);
      }

      const [reset] = await db`
      update jobs
      set status = 'verified', last_error = null,
          payment_reference = coalesce(payment_reference, ${jobPaymentReference(id)}),
          payment_error_code = null, payment_next_check_at = null,
          payment_reconciliation_reason = null
      where id = ${id} and status in ('payment_failed', 'payment_unknown')
      returning *
    `;
      return { job: reset, retryAllowed: true };
    },
  );

  app.get<{ Querystring: Static<typeof PageQuery> }>(
    "/quizzes",
    {
      schema: {
        querystring: PageQuery,
        response: { 200: QuizzesPage, ...ErrorResponses },
      },
    },
    async (request) => {
      const { limit, cursor } = pageParams(request.query);
      const rows = await db<{ id: string }[]>`
        select q.id, q.title, q.reward_pool, q.entry_fee, q.status,
               (select count(*)::int from quiz_questions qq where qq.quiz_id = q.id) as questions
        from quizzes q
        where (${cursor}::text is null or q.id > ${cursor})
        order by q.id limit ${limit + 1}
      `;
      return pageResult([...rows], limit, (row) => row.id);
    },
  );

  app.post<{ Params: Static<typeof QuizParams>; Body: Static<typeof StartQuizBody> }>(
    "/quizzes/:id/start",
    {
      schema: {
        params: QuizParams,
        body: StartQuizBody,
        response: { 200: StartQuizResponse, ...ErrorResponses },
      },
    },
    async (request) => {
      const { id } = request.params;
      const accountId = requireAuth(request).accountId;
      try {
        const { attemptId, questions } = await startQuizAttempt(db, { quizId: id, accountId });
        return {
          attemptId,
          quizId: id,
          questions: questions.map((question) => ({
            id: question.question_id,
            question: question.question,
            options: question.options,
            category: question.category,
          })),
        };
      } catch (error) {
        if (error instanceof QuizError) fail(error.message, error.statusCode);
        throw error;
      }
    },
  );

  app.post<{ Params: Static<typeof QuizParams>; Body: Static<typeof SubmitQuizBody> }>(
    "/quizzes/:id/submit",
    {
      schema: {
        params: QuizParams,
        body: SubmitQuizBody,
        response: { 200: SubmitQuizResponse, ...ErrorResponses },
      },
    },
    async (request) => {
      const { id } = request.params;
      const { attemptId, answers } = request.body;
      const accountId = requireAuth(request).accountId;

      const [attempt] = await db`
      select * from quiz_attempts
      where id = ${attemptId} and quiz_id = ${id} and player_account = ${accountId}
    `;
      if (!attempt) fail("attempt not found", 404);
      if (["submitted", "rewarded", "failed", "reward_pending"].includes(attempt.status as string)) {
        return attemptResult(attempt, true);
      }
      if (attempt.status === "expired") fail("quiz attempt expired", 410);
      if (attemptExpired(attempt.expires_at)) {
        await db`update quiz_attempts set status = 'expired' where id = ${attemptId} and status = 'started'`;
        fail("quiz attempt expired", 410);
      }

      const questions: SnapshotQuestion[] = await snapshotQuestions(db, attemptId);
      const { score } = scoreSnapshot(questions, answers);
      const rewardAmount = String(attempt.reward_amount);
      const rewardCandidate = score >= Number(attempt.pass_score) && compareQc(rewardAmount, "0") > 0;
      const rewardDay = rewardDayOf(attempt.reward_day);

      let won = false;
      let ownsReward = false;
      await db.begin(async (transaction) => {
        const [updated] = await transaction`
        update quiz_attempts
        set score = ${score}, total = ${questions.length}, submitted_at = now(),
            status = ${rewardCandidate ? "reward_pending" : "submitted"}
        where id = ${attemptId} and status = 'started'
        returning id
      `;
        if (!updated) return;
        won = true;
        if (!rewardCandidate) return;
        const reservation = await reserveQuizReward(transaction, {
          playerAccount: accountId,
          rewardDay,
          attemptId,
        });
        if (reservation.ownedByAttempt) {
          const [pool] = await transaction`
            update quizzes set reward_reserved = reward_reserved + ${rewardAmount}::numeric
            where id = ${id}
              and status = 'live'
              and reward_pool - reward_reserved - reward_paid >= ${rewardAmount}::numeric
            returning id
          `;
          if (pool) {
            ownsReward = true;
            await transaction`
              update quiz_attempts
              set reward_state = 'pending', reward_first_checked_at = now(),
                  reward_next_check_at = now() + interval '2 minutes'
              where id = ${attemptId}
            `;
          } else {
            await transaction`delete from quiz_reward_claims where attempt_id = ${attemptId}`;
            await transaction`
              update quiz_attempts set status = 'submitted', reward_amount = 0, reward_state = 'none'
              where id = ${attemptId}
            `;
          }
        } else {
          await transaction`
          update quiz_attempts set status = 'submitted', reward_amount = 0 where id = ${attemptId}
        `;
        }
      });

      if (!won) {
        const [current] = await db`select * from quiz_attempts where id = ${attemptId}`;
        return attemptResult(current, true);
      }
      if (!ownsReward) {
        return {
          score,
          total: questions.length,
          reward: "0",
          txHash: null,
          alreadySubmitted: false,
          status: "submitted",
        };
      }

      const wallet = playerWallet(accountId);
      const previous = await getMirroredBalance(wallet);
      try {
        const result = await creditReward(wallet, rewardAmount, `quiz:${attemptId}`);
        if (result.kind === "unknown") {
          await db`
            update quiz_attempts
            set status = 'reward_pending', reward_state = 'unknown',
                reward_error_code = ${result.code}, last_error = ${"reward outcome is unknown"},
                reward_next_check_at = now() + interval '2 minutes'
            where id = ${attemptId}
          `;
          fail("quiz reward outcome is unknown", 502);
        }
        if (result.kind === "rejected") {
          await db.begin(async (transaction) => {
            await transaction`update quiz_reward_claims set status = 'failed' where attempt_id = ${attemptId}`;
            await transaction`
              update quizzes set reward_reserved = greatest(0, reward_reserved - ${rewardAmount}::numeric)
              where id = ${id}
            `;
            await transaction`
              update quiz_attempts
              set status = 'failed', reward_state = 'failed', reward_error_code = ${result.code},
                  last_error = ${result.safeMessage}, reward_next_check_at = null
              where id = ${attemptId}
            `;
          });
          fail("quiz reward was rejected", 409);
        }
        // Persist the hash immediately; local finalization may fail afterward.
        await db`update quiz_attempts set reward_tx = ${result.txHash} where id = ${attemptId}`;
        const verified = await verifyOperatorOutcome(result.outcome, result.txHash, {
          signerId: config.operatorAccount,
          method: "credit_reward",
          args: { wallet, amount: rewardAmount, reference: `quiz:${attemptId}` },
          events: [
            {
              name: "reward_issued",
              entityId: wallet,
              walletFrom: null,
              walletTo: wallet,
              amount: rewardAmount,
              reference: `quiz:${attemptId}`,
            },
          ],
        });
        const balance = await readChainBalance(wallet, addQc(previous, rewardAmount));
        const proof = requireExpectedEvent(verified.events, {
          name: "reward_issued",
          entityId: wallet,
        });
        const consumption = consumptionContext(
          result.txHash,
          "credit_reward",
          "quiz_attempt",
          attemptId,
          config.operatorAccount,
          proof,
        );
        await db.begin(async (transaction) => {
          await consumeTransaction(transaction, consumption);
          await setMirroredBalance(transaction, wallet, balance);
          await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
          await projectQuizReward(transaction, {
            attemptId,
            txHash: result.txHash,
            amount: rewardAmount,
          });
        });
        return {
          score,
          total: questions.length,
          reward: rewardAmount,
          txHash: result.txHash,
          alreadySubmitted: false,
          status: "rewarded",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 300) : "reward payment failed";
        await db`
          update quiz_attempts
          set status = 'reward_pending', reward_state = 'unknown',
              reward_error_code = 'CHAIN_UNAVAILABLE', last_error = ${message},
              reward_next_check_at = now() + interval '2 minutes'
          where id = ${attemptId}
        `;
        fail("quiz reward outcome is unknown", 502);
      }
    },
  );

  app.post<{ Params: Static<typeof PropertyParams>; Body: Static<typeof BuyPropertyBody> }>(
    "/properties/:id/buy",
    {
      schema: {
        params: PropertyParams,
        body: BuyPropertyBody,
        response: { 200: BuyPropertyResponse, ...ErrorResponses },
      },
    },
    async (request) => {
      const propertyId = numericId(request.params.id, "property id");
      const { txHash } = request.body;
      const accountId = requireAuth(request).accountId;

      const verified = await verifyExpectedFunctionCall(txHash, {
        signerId: accountId,
        method: "buy_property",
        args: { property_id: propertyId },
        events: [{ name: "property_transferred", entityId: `property:${propertyId}` }],
      });
      const property = await viewContract<ChainProperty | null>("get_property", { property_id: propertyId });
      if (!property) fail("property not found", 404);
      if (property.owner !== playerWallet(accountId)) fail("chain ownership not confirmed", 409);

      const buyer = playerWallet(accountId);
      let seller: string;
      let price: string;
      try {
        const receipt = propertySaleFromReceipts(verified.events, buyer, propertyId, property.transfer_count);
        if (!receipt) fail("property sale receipt is missing", 409);
        seller = receipt.seller;
        price = receipt.price;
      } catch (error) {
        if (error instanceof ReceiptError) fail(error.message, 409);
        throw error;
      }

      const buyerBalance = await readChainBalance(buyer);
      const sellerBalance = await readChainBalance(seller);
      const proof = requireExpectedEvent(verified.events, {
        name: "property_transferred",
        entityId: `property:${propertyId}`,
      });
      const consumption = consumptionContext(
        txHash,
        "buy_property",
        "property",
        String(propertyId),
        accountId,
        proof,
      );
      await db.begin(async (transaction) => {
        await consumeTransaction(transaction, consumption);
        await transaction`
          insert into properties (id, district, x, y, owner_wallet, property_type, price, for_sale, transfer_count, updated_at)
          values (${property.id}, ${property.district}, ${property.x}, ${property.y}, ${property.owner},
                  ${property.kind}, ${property.price}, ${property.for_sale}, ${property.transfer_count}, now())
          on conflict (id) do update set
            owner_wallet = excluded.owner_wallet,
            property_type = excluded.property_type,
            price = excluded.price,
            for_sale = excluded.for_sale,
            transfer_count = excluded.transfer_count,
            updated_at = now()
        `;
        await setMirroredBalance(transaction, buyer, buyerBalance);
        await setMirroredBalance(transaction, seller, sellerBalance);
        await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
        await recordOwnershipHistory(transaction, proof, "property", String(propertyId), {
          networkId: config.networkId,
          contractId: config.contractId,
        });
      });
      return { property, seller, price };
    },
  );

  app.post<{ Body: Static<typeof CreateBusinessBody> }>(
    "/businesses",
    {
      schema: {
        body: CreateBusinessBody,
        response: { 200: LooseObject, ...ErrorResponses },
      },
    },
    async (request) => {
      const { propertyId, name, txHash } = request.body;
      const accountId = requireAuth(request).accountId;

      const verified = await verifyExpectedFunctionCall(txHash, {
        signerId: accountId,
        method: "create_business",
        args: { property_id: propertyId, name },
        events: [{ name: "permit_burn" }, { name: "business_created" }],
      });
      const businesses = await viewAllBusinesses();
      const business = businesses.find((b) => b.owner === accountId && Number(b.property_id) === propertyId);
      if (!business) fail("business creation not confirmed on chain", 409);
      requireExpectedEvent(verified.events, { name: "permit_burn", entityId: `business:${business.id}` });
      requireExpectedEvent(verified.events, {
        name: "business_created",
        entityId: `business:${business.id}`,
      });

      const ownerWallet = playerWallet(accountId);
      const ownerBalance = await readChainBalance(ownerWallet);
      const treasuryBalance = await readChainBalance(business.treasury);
      const proof = requireExpectedEvent(verified.events, {
        name: "business_created",
        entityId: `business:${business.id}`,
      });
      const consumption = consumptionContext(
        txHash,
        "create_business",
        "business",
        String(business.id),
        accountId,
        proof,
      );
      await db.begin(async (transaction) => {
        await consumeTransaction(transaction, consumption);
        await transaction`
          insert into businesses (id, name, owner_account, property_id, treasury_wallet, revenue_total)
          values (${business.id}, ${business.name}, ${business.owner}, ${business.property_id},
                  ${business.treasury}, ${business.revenue_total})
          on conflict (id) do update set
            name = excluded.name,
            owner_account = excluded.owner_account,
            treasury_wallet = excluded.treasury_wallet,
            revenue_total = excluded.revenue_total
        `;
        await setMirroredBalance(transaction, ownerWallet, ownerBalance);
        await setMirroredBalance(transaction, business.treasury, treasuryBalance);
        await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
      });
      return business;
    },
  );

  app.post<{ Params: Static<typeof BusinessParams>; Body: Static<typeof PayServiceBody> }>(
    "/businesses/:id/pay",
    {
      schema: {
        params: BusinessParams,
        body: PayServiceBody,
        response: { 200: PayServiceResponse, ...ErrorResponses },
      },
    },
    async (request) => {
      const businessId = numericId(request.params.id, "business id");
      const { amount, txHash } = request.body;
      const accountId = requireAuth(request).accountId;
      try {
        parseQc(amount);
      } catch {
        fail("amount exceeds the QC maximum");
      }

      const verified = await verifyExpectedFunctionCall(txHash, {
        signerId: accountId,
        method: "pay_service",
        args: { business_id: businessId, amount },
        events: [{ name: "service_paid", entityId: `business:${businessId}` }],
      });
      const businesses = await viewAllBusinesses();
      const business = businesses.find((b) => Number(b.id) === businessId);
      if (!business) fail("business not found on chain", 404);

      const payer = playerWallet(accountId);
      let receipt: { amount: string } | null;
      try {
        receipt = servicePaymentReceipt(verified.events, payer, business.treasury, businessId);
      } catch (error) {
        if (error instanceof ReceiptError) fail(error.message, 409);
        throw error;
      }
      if (!receipt) fail("service payment receipt is missing", 409);
      if (receipt.amount !== amount) fail("request amount does not match the receipt", 409);

      const payerBalance = await readChainBalance(payer);
      const treasuryBalance = await readChainBalance(business.treasury);
      const proof = requireExpectedEvent(verified.events, {
        name: "service_paid",
        entityId: `business:${businessId}`,
      });
      const consumption = consumptionContext(
        txHash,
        "pay_service",
        "business",
        String(businessId),
        accountId,
        proof,
      );
      await db.begin(async (transaction) => {
        await consumeTransaction(transaction, consumption);
        await transaction`update businesses set revenue_total = ${business.revenue_total} where id = ${businessId}`;
        await setMirroredBalance(transaction, payer, payerBalance);
        await setMirroredBalance(transaction, business.treasury, treasuryBalance);
        await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
      });
      return { business, amount: receipt.amount };
    },
  );

  app.post<{ Params: Static<typeof BusinessParams>; Body: Static<typeof TransferBusinessBody> }>(
    "/businesses/:id/transfer",
    {
      schema: {
        params: BusinessParams,
        body: TransferBusinessBody,
        response: { 200: TransferBusinessResponse, ...ErrorResponses },
      },
    },
    async (request) => {
      const businessId = numericId(request.params.id, "business id");
      const { newOwner, txHash } = request.body;
      const accountId = requireAuth(request).accountId;

      const verified = await verifyExpectedFunctionCall(txHash, {
        signerId: accountId,
        method: "transfer_business",
        args: { business_id: businessId, new_owner: newOwner },
        events: [{ name: "business_transferred", entityId: `business:${businessId}` }],
      });
      const businesses = await viewAllBusinesses();
      const business = businesses.find((b) => Number(b.id) === businessId);
      if (!business) fail("business not found on chain", 404);
      if (business.owner !== newOwner) fail("chain transfer not confirmed", 409);

      const proof = requireExpectedEvent(verified.events, {
        name: "business_transferred",
        entityId: `business:${businessId}`,
      });
      const consumption = consumptionContext(
        txHash,
        "transfer_business",
        "business",
        String(businessId),
        accountId,
        proof,
      );
      await db.begin(async (transaction) => {
        await consumeTransaction(transaction, consumption);
        await transaction`update businesses set owner_account = ${newOwner} where id = ${businessId}`;
        await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
        await recordOwnershipHistory(transaction, proof, "business", String(businessId), {
          networkId: config.networkId,
          contractId: config.contractId,
        });
      });
      return { business };
    },
  );
}
