import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "./db.js";
import { viewContract } from "./near.js";
import { creditReward, payJob } from "./operator.js";
import { getMirroredBalance, refreshWallet } from "./sync.js";
import { assertTxSucceeded, parseEvents } from "./verify.js";

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

type ChainBusiness = {
  id: number;
  name: string;
  owner: string;
  property_id: number;
  treasury: string;
  revenue_total: string;
};

const STARTER_ALLOWANCE = 500;
const QUIZ_REWARD = 25;
const QUIZ_PASS_MARK = 6;
const QUIZ_WINDOW_MS = 10 * 60 * 1000;

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

async function recordTx(
  txHash: string,
  from: string,
  to: string,
  amount: number,
  kind: string,
  reference: string | null = null,
): Promise<void> {
  await sql`
    insert into transactions (tx_hash, wallet_from, wallet_to, amount, kind, reference)
    values (${txHash}, ${from}, ${to}, ${amount}, ${kind}, ${reference})
    on conflict do nothing
  `;
}

export function registerRoutes(app: FastifyInstance): void {
  app.get("/players/:account", async (request) => {
    const { account } = request.params as { account: string };
    const [player] =
      await sql`select account_id, username, reputation, created_at from players where account_id = ${account}`;
    if (!player) fail("player not found", 404);
    const [wallet] =
      await sql`select balance, updated_at from wallets where wallet_id = ${playerWallet(account)}`;
    return { ...player, wallet: wallet ?? null };
  });

  app.post("/players/register", async (request) => {
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const txHash = text(body.txHash, "txHash");
    await assertTxSucceeded(txHash, accountId);
    const chainPlayer = await viewContract<ChainPlayer | null>("get_player", { account: accountId });
    if (!chainPlayer) fail("player is not registered on chain", 409);
    await sql`
      insert into players (account_id, username)
      values (${accountId}, ${chainPlayer.username})
      on conflict (account_id) do update set username = excluded.username
    `;
    await refreshWallet(playerWallet(accountId));
    return { accountId, username: chainPlayer.username, starter_claimed: chainPlayer.starter_claimed };
  });

  app.post("/players/claim", async (request) => {
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const txHash = text(body.txHash, "txHash");
    await assertTxSucceeded(txHash, accountId);
    const chainPlayer = await viewContract<ChainPlayer | null>("get_player", { account: accountId });
    if (!chainPlayer?.starter_claimed) fail("starter allowance not confirmed on chain", 409);
    const wallet = playerWallet(accountId);
    const balance = await refreshWallet(wallet, STARTER_ALLOWANCE);
    await recordTx(txHash, "system:mint", wallet, STARTER_ALLOWANCE, "starter_allowance", accountId);
    return { balance };
  });

  app.get("/jobs", async () => sql`select * from jobs order by created_at desc`);

  app.get("/npcs", async () => {
    const npcs = await sql<
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
    const [job] = await sql`
      update jobs set employee_account = ${accountId}, status = 'accepted'
      where id = ${id} and status = 'open'
      returning *
    `;
    if (!job) fail("job is not open", 409);
    return job;
  });

  app.post("/jobs/:id/complete", async (request) => {
    const { id } = request.params as { id: string };
    const accountId = text((request.body as Record<string, unknown>).accountId, "accountId");
    const [job] = await sql`select * from jobs where id = ${id}`;
    if (!job) fail("job not found", 404);
    if (job.status === "paid") return { job, txHash: job.chain_tx };
    if (job.employee_account !== accountId) fail("you did not accept this job", 403);
    if (!["accepted", "completed"].includes(job.status)) fail("job is not in progress", 409);

    const wallet = playerWallet(accountId);
    const previous = await getMirroredBalance(wallet);
    let txHash: string;
    try {
      txHash = await payJob(job.employer_wallet, wallet, Number(job.payment), job.reference);
    } catch {
      fail("NPC budget cannot cover this job right now", 409);
    }
    const balance = await refreshWallet(wallet, previous + Number(job.payment));
    await refreshWallet(job.employer_wallet);
    await recordTx(
      txHash,
      "system:mint",
      playerWallet(accountId),
      Number(job.payment),
      "job_reward",
      job.reference,
    );
    const [updated] = await sql`
      update jobs set status = 'paid', chain_tx = ${txHash}
      where id = ${id} returning *
    `;
    return { job: updated, txHash, balance };
  });

  app.get("/quizzes", async () => {
    return sql`
      select q.id, q.title, q.reward_pool, q.entry_fee, q.status,
             (select count(*)::int from quiz_questions qq where qq.quiz_id = q.id) as questions
      from quizzes q order by q.id
    `;
  });

  app.post("/quizzes/:id/start", async (request) => {
    const { id } = request.params as { id: string };
    const accountId = text((request.body as Record<string, unknown>).accountId, "accountId");
    const [quiz] = await sql`select * from quizzes where id = ${id} and status = 'live'`;
    if (!quiz) fail("quiz is not live", 404);
    const questions = await sql<{ id: string; question: string; options: string[]; category: string }[]>`
      select id, question, options, category from quiz_questions
      where quiz_id = ${id} order by random()
    `;
    if (questions.length === 0) fail("quiz has no questions", 409);
    const attemptId = randomUUID();
    await sql`
      insert into quiz_attempts (id, quiz_id, player_account, total)
      values (${attemptId}, ${id}, ${accountId}, ${questions.length})
    `;
    return {
      attemptId,
      quizId: id,
      questions: questions.map((q) => ({
        id: q.id,
        question: q.question,
        options: q.options,
        category: q.category,
      })),
    };
  });

  app.post("/quizzes/:id/submit", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const attemptId = text(body.attemptId, "attemptId");
    const answers = (body.answers ?? {}) as Record<string, number>;

    const [attempt] = await sql`
      select * from quiz_attempts
      where id = ${attemptId} and quiz_id = ${id} and player_account = ${accountId}
    `;
    if (!attempt) fail("attempt not found", 404);
    if (attempt.completed_at) {
      return {
        score: attempt.score,
        total: attempt.total,
        reward: Number(attempt.reward_paid),
        txHash: attempt.reward_tx,
        alreadySubmitted: true,
      };
    }
    const elapsed = Date.now() - new Date(attempt.started_at as string).getTime();
    if (elapsed > QUIZ_WINDOW_MS) fail("quiz attempt expired", 410);

    const questions = await sql<{ id: string; correct_index: number }[]>`
      select id, correct_index from quiz_questions where quiz_id = ${id}
    `;
    let score = 0;
    for (const question of questions) {
      if (answers[question.id] === question.correct_index) score += 1;
    }

    const [alreadyPaid] = await sql`
      select 1 from quiz_attempts
      where player_account = ${accountId} and reward_paid > 0 and completed_at::date = current_date
      limit 1
    `;
    const reward = score >= QUIZ_PASS_MARK && !alreadyPaid ? QUIZ_REWARD : 0;

    let rewardTx: string | null = null;
    if (reward > 0) {
      const wallet = playerWallet(accountId);
      const previous = await getMirroredBalance(wallet);
      rewardTx = await creditReward(wallet, reward, `quiz:${attemptId}`);
      await refreshWallet(wallet, previous + reward);
      await recordTx(rewardTx, "system:mint", playerWallet(accountId), reward, "quiz_reward", attemptId);
    }

    await sql`
      update quiz_attempts
      set score = ${score}, total = ${questions.length}, reward_paid = ${reward},
          reward_tx = ${rewardTx}, completed_at = now()
      where id = ${attemptId}
    `;
    return { score, total: questions.length, reward, txHash: rewardTx, alreadySubmitted: false };
  });

  app.post("/properties/:id/buy", async (request) => {
    const propertyId = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const txHash = text(body.txHash, "txHash");
    if (!Number.isFinite(propertyId)) fail("invalid property id");

    const outcome = await assertTxSucceeded(txHash, accountId);
    const property = await viewContract<ChainProperty | null>("get_property", { property_id: propertyId });
    if (!property) fail("property not found", 404);
    if (property.owner !== playerWallet(accountId)) fail("chain ownership not confirmed", 409);

    const sale = parseEvents(outcome)
      .filter((event) => event.event === "transfer")
      .flatMap((event) => event.data)
      .find((entry) => entry.kind === "property_sale" && entry.to === playerWallet(accountId));

    const [before] = await sql`select owner_wallet, price from properties where id = ${propertyId}`;
    const seller = typeof sale?.from === "string" ? sale.from : (before?.owner_wallet ?? "unknown");
    const price = sale?.amount !== undefined ? Number(sale.amount) : Number(before?.price ?? 0);

    await sql`
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
    if (price > 0 && seller !== "unknown") {
      await recordTx(txHash, seller, playerWallet(accountId), price, "property_sale", String(propertyId));
      await refreshWallet(playerWallet(accountId));
      await refreshWallet(seller);
    }
    return { property, seller, price };
  });

  app.post("/businesses", async (request) => {
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const propertyId = positive(body.propertyId, "propertyId");
    text(body.name, "name");
    const txHash = text(body.txHash, "txHash");

    await assertTxSucceeded(txHash, accountId);
    const businesses = await viewContract<ChainBusiness[]>("get_businesses");
    const business = businesses.find((b) => b.owner === accountId && Number(b.property_id) === propertyId);
    if (!business) fail("business creation not confirmed on chain", 409);

    await sql`
      insert into businesses (id, name, owner_account, property_id, treasury_wallet, revenue_total)
      values (${business.id}, ${business.name}, ${business.owner}, ${business.property_id},
              ${business.treasury}, ${business.revenue_total})
      on conflict (id) do update set
        name = excluded.name,
        owner_account = excluded.owner_account,
        treasury_wallet = excluded.treasury_wallet,
        revenue_total = excluded.revenue_total
    `;
    await refreshWallet(business.treasury);
    await recordTx(
      txHash,
      playerWallet(accountId),
      "system:burn",
      100,
      "business_permit",
      String(business.id),
    );
    return business;
  });

  app.post("/businesses/:id/pay", async (request) => {
    const businessId = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const amount = positive(body.amount, "amount");
    const txHash = text(body.txHash, "txHash");

    const outcome = await assertTxSucceeded(txHash, accountId);
    const businesses = await viewContract<ChainBusiness[]>("get_businesses");
    const business = businesses.find((b) => Number(b.id) === businessId);
    if (!business) fail("business not found on chain", 404);

    const payment = parseEvents(outcome)
      .filter((event) => event.event === "transfer")
      .flatMap((event) => event.data)
      .find((entry) => entry.kind === "service_payment" && entry.from === playerWallet(accountId));
    const actualAmount = payment?.amount !== undefined ? Number(payment.amount) : amount;

    await sql`update businesses set revenue_total = ${business.revenue_total} where id = ${businessId}`;
    const previous = await getMirroredBalance(business.treasury);
    await refreshWallet(business.treasury, previous + actualAmount);
    await recordTx(
      txHash,
      playerWallet(accountId),
      business.treasury,
      actualAmount,
      "service_payment",
      String(businessId),
    );
    return { business, amount: actualAmount };
  });

  app.post("/businesses/:id/transfer", async (request) => {
    const businessId = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;
    const accountId = text(body.accountId, "accountId");
    const newOwner = text(body.newOwner, "newOwner");
    const txHash = text(body.txHash, "txHash");

    await assertTxSucceeded(txHash, accountId);
    const businesses = await viewContract<ChainBusiness[]>("get_businesses");
    const business = businesses.find((b) => Number(b.id) === businessId);
    if (!business) fail("business not found on chain", 404);
    if (business.owner !== newOwner) fail("chain transfer not confirmed", 409);

    await sql`update businesses set owner_account = ${newOwner} where id = ${businessId}`;
    await recordTx(
      txHash,
      playerWallet(accountId),
      playerWallet(newOwner),
      0,
      "business_transfer",
      String(businessId),
    );
    return { business };
  });
}
