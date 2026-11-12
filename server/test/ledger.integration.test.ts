import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { insertLedgerEntries, LedgerConflictError, type LedgerEntry } from "../src/ledger.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { connectTestClient, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));

async function migrate(sql: Sql) {
  return runMigrations(postgresMigrationStore(sql), migrations);
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    networkId: "testnet",
    contractId: "quizcity.testnet",
    txHash: "tx-hash",
    receiptId: "receipt-1",
    eventIndex: 0,
    eventName: "job_reward",
    eventVersion: "1.0.0",
    walletFrom: "npc:professor-kofi",
    walletTo: "player:alice.testnet",
    amount: "100",
    reference: "job:1",
    entityType: "player",
    entityId: "alice.testnet",
    blockHeight: 100,
    blockHash: "block-hash",
    chainTimestamp: "2026-11-12T00:00:00.000Z",
    payload: {
      standard: "quizcity",
      version: "1.0.0",
      event: "job_reward",
      data: [{ seq: 1, amount: "100" }],
    },
    ...overrides,
  };
}

test("stores multiple events sharing one tx hash and preserves a 39-digit amount", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const amount = "340282366920938463463374607431768211455";
    const result = await sql.begin((transaction) =>
      insertLedgerEntries(transaction, [
        entry({ eventIndex: 0, amount }),
        entry({ eventIndex: 1, eventName: "reward_issued", entityId: "alice.testnet", amount }),
      ]),
    );
    assert.deepEqual(result, { inserted: 2, replayed: 0 });

    const rows = await sql`
      select event_index, amount::text as amount from transactions order by event_index
    `;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].amount, amount);
    assert.equal(rows[1].amount, amount);

    const [raw] = await sql`select count(*)::int as count from chain_events`;
    assert.equal(raw.count, 2);
    const [applied] = await sql`
      select count(*)::int as count from chain_events where applied = true
    `;
    assert.equal(applied.count, 2);
  });
});

test("exact replay is idempotent", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql.begin((transaction) => insertLedgerEntries(transaction, [entry()]));
    const replay = await sql.begin((transaction) => insertLedgerEntries(transaction, [entry()]));
    assert.deepEqual(replay, { inserted: 0, replayed: 1 });
    const [count] = await sql`select count(*)::int as count from transactions`;
    assert.equal(count.count, 1);
  });
});

test("conflicting amount, event name, and payload fail loudly", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql.begin((transaction) => insertLedgerEntries(transaction, [entry()]));

    for (const conflict of [
      entry({ amount: "101" }),
      entry({ eventName: "service_paid" }),
      entry({ payload: { standard: "quizcity", version: "1.0.0", event: "job_reward", data: [{ seq: 2 }] } }),
      entry({ txHash: "other-tx" }),
    ]) {
      await assert.rejects(
        sql.begin((transaction) => insertLedgerEntries(transaction, [conflict])),
        LedgerConflictError,
      );
    }

    const [count] = await sql`select count(*)::int as count from transactions`;
    assert.equal(count.count, 1);
  });
});

test("a conflict in the second event rolls back the first", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql.begin((transaction) => insertLedgerEntries(transaction, [entry()]));
    await assert.rejects(
      sql.begin((transaction) =>
        insertLedgerEntries(transaction, [entry({ eventIndex: 1 }), entry({ eventIndex: 0, amount: "999" })]),
      ),
      LedgerConflictError,
    );
    const [count] = await sql`select count(*)::int as count from transactions`;
    assert.equal(count.count, 1);
  });
});

test("database constraints reject invalid amounts and identities", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const invalidEntries = [
      entry({ eventIndex: 0, amount: "1".repeat(40) }),
      entry({ eventIndex: 1, eventName: "" }),
      entry({ eventIndex: -1 }),
    ];
    for (const invalid of invalidEntries) {
      await assert.rejects(
        sql.begin((transaction) => insertLedgerEntries(transaction, [invalid])),
        /amount|event_name|event_index|constraint|check/i,
      );
    }
  });
});

test("concurrent exact replay succeeds across two connections", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    const first = connectTestClient(url, schema);
    const second = connectTestClient(url, schema);
    try {
      const results = await Promise.all([
        first.begin((transaction) => insertLedgerEntries(transaction, [entry()])),
        second.begin((transaction) => insertLedgerEntries(transaction, [entry()])),
      ]);
      assert.equal(
        results.reduce((sum, result) => sum + result.inserted, 0),
        1,
      );
      assert.equal(
        results.reduce((sum, result) => sum + result.replayed, 0),
        1,
      );
    } finally {
      await first.end();
      await second.end();
    }
    const [raw] = await sql`select count(*)::int as count from chain_events`;
    const [projection] = await sql`select count(*)::int as count from transactions`;
    assert.equal(raw.count, 1);
    assert.equal(projection.count, 1);
  });
});

test("concurrent identity conflicts fail loudly without partial rows", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    const first = connectTestClient(url, schema);
    const second = connectTestClient(url, schema);
    try {
      const results = await Promise.allSettled([
        first.begin((transaction) => insertLedgerEntries(transaction, [entry({ amount: "100" })])),
        second.begin((transaction) => insertLedgerEntries(transaction, [entry({ amount: "999" })])),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected && rejected.status === "rejected");
      assert.ok(rejected.reason instanceof LedgerConflictError);
    } finally {
      await first.end();
      await second.end();
    }
    const [raw] = await sql`select count(*)::int as count from chain_events`;
    const [projection] = await sql`select count(*)::int as count from transactions`;
    assert.equal(raw.count, 1);
    assert.equal(projection.count, 1);
  });
});

test("concurrent payload conflicts fail loudly without partial rows", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    const first = connectTestClient(url, schema);
    const second = connectTestClient(url, schema);
    try {
      const results = await Promise.allSettled([
        first.begin((transaction) => insertLedgerEntries(transaction, [entry()])),
        second.begin((transaction) =>
          insertLedgerEntries(transaction, [
            entry({
              payload: {
                standard: "quizcity",
                version: "1.0.0",
                event: "job_reward",
                data: [{ seq: 999 }],
              },
            }),
          ]),
        ),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected && rejected.status === "rejected");
      assert.ok(rejected.reason instanceof LedgerConflictError);
    } finally {
      await first.end();
      await second.end();
    }
    const [raw] = await sql`select count(*)::int as count from chain_events`;
    const [projection] = await sql`select count(*)::int as count from transactions`;
    assert.equal(raw.count, 1);
    assert.equal(projection.count, 1);
  });
});

test("nullable block metadata is compared symmetrically in both directions", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql.begin((transaction) => insertLedgerEntries(transaction, [entry()]));
    await sql`update chain_events set block_height = null`;
    await sql`update transactions set block_height = null`;
    await assert.rejects(
      sql.begin((transaction) => insertLedgerEntries(transaction, [entry({ blockHeight: 100 })])),
      /block_height/,
    );

    await sql`update chain_events set block_height = 100`;
    await sql`update transactions set block_height = 100`;
    await assert.rejects(
      sql.begin((transaction) => insertLedgerEntries(transaction, [entry({ blockHeight: null })])),
      /block_height/,
    );
  });
});

test("changed block hash, chain timestamp, and contract id are conflicts", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql.begin((transaction) => insertLedgerEntries(transaction, [entry()]));

    await assert.rejects(
      sql.begin((transaction) => insertLedgerEntries(transaction, [entry({ blockHash: "different-block" })])),
      /block_hash/,
    );
    await assert.rejects(
      sql.begin((transaction) =>
        insertLedgerEntries(transaction, [entry({ chainTimestamp: "2026-11-13T00:00:00.000Z" })]),
      ),
      /chain_timestamp/,
    );
    await assert.rejects(
      sql.begin((transaction) => insertLedgerEntries(transaction, [entry({ contractId: "other.testnet" })])),
      /contract_id/,
    );

    await sql`update transactions set contract_id = 'other.testnet'`;
    await assert.rejects(
      sql.begin((transaction) => insertLedgerEntries(transaction, [entry()])),
      /contract_id/,
    );
  });
});
