import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { config } from "./runtime-config.js";
import { sql } from "./db.js";
import { viewAllBusinesses, viewContract } from "./near.js";
import { creditReward, payJob, type OperatorResult } from "./operator.js";
import { jobPaymentReference, reserveJobPayment, safeErrorMessage } from "./jobs.js";
import { getMirroredBalance, readChainBalance, setMirroredBalance } from "./sync.js";
import { propertySaleFromReceipts, ReceiptError, servicePaymentReceipt } from "./event-ledger.js";
import type { ValidatedEvent } from "./event-validation.js";
import { ledgerEntriesFromEvents } from "./record-chain-events.js";
import { insertLedgerEntries } from "./ledger.js";
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

const STARTER_ALLOWANCE = 500;

function fail(message: string, status = 400): never {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = status;
  throw error;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  return value.trim();
}

function positive(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${name} must be a positive number`);
  return Math.floor(parsed);
}

function playerWallet(accountId: string): string {
  return `player:${accountId}`;
}

function rewardDayOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function attemptResult(attempt: Record<string, unknown>, alreadySubmitted: boolean) {
  return {
    score: Number(attempt.score),
    total: Number(attempt.total),
    reward: Number(attempt.reward_paid),
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

  function jobPaymentExpectation(job: Record<string, unknown>) {
    const employeeWallet = playerWallet(String(job.employee_account));
    const reference = String(job.payment_reference ?? jobPaymentReference(String(job.id)));
    return {
      employeeWallet,
      reference,
      expectation: {
        signerId: config.operatorAccount,
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

  async function finalizeJobPayment(job: Record<string, unknown>, txHash: string, events: ValidatedEvent[]) {
    const { employeeWallet } = jobPaymentExpectation(job);
    const employerWallet = String(job.employer_wallet);
    const employeeBalance = await readChainBalance(employeeWallet);
    const employerBalance = await readChainBalance(employerWallet);
    const updated = await db.begin(async (transaction) => {
      await setMirroredBalance(transaction, employeeWallet, employeeBalance);
      await setMirroredBalance(transaction, employerWallet, employerBalance);
      await insertLedgerEntries(transaction, ledgerEntriesFromEvents(events));
      const [finalized] = await transaction`
        update jobs
        set status = 'paid', chain_tx = ${txHash}, paid_at = now(), last_error = null
        where id = ${String(job.id)} and status in ('payment_pending', 'payment_failed')
        returning *
      `;
      if (finalized) return finalized;
      const [current] = await transaction`
        select * from jobs where id = ${String(job.id)}
      `;
      if (current?.status === "paid" && current.chain_tx === txHash) return current;
      throw new Error("job payment state changed before finalization");
    });
    return { job: updated, balance: employeeBalance };
  }
  app.get("/players/:account", async (request) => {
    const { account } = request.params as { account: string };
    const [player] =
      await db`select account_id, username, reputation, created_at from players where account_id = ${account}`;
    if (!player) fail("player not found", 404);
    const [wallet] =
      await db`select balance, updated_at from wallets where wallet_id = ${playerWallet(account)}`;
    return { ...player, wallet: wallet ?? null };
  });

  app.post("/players/register", async (request) => {
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const txHash = text(body.txHash, "txHash");
    const username = text(body.username, "username");

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
    await db.begin(async (transaction) => {
      await transaction`
        insert into players (account_id, username)
        values (${accountId}, ${chainPlayer.username})
        on conflict (account_id) do update set username = excluded.username
      `;
      await setMirroredBalance(transaction, wallet, balance);
      await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
    });
    return { accountId, username: chainPlayer.username, starter_claimed: chainPlayer.starter_claimed };
  });

  app.post("/players/claim", async (request) => {
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const txHash = text(body.txHash, "txHash");
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
    await db.begin(async (transaction) => {
      await setMirroredBalance(transaction, wallet, balance);
      await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
    });
    return { balance };
  });

  app.get("/jobs", async () => db`select * from jobs order by created_at desc`);

  app.get("/npcs", async () => {
    const npcs = await db<
      {
        npc_id: string;
        wallet_id: string;
        archetype: string;
        budget: string;
        state: unknown;
        last_tick_at: string | null;
      }[]
    >`
      select npc_id, wallet_id, archetype, budget, state, last_tick_at from npc_state order by npc_id
    `;
    return Promise.all(
      npcs.map(async (npc) => ({
        ...npc,
        chain_balance: await viewContract<string>("get_balance", { wallet: npc.wallet_id }),
      })),
    );
  });

  app.post("/jobs/:id/accept", async (request) => {
    const { id } = request.params as { id: string };
    const accountId = text((request.body as Record<string, unknown>).accountId, "accountId");
    const [job] = await db`
      update jobs set employee_account = ${accountId}, status = 'accepted', accepted_at = now()
      where id = ${id} and status = 'open'
      returning *
    `;
    if (!job) fail("job is not open", 409);
    return job;
  });

  app.post("/jobs/:id/submit", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const deliverable = text(body.deliverable, "deliverable");
    const [job] = await db`
      update jobs
      set status = 'submitted', deliverable = ${deliverable}, submitted_at = now()
      where id = ${id} and status = 'accepted' and employee_account = ${accountId}
      returning *
    `;
    if (!job) fail("job is not ready to submit", 409);
    return job;
  });

  app.post("/jobs/:id/verify", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const notes = typeof body.notes === "string" ? body.notes.slice(0, 500) : null;
    const [job] = await db`
      update jobs
      set status = 'verified', verification_notes = ${notes}, verified_at = now()
      where id = ${id} and status = 'submitted'
      returning *
    `;
    if (!job) fail("job is not awaiting verification", 409);
    return job;
  });

  app.post("/jobs/:id/complete", async (request) => {
    const { id } = request.params as { id: string };
    const accountId = text((request.body as Record<string, unknown>).accountId, "accountId");
    const [job] = await db`select * from jobs where id = ${id}`;
    if (!job) fail("job not found", 404);
    if (job.employee_account !== accountId) fail("you did not accept this job", 403);
    if (job.status === "paid") return { job, txHash: job.chain_tx, alreadyPaid: true };
    if (job.status === "payment_pending") {
      return { job, txHash: null, paymentPending: true };
    }
    if (job.status === "payment_failed") {
      fail("job payment previously failed; reconcile before retrying", 409);
    }
    if (job.status !== "verified") fail("job must be verified before payment", 409);

    const reserved = await reserveJobPayment(db, id);
    if (!reserved) {
      const [current] = await db`select * from jobs where id = ${id}`;
      if (current?.status === "paid") {
        return { job: current, txHash: current.chain_tx, alreadyPaid: true };
      }
      return { job: current, txHash: null, paymentPending: true };
    }

    const { employeeWallet, reference, expectation } = jobPaymentExpectation(reserved);
    let result: OperatorResult;
    try {
      result = await payJob(
        String(reserved.employer_wallet),
        employeeWallet,
        Number(reserved.payment),
        reference,
      );
    } catch (error) {
      await db`
        update jobs set status = 'payment_failed', last_error = ${safeErrorMessage(error)}
        where id = ${id} and status = 'payment_pending'
      `;
      fail("NPC budget cannot cover this job right now", 409);
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
      const finalized = await finalizeJobPayment(reserved, result.txHash, verified.events);
      return { job: finalized.job, txHash: result.txHash, balance: finalized.balance };
    } catch (error) {
      await db`
        update jobs
        set status = 'payment_failed', chain_tx = ${result.txHash}, last_error = ${safeErrorMessage(error)}
        where id = ${id} and status = 'payment_pending'
      `;
      fail("job payment could not be finalized", 502);
    }
  });

  app.post("/jobs/:id/retry-payment", async (request) => {
    const { id } = request.params as { id: string };
    const [job] = await db`select * from jobs where id = ${id}`;
    if (!job) fail("job not found", 404);
    if (job.status === "paid") return { job, reconciled: true, alreadyPaid: true };
    if (!["payment_failed", "payment_pending"].includes(String(job.status))) {
      fail("job is not awaiting payment reconciliation", 409);
    }

    const { reference, expectation } = jobPaymentExpectation(job);
    const [ledgerEvent] = await db`
      select tx_hash from transactions
      where reference = ${reference} and event_name = 'job_reward'
      order by seq desc limit 1
    `;
    const txHash = (job.chain_tx as string | null) ?? (ledgerEvent?.tx_hash as string | null) ?? null;

    if (txHash) {
      try {
        const verified = await verifyExpectedFunctionCall(txHash, expectation);
        const finalized = await finalizeJobPayment(job, txHash, verified.events);
        return { job: finalized.job, reconciled: true };
      } catch (error) {
        await db`
          update jobs set last_error = ${safeErrorMessage(error)}
          where id = ${id} and status = 'payment_failed'
        `;
        fail("job payment reconciliation could not verify the chain event", 502);
      }
    }

    const processed = await viewContract<boolean>("is_reference_processed", { reference });
    if (processed) {
      await db`
        update jobs
        set last_error = ${"reference processed but transaction outcome is unavailable"}
        where id = ${id} and status = 'payment_failed'
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
          payment_reference = coalesce(payment_reference, ${jobPaymentReference(id)})
      where id = ${id} and status = 'payment_failed'
      returning *
    `;
    return { job: reset, retryAllowed: true };
  });

  app.get("/quizzes", async () => {
    return db`
      select q.id, q.title, q.reward_pool, q.entry_fee, q.status,
             (select count(*)::int from quiz_questions qq where qq.quiz_id = q.id) as questions
      from quizzes q order by q.id
    `;
  });

  app.post("/quizzes/:id/start", async (request) => {
    const { id } = request.params as { id: string };
    const accountId = text((request.body as Record<string, unknown>).accountId, "accountId");
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
  });

  app.post("/quizzes/:id/submit", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const attemptId = text(body.attemptId, "attemptId");
    const answers = (body.answers ?? {}) as Record<string, number>;

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
    const rewardAmount = Number(attempt.reward_amount);
    const rewardCandidate = score >= Number(attempt.pass_score) && rewardAmount > 0;
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
        ownsReward = true;
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
        reward: 0,
        txHash: null,
        alreadySubmitted: false,
        status: "submitted",
      };
    }

    const wallet = playerWallet(accountId);
    const previous = await getMirroredBalance(wallet);
    try {
      const result = await creditReward(wallet, rewardAmount, `quiz:${attemptId}`);
      // Persist the hash immediately; local finalization may fail afterward.
      await db`update quiz_attempts set reward_tx = ${result.txHash} where id = ${attemptId}`;
      const verified = await verifyOperatorOutcome(result.outcome, result.txHash, {
        signerId: config.operatorAccount,
        method: "credit_reward",
        args: { wallet, amount: String(rewardAmount), reference: `quiz:${attemptId}` },
        events: [
          {
            name: "reward_issued",
            entityId: wallet,
            walletFrom: null,
            walletTo: wallet,
            amount: String(rewardAmount),
            reference: `quiz:${attemptId}`,
          },
        ],
      });
      const balance = await readChainBalance(wallet, previous + rewardAmount);
      await db.begin(async (transaction) => {
        await setMirroredBalance(transaction, wallet, balance);
        await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
        await transaction`
          update quiz_reward_claims set status = 'paid', paid_at = now()
          where attempt_id = ${attemptId}
        `;
        await transaction`
          update quiz_attempts
          set status = 'rewarded', reward_paid = ${rewardAmount}, reward_tx = ${result.txHash},
              rewarded_at = now(), last_error = null
          where id = ${attemptId}
        `;
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
      await db.begin(async (transaction) => {
        await transaction`update quiz_reward_claims set status = 'failed' where attempt_id = ${attemptId}`;
        await transaction`
          update quiz_attempts set status = 'failed', last_error = ${message} where id = ${attemptId}
        `;
      });
      fail("quiz reward payment failed", 502);
    }
  });

  app.post("/properties/:id/buy", async (request) => {
    const propertyId = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const txHash = text(body.txHash, "txHash");
    if (!Number.isFinite(propertyId)) fail("invalid property id");

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
    let price: number;
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
    await db.begin(async (transaction) => {
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
    });
    return { property, seller, price };
  });

  app.post("/businesses", async (request) => {
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const propertyId = positive(body.propertyId, "propertyId");
    const name = text(body.name, "name");
    const txHash = text(body.txHash, "txHash");

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
    await db.begin(async (transaction) => {
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
  });

  app.post("/businesses/:id/pay", async (request) => {
    const businessId = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const amount = positive(body.amount, "amount");
    const txHash = text(body.txHash, "txHash");

    const verified = await verifyExpectedFunctionCall(txHash, {
      signerId: accountId,
      method: "pay_service",
      args: { business_id: businessId, amount: String(amount) },
      events: [{ name: "service_paid", entityId: `business:${businessId}` }],
    });
    const businesses = await viewAllBusinesses();
    const business = businesses.find((b) => Number(b.id) === businessId);
    if (!business) fail("business not found on chain", 404);

    const payer = playerWallet(accountId);
    let receipt: { amount: number } | null;
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
    await db.begin(async (transaction) => {
      await transaction`update businesses set revenue_total = ${business.revenue_total} where id = ${businessId}`;
      await setMirroredBalance(transaction, payer, payerBalance);
      await setMirroredBalance(transaction, business.treasury, treasuryBalance);
      await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
    });
    return { business, amount: receipt.amount };
  });

  app.post("/businesses/:id/transfer", async (request) => {
    const businessId = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const newOwner = text(body.newOwner, "newOwner");
    const txHash = text(body.txHash, "txHash");

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

    await db.begin(async (transaction) => {
      await transaction`update businesses set owner_account = ${newOwner} where id = ${businessId}`;
      await insertLedgerEntries(transaction, ledgerEntriesFromEvents(verified.events));
    });
    return { business };
  });
}
