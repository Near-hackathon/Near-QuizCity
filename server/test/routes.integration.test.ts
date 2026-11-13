import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { Sql } from "postgres";
import { insertLedgerEntries } from "../src/ledger.js";
import { registerErrorHandler } from "../src/errors.js";
import { ajvOptions } from "../src/fastify-options.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { startQuizAttempt } from "../src/quiz.js";
import { setMirroredBalance } from "../src/sync.js";
import { ExpectedCallError } from "../src/verify.js";
import { testEnv } from "./fixtures.js";
import { withTestSchema } from "./db-test-utils.js";

Object.assign(process.env, testEnv);
const { registerRoutes } = await import("../src/routes.js");
type RouteDeps = import("../src/routes.js").RouteDeps;

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));

function event(name: string, data: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    standard: "quizcity",
    version: "1.0.0",
    event: name,
    data: [
      {
        seq: 1,
        reference: null,
        entity_id: "wallet",
        amount: "0",
        ...(name === "property_created"
          ? { kind: "plot", district: "knowledge", x: 1, y: 1 }
          : name === "business_created"
            ? { name: "Cafe" }
            : {}),
        ...data,
      },
    ],
    receiptId: `receipt-${name}`,
    eventIndex: 0,
    blockHeight: "10",
    blockHash: "block-hash",
    txHash: "tx-hash",
    chainTimestamp: "2026-11-12T00:00:00.000Z",
    ...overrides,
  } as never;
}

function deps(db: Sql, overrides: Partial<RouteDeps> = {}): RouteDeps {
  return {
    db,
    viewContract: async () => null,
    viewAllBusinesses: async () => [],
    creditReward: async () => ({ kind: "confirmed", txHash: "reward-tx", outcome: {} }),
    payJob: async () => ({ kind: "confirmed", txHash: "job-tx", outcome: {} }),
    readChainBalance: async () => "0",
    setMirroredBalance,
    getMirroredBalance: async () => "0",
    verifyExpectedFunctionCall: async () => ({ txHash: "tx-hash", outcome: {}, events: [] }),
    verifyOperatorOutcome: async () => ({ txHash: "tx-hash", outcome: {}, events: [] }),
    insertLedgerEntries,
    ...overrides,
  };
}

async function buildApp(
  db: Sql,
  overrides: Partial<RouteDeps> = {},
  roles = ["player", "operator", "admin"],
) {
  const app = Fastify({
    genReqId: () => `req-test-${Math.random().toString(16).slice(2)}`,
    ajv: { customOptions: ajvOptions },
  });
  app.decorateRequest("auth", null);
  app.addHook("preValidation", async (request) => {
    request.auth = {
      accountId: "alice.testnet",
      roles,
      sessionTokenHash: "test-session",
      csrfHash: "test-csrf",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  });
  registerErrorHandler(app);
  await app.register(async (v1) => registerRoutes(v1, deps(db, overrides)), { prefix: "/v1" });
  await app.ready();
  return app;
}

async function migrated(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

test("registration records only the expected player_registered event", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    const app = await buildApp(sql, {
      viewContract: async (method) =>
        method === "get_player"
          ? ({ username: "alice", created_at: 0, starter_claimed: false } as never)
          : (null as never),
      readChainBalance: async () => "0",
      verifyExpectedFunctionCall: async () => ({
        txHash: "tx-hash",
        outcome: {},
        events: [
          event("player_registered", {
            seq: 1,
            wallet_from: null,
            wallet_to: null,
            amount: "0",
            reference: "player:alice.testnet",
            entity_id: "player:alice.testnet",
            account: "alice.testnet",
            username: "alice",
            owner_wallet: "player:alice.testnet",
          }),
        ],
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/players/register",
      payload: { username: "alice", txHash: "x".repeat(44) },
    });
    assert.equal(response.statusCode, 200, response.body);
    const [player] = await sql`select username from players`;
    assert.equal(player.username, "alice");
    const ledger = await sql`select event_name from transactions`;
    assert.deepEqual(
      [...ledger].map((row) => row.event_name),
      ["player_registered"],
    );
    await app.close();
  });
});

test("starter claim records exactly one issuance event", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    const wallet = "player:alice.testnet";
    const starter = event("starter_allowance", {
      seq: 1,
      wallet_from: null,
      wallet_to: wallet,
      amount: "500",
      reference: "starter:alice.testnet",
      entity_id: wallet,
      account: "alice.testnet",
    });
    const app = await buildApp(sql, {
      viewContract: async () => ({ username: "alice", starter_claimed: true }) as never,
      readChainBalance: async () => "500",
      verifyExpectedFunctionCall: async () => ({ txHash: "tx-hash", outcome: {}, events: [starter] }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/players/claim",
      payload: { txHash: "x".repeat(44) },
    });
    assert.equal(response.statusCode, 200, response.body);
    const ledger =
      await sql`select event_name, wallet_from, wallet_to, amount::text as amount from transactions`;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].event_name, "starter_allowance");
    assert.equal(ledger[0].wallet_from, null);
    assert.equal(ledger[0].wallet_to, wallet);
    assert.equal(ledger[0].amount, "500");
    await app.close();
  });
});

test("business creation records permit burn and business creation atomically", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await sql`
      insert into properties (id, district, x, y, owner_wallet, property_type)
      values (3, 'knowledge', 1, 1, 'player:alice.testnet', 'plot')
    `;
    const permit = event("permit_burn", {
      wallet_from: "player:alice.testnet",
      wallet_to: null,
      amount: "100",
      reference: "permit:1",
      entity_id: "business:1",
      business_id: 1,
    });
    const created = event(
      "business_created",
      {
        wallet_from: null,
        wallet_to: null,
        amount: "0",
        reference: "business:1:create",
        entity_id: "business:1",
        id: 1,
        owner: "alice.testnet",
        owner_wallet: "player:alice.testnet",
        property_id: 3,
        treasury: "biz:1",
        permit_fee: "100",
      },
      { receiptId: "receipt-business", eventIndex: 1 },
    );
    const app = await buildApp(sql, {
      viewAllBusinesses: async () => [
        {
          id: 1,
          name: "Cafe",
          owner: "alice.testnet",
          property_id: 3,
          treasury: "biz:1",
          revenue_total: "0",
        },
      ],
      verifyExpectedFunctionCall: async () => ({
        txHash: "tx-hash",
        outcome: {},
        events: [permit, created],
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/businesses",
      payload: { propertyId: 3, name: "Cafe", txHash: "x".repeat(44) },
    });
    assert.equal(response.statusCode, 200, response.body);
    const ledger = await sql`select event_name from transactions order by event_index`;
    assert.deepEqual(
      [...ledger].map((row) => row.event_name),
      ["permit_burn", "business_created"],
    );
    const [business] = await sql`select id from businesses`;
    assert.equal(Number(business.id), 1);
    await app.close();
  });
});

test("property purchase records buyer to seller", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    const buyer = "player:alice.testnet";
    const seller = "player:bob.testnet";
    const sale = event("property_transferred", {
      wallet_from: buyer,
      wallet_to: seller,
      amount: "300",
      reference: "property:1:1",
      entity_id: "property:1",
      id: 1,
      previous_owner: seller,
      new_owner: buyer,
      transfer_count: 1,
    });
    const app = await buildApp(sql, {
      viewContract: async () =>
        ({
          id: 1,
          kind: "plot",
          district: "knowledge",
          x: 1,
          y: 1,
          owner: buyer,
          price: "0",
          for_sale: false,
          transfer_count: 1,
        }) as never,
      verifyExpectedFunctionCall: async () => ({ txHash: "tx-hash", outcome: {}, events: [sale] }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/properties/1/buy",
      payload: { txHash: "x".repeat(44) },
    });
    assert.equal(response.statusCode, 200, response.body);
    const [row] =
      await sql`select wallet_from, wallet_to, amount::text as amount from transactions where event_name = 'property_transferred'`;
    assert.equal(row.wallet_from, buyer);
    assert.equal(row.wallet_to, seller);
    assert.equal(row.amount, "300");
    const [history] = await sql`
      select asset_type, asset_id, previous_owner, new_owner
      from asset_ownership_history
    `;
    assert.equal(history.asset_type, "property");
    assert.equal(history.asset_id, "1");
    assert.equal(history.previous_owner, seller);
    assert.equal(history.new_owner, buyer);
    await app.close();
  });
});

test("service payment records payer to treasury", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    const payer = "player:alice.testnet";
    const treasury = "biz:1";
    const payment = event("service_paid", {
      wallet_from: payer,
      wallet_to: treasury,
      amount: "20",
      reference: "service:1:1",
      entity_id: "business:1",
      business_id: 1,
    });
    const app = await buildApp(sql, {
      viewAllBusinesses: async () => [
        {
          id: 1,
          name: "Cafe",
          owner: "alice.testnet",
          property_id: 3,
          treasury,
          revenue_total: "20",
        },
      ],
      verifyExpectedFunctionCall: async () => ({ txHash: "tx-hash", outcome: {}, events: [payment] }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/businesses/1/pay",
      payload: { amount: "20", txHash: "x".repeat(44) },
    });
    assert.equal(response.statusCode, 200, response.body);
    const [row] =
      await sql`select wallet_from, wallet_to from transactions where event_name = 'service_paid'`;
    assert.equal(row.wallet_from, payer);
    assert.equal(row.wallet_to, treasury);
    await app.close();
  });
});

test("job payment records employer to employee exactly once", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await sql`
      insert into jobs (id, employer_wallet, employee_account, title, payment, status, reference)
      values ('job-1', 'npc:professor-kofi', 'alice.testnet', 'Research', 100, 'verified', 'job:job-1')
    `;
    const employee = "player:alice.testnet";
    const reward = event("job_reward", {
      wallet_from: "npc:professor-kofi",
      wallet_to: employee,
      amount: "100",
      reference: "job:job-1",
      entity_id: employee,
    });
    const app = await buildApp(sql, {
      payJob: async () => ({ kind: "confirmed", txHash: "job-tx", outcome: {} }),
      verifyOperatorOutcome: async () => ({ txHash: "job-tx", outcome: {}, events: [reward] }),
      readChainBalance: async () => "100",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/job-1/complete",
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const [row] =
      await sql`select wallet_from, wallet_to, reference from transactions where event_name = 'job_reward'`;
    assert.equal(row.wallet_from, "npc:professor-kofi");
    assert.equal(row.wallet_to, employee);
    assert.equal(row.reference, "job:job-1");
    const [job] = await sql`select status, paid_at from jobs`;
    assert.equal(job.status, "paid");
    assert.ok(job.paid_at);
    await app.close();
  });
});

test("replaying the same verified event is idempotent", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    const wallet = "player:alice.testnet";
    const starter = event("starter_allowance", {
      wallet_from: null,
      wallet_to: wallet,
      amount: "500",
      reference: "starter:alice.testnet",
      entity_id: wallet,
      account: "alice.testnet",
    });
    const app = await buildApp(sql, {
      viewContract: async () => ({ username: "alice", starter_claimed: true }) as never,
      readChainBalance: async () => "500",
      verifyExpectedFunctionCall: async () => ({ txHash: "tx-hash", outcome: {}, events: [starter] }),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/players/claim",
        payload: { txHash: "x".repeat(44) },
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    const [count] = await sql`select count(*)::int as count from transactions`;
    assert.equal(count.count, 1);
    const [consumptions] = await sql`select count(*)::int as count from transaction_consumptions`;
    assert.equal(consumptions.count, 1);
    await app.close();
  });
});

test("reusing an event identity with different content fails loudly", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    const wallet = "player:alice.testnet";
    let amount = "500";
    const app = await buildApp(sql, {
      viewContract: async () => ({ username: "alice", starter_claimed: true }) as never,
      readChainBalance: async () => amount,
      verifyExpectedFunctionCall: async () => ({
        txHash: "tx-hash",
        outcome: {},
        events: [
          event("starter_allowance", {
            wallet_from: null,
            wallet_to: wallet,
            amount,
            reference: "starter:alice.testnet",
            entity_id: wallet,
            account: "alice.testnet",
          }),
        ],
      }),
    });
    const first = await app.inject({
      method: "POST",
      url: "/v1/players/claim",
      payload: { txHash: "x".repeat(44) },
    });
    assert.equal(first.statusCode, 200, first.body);
    amount = "501";
    const second = await app.inject({
      method: "POST",
      url: "/v1/players/claim",
      payload: { txHash: "x".repeat(44) },
    });
    assert.equal(second.statusCode, 500);
    const [row] = await sql`select amount::text as amount from transactions`;
    assert.equal(row.amount, "500");
    await app.close();
  });
});

test("an unrelated successful transaction cannot satisfy a route", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    const app = await buildApp(sql, {
      verifyExpectedFunctionCall: async () => {
        throw new ExpectedCallError("transaction called pay_service, expected buy_property");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/properties/1/buy",
      payload: { txHash: "x".repeat(44) },
    });
    assert.ok(response.statusCode >= 400);
    const [count] = await sql`select count(*)::int as count from transactions`;
    assert.equal(count.count, 0);
    await app.close();
  });
});

test("read-model changes roll back when ledger persistence fails", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await sql`
      insert into properties (id, district, x, y, owner_wallet, property_type)
      values (3, 'knowledge', 1, 1, 'player:alice.testnet', 'plot')
    `;
    const permit = event("permit_burn", {
      wallet_from: "player:alice.testnet",
      wallet_to: null,
      amount: "100",
      reference: "permit:1",
      entity_id: "business:1",
      business_id: 1,
    });
    const created = event(
      "business_created",
      {
        wallet_from: null,
        wallet_to: null,
        amount: "0",
        reference: "business:1:create",
        entity_id: "business:1",
        id: 1,
        owner: "alice.testnet",
        owner_wallet: "player:alice.testnet",
        property_id: 3,
        treasury: "biz:1",
        permit_fee: "100",
      },
      { receiptId: "receipt-business", eventIndex: 1 },
    );
    const app = await buildApp(sql, {
      viewAllBusinesses: async () => [
        {
          id: 1,
          name: "Cafe",
          owner: "alice.testnet",
          property_id: 3,
          treasury: "biz:1",
          revenue_total: "0",
        },
      ],
      verifyExpectedFunctionCall: async () => ({
        txHash: "tx-hash",
        outcome: {},
        events: [permit, created],
      }),
      insertLedgerEntries: async () => {
        throw new Error("ledger write failed");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/businesses",
      payload: { propertyId: 3, name: "Cafe", txHash: "x".repeat(44) },
    });
    assert.equal(response.statusCode, 500);
    const [businesses] = await sql`select count(*)::int as count from businesses`;
    const [ledger] = await sql`select count(*)::int as count from transactions`;
    const [consumptions] = await sql`select count(*)::int as count from transaction_consumptions`;
    assert.equal(businesses.count, 0);
    assert.equal(ledger.count, 0);
    assert.equal(consumptions.count, 0);
    await app.close();
  });
});

function jobRewardEvent(reference = "job:job-1") {
  return event("job_reward", {
    wallet_from: "npc:professor-kofi",
    wallet_to: "player:alice.testnet",
    amount: "100",
    reference,
    entity_id: "player:alice.testnet",
  });
}

async function seedVerifiedJob(sql: Sql, status = "verified", id = "job-1") {
  await sql`
    insert into jobs (id, employer_wallet, employee_account, title, payment, status, reference)
    values (${id}, ${"npc:professor-kofi"}, ${"alice.testnet"}, ${"Research"}, 100,
            ${status}, ${`job:${id}`})
  `;
}

test("twenty concurrent complete requests produce one chain call and one ledger event", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedVerifiedJob(sql);
    let payJobCalls = 0;
    const app = await buildApp(sql, {
      payJob: async () => {
        payJobCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { kind: "confirmed", txHash: "job-tx", outcome: {} };
      },
      verifyOperatorOutcome: async () => ({
        txHash: "job-tx",
        outcome: {},
        events: [jobRewardEvent()],
      }),
      readChainBalance: async (wallet) => (wallet === "player:alice.testnet" ? "100" : "900"),
    });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/jobs/job-1/complete",
          payload: {},
        }),
      ),
    );
    assert.ok(responses.every((response) => response.statusCode === 200));
    assert.equal(payJobCalls, 1);

    const [job] = await sql`
      select status, payment_attempts, chain_tx from jobs where id = 'job-1'
    `;
    assert.equal(job.status, "paid");
    assert.equal(job.payment_attempts, 1);
    assert.equal(job.chain_tx, "job-tx");
    const [ledger] = await sql`
      select count(*)::int as count from transactions where event_name = 'job_reward'
    `;
    const [raw] = await sql`
      select count(*)::int as count from chain_events where event_name = 'job_reward'
    `;
    assert.equal(ledger.count, 1);
    assert.equal(raw.count, 1);
    const wallets = await sql`select wallet_id, balance::text as balance from wallets order by wallet_id`;
    assert.deepEqual(
      [...wallets].map((wallet) => [wallet.wallet_id, wallet.balance]),
      [
        ["npc:professor-kofi", "900"],
        ["player:alice.testnet", "100"],
      ],
    );
    await app.close();
  });
});

test("open, submitted, cancelled, and failed jobs cannot enter payment pending", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    for (const status of ["open", "submitted", "cancelled", "payment_failed"]) {
      await seedVerifiedJob(sql, status, `job-${status}`).catch(async () => {
        await sql`
          insert into jobs (id, employer_wallet, employee_account, title, payment, status, reference)
          values (${`job-${status}`}, ${"npc:professor-kofi"}, ${"alice.testnet"},
                  ${"Research"}, 100, ${status}, ${`job:job-${status}`})
        `;
      });
    }
    let payJobCalls = 0;
    const app = await buildApp(sql, {
      payJob: async () => {
        payJobCalls += 1;
        return { kind: "confirmed", txHash: "job-tx", outcome: {} };
      },
    });
    for (const status of ["open", "submitted", "cancelled", "payment_failed"]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/jobs/job-${status}/complete`,
        payload: {},
      });
      assert.equal(response.statusCode, 409, `${status}: ${response.body}`);
    }
    assert.equal(payJobCalls, 0);
    const [attempts] = await sql`select coalesce(sum(payment_attempts), 0)::int as attempts from jobs`;
    assert.equal(attempts.attempts, 0);
    await app.close();
  });
});

test("chain success plus local failure can be reconciled without paying twice", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedVerifiedJob(sql);
    const reward = jobRewardEvent();
    let payJobCalls = 0;
    const failing = await buildApp(sql, {
      payJob: async () => {
        payJobCalls += 1;
        return { kind: "confirmed", txHash: "job-tx", outcome: {} };
      },
      verifyOperatorOutcome: async () => ({ txHash: "job-tx", outcome: {}, events: [reward] }),
      readChainBalance: async () => "100",
      insertLedgerEntries: async () => {
        throw new Error("database unavailable");
      },
    });
    const failed = await failing.inject({
      method: "POST",
      url: "/v1/jobs/job-1/complete",
      payload: {},
    });
    assert.equal(failed.statusCode, 502);
    const [afterFailure] = await sql`
      select status, chain_tx, last_error from jobs where id = 'job-1'
    `;
    assert.equal(afterFailure.status, "payment_unknown");
    assert.equal(afterFailure.chain_tx, "job-tx");
    assert.match(afterFailure.last_error, /database unavailable/);
    await failing.close();

    const reconciling = await buildApp(sql, {
      verifyExpectedFunctionCall: async () => ({
        txHash: "job-tx",
        outcome: {},
        events: [reward],
      }),
      readChainBalance: async (wallet) => (wallet === "player:alice.testnet" ? "100" : "900"),
    });
    const reconciled = await reconciling.inject({
      method: "POST",
      url: "/v1/jobs/job-1/retry-payment",
      payload: {},
    });
    assert.equal(reconciled.statusCode, 200, reconciled.body);
    const [job] = await sql`select status, chain_tx from jobs where id = 'job-1'`;
    assert.equal(job.status, "paid");
    assert.equal(job.chain_tx, "job-tx");
    const [ledger] = await sql`
      select count(*)::int as count from transactions where event_name = 'job_reward'
    `;
    assert.equal(ledger.count, 1);
    assert.equal(payJobCalls, 1);

    const repeated = await reconciling.inject({
      method: "POST",
      url: "/v1/jobs/job-1/retry-payment",
      payload: {},
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json().alreadyPaid, true);
    await reconciling.close();
  });
});

test("a failed first hash write falls through to atomic job finalization", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedVerifiedJob(sql);
    await sql`create sequence fail_first_chain_tx_write`;
    await sql`
      create function reject_first_chain_tx_write() returns trigger as $$
      begin
        if old.chain_tx is null and new.chain_tx is not null
           and nextval('fail_first_chain_tx_write') = 1 then
          raise exception 'simulated first chain_tx write failure';
        end if;
        return new;
      end;
      $$ language plpgsql
    `;
    await sql`
      create trigger reject_first_chain_tx_write_trigger
      before update of chain_tx on jobs
      for each row execute function reject_first_chain_tx_write()
    `;

    let payJobCalls = 0;
    const app = await buildApp(sql, {
      payJob: async () => {
        payJobCalls += 1;
        return { kind: "confirmed", txHash: "job-tx", outcome: {} };
      },
      verifyOperatorOutcome: async () => ({
        txHash: "job-tx",
        outcome: {},
        events: [jobRewardEvent()],
      }),
      readChainBalance: async (wallet) => (wallet === "player:alice.testnet" ? "100" : "900"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/job-1/complete",
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(payJobCalls, 1);
    const [job] = await sql`select status, chain_tx from jobs where id = 'job-1'`;
    assert.equal(job.status, "paid");
    assert.equal(job.chain_tx, "job-tx");
    const [ledger] = await sql`
      select count(*)::int as count from transactions where event_name = 'job_reward'
    `;
    assert.equal(ledger.count, 1);
    await app.close();
  });
});

test("a pending job with a stored hash can enter explicit reconciliation", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedVerifiedJob(sql, "payment_pending");
    await sql`
      update jobs
      set chain_tx = 'job-tx', payment_reference = 'job:job-1', payment_started_at = now()
      where id = 'job-1'
    `;
    const app = await buildApp(sql, {
      verifyExpectedFunctionCall: async () => ({
        txHash: "job-tx",
        outcome: {},
        events: [jobRewardEvent()],
      }),
      readChainBalance: async (wallet) => (wallet === "player:alice.testnet" ? "100" : "900"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/job-1/retry-payment",
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const [job] = await sql`select status, chain_tx from jobs where id = 'job-1'`;
    assert.equal(job.status, "paid");
    assert.equal(job.chain_tx, "job-tx");
    await app.close();
  });
});

test("processed reference without a verifiable event does not mark paid", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedVerifiedJob(sql, "payment_failed");
    const app = await buildApp(sql, {
      viewContract: async () => true as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/job-1/retry-payment",
      payload: {},
    });
    assert.equal(response.statusCode, 409);
    const [job] = await sql`select status, chain_tx from jobs where id = 'job-1'`;
    assert.equal(job.status, "payment_failed");
    assert.equal(job.chain_tx, null);
    await app.close();
  });
});

test("known rejection stores safe failure text and unknown timeout does not retry", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedVerifiedJob(sql);
    let calls = 0;
    const app = await buildApp(sql, {
      payJob: async () => {
        calls += 1;
        return {
          kind: "rejected" as const,
          code: "FINAL_REJECTION",
          safeMessage: "insufficient allowance",
        };
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/job-1/complete",
      payload: {},
    });
    assert.equal(response.statusCode, 409);
    assert.equal(calls, 1);
    const [job] = await sql`select status, last_error, chain_tx from jobs where id = 'job-1'`;
    assert.equal(job.status, "payment_failed");
    assert.match(job.last_error, /insufficient allowance/);
    assert.equal(job.chain_tx, null);
    await app.close();
  });
});

test("unknown payout outcomes remain pending without a second operator call", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedVerifiedJob(sql);
    let calls = 0;
    const app = await buildApp(sql, {
      payJob: async () => {
        calls += 1;
        return { kind: "unknown" as const, code: "CHAIN_TIMEOUT" as const };
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/job-1/complete",
      payload: {},
    });
    assert.equal(response.statusCode, 502);
    assert.equal(calls, 1);
    const [job] = await sql`
      select status, chain_tx, payment_next_check_at, payment_error_code
      from jobs where id = 'job-1'
    `;
    assert.equal(job.status, "payment_unknown");
    assert.equal(job.chain_tx, null);
    assert.ok(job.payment_next_check_at);
    assert.equal(job.payment_error_code, "CHAIN_TIMEOUT");
    await app.close();
  });
});

test("retrying a definitely absent reference keeps the same reference", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedVerifiedJob(sql, "payment_failed");
    const app = await buildApp(sql, {
      viewContract: async () => false as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/job-1/retry-payment",
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().retryAllowed, true);
    const [job] = await sql`select status, payment_reference from jobs where id = 'job-1'`;
    assert.equal(job.status, "verified");
    assert.equal(job.payment_reference, "job:job-1");
    await app.close();
  });
});

async function seedRouteQuiz(sql: Sql, id = "quiz-route", count = 3) {
  await sql`
    insert into quizzes (
      id, title, status, question_count, pass_score, reward_amount,
      attempt_duration_seconds, reward_pool
    ) values (
      ${id}, ${"Route Quiz"}, ${"live"}, ${count}, ${count >= 6 ? 6 : count},
      ${count >= 6 ? "25" : "0"}, 600, ${count >= 6 ? "1000" : "0"}
    )
  `;
  for (let index = 0; index < count; index += 1) {
    await sql`
      insert into quiz_questions (id, quiz_id, category, question, options, correct_index)
      values (${`${id}-q${index}`}, ${id}, ${"test"}, ${`Question ${index}`},
              '["a","b"]'::jsonb, 0)
    `;
  }
}

function rewardEvent(amount: string, reference: string) {
  return event("reward_issued", {
    wallet_from: null,
    wallet_to: "player:alice.testnet",
    amount,
    reference,
    entity_id: "player:alice.testnet",
  });
}

test("starting a quiz returns snapshots without correct answers", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedRouteQuiz(sql);
    const app = await buildApp(sql);
    const response = await app.inject({
      method: "POST",
      url: "/v1/quizzes/quiz-route/start",
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.questions.length, 3);
    assert.ok(body.questions.every((question: Record<string, unknown>) => !("correct_index" in question)));
    const [snapshots] = await sql`select count(*)::int as count from quiz_attempt_questions`;
    assert.equal(snapshots.count, 3);
    await app.close();
  });
});

test("editing live questions after start does not change submission score", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedRouteQuiz(sql);
    const app = await buildApp(sql);
    const started = (
      await app.inject({
        method: "POST",
        url: "/v1/quizzes/quiz-route/start",
        payload: {},
      })
    ).json();
    await sql`update quiz_questions set correct_index = 1, question = 'changed' where quiz_id = 'quiz-route'`;
    await sql`delete from quiz_questions where id = 'quiz-route-q2'`;
    await sql`
      insert into quiz_questions (id, quiz_id, category, question, options, correct_index)
      values ('new', 'quiz-route', 'test', 'New?', '["a","b"]'::jsonb, 1)
    `;
    const answers = Object.fromEntries(started.questions.map((question: { id: string }) => [question.id, 0]));
    const response = await app.inject({
      method: "POST",
      url: "/v1/quizzes/quiz-route/submit",
      payload: { attemptId: started.attemptId, answers },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().score, 3);
    assert.equal(response.json().total, 3);
    assert.equal(response.json().status, "submitted");
    await app.close();
  });
});

test("missing answers count incorrect and extra answers do not increase the score", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedRouteQuiz(sql);
    const app = await buildApp(sql);
    const start = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/v1/quizzes/quiz-route/start",
          payload: {},
        })
      ).json();

    const missing = await start();
    const missingResponse = await app.inject({
      method: "POST",
      url: "/v1/quizzes/quiz-route/submit",
      payload: { attemptId: missing.attemptId, answers: {} },
    });
    assert.equal(missingResponse.json().score, 0);

    const extra = await start();
    const answers = Object.fromEntries(extra.questions.map((question: { id: string }) => [question.id, 0]));
    const extraResponse = await app.inject({
      method: "POST",
      url: "/v1/quizzes/quiz-route/submit",
      payload: {
        attemptId: extra.attemptId,
        answers: { ...answers, unknown: 0 },
      },
    });
    assert.equal(extraResponse.json().score, 3);
    await app.close();
  });
});

test("expired attempts become expired and create no reward claim", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedRouteQuiz(sql);
    const started = await startQuizAttempt(sql, {
      quizId: "quiz-route",
      accountId: "alice.testnet",
      now: new Date("2026-01-01T00:00:00.000Z"),
      windowMs: 1000,
    });
    const app = await buildApp(sql);
    const response = await app.inject({
      method: "POST",
      url: "/v1/quizzes/quiz-route/submit",
      payload: { attemptId: started.attemptId, answers: {} },
    });
    assert.equal(response.statusCode, 410);
    const [attempt] = await sql`select status from quiz_attempts where id = ${started.attemptId}`;
    assert.equal(attempt.status, "expired");
    const [claims] = await sql`select count(*)::int as count from quiz_reward_claims`;
    assert.equal(claims.count, 0);
    await app.close();
  });
});

test("repeated quiz submission returns the stored result", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedRouteQuiz(sql);
    const app = await buildApp(sql);
    const started = (
      await app.inject({
        method: "POST",
        url: "/v1/quizzes/quiz-route/start",
        payload: {},
      })
    ).json();
    const payload = {
      attemptId: started.attemptId,
      answers: {},
    };
    const first = await app.inject({ method: "POST", url: "/v1/quizzes/quiz-route/submit", payload });
    const second = await app.inject({ method: "POST", url: "/v1/quizzes/quiz-route/submit", payload });
    assert.equal(first.json().score, 0);
    assert.equal(second.json().alreadySubmitted, true);
    assert.equal(second.json().score, 0);
    assert.equal(second.json().status, "submitted");
    await app.close();
  });
});

test("two qualifying attempts on one day create one reward claim", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedRouteQuiz(sql, "quiz-route", 6);
    let rewardCalls = 0;
    const app = await buildApp(sql, {
      creditReward: async () => {
        rewardCalls += 1;
        return { kind: "confirmed", txHash: "reward-tx", outcome: {} };
      },
      verifyOperatorOutcome: async (_outcome, txHash, expectation) => ({
        txHash,
        outcome: {},
        events: [rewardEvent(String(expectation.args.amount), String(expectation.args.reference))],
      }),
      readChainBalance: async () => "25",
    });
    const start = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/v1/quizzes/quiz-route/start",
          payload: {},
        })
      ).json();
    const submit = async (attemptId: string, questions: { id: string }[]) =>
      app.inject({
        method: "POST",
        url: "/v1/quizzes/quiz-route/submit",
        payload: {
          attemptId,
          answers: Object.fromEntries(questions.map((question) => [question.id, 0])),
        },
      });

    const first = await start();
    const second = await start();
    const firstResponse = await submit(first.attemptId, first.questions);
    const secondResponse = await submit(second.attemptId, second.questions);
    assert.equal(firstResponse.statusCode, 200, firstResponse.body);
    assert.equal(secondResponse.statusCode, 200, secondResponse.body);
    assert.equal(rewardCalls, 1);
    const [claims] = await sql`select count(*)::int as count from quiz_reward_claims`;
    assert.equal(claims.count, 1);
    const statuses = await sql`select status from quiz_attempts order by status`;
    assert.deepEqual(
      [...statuses].map((row) => row.status),
      ["rewarded", "submitted"],
    );
    await app.close();
  });
});

test("twenty concurrent submissions produce one reward call and one event", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedRouteQuiz(sql, "quiz-route", 6);
    let rewardCalls = 0;
    const app = await buildApp(sql, {
      creditReward: async () => {
        rewardCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { kind: "confirmed", txHash: "reward-tx", outcome: {} };
      },
      verifyOperatorOutcome: async (_outcome, txHash, expectation) => ({
        txHash,
        outcome: {},
        events: [rewardEvent(String(expectation.args.amount), String(expectation.args.reference))],
      }),
      readChainBalance: async () => "25",
    });
    const started = (
      await app.inject({
        method: "POST",
        url: "/v1/quizzes/quiz-route/start",
        payload: {},
      })
    ).json();
    const payload = {
      attemptId: started.attemptId,
      answers: Object.fromEntries(started.questions.map((question: { id: string }) => [question.id, 0])),
    };
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({ method: "POST", url: "/v1/quizzes/quiz-route/submit", payload }),
      ),
    );
    assert.ok(responses.every((response) => response.statusCode === 200));
    assert.equal(rewardCalls, 1);
    const [claims] = await sql`
      select count(*)::int as count from quiz_reward_claims where status = 'paid'
    `;
    const [rewarded] = await sql`
      select count(*)::int as count from quiz_attempts where status = 'rewarded'
    `;
    const [ledger] = await sql`
      select count(*)::int as count from transactions where event_name = 'reward_issued'
    `;
    assert.equal(claims.count, 1);
    assert.equal(rewarded.count, 1);
    assert.equal(ledger.count, 1);
    await app.close();
  });
});

test("a local failure after a chain reward leaves a recoverable failed attempt", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedRouteQuiz(sql, "quiz-route", 6);
    let rewardCalls = 0;
    const app = await buildApp(sql, {
      creditReward: async () => {
        rewardCalls += 1;
        return { kind: "confirmed", txHash: "reward-tx", outcome: {} };
      },
      verifyOperatorOutcome: async (_outcome, txHash, expectation) => ({
        txHash,
        outcome: {},
        events: [rewardEvent(String(expectation.args.amount), String(expectation.args.reference))],
      }),
      readChainBalance: async () => "25",
      insertLedgerEntries: async () => {
        throw new Error("ledger unavailable");
      },
    });
    const started = (
      await app.inject({
        method: "POST",
        url: "/v1/quizzes/quiz-route/start",
        payload: {},
      })
    ).json();
    const payload = {
      attemptId: started.attemptId,
      answers: Object.fromEntries(started.questions.map((question: { id: string }) => [question.id, 0])),
    };
    const response = await app.inject({ method: "POST", url: "/v1/quizzes/quiz-route/submit", payload });
    assert.equal(response.statusCode, 502);
    const [attempt] = await sql`
      select status, reward_state, reward_tx, last_error from quiz_attempts where id = ${started.attemptId}
    `;
    assert.equal(attempt.status, "reward_pending");
    assert.equal(attempt.reward_state, "unknown");
    assert.equal(attempt.reward_tx, "reward-tx");
    assert.match(attempt.last_error, /ledger unavailable/);
    const [claim] = await sql`select status from quiz_reward_claims`;
    assert.equal(claim.status, "reserved");

    const replay = await app.inject({ method: "POST", url: "/v1/quizzes/quiz-route/submit", payload });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().alreadySubmitted, true);
    assert.equal(rewardCalls, 1);
    await app.close();
  });
});

test("a transaction cannot be reused for a different command or entity", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    const txHash = "x".repeat(44);
    const starter = event("starter_allowance", {
      wallet_from: null,
      wallet_to: "player:alice.testnet",
      amount: "500",
      reference: "starter:alice.testnet",
      entity_id: "player:alice.testnet",
      account: "alice.testnet",
    });
    const sale = event("property_transferred", {
      wallet_from: "player:alice.testnet",
      wallet_to: "player:bob.testnet",
      amount: "300",
      reference: "property:1:1",
      entity_id: "property:1",
      id: 1,
      previous_owner: "player:bob.testnet",
      new_owner: "player:alice.testnet",
      transfer_count: 1,
    });
    const app = await buildApp(sql, {
      viewContract: async (method) => {
        if (method === "get_player") {
          return { username: "alice", starter_claimed: true } as never;
        }
        if (method === "get_property") {
          return {
            id: 1,
            kind: "plot",
            district: "knowledge",
            x: 1,
            y: 1,
            owner: "player:alice.testnet",
            price: "0",
            for_sale: false,
            transfer_count: 1,
          } as never;
        }
        return null as never;
      },
      readChainBalance: async () => "500",
      verifyExpectedFunctionCall: async (_txHash, expectation) => ({
        txHash,
        outcome: {},
        events: [expectation.method === "claim_starter" ? starter : sale],
      }),
    });

    const claim = await app.inject({
      method: "POST",
      url: "/v1/players/claim",
      payload: { txHash },
    });
    assert.equal(claim.statusCode, 200, claim.body);

    const reuse = await app.inject({
      method: "POST",
      url: "/v1/properties/1/buy",
      payload: { txHash },
    });
    assert.equal(reuse.statusCode, 409, reuse.body);
    assert.equal(reuse.json().error.code, "TX_ALREADY_CONSUMED");
    const [properties] = await sql`select count(*)::int as count from properties`;
    const [consumptions] = await sql`select count(*)::int as count from transaction_consumptions`;
    assert.equal(properties.count, 0);
    assert.equal(consumptions.count, 1);
    await app.close();
  });
});

test("an exhausted quiz reward pool issues no reward", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedRouteQuiz(sql, "quiz-route", 6);
    await sql`update quizzes set reward_pool = 0 where id = 'quiz-route'`;
    const app = await buildApp(sql, {
      creditReward: async () => {
        throw new Error("should not be called");
      },
    });
    const started = (
      await app.inject({
        method: "POST",
        url: "/v1/quizzes/quiz-route/start",
        payload: {},
      })
    ).json();
    const response = await app.inject({
      method: "POST",
      url: "/v1/quizzes/quiz-route/submit",
      payload: {
        attemptId: started.attemptId,
        answers: Object.fromEntries(started.questions.map((question: { id: string }) => [question.id, 0])),
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().reward, "0");
    assert.equal(response.json().status, "submitted");
    const [claims] = await sql`select count(*)::int as count from quiz_reward_claims`;
    assert.equal(claims.count, 0);
    const [pool] = await sql`
      select reward_reserved::text as reserved, reward_paid::text as paid from quizzes
    `;
    assert.equal(pool.reserved, "0");
    assert.equal(pool.paid, "0");
    await app.close();
  });
});

test("retry-payment requires an operator or admin role", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrated(sql);
    await seedVerifiedJob(sql, "payment_failed");
    let providerCalls = 0;
    const playerApp = await buildApp(
      sql,
      {
        viewContract: async () => {
          providerCalls += 1;
          return false as never;
        },
      },
      ["player"],
    );
    const forbidden = await playerApp.inject({
      method: "POST",
      url: "/v1/jobs/job-1/retry-payment",
      payload: {},
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error.code, "FORBIDDEN");
    assert.equal(providerCalls, 0);
    const [unchanged] = await sql`select status from jobs where id = 'job-1'`;
    assert.equal(unchanged.status, "payment_failed");
    await playerApp.close();

    const operatorApp = await buildApp(sql, { viewContract: async () => false as never }, ["operator"]);
    const allowed = await operatorApp.inject({
      method: "POST",
      url: "/v1/jobs/job-1/retry-payment",
      payload: {},
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json().retryAllowed, true);
    await operatorApp.close();
  });
});
