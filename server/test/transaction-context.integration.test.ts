import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { AppError } from "../src/errors.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { consumeTransaction, type TransactionContext } from "../src/transaction-context.js";
import { withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));

async function migrate(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

const base: TransactionContext = {
  networkId: "testnet",
  contractId: "quizcity.testnet",
  txHash: "x".repeat(44),
  commandType: "buy_property",
  entityType: "property",
  entityId: "1",
  signerId: "alice.testnet",
  receiptId: "receipt-1",
  eventIndex: 0,
};

test("exact proof replay is idempotent and every identity change conflicts", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const first = await sql.begin((transaction) => consumeTransaction(transaction, base));
    assert.equal(first.replay, false);

    const replay = await sql.begin((transaction) => consumeTransaction(transaction, base));
    assert.equal(replay.replay, true);

    for (const change of [
      { entityId: "2" },
      { signerId: "bob.testnet" },
      { receiptId: "receipt-2" },
      { eventIndex: 1 },
      { commandType: "pay_service" },
    ]) {
      await assert.rejects(
        sql.begin((transaction) => consumeTransaction(transaction, { ...base, ...change })),
        (error: unknown) => error instanceof AppError && error.code === "TX_ALREADY_CONSUMED",
      );
    }
  });
});

test("a rolled-back consumption leaves the transaction unconsumed", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await assert.rejects(
      sql.begin(async (transaction) => {
        await consumeTransaction(transaction, base);
        throw new Error("rollback");
      }),
      /rollback/,
    );
    const [count] = await sql`select count(*)::int as count from transaction_consumptions`;
    assert.equal(count.count, 0);
  });
});

test("database constraints reject oversized consumption identities", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await assert.rejects(
      sql.begin((transaction) => consumeTransaction(transaction, { ...base, commandType: "c".repeat(100) })),
      /check constraint|too long|value too long/i,
    );
  });
});
