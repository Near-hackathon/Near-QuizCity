import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withTestSchema, connectTestClient, testDatabaseUrl } from "./db-test-utils.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { createShopItem, deliverStock, reserveShopOrder, projectConfirmedOrder } from "../src/commerce.js";
import { validateEvent } from "../src/event-validation.js";
const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
async function setup(sql: Parameters<typeof createShopItem>[0], selected = migrations) {
  await runMigrations(postgresMigrationStore(sql), selected);
  await sql`insert into properties(id,district,x,y,owner_wallet,property_type,price,for_sale) values (1,'knowledge',22,20,'player:alice.testnet','commercial',300,false)`;
  await sql`insert into businesses(id,owner_account,property_id,name,treasury_wallet) values (1,'alice.testnet',1,'City Books','biz:1')`;
  return createShopItem(sql, "1", "alice.testnet", {
    sku: "book",
    name: "City guide",
    unitPrice: "20",
    quantity: 2,
  });
}
test("catalogue ownership, exact stock ledger, fixed-price reservations and receipt replays", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql);
    await assert.rejects(
      createShopItem(sql, "1", "alice.testnet", {
        sku: "book",
        name: "Duplicate",
        unitPrice: "1",
        quantity: 10,
      }),
      { code: "CONFLICT" },
    );
    await assert.rejects(
      createShopItem(sql, "1", "bob.testnet", { sku: "rogue", name: "X", unitPrice: "1", quantity: 1 }),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(reserveShopOrder(sql, "alice.testnet", item.id, 1), { code: "FORBIDDEN" });
    const order = await reserveShopOrder(sql, "bob.testnet", item.id, 1);
    assert.equal((await reserveShopOrder(sql, "bob.testnet", item.id, 1)).id, order.id);
    await sql`update business_items set unit_price=99 where id=${item.id}`;
    assert.equal(order.total, "20");
    const event = validateEvent({
      standard: "quizcity",
      version: "1.0.0",
      event: "service_paid",
      data: [
        {
          seq: 1,
          wallet_from: "player:bob.testnet",
          wallet_to: "biz:1",
          amount: "20",
          reference: order.reference,
          entity_id: "business:1",
          business_id: 1,
        },
      ],
      txHash: "transaction-fixture",
      receiptId: "receipt-fixture",
      eventIndex: 0,
    });
    const before = await sql`select * from business_items`;
    await assert.rejects(
      sql.begin((tx) => projectConfirmedOrder(tx, { ...event, data: [{ ...event.data[0], amount: "21" }] })),
      { code: "CONFLICT" },
    );
    assert.deepEqual([...(await sql`select * from business_items`)], [...before]);
    // Submitted user hashes are only hints; they cannot block a real matching chain event.
    await sql`update business_orders set tx_hash='untrusted-hint',status='confirming' where id=${order.id}`;
    await sql.begin((tx) => projectConfirmedOrder(tx, event));
    await sql.begin((tx) => projectConfirmedOrder(tx, event));
    assert.equal((await sql`select on_hand from business_items where id=${item.id}`)[0].on_hand, 1);
    assert.equal((await sql`select count(*)::int as n from stock_movements where kind='sale'`)[0].n, 1);
    await deliverStock(sql, item.id, "alice.testnet", 5, "delivery:one");
    await deliverStock(sql, item.id, "alice.testnet", 5, "delivery:one");
    await assert.rejects(deliverStock(sql, item.id, "alice.testnet", 6, "delivery:one"), {
      code: "CONFLICT",
    });
    const [totals] =
      await sql`select i.on_hand,coalesce(sum(m.quantity),0)::int as movements from business_items i join stock_movements m on m.item_id=i.id group by i.id`;
    assert.deepEqual({ ...totals }, { on_hand: 6, movements: 6 });
    assert.equal((await sql`select count(*)::int as n from wallets`)[0].n, 0);
  });
});
test("two synchronised buyers cannot reserve the same last unit", async () => {
  await withTestSchema(async ({ sql, schema }) => {
    const item = await setup(sql);
    await sql`update business_items set on_hand=1 where id=${item.id}`;
    const a = connectTestClient(testDatabaseUrl(), schema),
      b = connectTestClient(testDatabaseUrl(), schema);
    let attempts: Promise<unknown>[] = [];
    try {
      const [pa] = await a`select pg_backend_pid() as pid`,
        [pb] = await b`select pg_backend_pid() as pid`;
      await sql.begin(async (tx) => {
        await tx`select id from business_items where id=${item.id} for update`;
        attempts = [
          reserveShopOrder(a, "bob.testnet", item.id, 1),
          reserveShopOrder(b, "carol.testnet", item.id, 1),
        ];
        const deadline = Date.now() + 10000;
        while (true) {
          const [waiting] =
            await tx`select count(*)::int as n from pg_stat_activity where pid in (${pa.pid},${pb.pid}) and wait_event_type='Lock'`;
          if (waiting.n === 2) break;
          if (Date.now() > deadline) throw Error("buyers did not overlap at item lock");
        }
      });
      const results = await Promise.allSettled(attempts);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const [state] = await sql`select on_hand,reserved from business_items where id=${item.id}`;
      assert.deepEqual({ ...state }, { on_hand: 1, reserved: 1 });
      assert.equal((await sql`select count(*)::int as n from business_orders`)[0].n, 1);
    } finally {
      await Promise.allSettled(attempts);
      await a.end();
      await b.end();
    }
  });
});

test("unfinished orders are bounded per buyer and never hide behind paid history", async () => {
  await withTestSchema(async ({ sql }) => {
    const first = await setup(sql);
    await reserveShopOrder(sql, "bob.testnet", first.id, 1);
    for (let i = 0; i < 9; i++) {
      const item = await createShopItem(sql, "1", "alice.testnet", {
        sku: `item-${i}`,
        name: `Item ${i}`,
        unitPrice: "1",
        quantity: 1,
      });
      await reserveShopOrder(sql, "bob.testnet", item.id, 1);
    }
    const extra = await createShopItem(sql, "1", "alice.testnet", {
      sku: "item-extra",
      name: "Extra",
      unitPrice: "1",
      quantity: 1,
    });
    await assert.rejects(reserveShopOrder(sql, "bob.testnet", extra.id, 1), { code: "CONFLICT" });
    assert.equal((await sql`select reserved from business_items where id=${extra.id}`)[0].reserved, 0);
    assert.equal((await sql`select count(*)::int as n from business_orders`)[0].n, 10);
  });
});

test("pending-order index upgrades existing carts, rolls back on later failure and rejects duplicate reservations", async () => {
  await withTestSchema(async ({ sql }) => {
    const item = await setup(
      sql,
      migrations.filter((m) => m.filename < "0031"),
    );
    const orderId = randomUUID();
    const [order] =
      await sql`insert into business_orders(id,buyer_account,business_id,item_id,item_name,quantity,unit_price,total,buyer_tag,reference) values (${orderId},'bob.testnet',1,${item.id},'City guide',1,20,20,'00000000000000000000000000000000',${`order:${orderId}:1:20:00000000000000000000000000000000`}) returning *`;
    await sql`update business_items set reserved=1 where id=${item.id}`;
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), [
        ...migrations,
        { filename: "9999_fixture_failure.sql", checksum: "failure", sql: "select 1/0" },
      ]),
    );
    assert.equal(
      (
        await sql`select indexname from pg_indexes where schemaname=current_schema() and indexname='business_orders_one_pending_item'`
      ).length,
      0,
    );
    await runMigrations(postgresMigrationStore(sql), migrations);
    const id = randomUUID();
    await assert.rejects(
      sql`insert into business_orders(id,buyer_account,business_id,item_id,item_name,quantity,unit_price,total,buyer_tag,reference) select ${id},buyer_account,business_id,item_id,item_name,quantity,unit_price,total,buyer_tag,'order:'||${id}::text||':'||business_id::text||':'||total::text||':'||buyer_tag from business_orders where id=${order.id}`,
      { code: "23505" },
    );
    assert.equal((await sql`select count(*)::int as n from business_orders`)[0].n, 1);
    assert.equal((await sql`select reserved from business_items where id=${item.id}`)[0].reserved, 1);
    assert.equal((await runMigrations(postgresMigrationStore(sql), migrations)).applied.length, 0);
  });
});

test("owner shop controls check current chain ownership, fail closed on outage and retain delivery replay safety", async () => {
  const { testEnv } = await import("./fixtures.js");
  Object.assign(process.env, testEnv);
  const [
    { default: Fastify },
    { registerCommerceRoutes },
    { registerErrorHandler },
    { ajvOptions, serializerOptions },
  ] = await Promise.all([
    import("fastify"),
    import("../src/commerce-routes.js"),
    import("../src/errors.js"),
    import("../src/fastify-options.js"),
  ]);
  await withTestSchema(async ({ sql }) => {
    const item = await setup(sql);
    let owner: string | null = "bob.testnet",
      outage = false;
    const app = Fastify({ ajv: { customOptions: ajvOptions }, serializerOpts: serializerOptions });
    registerErrorHandler(app);
    app.decorateRequest("auth", null);
    app.addHook("preValidation", async (req) => {
      req.auth = {
        accountId: "alice.testnet",
        roles: ["player"],
        sessionTokenHash: "fixture",
        csrfHash: "fixture",
        expiresAt: "2099-01-01",
      };
    });
    registerCommerceRoutes(app, sql, {
      readOwner: async () => {
        if (outage) throw Error("private provider detail");
        return owner;
      },
    });
    try {
      const before = await sql`select * from business_items`;
      const changed = await app.inject({
        method: "POST",
        url: `/items/${item.id}/settings`,
        payload: { unitPrice: "30", active: true },
      });
      assert.equal(changed.statusCode, 403);
      const delivered = await app.inject({
        method: "POST",
        url: `/items/${item.id}/deliveries`,
        payload: { quantity: 5, reference: "delivery:fixture" },
      });
      assert.equal(delivered.statusCode, 403);
      assert.deepEqual([...(await sql`select * from business_items`)], [...before]);
      owner = "alice.testnet";
      outage = true;
      const down = await app.inject({
        method: "POST",
        url: `/items/${item.id}/settings`,
        payload: { unitPrice: "30", active: true },
      });
      assert.equal(down.statusCode, 503);
      assert.ok(!down.body.includes("private provider detail"));
      outage = false;
      const price = await app.inject({
        method: "POST",
        url: `/items/${item.id}/settings`,
        payload: { unitPrice: "30", active: true },
      });
      assert.equal(price.statusCode, 200, price.body);
      assert.equal(price.json().unit_price, "30");
      for (let i = 0; i < 2; i++) {
        const receipt = await app.inject({
          method: "POST",
          url: `/items/${item.id}/deliveries`,
          payload: { quantity: 5, reference: "delivery:fixture" },
        });
        assert.equal(receipt.statusCode, 409, receipt.body);
        assert.match(receipt.json().error.message, /supplier/);
      }
      assert.equal((await sql`select count(*)::int as n from stock_movements where kind='delivery'`)[0].n, 0);
    } finally {
      await app.close();
    }
  });
});
