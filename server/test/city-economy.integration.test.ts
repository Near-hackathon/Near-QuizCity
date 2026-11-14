import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { withTestSchema } from "./db-test-utils.js";
import { loadMigrations, runMigrations, postgresMigrationStore } from "../src/migrations.js";
import { prepareCityCommand, projectCityOperation } from "../src/city-economy.js";
import { projectNpcPurchase, reserveNpcShopping } from "../src/npc-shopping.js";
import { createShopItem } from "../src/commerce.js";
import { validateEvent, type ValidatedEvent } from "../src/event-validation.js";
import { cityHealth, registerCityHealth } from "../src/city-health.js";
import { seedWorld } from "../db/seeds/world.js";
const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
async function setup(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
  await seedWorld(sql);
  await sql`insert into properties(id,district,x,y,owner_wallet,property_type,price,for_sale) values (1,'knowledge',4,7,'player:alice.testnet','commercial',300,false)`;
  await sql`insert into businesses(id,owner_account,property_id,name,treasury_wallet) values (1,'alice.testnet',1,'City Market','biz:1')`;
  await sql`insert into wallets(wallet_id,owner_type,owner_id,balance) values ('player:alice.testnet','player','alice.testnet',500),('player:bob.testnet','player','bob.testnet',500),('biz:1','business','1',500),('gov:council','gov','council',0),('npc:professor-kofi','npc','professor-kofi',1000)`;
  return createShopItem(sql, "1", "alice.testnet", {
    sku: "guide",
    name: "City guide",
    unitPrice: "20",
    quantity: 10,
  });
}
function eventFor(op: any): ValidatedEvent {
  const e = op.expected_events[0];
  return validateEvent(
    JSON.parse(
      JSON.stringify({
        standard: "quizcity",
        version: "1.0.0",
        event: e.name,
        data: [
          {
            seq: 1,
            wallet_from: e.walletFrom ?? null,
            wallet_to: e.walletTo ?? null,
            amount: e.amount ?? "0",
            reference: op.reference,
            entity_id: e.entityId,
            escrow_id: op.args.id,
            owner: op.actor_account,
            purpose: op.args.purpose ?? (op.payload.jobId ? "public_contract" : "prize"),
            beneficiary: op.args.beneficiary_wallet ?? null,
            business_id: op.args.business_id,
            payment_reference: op.args.payment_reference,
            order_reference: op.args.order_reference,
          },
        ],
        receiptId: `receipt-${op.id}`,
        eventIndex: 0,
        txHash: `hash-${op.id}`,
      }),
    ),
  );
}
test("supplier reservations require confirmed exact payments and replay delivers once", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql),
      request = { requestId: randomUUID(), action: "supplier" as const, targetId: item.id, quantity: 5 };
    await assert.rejects(prepareCityCommand(sql, "bob.testnet", request), { code: "FORBIDDEN" });
    const op = await prepareCityCommand(sql, "alice.testnet", request);
    assert.equal((await prepareCityCommand(sql, "alice.testnet", request)).id, op.id);
    assert.equal((await sql`select on_hand from business_items where id=${item.id}`)[0].on_hand, 10);
    const event = eventFor(op);
    await assert.rejects(
      sql.begin((tx) => projectCityOperation(tx, { ...event, data: [{ ...event.data[0], amount: "99" }] })),
    );
    assert.equal((await sql`select on_hand from business_items where id=${item.id}`)[0].on_hand, 10);
    await sql.begin((tx) => projectCityOperation(tx, event));
    await sql.begin((tx) => projectCityOperation(tx, event));
    assert.equal((await sql`select on_hand from business_items where id=${item.id}`)[0].on_hand, 15);
    assert.equal(
      (await sql`select count(*)::int as n from stock_movements where reference=${op.reference}`)[0].n,
      1,
    );
  });
});
test("business jobs cannot open before real funding and migrations are idempotent", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const op = await prepareCityCommand(sql, "alice.testnet", {
      requestId: randomUUID(),
      action: "job",
      targetId: "1",
      amount: "40",
      title: "Stock the reading desk",
      description: "Prepare a referenced report describing the city reading catalogue.",
      days: 7,
    });
    assert.equal((await sql`select count(*)::int as n from jobs`)[0].n, 0);
    await sql.begin((tx) => projectCityOperation(tx, eventFor(op)));
    const [job] = await sql`select * from jobs`;
    assert.equal(job.payment, "40");
    assert.equal(job.employer_wallet, `gov:escrow.${op.id}`);
    await sql.begin((tx) => projectCityOperation(tx, eventFor(op)));
    assert.equal((await sql`select count(*)::int as n from jobs`)[0].n, 1);
    assert.equal((await runMigrations(postgresMigrationStore(sql), migrations)).applied.length, 0);
  });
});
test("NPC purchases reserve real funds and stock then fulfill once from their canonical receipt", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql);
    await sql`update npc_runtime set activity='garden_walk',scene_id='city-district' where npc_id='professor-kofi'`;
    const now = new Date("2026-11-14T12:00:00Z");
    await reserveNpcShopping(sql, now);
    await reserveNpcShopping(sql, now);
    const [v] = await sql`select * from npc_shop_visits`;
    assert.ok(v);
    assert.equal(v.destination_spawn_id, "market-queue");
    const event = validateEvent({
      standard: "quizcity",
      version: "1.0.0",
      event: "service_paid",
      data: [
        {
          seq: 1,
          wallet_from: "npc:professor-kofi",
          wallet_to: "biz:1",
          amount: "20",
          reference: v.reference,
          entity_id: "business:1",
          business_id: 1,
        },
      ],
      receiptId: "npc-receipt",
      eventIndex: 0,
      txHash: "npc-hash",
    });
    await sql.begin((tx) => projectNpcPurchase(tx, event));
    await sql.begin((tx) => projectNpcPurchase(tx, event));
    const [stock] = await sql`select on_hand,reserved from business_items where id=${item.id}`;
    assert.deepEqual({ ...stock }, { on_hand: 9, reserved: 0 });
    assert.equal(
      (await sql`select count(*)::int as n from stock_movements where npc_visit_id=${v.id}`)[0].n,
      1,
    );
  });
});
test("public health separates confirmed supply and commitments without private diagnostics", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const health = await cityHealth(sql, { total_issued: "2500", total_burned: "0" });
    assert.equal(health.supply.difference, "0");
    assert.equal(health.diagnostics, undefined);
    assert.ok(health.walletGroups.length);
  });
});

import Fastify from "fastify";
import { fastifyOptions } from "../src/fastify-options.js";
import { registerErrorHandler } from "../src/errors.js";
import { registerCityEconomyRoutes, registerCityReviewRoutes } from "../src/city-economy-routes.js";
import { startQuizAttempt } from "../src/quiz.js";
async function routes(sql: Sql, overrides: Partial<import("../src/city-economy-routes.js").CityDeps> = {}) {
  const app = Fastify({ ...fastifyOptions, logger: false });
  registerErrorHandler(app);
  app.decorateRequest("auth", null);
  app.addHook("preValidation", async (req) => {
    const a = req.headers["x-test-actor"];
    if (typeof a === "string")
      req.auth = {
        accountId: a,
        roles: req.headers["x-test-role"] === "operator" ? ["operator"] : ["player"],
        sessionTokenHash: "test",
        csrfHash: "test",
        expiresAt: "2026-12-01T00:00:00Z",
      };
  });
  await app.register(
    async (v1) => {
      registerCityEconomyRoutes(v1, sql, {
        now: () => new Date("2026-11-14T12:00:00Z"),
        view: async <T>(method: string) => {
          const result =
            method === "get_business"
              ? { owner: "alice.testnet" }
              : method === "get_property"
                ? { owner: "player:alice.testnet" }
                : method === "get_reward_policy"
                  ? { daily_cap: "5000", issued_today: "0" }
                  : true;
          return result as T;
        },
        ...overrides,
      });
      registerCityReviewRoutes(v1, sql);
      registerCityHealth(v1, sql, async () => ({ total_issued: "2500", total_burned: "0" }));
    },
    { prefix: "/v1" },
  );
  const request = (
    method: "GET" | "POST",
    url: string,
    actor?: string,
    payload?: unknown,
    operator = false,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(actor ? { "x-test-actor": actor } : {}),
        ...(operator ? { "x-test-role": "operator" } : {}),
      },
      ...(payload ? { payload: payload as any } : {}),
    });
  return { app, request };
}
test("quiz publishing requires independent review, freezes content, funds prizes and consumes admission once", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const { app, request } = await routes(sql);
    try {
      assert.equal((await request("GET", "/v1/city/moderation")).statusCode, 401);
      assert.equal((await request("GET", "/v1/city/moderation", "bob.testnet")).statusCode, 403);
      const body = {
        businessId: "1",
        title: "Read the city charter",
        questions: [
          {
            question: "What protects a wallet?",
            options: ["Private keys", "Public usernames"],
            correct: 0,
            source: "https://near.org/",
          },
        ],
        passScore: 1,
        entryFee: "5",
        reward: "25",
        capacity: 1,
        opensAt: "2026-11-14T11:00:00Z",
        closesAt: "2026-11-14T15:00:00Z",
      };
      assert.equal((await request("POST", "/v1/city/quizzes/drafts", "bob.testnet", body)).statusCode, 403);
      const created = await request("POST", "/v1/city/quizzes/drafts", "alice.testnet", body);
      assert.equal(created.statusCode, 200, created.body);
      const id = created.json().id;
      assert.equal(
        (
          await request("POST", `/v1/city/quizzes/drafts/${id}/review`, "alice.testnet", {
            decision: "submit",
            note: "Sources and answers ready for review.",
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await request(
            "POST",
            `/v1/city/quizzes/drafts/${id}/review`,
            "alice.testnet",
            { decision: "approve", note: "Independent answer verification." },
            true,
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await request(
            "POST",
            `/v1/city/quizzes/drafts/${id}/review`,
            "moderator.testnet",
            { decision: "approve", note: "Sources and answer key independently verified." },
            true,
          )
        ).statusCode,
        200,
      );
      await assert.rejects(sql`update quiz_drafts set title='Changed after review' where id=${id}`);
      const fund = await prepareCityCommand(sql, "alice.testnet", {
        requestId: randomUUID(),
        action: "quiz-fund",
        targetId: id,
        amount: "100",
      });
      await sql.begin((tx) => projectCityOperation(tx, eventFor(fund)));
      const quizId = `venue-${id}`;
      await assert.rejects(
        startQuizAttempt(sql, { quizId, accountId: "bob.testnet", now: new Date("2026-11-14T12:00:00Z") }),
        /admission/,
      );
      let admission = await prepareCityCommand(
        sql,
        "bob.testnet",
        { requestId: randomUUID(), action: "admission", targetId: quizId },
        new Date("2026-11-14T12:00:00Z"),
      );
      await sql.begin((tx) => projectCityOperation(tx, eventFor(admission)));
      const refund = await prepareCityCommand(sql, "alice.testnet", {
        requestId: randomUUID(),
        action: "refund-admission",
        targetId: admission.id,
      });
      await assert.rejects(
        startQuizAttempt(sql, { quizId, accountId: "bob.testnet", now: new Date("2026-11-14T12:00:00Z") }),
        /admission/,
      );
      await sql.begin((tx) => projectCityOperation(tx, eventFor(refund)));
      await sql.begin((tx) => projectCityOperation(tx, eventFor(refund)));
      assert.ok(
        (await sql`select refunded_at from quiz_admissions where operation_id=${admission.id}`)[0]
          .refunded_at,
      );
      admission = await prepareCityCommand(
        sql,
        "bob.testnet",
        { requestId: randomUUID(), action: "admission", targetId: quizId },
        new Date("2026-11-14T12:00:00Z"),
      );
      await sql.begin((tx) => projectCityOperation(tx, eventFor(admission)));
      const attempt = await startQuizAttempt(sql, {
        quizId,
        accountId: "bob.testnet",
        now: new Date("2026-11-14T12:00:00Z"),
      });
      await assert.rejects(
        prepareCityCommand(sql, "alice.testnet", {
          requestId: randomUUID(),
          action: "refund-admission",
          targetId: admission.id,
        }),
        /used/,
      );
      assert.equal(
        (await sql`select funding_escrow_id from quiz_attempts where id=${attempt.attemptId}`)[0]
          .funding_escrow_id,
        fund.id,
      );
      await assert.rejects(
        startQuizAttempt(sql, { quizId, accountId: "other.testnet", now: new Date("2026-11-14T12:01:00Z") }),
        /full/,
      );
      assert.equal(
        (
          await request("POST", `/v1/city/quizzes/drafts/${id}/report`, "bob.testnet", {
            reason: "Please check the published source wording.",
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await request("GET", "/v1/city/moderation", "moderator.testnet", undefined, true)).json().reports
          .length,
        1,
      );
    } finally {
      await app.close();
    }
  });
});
test("permanent supplier quote cancellation releases reservations while preserving payment history", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql),
      original = await prepareCityCommand(sql, "alice.testnet", {
        requestId: randomUUID(),
        action: "supplier",
        targetId: item.id,
        quantity: 4,
      });
    const cancellation = await prepareCityCommand(sql, "alice.testnet", {
      requestId: randomUUID(),
      action: "cancel-payment",
      targetId: original.id,
    });
    const event = validateEvent({
      standard: "quizcity",
      version: "1.0.0",
      event: "charge_cancelled",
      data: [
        {
          seq: 1,
          wallet_from: null,
          wallet_to: null,
          amount: "0",
          reference: original.reference,
          entity_id: "gov:council",
          source_wallet: "biz:1",
        },
      ],
      receiptId: "cancel-receipt",
      eventIndex: 0,
      txHash: "cancel-hash",
    });
    await sql.begin((tx) => projectCityOperation(tx, event));
    await sql.begin((tx) => projectCityOperation(tx, event));
    assert.equal((await sql`select reserved from supplier_offers`)[0].reserved, 0);
    assert.equal(
      (await sql`select status from city_operations where id=${original.id}`)[0].status,
      "cancelled",
    );
    assert.equal(
      (await sql`select status from city_operations where id=${cancellation.id}`)[0].status,
      "confirmed",
    );
    await assert.rejects(sql.begin((tx) => projectCityOperation(tx, eventFor(original))));
    assert.equal((await sql`select on_hand from business_items where id=${item.id}`)[0].on_hand, 10);
  });
});
test("council budgets cannot overcommit and rent requires a canonical use-rights fact", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    await sql`update wallets set balance=50 where wallet_id='gov:council'`;
    await sql`update council_budgets set ceiling=40 where category='library'`;
    const budget = await prepareCityCommand(sql, "operator.testnet", {
      requestId: randomUUID(),
      action: "budget",
      targetId: "council",
      category: "library",
      recipient: "player:bob.testnet",
      amount: "30",
      description: "Pay for a verified public library catalogue.",
    });
    await assert.rejects(
      prepareCityCommand(sql, "operator.testnet", {
        requestId: randomUUID(),
        action: "budget",
        targetId: "council",
        category: "library",
        recipient: "player:bob.testnet",
        amount: "20",
        description: "A second public library commitment.",
      }),
    );
    await sql.begin((tx) => projectCityOperation(tx, eventFor(budget)));
    await sql.begin((tx) => projectCityOperation(tx, eventFor(budget)));
    assert.deepEqual(
      {
        ...(
          await sql`select committed::text as c,spent::text as s from council_budgets where category='library'`
        )[0],
      },
      { c: "0", s: "30" },
    );
    await sql`insert into property_rent_offers(property_id,owner_wallet,rent,period_days) values (1,'player:alice.testnet',30,7)`;
    const rent = await prepareCityCommand(sql, "bob.testnet", {
      requestId: randomUUID(),
      action: "rent",
      targetId: "1",
    });
    await sql.begin((tx) => projectCityOperation(tx, eventFor(rent)));
    assert.equal((await sql`select status from property_leases where id=${rent.id}`)[0].status, "reserved");
    const ends = BigInt(Date.parse("2026-11-21T12:00:00Z")) * 1000000n,
      grace = ends + 259200000000000n;
    const fact = validateEvent({
      standard: "quizcity",
      version: "1.0.0",
      event: "lease_started",
      data: [
        {
          seq: 2,
          wallet_from: null,
          wallet_to: null,
          amount: "0",
          reference: rent.reference,
          entity_id: "property:1",
          property_id: 1,
          tenant: "bob.testnet",
          ends_at: ends.toString(),
          grace_ends_at: grace.toString(),
        },
      ],
      txHash: `hash-${rent.id}`,
      receiptId: "rent-receipt",
      eventIndex: 1,
    });
    await sql.begin((tx) => projectCityOperation(tx, fact));
    assert.equal((await sql`select status from property_leases where id=${rent.id}`)[0].status, "active");
    assert.equal(
      (await sql`select owner_wallet from properties where id=1`)[0].owner_wallet,
      "player:alice.testnet",
    );
  });
});

import { connectTestClient, testDatabaseUrl } from "./db-test-utils.js";
import { reserveShopOrder } from "../src/commerce.js";

async function overlap(
  sql: Sql,
  schema: string,
  lock: (tx: any) => Promise<unknown>,
  work: (client: Sql, index: number) => Promise<unknown>,
) {
  const clients = [
    connectTestClient(testDatabaseUrl(), schema),
    connectTestClient(testDatabaseUrl(), schema),
  ];
  let attempts: Promise<unknown>[] = [];
  try {
    const pids = await Promise.all(
      clients.map(async (client) => (await client`select pg_backend_pid() as pid`)[0].pid),
    );
    await sql.begin(async (tx) => {
      await lock(tx);
      attempts = clients.map(work);
      const deadline = Date.now() + 10000;
      while (true) {
        const [waiters] =
          await tx`select count(*)::int as n from pg_stat_activity where pid in (${pids[0]},${pids[1]}) and wait_event_type='Lock'`;
        if (waiters.n === 2) break;
        if (Date.now() > deadline) throw Error("Expected both workers to overlap at a database lock");
      }
    });
    return await Promise.allSettled(attempts);
  } finally {
    await Promise.allSettled(attempts);
    await Promise.all(clients.map((c) => c.end()));
  }
}
test("two supplier buyers contend for the last stock without overcommitting or partial rows", async () => {
  await withTestSchema(async ({ sql, schema }) => {
    const item = await setup(sql);
    await sql`update supplier_offers set on_hand=10`;
    const outcomes = await overlap(
      sql,
      schema,
      (tx) => tx`select id from business_items where id=${item.id} for update`,
      (client) =>
        prepareCityCommand(client, "alice.testnet", {
          requestId: randomUUID(),
          action: "supplier",
          targetId: item.id,
          quantity: 6,
        }),
    );
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal((await sql`select reserved from supplier_offers`)[0].reserved, 6);
    assert.equal((await sql`select count(*)::int as n from supplier_orders`)[0].n, 1);
    assert.equal((await sql`select count(*)::int as n from city_operations`)[0].n, 1);
    assert.equal((await sql`select on_hand from business_items where id=${item.id}`)[0].on_hand, 10);
  });
});
test("two government actors share one council commitment budget", async () => {
  await withTestSchema(async ({ sql, schema }) => {
    await setup(sql);
    await sql`update wallets set balance=50 where wallet_id='gov:council'`;
    await sql`update council_budgets set ceiling=50`;
    const outcomes = await overlap(
      sql,
      schema,
      (tx) => tx`select wallet_id from wallets where wallet_id='gov:council' for update`,
      (client, index) =>
        prepareCityCommand(client, index ? "operator.testnet" : "admin.testnet", {
          requestId: randomUUID(),
          action: "budget",
          targetId: "council",
          category: index ? "quizzes" : "library",
          recipient: "npc:professor-kofi",
          amount: "40",
          description: "Reviewed public reading programme funding",
        }),
    );
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal((await sql`select sum(committed)::text as n from council_budgets`)[0].n, "40");
    assert.equal((await sql`select count(*)::int as n from council_commitments`)[0].n, 1);
  });
});
test("shop hours reject new carts while preserving already reserved payments", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql);
    await sql`insert into business_settings values(1,540,1020,true)`;
    await assert.rejects(reserveShopOrder(sql, "bob.testnet", item.id, 1, new Date("2026-11-14T08:00:00Z")), {
      code: "CONFLICT",
    });
    assert.equal((await sql`select reserved from business_items where id=${item.id}`)[0].reserved, 0);
    await reserveShopOrder(sql, "bob.testnet", item.id, 1, new Date("2026-11-14T09:00:00Z"));
    assert.equal((await sql`select reserved from business_items where id=${item.id}`)[0].reserved, 1);
  });
});
test("economy migration upgrades exact prior data, enforces constraints and rolls back later failure", async () => {
  await withTestSchema(async ({ sql }) => {
    const previous = migrations.filter((m) => m.filename < "0033");
    await runMigrations(postgresMigrationStore(sql), previous);
    await sql`insert into wallets(wallet_id,owner_type,owner_id,balance) values('player:upgrade.testnet','player','upgrade.testnet',9007199254740993)`;
    const before = [...(await sql`select * from wallets`)];
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), [
        ...migrations,
        { filename: "9999_failure.sql", checksum: "failure", sql: "select 1/0" },
      ]),
    );
    assert.equal((await sql`select to_regclass('city_operations') as name`)[0].name, null);
    assert.deepEqual([...(await sql`select * from wallets`)], before);
    assert.equal((await sql`select count(*)::int as n from schema_migrations`)[0].n, previous.length);
    await runMigrations(postgresMigrationStore(sql), migrations);
    assert.deepEqual([...(await sql`select * from wallets`)], before);
    assert.equal((await runMigrations(postgresMigrationStore(sql), migrations)).applied.length, 0);
    await assert.rejects(sql`update supplier_offers set reserved=on_hand+1`, { code: "23514" });
    await assert.rejects(sql`update council_budgets set ceiling=-1`, { code: "23514" });
    assert.equal((await sql`select reserved from supplier_offers`)[0].reserved, 0);
  });
});
test("new command routes fail closed for unauthenticated, wrong-role and malformed requests", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const { app, request } = await routes(sql);
    try {
      for (const url of ["/v1/city/overview", "/v1/city/moderation"])
        assert.equal((await request("GET", url)).statusCode, 401);
      for (const action of ["budget", "public-job"])
        assert.equal(
          (
            await request("POST", "/v1/city/commands", "bob.testnet", {
              requestId: randomUUID(),
              action,
              targetId: "council",
            })
          ).statusCode,
          403,
        );
      for (const url of [
        "/v1/city/operations/not-a-uuid/confirm",
        "/v1/city/shops/not-a-number/hours",
        "/v1/city/quizzes/drafts/not-a-uuid/review",
      ])
        assert.equal((await request("POST", url, "alice.testnet", {})).statusCode, 400);
      assert.equal((await sql`select count(*)::int as n from city_operations`)[0].n, 0);
    } finally {
      await app.close();
    }
  });
});

test("domain validation, request identity, role ownership and cancelled operations preserve state", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql);
    const prepare = (
      action: string,
      targetId: string,
      extra: Record<string, unknown> = {},
      actor = "alice.testnet",
    ) => prepareCityCommand(sql, actor, { requestId: randomUUID(), action, targetId, ...extra } as any);
    for (const [action, target] of [
      ["supplier", "bad"],
      ["rent", "bad"],
      ["job", "0"],
      ["tax", "9007199254740993"],
    ])
      await assert.rejects(prepare(action, target));
    await assert.rejects(prepare("supplier", randomUUID()), /not found/);
    await assert.rejects(prepare("settlement", "1"), /reviewed/);
    await assert.rejects(prepare("unknown", "1"), /Unknown/);
    await assert.rejects(prepare("upkeep", "1", {}, "bob.testnet"), { code: "FORBIDDEN" });
    await assert.rejects(prepare("job", "1", { amount: "30" }), /Describe/);
    for (const amount of ["0", "10001", "-1", "01"])
      await assert.rejects(
        prepare("job", "1", {
          amount,
          title: "Library report",
          description: "Write a referenced report about the city library.",
        }),
      );
    await assert.rejects(prepare("cancel-payment", randomUUID()), { code: "NOT_FOUND" });
    await assert.rejects(prepare("refund", randomUUID()), { code: "NOT_FOUND" });
    await assert.rejects(prepare("refund-admission", randomUUID()), { code: "NOT_FOUND" });
    await assert.rejects(prepare("admission", "missing"), /admitting/);
    await assert.rejects(prepare("sponsor", "missing", { amount: "1" }), /accepting/);
    await assert.rejects(prepare("quiz-fund", randomUUID(), { amount: "1" }), /moderator/);
    assert.equal((await sql`select count(*)::int as n from city_operations`)[0].n, 0);
    const intent = { requestId: randomUUID(), action: "supplier" as const, targetId: item.id, quantity: 1 };
    const op = await prepareCityCommand(sql, "alice.testnet", intent);
    await assert.rejects(
      prepareCityCommand(sql, "alice.testnet", { ...intent, quantity: 2 }),
      /different command/,
    );
    await assert.rejects(prepareCityCommand(sql, "bob.testnet", intent), /different command/);
    await sql.begin((tx) => projectCityOperation(tx, eventFor(op)));
    await assert.rejects(prepare("cancel-payment", op.id), /cannot be cancelled/);
    await assert.rejects(
      sql.begin((tx) => projectCityOperation(tx, { ...eventFor(op), receiptId: "different" })),
      /different confirmed/,
    );
    assert.equal((await sql`select on_hand from business_items where id=${item.id}`)[0].on_hand, 11);
  });
});
test("public employment cancellation returns escrow and restores the category budget exactly once", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    await sql`update wallets set balance=100 where wallet_id='gov:council'`;
    await sql`update council_budgets set ceiling=100 where category='employment'`;
    const op = await prepareCityCommand(sql, "operator.testnet", {
      requestId: randomUUID(),
      action: "public-job",
      targetId: "council",
      title: "Public library report",
      description: "Research and submit a sourced library programme report.",
      amount: "40",
    });
    await sql.begin((tx) => projectCityOperation(tx, eventFor(op)));
    const jobId = op.payload.jobId;
    let submissions = 0;
    const { app, request } = await routes(sql, {
      submit: async () => {
        submissions++;
        return { kind: "unknown", code: "CHAIN_TIMEOUT" };
      },
    });
    try {
      assert.equal(
        (
          await request("POST", `/v1/city/jobs/${jobId}/review`, "bob.testnet", {
            decision: "approve",
            note: "Please pay this unsubmitted public contract.",
          })
        ).statusCode,
        403,
      );
      await sql`update jobs set status='accepted',employee_account='bob.testnet' where id=${jobId}`;
      assert.equal(
        (
          await request("POST", `/v1/city/jobs/${jobId}/review`, "bob.testnet", {
            decision: "dispute",
            note: "Please independently review this employment dispute.",
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await request(
            "POST",
            `/v1/city/jobs/${jobId}/resolve`,
            "operator.testnet",
            { decision: "cancel", note: "Return unused wages to the original public budget." },
            true,
          )
        ).statusCode,
        403,
      );
      const resolved = await request(
        "POST",
        `/v1/city/jobs/${jobId}/resolve`,
        "moderator.testnet",
        { decision: "cancel", note: "Return unused wages to the original public budget." },
        true,
      );
      assert.equal(resolved.statusCode, 200, resolved.body);
      const refund = resolved.json().operation;
      assert.equal(
        (await request("POST", `/v1/city/operations/${refund.id}/execute`, "bob.testnet", {})).statusCode,
        403,
      );
      for (let i = 0; i < 2; i++) {
        const response = await request(
          "POST",
          `/v1/city/operations/${refund.id}/execute`,
          "moderator.testnet",
          {},
          true,
        );
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().operation.status, "unknown");
      }
      assert.equal(submissions, 1);

      await sql.begin((tx) => projectCityOperation(tx, eventFor(refund)));
      await sql.begin((tx) => projectCityOperation(tx, eventFor(refund)));
      assert.equal((await sql`select status from jobs where id=${jobId}`)[0].status, "cancelled");
      assert.equal(
        (await sql`select spent::text as n from council_budgets where category='employment'`)[0].n,
        "0",
      );
    } finally {
      await app.close();
    }
  });
});
test("tax and maintenance invoices only become paid from their exact canonical receipts", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const now = new Date("2026-11-14T12:00:00Z");
    const tax = await prepareCityCommand(
      sql,
      "alice.testnet",
      { requestId: randomUUID(), action: "tax", targetId: "1" },
      now,
    );
    assert.equal(
      (
        await prepareCityCommand(
          sql,
          "alice.testnet",
          { requestId: randomUUID(), action: "tax", targetId: "1" },
          now,
        )
      ).id,
      tax.id,
    );
    assert.equal((await sql`select paid_at from business_tax_invoices`)[0].paid_at, null);
    await sql.begin((tx) => projectCityOperation(tx, eventFor(tax)));
    await sql.begin((tx) => projectCityOperation(tx, eventFor(tax)));
    assert.ok((await sql`select paid_at from business_tax_invoices`)[0].paid_at);
    const repair = await prepareCityCommand(sql, "alice.testnet", {
      requestId: randomUUID(),
      action: "upkeep",
      targetId: "1",
    });
    await sql.begin((tx) => projectCityOperation(tx, eventFor(repair)));
    assert.equal((await sql`select condition from property_condition`)[0].condition, 100);
  });
});

import { tickNpcShopping, type NpcShoppingDeps } from "../src/npc-shopping.js";
test("NPC worker handles final rejection, hashless uncertainty, late verified receipt and replay without another payment", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql);
    const now = new Date("2026-11-14T12:00:00Z");
    await sql`update npc_runtime set activity='garden_walk',scene_id='city-district',x=5,y=8 where npc_id='professor-kofi'`;
    const unavailable: Partial<NpcShoppingDeps> = {
      view: async () => {
        throw Error("provider unavailable");
      },
    };
    await tickNpcShopping(sql, now, unavailable);
    assert.equal((await sql`select count(*)::int as n from npc_shop_visits`)[0].n, 0);
    await tickNpcShopping(sql, now, { view: async <T>() => false as T });
    let calls = 0;
    const deps: Partial<NpcShoppingDeps> = {
      view: async <T>(method: string) =>
        (method === "supports_city_economy" ? true : { revenue_total: "20" }) as T,
      submit: async () => {
        calls++;
        return { kind: "unknown", code: "CHAIN_TIMEOUT" };
      },
      balance: async (wallet) => (wallet === "biz:1" ? "520" : "980"),
    };
    await tickNpcShopping(sql, now, deps);
    await tickNpcShopping(sql, new Date(now.getTime() + 4000), deps);
    await tickNpcShopping(sql, new Date(now.getTime() + 8000), deps);
    assert.equal(calls, 1);
    let [visit] = await sql`select * from npc_shop_visits`;
    assert.equal(visit.status, "unknown");
    assert.equal((await sql`select reserved from business_items where id=${item.id}`)[0].reserved, 1);
    const event = validateEvent({
      standard: "quizcity",
      version: "1.0.0",
      event: "service_paid",
      data: [
        {
          seq: 1,
          wallet_from: "npc:professor-kofi",
          wallet_to: "biz:1",
          amount: "20",
          reference: visit.reference,
          entity_id: "business:1",
          business_id: 1,
        },
      ],
      receiptId: "late-npc-receipt",
      eventIndex: 0,
      txHash: "late-npc-hash",
      chainTimestamp: "2026-11-14T12:00:00Z",
    });
    await sql`update npc_shop_visits set tx_hash='late-npc-hash' where id=${visit.id}`;
    await tickNpcShopping(sql, new Date(now.getTime() + 12000), {
      ...deps,
      verify: async () => {
        throw Error("still unavailable");
      },
    });
    deps.verify = async () => ({ events: [event] }) as never;
    await tickNpcShopping(sql, new Date(now.getTime() + 16000), deps);
    await tickNpcShopping(sql, new Date(now.getTime() + 20000), deps);
    [visit] = await sql`select * from npc_shop_visits`;
    assert.equal(visit.status, "paid");
    assert.equal(calls, 1);
    assert.equal((await sql`select reserved from business_items where id=${item.id}`)[0].reserved, 0);
    assert.equal(
      (await sql`select count(*)::int as n from transactions where reference=${visit.reference}`)[0].n,
      1,
    );
    assert.equal(
      (await sql`select count(*)::int as n from stock_movements where npc_visit_id=${visit.id}`)[0].n,
      1,
    );
    await assert.rejects(
      sql.begin((tx) => projectNpcPurchase(tx, { ...event, data: [{ ...event.data[0], amount: "21" }] })),
      { code: "CONFLICT" },
    );
    await assert.rejects(
      sql.begin((tx) => projectNpcPurchase(tx, { ...event, receiptId: "conflict" })),
      { code: "CONFLICT" },
    );
    const tomorrow = new Date(now.getTime() + 86400000);
    await tickNpcShopping(sql, tomorrow, {
      ...deps,
      submit: async () => ({ kind: "rejected", code: "TX_FAILED", safeMessage: "Payment rejected" }),
    });
    await tickNpcShopping(sql, new Date(tomorrow.getTime() + 4000), {
      ...deps,
      submit: async () => ({ kind: "rejected", code: "TX_FAILED", safeMessage: "Payment rejected" }),
    });
    assert.equal(
      (
        await sql`select status from npc_shop_visits where day=${tomorrow.toISOString().slice(0, 10)}::date`
      )[0].status,
      "cancelled",
    );
    assert.equal((await sql`select reserved from business_items where id=${item.id}`)[0].reserved, 0);
  });
});

import { confirmCityOperation } from "../src/city-economy-routes.js";
import { refreshPropertyServices } from "../src/property-services.js";
import { refreshShopHours } from "../src/commerce.js";
test("payment confirmation consumes the verified receipt, reconciles wallets and replays without changing stock", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql),
      op = await prepareCityCommand(sql, "alice.testnet", {
        requestId: randomUUID(),
        action: "supplier",
        targetId: item.id,
        quantity: 2,
      });
    const event = eventFor(op),
      proof = { events: [event] } as never;
    const deps = {
      verify: async () => proof,
      balance: async (wallet: string) => (wallet === "biz:1" ? "496" : "4"),
      view: async <T>() => true as T,
      now: () => new Date(),
      submit: async () => ({ kind: "unknown" as const }),
    };
    await assert.rejects(confirmCityOperation(sql, "bob.testnet", op.id, "fake", deps), {
      code: "NOT_FOUND",
    });
    await confirmCityOperation(sql, "alice.testnet", op.id, event.txHash!, deps);
    await confirmCityOperation(sql, "alice.testnet", op.id, event.txHash!, deps);
    assert.equal((await sql`select on_hand from business_items where id=${item.id}`)[0].on_hand, 12);
    assert.equal((await sql`select balance::text from wallets where wallet_id='biz:1'`)[0].balance, "496");
    assert.equal((await sql`select count(*)::int as n from transaction_consumptions`)[0].n, 1);
    assert.equal((await sql`select count(*)::int as n from transactions`)[0].n, 1);
    assert.equal((await sql`select status from city_operations where id=${op.id}`)[0].status, "confirmed");
  });
});
test("public health alerts on inflation, depleted pools, stock, employer obligations and drift while diagnostics require a role", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    await sql`update business_items set on_hand=1`;
    await sql`insert into jobs(id,employer_wallet,title,description,payment,status,reference) values('health-job','npc:professor-kofi','Large commitment','An intentionally overcommitted test fixture.',2000,'open','health-job-reference')`;
    await sql`insert into quizzes(id,title,reward_pool,status) values('empty-pool','Empty prize pool',0,'live')`;
    await sql`insert into chain_event_failures(network_id,contract_id,error_code,error_message) values('testnet','quizcity.testnet','INVALID_EVENT','Safe failure')`;
    const health = await cityHealth(sql, { total_issued: "1000000001", total_burned: "0" }, true);
    for (const code of [
      "INFLATION_CAP",
      "SUPPLY_DRIFT",
      "PRIZE_POOL_EMPTY",
      "LOW_STOCK",
      "EMPLOYER_BUDGET_LOW",
      "RECONCILIATION_FAILURES",
    ])
      assert.ok(
        health.alerts.some((a: any) => a.code === code),
        code,
      );
    assert.ok(health.diagnostics.wallets.length);
    assert.ok(health.diagnostics.schedules.length);
    const { app, request } = await routes(sql);
    try {
      assert.equal((await request("GET", "/v1/city/health")).statusCode, 401);
      const publicHealth = await request("GET", "/v1/city/health", "bob.testnet");
      assert.equal(publicHealth.statusCode, 200, publicHealth.body);
      assert.equal(publicHealth.json().diagnostics, undefined);
      assert.equal((await request("GET", "/v1/city/diagnostics", "bob.testnet")).statusCode, 403);
      const privateHealth = await request(
        "GET",
        "/v1/city/diagnostics",
        "moderator.testnet",
        undefined,
        true,
      );
      assert.equal(privateHealth.statusCode, 200, privateHealth.body);
      assert.ok(privateHealth.json().diagnostics.wallets.length);
    } finally {
      await app.close();
    }
  });
});
test("maintenance renews services and restores condition without changing title; opening hours publish confirmed shop status", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql);
    const now = new Date("2026-11-14T12:00:00Z");
    await sql`insert into property_condition(property_id,last_maintained_at,utilities_paid_until) values(1,${new Date(now.getTime() - 35 * 86400000)},${new Date(now.getTime() - 1)})`;
    await refreshPropertyServices(sql, now);
    assert.equal((await sql`select condition from property_condition`)[0].condition, 75);
    await assert.rejects(reserveShopOrder(sql, "bob.testnet", item.id, 1, now), /utilities/);
    const owner = (await sql`select owner_wallet from properties where id=1`)[0].owner_wallet;
    const upkeep = await prepareCityCommand(sql, "alice.testnet", {
      requestId: randomUUID(),
      action: "upkeep",
      targetId: "1",
    });
    await sql.begin((tx) => projectCityOperation(tx, eventFor(upkeep)));
    assert.equal((await sql`select condition from property_condition`)[0].condition, 100);
    assert.equal((await sql`select owner_wallet from properties where id=1`)[0].owner_wallet, owner);
    await sql`insert into business_settings values(1,540,1020,true)`;
    await refreshShopHours(sql, new Date("2026-11-14T08:00:00Z"), "Africa/Accra");
    assert.equal((await sql`select status from businesses where id=1`)[0].status, "closed");
    await refreshShopHours(sql, now, "Africa/Accra");
    await refreshShopHours(sql, now, "Africa/Accra");
    assert.equal((await sql`select status from businesses where id=1`)[0].status, "open");
  });
});

test("owner controls, market proofs and operator budgets reject unauthorized or malformed changes", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const { app, request } = await routes(sql, {
      view: async <T>(method: string) =>
        (method === "get_property"
          ? { owner: "player:alice.testnet", price: "300", for_sale: true }
          : method === "get_business"
            ? { owner: "alice.testnet", revenue_total: "0" }
            : method === "get_business_sale_price"
              ? "0"
              : method === "get_reward_policy"
                ? { daily_cap: "5000", issued_today: "0" }
                : true) as T,
      verify: async (hash, expected) => {
        const definition = expected.events![0],
          name = definition.name;
        const data = {
          seq: 1,
          wallet_from: null,
          wallet_to: null,
          amount: "0",
          reference: `market:${expected.method}`,
          entity_id: definition.entityId,
          id: 1,
          business_id: 1,
          property_id: 1,
          owner_wallet: "player:alice.testnet",
          owner: "alice.testnet",
          listing_price: "300",
          for_sale: true,
          rent: "20",
          period_days: 7,
          source_wallet: "player:alice.testnet",
        };
        const event = validateEvent(
          JSON.parse(
            JSON.stringify({
              standard: "quizcity",
              version: "1.0.0",
              event: name,
              data: [data],
              receiptId: `control-${expected.method}`,
              eventIndex: 0,
              txHash: hash,
              chainTimestamp: "2026-11-14T12:00:00Z",
            }),
          ),
        );
        return { events: [event] } as never;
      },
    });
    const hash = "1".repeat(44);
    try {
      const hours = { openMinute: 540, closeMinute: 1020, acceptingCustomers: true };
      assert.equal((await request("POST", "/v1/city/shops/1/hours", "bob.testnet", hours)).statusCode, 403);
      assert.equal(
        (await request("POST", "/v1/city/shops/1/hours", "alice.testnet", { ...hours, closeMinute: 500 }))
          .statusCode,
        400,
      );
      assert.equal((await request("POST", "/v1/city/shops/1/hours", "alice.testnet", hours)).statusCode, 200);
      const rent = { rent: "20", periodDays: 7, active: true, txHash: hash };
      assert.equal(
        (await request("POST", "/v1/city/property/1/rent-offer", "bob.testnet", rent)).statusCode,
        403,
      );
      assert.equal(
        (await request("POST", "/v1/city/property/1/rent-offer", "alice.testnet", { ...rent, rent: "0" }))
          .statusCode,
        400,
      );
      const offer = await request("POST", "/v1/city/property/1/rent-offer", "alice.testnet", rent);
      assert.equal(offer.statusCode, 200, offer.body);
      let marketHash = 2;
      for (const [method, args] of [
        ["list_property", { property_id: 1, price: "300" }],
        ["cancel_property_listing", { property_id: 1 }],
        ["list_business", { business_id: 1, price: "20" }],
      ] as const) {
        const result = await request("POST", "/v1/city/market/1/confirm", "alice.testnet", {
          method,
          args,
          txHash: hash.slice(1) + String(marketHash++),
        });
        assert.equal(result.statusCode, 200, result.body);
      }
      assert.equal(
        (
          await request("POST", "/v1/city/market/1/confirm", "alice.testnet", {
            method: "list_property",
            args: { property_id: 2, price: "20" },
            txHash: hash,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await request("POST", "/v1/city/market/1/confirm", "alice.testnet", {
            method: "list_property",
            args: { property_id: 1, price: "20", untrusted: true },
            txHash: hash,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (await request("POST", "/v1/city/budgets/library", "bob.testnet", { ceiling: "100" })).statusCode,
        403,
      );
      assert.equal(
        (await request("POST", "/v1/city/budgets/library", "operator.testnet", { ceiling: "1000001" }, true))
          .statusCode,
        400,
      );
      assert.equal(
        (await request("POST", "/v1/city/budgets/library", "operator.testnet", { ceiling: "100" }, true))
          .statusCode,
        200,
      );
      const overview = await request("GET", "/v1/city/overview", "alice.testnet");
      assert.equal(overview.statusCode, 200, overview.body);
      assert.equal(overview.json().policy.available, true);
      assert.equal(overview.json().shops.length, 1);
    } finally {
      await app.close();
    }
  });
});
test("starter inventory is bounded across all product codes and zero-stock listings cannot create free deliveries", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    await assert.rejects(
      createShopItem(
        sql,
        "1",
        "alice.testnet",
        { sku: "another", name: "Another product", unitPrice: "1", quantity: 1 },
        10,
      ),
      /starter units/,
    );
    const empty = await createShopItem(
      sql,
      "1",
      "alice.testnet",
      { sku: "empty", name: "Awaiting paid delivery", unitPrice: "1", quantity: 0 },
      10,
    );
    assert.equal(empty.on_hand, 0);
    assert.equal(
      (await sql`select count(*)::int as n from stock_movements where item_id=${empty.id}`)[0].n,
      0,
    );
    await assert.rejects(reserveShopOrder(sql, "bob.testnet", empty.id, 1), /stock/);
  });
});

test("community question review rejects invalid content, role misuse, self approval and illegal state transitions", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const { app, request } = await routes(sql);
    const body = {
      businessId: "1",
      title: "City safety quiz",
      questions: [
        {
          question: "What keeps an account secure?",
          options: ["Private keys", "Public names"],
          correct: 0,
          source: "https://near.org/",
        },
      ],
      passScore: 1,
      entryFee: "0",
      reward: "25",
      capacity: 5,
      opensAt: "2026-11-14T11:00:00Z",
      closesAt: "2026-11-14T15:00:00Z",
    };
    try {
      const invalid = [
        { ...body, passScore: 2 },
        { ...body, entryFee: "1001" },
        { ...body, reward: "1001" },
        { ...body, closesAt: body.opensAt },
        { ...body, closesAt: "2027-12-01T00:00:00Z" },
        { ...body, questions: [{ ...body.questions[0], correct: 3 }] },
        { ...body, questions: [{ ...body.questions[0], source: "http://near.org/" }] },
      ];
      for (const payload of invalid)
        assert.equal(
          (await request("POST", "/v1/city/quizzes/drafts", "alice.testnet", payload)).statusCode,
          400,
        );
      assert.equal((await sql`select count(*)::int as n from quiz_drafts`)[0].n, 0);
      const created = await request("POST", "/v1/city/quizzes/drafts", "alice.testnet", body);
      assert.equal(created.statusCode, 200, created.body);
      const id = created.json().id;
      const review = (actor: string, decision: string, operator = false) =>
        request(
          "POST",
          `/v1/city/quizzes/drafts/${id}/review`,
          actor,
          { decision, note: "The source and answer need independent verification." },
          operator,
        );
      assert.equal((await review("bob.testnet", "submit")).statusCode, 403);
      assert.equal((await review("bob.testnet", "approve")).statusCode, 403);
      assert.equal((await review("alice.testnet", "approve", true)).statusCode, 403);
      assert.equal((await review("moderator.testnet", "approve", true)).statusCode, 409);
      assert.equal((await review("alice.testnet", "submit")).statusCode, 200);
      assert.equal((await review("moderator.testnet", "reject", true)).statusCode, 200);
      assert.equal((await review("alice.testnet", "submit")).statusCode, 403);
      assert.equal(
        (
          await request("POST", `/v1/city/quizzes/drafts/${id}/report`, "bob.testnet", {
            reason: "An unpublished draft must not accept reports.",
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            "POST",
            `/v1/city/quizzes/drafts/${randomUUID()}/review`,
            "moderator.testnet",
            { decision: "approve", note: "An unknown draft must not publish." },
            true,
          )
        ).statusCode,
        404,
      );
      assert.equal((await sql`select count(*)::int as n from quizzes`)[0].n, 0);
      assert.equal(
        (await request("POST", `/v1/city/operations/${randomUUID()}/execute`, "moderator.testnet", {}, true))
          .statusCode,
        403,
      );
    } finally {
      await app.close();
    }
  });
});

import { projectConfirmedOrder } from "../src/commerce.js";
import { tickCityReconciliation } from "../src/city-reconciler.js";
test("refunds preserve gross sales, cannot redirect funds, and record warehouse overflow honestly", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql),
      order = await reserveShopOrder(sql, "bob.testnet", item.id, 2);
    const paid = validateEvent({
      standard: "quizcity",
      version: "1.0.0",
      event: "service_paid",
      data: [
        {
          seq: 1,
          wallet_from: "player:bob.testnet",
          wallet_to: "biz:1",
          amount: "40",
          reference: order.reference,
          entity_id: "business:1",
          business_id: 1,
        },
      ],
      receiptId: "sale-receipt",
      eventIndex: 0,
      txHash: "sale-hash",
    });
    await sql.begin((tx) => projectConfirmedOrder(tx, paid));
    await assert.rejects(
      prepareCityCommand(sql, "bob.testnet", {
        requestId: randomUUID(),
        action: "refund",
        targetId: order.id,
      }),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      prepareCityCommand(sql, "bob.testnet", {
        requestId: randomUUID(),
        action: "cancel-order",
        targetId: order.id,
      }),
      /paid purchase/,
    );
    const refund = await prepareCityCommand(sql, "alice.testnet", {
      requestId: randomUUID(),
      action: "refund",
      targetId: order.id,
    });
    assert.equal(refund.args.buyer_wallet, "player:bob.testnet");
    assert.equal(refund.args.amount, "40");
    await sql`update business_items set on_hand=1000000 where id=${item.id}`;
    const data = {
      ...eventFor(refund),
      data: [{ ...eventFor(refund).data[0], order_reference: order.reference }],
    };
    await sql.begin((tx) => projectCityOperation(tx, data));
    await sql.begin((tx) => projectCityOperation(tx, data));
    assert.deepEqual(
      {
        ...(
          await sql`select quantity,restocked,discarded from inventory_returns where operation_id=${refund.id}`
        )[0],
      },
      { quantity: 2, restocked: 0, discarded: 2 },
    );
    assert.equal((await sql`select on_hand from business_items where id=${item.id}`)[0].on_hand, 1000000);
    assert.equal((await sql`select status from business_orders where id=${order.id}`)[0].status, "refunded");
  });
});
test("saved-payment reconciler backs off unknown outcomes and never submits a replacement payment", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql),
      op = await prepareCityCommand(sql, "alice.testnet", {
        requestId: randomUUID(),
        action: "supplier",
        targetId: item.id,
        quantity: 1,
      });
    let calls = 0;
    const failure = async () => {
      calls++;
      throw Error("temporarily unavailable");
    };
    await tickCityReconciliation(sql, failure);
    assert.equal(calls, 0);
    await sql`update city_operations set tx_hash='known-proof',next_check_at=null where id=${op.id}`;
    await tickCityReconciliation(sql, failure);
    assert.equal(calls, 1);
    const [pending] = await sql`select * from city_operations where id=${op.id}`;
    assert.equal(pending.status, "unknown");
    assert.equal(pending.error_code, "RECONCILIATION_PENDING");
    assert.ok(pending.next_check_at);
    await tickCityReconciliation(sql, failure);
    assert.equal(calls, 1);
    await sql`update city_operations set next_check_at=null where id=${op.id}`;
    await tickCityReconciliation(sql, async (_actor, id, hash) => {
      assert.equal(id, op.id);
      assert.equal(hash, "known-proof");
      await sql.begin((tx) => projectCityOperation(tx, eventFor(op)));
      return { operation: op };
    });
    assert.equal((await sql`select status from city_operations where id=${op.id}`)[0].status, "confirmed");
    assert.equal((await sql`select on_hand from business_items where id=${item.id}`)[0].on_hand, 11);
  });
});

test("employer review requires submitted work and independent resolution cannot bypass worker assignment", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const fund = await prepareCityCommand(sql, "alice.testnet", {
      requestId: randomUUID(),
      action: "job",
      targetId: "1",
      title: "Review a library report",
      description: "Submit an original referenced library research report.",
      amount: "30",
    });
    await sql.begin((tx) => projectCityOperation(tx, eventFor(fund)));
    const id = fund.payload.jobId,
      { app, request } = await routes(sql);
    const note = "The submitted source and work require independent review.";
    const review = (actor: string, decision: string) =>
      request("POST", `/v1/city/jobs/${id}/review`, actor, { decision, note });
    const resolve = (decision: string) =>
      request("POST", `/v1/city/jobs/${id}/resolve`, "moderator.testnet", { decision, note }, true);
    try {
      assert.equal((await review("alice.testnet", "approve")).statusCode, 409);
      assert.equal((await review("alice.testnet", "revise")).statusCode, 409);
      assert.equal((await review("alice.testnet", "cancel")).statusCode, 200);
      assert.equal((await resolve("approve")).statusCode, 409);
      assert.equal((await resolve("revise")).statusCode, 409);
      await sql`update funded_jobs set state='active' where job_id=${id}`;
      await sql`update jobs set employee_account='bob.testnet',status='submitted',deliverable='A report with documented city library sources.' where id=${id}`;
      assert.equal((await review("bob.testnet", "approve")).statusCode, 403);
      assert.equal((await review("alice.testnet", "revise")).statusCode, 200);
      assert.equal((await sql`select status from jobs where id=${id}`)[0].status, "accepted");
      assert.equal((await review("bob.testnet", "dispute")).statusCode, 200);
      assert.equal((await review("alice.testnet", "approve")).statusCode, 409);
      assert.equal((await resolve("dispute")).statusCode, 400);
      assert.equal((await resolve("revise")).statusCode, 200);
      await sql`update jobs set status='submitted' where id=${id}`;
      assert.equal((await review("alice.testnet", "approve")).statusCode, 200);
      assert.equal((await resolve("cancel")).statusCode, 409);
      assert.equal(
        (await sql`select count(*)::int as n from city_operations where kind='settlement'`)[0].n,
        0,
      );
    } finally {
      await app.close();
    }
  });
});
test("council confirmed spending settles a category once while a lower ceiling cannot erase commitments", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    await sql`update wallets set balance=100 where wallet_id='gov:council'`;
    await sql`update council_budgets set ceiling=100 where category='library'`;
    const op = await prepareCityCommand(sql, "operator.testnet", {
      requestId: randomUUID(),
      action: "budget",
      targetId: "council",
      category: "library",
      recipient: "npc:professor-kofi",
      amount: "40",
      description: "Approved public library education programme.",
    });
    const { app, request } = await routes(sql);
    try {
      assert.equal(
        (await request("POST", "/v1/city/budgets/library", "operator.testnet", { ceiling: "30" }, true))
          .statusCode,
        409,
      );
    } finally {
      await app.close();
    }
    await sql.begin((tx) => projectCityOperation(tx, eventFor(op)));
    await sql.begin((tx) => projectCityOperation(tx, eventFor(op)));
    assert.deepEqual(
      { ...(await sql`select committed::text,spent::text from council_budgets where category='library'`)[0] },
      { committed: "0", spent: "40" },
    );
  });
});

test("two paid-admission reservations contend for the last venue seat and never exceed capacity", async () => {
  await withTestSchema(async ({ sql, schema }) => {
    await setup(sql);
    const { app, request } = await routes(sql);
    try {
      const draft = await request("POST", "/v1/city/quizzes/drafts", "alice.testnet", {
        businessId: "1",
        title: "One-seat knowledge session",
        questions: [
          {
            question: "Which credential should stay private?",
            options: ["Private key", "Account name"],
            correct: 0,
            source: "https://near.org/",
          },
        ],
        passScore: 1,
        entryFee: "5",
        reward: "25",
        capacity: 1,
        opensAt: "2026-11-14T11:00:00Z",
        closesAt: "2026-11-14T15:00:00Z",
      });
      assert.equal(draft.statusCode, 200, draft.body);
      const id = draft.json().id;
      for (const [actor, decision, operator] of [
        ["alice.testnet", "submit", false],
        ["moderator.testnet", "approve", true],
      ] as const)
        assert.equal(
          (
            await request(
              "POST",
              `/v1/city/quizzes/drafts/${id}/review`,
              actor,
              { decision, note: "The independently sourced answer has been verified." },
              operator,
            )
          ).statusCode,
          200,
        );
      const fund = await prepareCityCommand(sql, "alice.testnet", {
        requestId: randomUUID(),
        action: "quiz-fund",
        targetId: id,
        amount: "50",
      });
      await sql.begin((tx) => projectCityOperation(tx, eventFor(fund)));
      const quizId = `venue-${id}`,
        now = new Date("2026-11-14T12:00:00Z");
      const outcomes = await overlap(
        sql,
        schema,
        (tx) => tx`select id from quizzes where id=${quizId} for update`,
        (client, index) =>
          prepareCityCommand(
            client,
            index ? "bob.testnet" : "carol.testnet",
            { requestId: randomUUID(), action: "admission", targetId: quizId },
            now,
          ),
      );
      assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
      assert.equal((await sql`select count(*)::int as n from quiz_admissions`)[0].n, 1);
      const [ticket] =
        await sql`select o.* from city_operations o join quiz_admissions a on a.operation_id=o.id`;
      const replay = await prepareCityCommand(
        sql,
        ticket.actor_account,
        { requestId: randomUUID(), action: "admission", targetId: quizId },
        now,
      );
      assert.equal(replay.id, ticket.id);
      await assert.rejects(
        prepareCityCommand(
          sql,
          "alice.testnet",
          { requestId: randomUUID(), action: "admission", targetId: quizId },
          now,
        ),
      );
      await assert.rejects(
        prepareCityCommand(
          sql,
          "other.testnet",
          { requestId: randomUUID(), action: "admission", targetId: quizId },
          new Date("2026-11-14T16:00:00Z"),
        ),
      );
      assert.equal((await sql`select reward_reserved::text as n from quizzes where id=${quizId}`)[0].n, "0");
    } finally {
      await app.close();
    }
  });
});
