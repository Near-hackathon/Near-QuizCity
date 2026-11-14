import assert from "node:assert/strict";
import test, { after } from "node:test";
import { api, startStack } from "./harness.js";

const stack = await startStack();
after(async () => {
  await stack.stop();
});

test("local sandbox economic loop is exact, idempotent, and reconciled", async () => {
  const { alice, bob, db } = stack;

  const aliceAuth = await stack.login(alice);
  const bobAuth = await stack.login(bob);
  const eventCounts = async () =>
    Object.fromEntries(
      (
        await db`
          select event_name, count(*)::int as count
          from transactions group by event_name
        `
      ).map((row) => [row.event_name, row.count]),
    );

  // Registration and starter allowance.
  const registerTx = await stack.contractCall(alice, "register_player", { username: "alice" });
  const registered = await api(stack, "/v1/players/register", {
    body: { username: "alice", txHash: registerTx },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));

  const bobRegisterTx = await stack.contractCall(bob, "register_player", { username: "bob" });
  const bobRegistered = await api(stack, "/v1/players/register", {
    body: { username: "bob", txHash: bobRegisterTx },
    cookie: bobAuth.cookie,
    csrf: bobAuth.csrf,
  });
  assert.equal(bobRegistered.status, 200, JSON.stringify(bobRegistered.body));

  const claimTx = await stack.contractCall(alice, "claim_starter");
  const claimed = await api(stack, "/v1/players/claim", {
    body: { txHash: claimTx },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.balance, "500");
  const starterCount = (await eventCounts()).starter_allowance;
  const replayClaim = await api(stack, "/v1/players/claim", {
    body: { txHash: claimTx },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(replayClaim.status, 200, JSON.stringify(replayClaim.body));
  assert.equal((await eventCounts()).starter_allowance, starterCount);

  const bobClaimTx = await stack.contractCall(bob, "claim_starter");
  const bobClaimed = await api(stack, "/v1/players/claim", {
    body: { txHash: bobClaimTx },
    cookie: bobAuth.cookie,
    csrf: bobAuth.csrf,
  });
  assert.equal(bobClaimed.status, 200, JSON.stringify(bobClaimed.body));
  const bobReplayClaim = await api(stack, "/v1/players/claim", {
    body: { txHash: bobClaimTx },
    cookie: bobAuth.cookie,
    csrf: bobAuth.csrf,
  });
  assert.equal(bobReplayClaim.status, 200, JSON.stringify(bobReplayClaim.body));
  assert.equal((await eventCounts()).starter_allowance, starterCount + 1);

  // Property purchase.
  const buyTx = await stack.contractCall(alice, "buy_property", { property_id: 1 });
  const bought = await api(stack, "/v1/properties/1/buy", {
    body: { txHash: buyTx },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  const [property] = await db`
    select owner_wallet, transfer_count, active from properties where id = 1
  `;
  assert.deepEqual(property, {
    owner_wallet: `player:${alice.accountId}`,
    transfer_count: "1",
    active: true,
  });
  assert.equal(
    await stack.readContract<string>("get_balance", { wallet: `player:${alice.accountId}` }),
    "200",
  );

  // Business creation and permit burn.
  const businessTx = await stack.contractCall(alice, "create_business", {
    property_id: 1,
    name: "E2E Cafe",
  });
  const created = await api(stack, "/v1/businesses", {
    body: { propertyId: 1, name: "E2E Cafe", txHash: businessTx },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const [business] = await db`
    select owner_account, name, treasury_wallet, property_id, active from businesses where id = 1
  `;
  assert.deepEqual(business, {
    owner_account: alice.accountId,
    name: "E2E Cafe",
    treasury_wallet: "biz:1",
    property_id: "1",
    active: true,
  });
  assert.equal(
    await stack.readContract<string>("get_balance", { wallet: `player:${alice.accountId}` }),
    "100",
  );
  const businessCount = (await eventCounts()).business_created;
  const replayBusiness = await api(stack, "/v1/businesses", {
    body: { propertyId: 1, name: "E2E Cafe", txHash: businessTx },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(replayBusiness.status, 200, JSON.stringify(replayBusiness.body));
  assert.equal((await eventCounts()).business_created, businessCount);

  // Server-priced item, fixed order and one idempotent on-chain checkout.
  const stocked = await api(stack, "/v1/businesses/1/catalogue", {
    body: { sku: "city-guide", name: "City guide", unitPrice: "20", quantity: 3 },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(stocked.status, 200, JSON.stringify(stocked.body));
  const reserved = await api(stack, "/v1/orders", {
    body: { itemId: stocked.body.id, quantity: 1 },
    cookie: bobAuth.cookie,
    csrf: bobAuth.csrf,
  });
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body));
  const order = reserved.body.order;
  const serviceTx = await stack.contractCall(bob, "pay_order", {
    business_id: 1,
    amount: order.total,
    reference: order.reference,
  });
  const paid = await api(stack, `/v1/orders/${order.id}/confirm`, {
    body: { txHash: serviceTx },
    cookie: bobAuth.cookie,
    csrf: bobAuth.csrf,
  });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const [treasury] = await db`
    select revenue_total, treasury_wallet from businesses where id = 1
  `;
  assert.equal(String(treasury.revenue_total), "20");
  assert.equal(await stack.readContract<string>("get_balance", { wallet: `player:${bob.accountId}` }), "480");
  const serviceCount = (await eventCounts()).service_paid;
  const replayService = await api(stack, `/v1/orders/${order.id}/confirm`, {
    body: { txHash: serviceTx },
    cookie: bobAuth.cookie,
    csrf: bobAuth.csrf,
  });
  assert.equal(replayService.status, 200, JSON.stringify(replayService.body));
  assert.equal((await eventCounts()).service_paid, serviceCount);
  assert.equal((await db`select on_hand from business_items where id=${stocked.body.id}`)[0].on_hand, 2);
  assert.equal((await db`select count(*)::int as n from stock_movements where order_id=${order.id}`)[0].n, 1);
  assert.equal(
    await stack.readContract<boolean>("is_reference_processed", { reference: order.reference }),
    true,
  );
  assert.equal(String((await db`select revenue_total from businesses where id = 1`)[0].revenue_total), "20");

  // Business transfer.
  const transferTx = await stack.contractCall(alice, "transfer_business", {
    business_id: 1,
    new_owner: bob.accountId,
  });
  const transferred = await api(stack, "/v1/businesses/1/transfer", {
    body: { newOwner: bob.accountId, txHash: transferTx },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(transferred.status, 200, JSON.stringify(transferred.body));
  const [transferredBusiness] = await db`
    select owner_account from businesses where id = 1
  `;
  assert.equal(transferredBusiness.owner_account, bob.accountId);
  assert.equal(
    (await stack.readContract<{ owner: string }>("get_business", { business_id: 1 })).owner,
    bob.accountId,
  );
  const transferCount = (await eventCounts()).business_transferred;
  const replayTransfer = await api(stack, "/v1/businesses/1/transfer", {
    body: { newOwner: bob.accountId, txHash: transferTx },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(replayTransfer.status, 200, JSON.stringify(replayTransfer.body));
  assert.equal((await eventCounts()).business_transferred, transferCount);
  assert.equal((await db`select owner_account from businesses where id = 1`)[0].owner_account, bob.accountId);

  // Owner withdrawal stays in the phone and preserves cumulative gross sales.
  const withdrawalTx = await stack.contractCall(bob, "business_withdraw", {
    business_id: 1,
    amount: "5",
  });
  const withdrawn = await api(stack, "/v1/businesses/1/withdraw", {
    body: { amount: "5", txHash: withdrawalTx },
    cookie: bobAuth.cookie,
    csrf: bobAuth.csrf,
  });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  const { verifyExpectedFunctionCall } = await import("../../src/verify.js");
  const { ledgerEntryFromEvent, insertLedgerEntries } = await import("../../src/ledger.js");
  const { applyMirrorEvent } = await import("../../src/chain-ingester.js");
  const verifiedWithdrawal = await verifyExpectedFunctionCall(withdrawalTx, {
    signerId: bob.accountId,
    method: "business_withdraw",
    args: { business_id: 1, amount: "5" },
    events: [
      {
        name: "business_withdrawal",
        entityId: "business:1",
        walletFrom: "biz:1",
        walletTo: `player:${bob.accountId}`,
        amount: "5",
      },
    ],
  });
  const runtime = { networkId: "testnet", contractId: stack.contractId };
  const ingestWithdrawal = async () => {
    let inserted = 0;
    let replayed = 0;
    await db.begin(async (transaction) => {
      for (const event of verifiedWithdrawal.events) {
        const entry = ledgerEntryFromEvent(event, runtime);
        assert.ok(entry);
        const result = await insertLedgerEntries(transaction, [entry]);
        inserted += result.inserted;
        replayed += result.replayed;
        if (result.inserted === 1) await applyMirrorEvent(transaction, event, runtime);
      }
    });
    return { inserted, replayed };
  };
  assert.deepEqual(await ingestWithdrawal(), { inserted: 0, replayed: 1 });
  assert.equal(await stack.readContract<string>("get_balance", { wallet: `player:${bob.accountId}` }), "485");
  assert.equal(await stack.readContract<string>("get_balance", { wallet: "biz:1" }), "15");
  const [withdrawnBusiness] = await db`select revenue_total from businesses where id = 1`;
  assert.equal(String(withdrawnBusiness.revenue_total), "20");
  assert.deepEqual(await ingestWithdrawal(), { inserted: 0, replayed: 1 });
  assert.equal(String((await db`select revenue_total from businesses where id = 1`)[0].revenue_total), "20");

  // Verified job paid by the server operator key.
  await db`
    insert into jobs (
      id, employer_wallet, employee_account, title, description, payment, status,
      reference, payment_reference, payment_attempts
    ) values (
      'job-1', 'npc:professor-kofi', ${alice.accountId}, 'E2E job', 'ship it', '100',
      'open', 'job:job-1', 'job:job-1', 0
    )
  `;
  const { attachResearchTask } = await import("../../src/research-tasks.js");
  await db.begin((tx) => attachResearchTask(tx, "job-1"));
  const acceptedJob = await api(stack, "/v1/jobs/job-1/accept", {
    body: {},
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(acceptedJob.status, 200);
  const research = await api(stack, "/v1/jobs/job-1/task", { cookie: aliceAuth.cookie });
  assert.equal(research.status, 200);
  assert.ok(research.body.questions.every((q: Record<string, unknown>) => !("correct" in q)));
  const delivered = await api(stack, "/v1/jobs/job-1/task", {
    body: {
      answers: { infrastructure: 0, intents: 1, ownership: 2 },
      summary:
        "NEAR provides blockchain applications and cross-chain execution. Private keys must stay private.",
    },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.job.status, "verified");
  const jobResult = await api(stack, "/v1/jobs/job-1/complete", {
    body: {},
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(jobResult.status, 200, JSON.stringify(jobResult.body));
  const [job] = await db`
    select status, chain_tx, payment_reference from jobs where id = 'job-1'
  `;
  assert.equal(job.status, "paid");
  assert.ok(job.chain_tx);
  assert.equal(job.payment_reference, "job:job-1");
  const [jobAttempt] = await db`
    select state, tx_hash from job_payment_attempts where job_id = 'job-1'
  `;
  assert.equal(jobAttempt.state, "confirmed");
  assert.equal(jobAttempt.tx_hash, job.chain_tx);
  assert.equal(
    await stack.readContract<string>("get_balance", { wallet: `player:${alice.accountId}` }),
    "200",
  );
  assert.equal(await stack.readContract<string>("get_balance", { wallet: "npc:professor-kofi" }), "9900");

  // Quiz reward.
  await db`
    insert into quizzes (
      id, title, status, question_count, pass_score, reward_amount,
      attempt_duration_seconds, daily_limit, reward_pool, reward_reserved, reward_paid
    ) values ('quiz-1', 'E2E Quiz', 'live', 2, 1, '25', 600, 1, '25', '0', '0')
  `;
  await db`
    insert into quiz_questions (id, quiz_id, category, difficulty, question, options, correct_index)
    values
      ('q1', 'quiz-1', 'general', 'easy', 'One?', ${db.json(["A", "B"])}, 0),
      ('q2', 'quiz-1', 'general', 'easy', 'Two?', ${db.json(["A", "B"])}, 0)
  `;
  const started = await api(stack, "/v1/quizzes/quiz-1/start", {
    body: {},
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const attemptId = started.body.attemptId as string;
  const answers = Object.fromEntries(
    (started.body.questions as { id: string }[]).map((question) => [question.id, 0]),
  );
  const submitted = await api(stack, "/v1/quizzes/quiz-1/submit", {
    body: { attemptId, answers },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.status, "rewarded");
  assert.equal(submitted.body.reward, "25");
  assert.equal(
    await stack.readContract<string>("get_balance", { wallet: `player:${alice.accountId}` }),
    "225",
  );
  const [quiz] = await db`select reward_reserved, reward_paid from quizzes where id = 'quiz-1'`;
  assert.equal(String(quiz.reward_reserved), "0");
  assert.equal(String(quiz.reward_paid), "25");
  const [claim] = await db`select status from quiz_reward_claims where attempt_id = ${attemptId}`;
  assert.equal(claim.status, "paid");

  // Ledger identity and directions.
  const [ledger] = await db`
    select
      count(*) filter (where event_name = 'starter_allowance')::int as starters,
      count(*) filter (where event_name = 'property_transferred')::int as property_transfers,
      count(*) filter (where event_name = 'permit_burn')::int as permits,
      count(*) filter (where event_name = 'service_paid')::int as services,
      count(*) filter (where event_name = 'business_transferred')::int as business_transfers,
      count(*) filter (where event_name = 'business_withdrawal')::int as business_withdrawals,
      count(*) filter (where event_name = 'job_reward')::int as job_rewards,
      count(*) filter (where event_name = 'reward_issued')::int as quiz_rewards
    from transactions
  `;
  assert.deepEqual(ledger, {
    starters: 2,
    property_transfers: 1,
    permits: 1,
    services: 1,
    business_transfers: 1,
    business_withdrawals: 1,
    job_rewards: 1,
    quiz_rewards: 1,
  });
  const [jobLedger] = await db`
    select wallet_from, wallet_to, amount, reference, receipt_id, event_index
    from transactions where event_name = 'job_reward'
  `;
  assert.equal(jobLedger.wallet_from, "npc:professor-kofi");
  assert.equal(jobLedger.wallet_to, `player:${alice.accountId}`);
  assert.equal(String(jobLedger.amount), "100");
  assert.equal(jobLedger.reference, "job:job-1");

  // Exact replays change nothing.
  const replayRegister = await api(stack, "/v1/players/register", {
    body: { username: "alice", txHash: registerTx },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(replayRegister.status, 200, JSON.stringify(replayRegister.body));
  const replayBuy = await api(stack, "/v1/properties/1/buy", {
    body: { txHash: buyTx },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(replayBuy.status, 200, JSON.stringify(replayBuy.body));
  const replayJob = await api(stack, "/v1/jobs/job-1/complete", {
    body: {},
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(replayJob.status, 200, JSON.stringify(replayJob.body));
  assert.equal(replayJob.body.alreadyPaid, true);
  const replayQuiz = await api(stack, "/v1/quizzes/quiz-1/submit", {
    body: { attemptId, answers },
    cookie: aliceAuth.cookie,
    csrf: aliceAuth.csrf,
  });
  assert.equal(replayQuiz.status, 200, JSON.stringify(replayQuiz.body));
  assert.equal(replayQuiz.body.reward, "25");

  const [afterReplayLedger] = await db`
    select
      count(*) filter (where event_name = 'starter_allowance')::int as starters,
      count(*) filter (where event_name = 'job_reward')::int as job_rewards,
      count(*) filter (where event_name = 'reward_issued')::int as quiz_rewards
    from transactions
  `;
  assert.deepEqual(afterReplayLedger, { starters: 2, job_rewards: 1, quiz_rewards: 1 });

  // Supply and mirror agree exactly.
  const stats = await stack.readContract<{
    total_issued: string;
    total_burned: string;
    tx_count: number;
  }>("get_stats");
  const canonical = BigInt(stats.total_issued) - BigInt(stats.total_burned);
  const [mirror] = await db`select coalesce(sum(balance), 0)::text as total from wallets`;
  assert.equal(String(stats.total_issued), "11025");
  assert.equal(String(stats.total_burned), "100");
  assert.equal(canonical.toString(), "10925");
  assert.equal(mirror.total, "10925");

  const economy = await api(stack, "/v1/economy");
  assert.equal(economy.status, 200, JSON.stringify(economy.body));
  assert.equal(economy.body.circulating_qc, "10925");
  assert.equal(economy.body.mirrored_wallet_sum, "10925");
  assert.equal(economy.body.supply_difference, "0");

  const [unresolvedJobs] = await db`
    select count(*)::int as count from jobs
    where status in ('payment_unknown', 'payment_failed')
  `;
  const [unresolvedQuiz] = await db`
    select count(*)::int as count from quiz_attempts
    where reward_state in ('pending', 'unknown', 'failed')
  `;
  assert.equal(unresolvedJobs.count, 0);
  assert.equal(unresolvedQuiz.count, 0);
});
