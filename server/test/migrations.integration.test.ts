import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadMigrations, postgresMigrationStore, runMigrations, type Migration } from "../src/migrations.js";
import { connectTestClient, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
const realMigrations = loadMigrations(migrationsDir);

test("fresh database applies every migration and records exact checksums", async () => {
  await withTestSchema(async ({ sql }) => {
    const first = await runMigrations(postgresMigrationStore(sql), realMigrations);
    assert.deepEqual(
      first.applied.map((migration) => migration.filename),
      realMigrations.map((migration) => migration.filename),
    );

    const registry = await sql<{ filename: string; checksum: string }[]>`
      select filename, checksum from schema_migrations order by filename
    `;
    assert.deepEqual(
      [...registry].map((row) => ({ filename: row.filename, checksum: row.checksum })),
      realMigrations.map((migration) => ({
        filename: migration.filename,
        checksum: migration.checksum,
      })),
    );

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = current_schema()
    `;
    const names = new Set(tables.map((table) => table.table_name));
    for (const name of ["players", "wallets", "transactions", "schema_migrations"]) {
      assert.ok(names.has(name), `${name} should exist`);
    }

    const second = await runMigrations(postgresMigrationStore(sql), realMigrations);
    assert.deepEqual(second.pending, []);
    assert.deepEqual(second.applied, []);
  });
});

test("a pre-migration schema upgrades without losing rows", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), [realMigrations[0]]);

    await sql`insert into players (account_id, username) values (${"alice.testnet"}, ${"alice"})`;
    await sql`
      insert into wallets (wallet_id, owner_type, owner_id, balance)
      values (${"player:alice.testnet"}, ${"player"}, ${"alice.testnet"}, 500)
    `;
    await sql`
      insert into transactions (tx_hash, wallet_from, wallet_to, amount, kind, reference)
      values (${"legacy-tx"}, ${"system:mint"}, ${"player:alice.testnet"}, 500, ${"starter_allowance"}, ${"alice.testnet"})
    `;
    await sql`
      insert into chain_events (receipt_id, tx_hash, event, payload)
      values (${"legacy-receipt"}, ${"legacy-tx"}, ${"starter_allowance"}, ${sql.json({ legacy: true })})
    `;

    const result = await runMigrations(postgresMigrationStore(sql), realMigrations);
    assert.ok(result.applied.length >= 1);

    const [player] = await sql`select account_id from players`;
    assert.equal(player.account_id, "alice.testnet");
    const [wallet] = await sql`select balance from wallets`;
    assert.equal(Number(wallet.balance), 500);
    const [tx] = await sql`select receipt_id, network_id, wallet_from from transactions`;
    assert.match(tx.receipt_id, /^legacy:/);
    assert.equal(tx.network_id, "legacy");
    assert.equal(tx.wallet_from, null);
    const [event] = await sql`select network_id, event_index from chain_events`;
    assert.equal(event.network_id, "legacy");
    assert.equal(event.event_index, 0);
  });
});

test("dead-letter source repair refuses an ambiguous legacy cursor source", async () => {
  await withTestSchema(async ({ sql }) => {
    const repairIndex = realMigrations.findIndex(
      (migration) => migration.filename === "0019_dead_letter_source_repair.sql",
    );
    assert.ok(repairIndex > 0, "source repair migration must exist after the audit migration");
    await runMigrations(postgresMigrationStore(sql), realMigrations.slice(0, repairIndex));
    await sql`
      insert into chain_cursors (
        network_id, contract_id, source, next_cursor, last_finalized_block
      ) values
        ('testnet', 'quizcity.testnet', 'source-a', '10', 9),
        ('testnet', 'quizcity.testnet', 'source-b', '10', 9)
    `;
    await sql`
      insert into chain_event_failures (
        network_id, contract_id, source, receipt_id, event_index,
        block_height, error_code, error_message
      ) values (
        'testnet', 'quizcity.testnet', 'source-a', 'receipt', 0,
        '10', 'DEAD_LETTER', 'legacy failure'
      )
    `;

    await runMigrations(postgresMigrationStore(sql), realMigrations);
    const [failure] = await sql`select source from chain_event_failures where receipt_id = 'receipt'`;
    assert.equal(failure.source, null);
  });
});

test("checksum drift is rejected before any new migration runs", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), [realMigrations[0]]);
    const changed: Migration = { ...realMigrations[0], checksum: "0".repeat(64) };
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), [changed, ...realMigrations.slice(1)]),
      /checksum changed/,
    );
    const columns = await sql`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = ${"transactions"}
    `;
    assert.equal(
      columns.some((column) => column.column_name === "network_id"),
      false,
    );
  });
});

test("missing and out-of-order applied histories are rejected", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), realMigrations);
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), realMigrations.slice(0, -1)),
      /applied history contains/,
    );
  });

  await withTestSchema(async ({ sql }) => {
    await sql`
      create table schema_migrations (
        filename text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `;
    const last = realMigrations[realMigrations.length - 1];
    await sql`
      insert into schema_migrations (filename, checksum) values (${last.filename}, ${last.checksum})
    `;
    await assert.rejects(runMigrations(postgresMigrationStore(sql), realMigrations), /not an ordered prefix/);
  });
});

test("concurrent runners serialize and apply each migration once", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ schema }) => {
    const migrations: Migration[] = [
      {
        filename: "0001_concurrency.sql",
        checksum: "a",
        sql: "create table concurrency_probe (id integer); select pg_sleep(0.3);",
      },
      {
        filename: "0002_concurrency.sql",
        checksum: "b",
        sql: "create table concurrency_probe_two (id integer);",
      },
    ];
    const first = connectTestClient(url, schema);
    const second = connectTestClient(url, schema);
    try {
      const [resultA, resultB] = await Promise.all([
        runMigrations(postgresMigrationStore(first), migrations),
        runMigrations(postgresMigrationStore(second), migrations),
      ]);
      assert.equal(resultA.applied.length + resultB.applied.length, 2);
      const [registry] = await first<{ count: number }[]>`
        select count(*)::int as count from schema_migrations
      `;
      assert.equal(registry.count, 2);
    } finally {
      await first.end();
      await second.end();
    }
  });
});

test("a failing later migration rolls back the whole run", async () => {
  await withTestSchema(async ({ sql }) => {
    const migrations: Migration[] = [
      {
        filename: "0001_rollback.sql",
        checksum: "a",
        sql: "create table rollback_probe (id integer);",
      },
      {
        filename: "0002_rollback.sql",
        checksum: "b",
        sql: "create table broken (",
      },
    ];
    await assert.rejects(runMigrations(postgresMigrationStore(sql), migrations));
    const [probe] = await sql`select to_regclass('rollback_probe') as relation`;
    assert.equal(probe.relation, null);
    const [registryTable] = await sql`select to_regclass('schema_migrations') as relation`;
    if (registryTable.relation !== null) {
      const [registry] = await sql`select count(*)::int as count from schema_migrations`;
      assert.equal(registry.count, 0);
    }
  });
});
