import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertDestructiveResetAllowed,
  loadMigrations,
  parseResetArgs,
  runMigrations,
  validateMigrationHistory,
  type AppliedMigration,
  type Migration,
  type MigrationStore,
} from "../src/migrations.js";

function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "quizcity-migrations-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

function withFixture(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = fixtureDir(files);
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

class MemoryStore implements MigrationStore {
  rows: string[] = [];
  migrations = new Map<string, string>();
  appliedCalls: string[] = [];

  async transaction<T>(
    run: (transaction: {
      ensureRegistry(): Promise<void>;
      applied(): Promise<AppliedMigration[]>;
      apply(migration: Migration): Promise<boolean>;
    }) => Promise<T>,
  ): Promise<T> {
    return run({
      ensureRegistry: async () => {},
      applied: async () => [...this.migrations].map(([filename, checksum]) => ({ filename, checksum })),
      apply: async (migration) => {
        this.appliedCalls.push(migration.filename);
        this.migrations.set(migration.filename, migration.checksum);
        return true;
      },
    });
  }
}

test("loads migrations in filename order with content checksums", () => {
  withFixture(
    {
      "0010_second.sql": "select 2;",
      "0002_first.sql": "select 1;",
      "notes.txt": "ignored",
    },
    (dir) => {
      const migrations = loadMigrations(dir);
      assert.deepEqual(
        migrations.map((migration) => migration.filename),
        ["0002_first.sql", "0010_second.sql"],
      );
      assert.notEqual(migrations[0].checksum, migrations[1].checksum);
      assert.match(migrations[0].checksum, /^[0-9a-f]{64}$/);
    },
  );
});

test("rejects invalid filenames, duplicate numbers, and empty directories", () => {
  withFixture({ "001_bad.sql": "select 1;" }, (dir) => {
    assert.throws(() => loadMigrations(dir), /invalid migration filename: 001_bad\.sql/);
  });
  withFixture({ "0002_one.sql": "select 1;", "0002_two.sql": "select 2;" }, (dir) => {
    assert.throws(() => loadMigrations(dir), /duplicate migration number 0002/);
  });
  withFixture({}, (dir) => {
    assert.throws(() => loadMigrations(dir), /no migrations found/);
  });
});

test("fresh database applies every migration in order", async () => {
  withFixture(
    {
      "0002_event_ledger.sql": "alter table transactions add column event_index integer;",
      "0001_initial.sql": "create table players (id text primary key);",
    },
    async (dir) => {
      const migrations = loadMigrations(dir);
      const store = new MemoryStore();
      const result = await runMigrations(store, migrations);
      assert.deepEqual(
        result.applied.map((migration) => migration.filename),
        ["0001_initial.sql", "0002_event_ledger.sql"],
      );
      assert.deepEqual(store.appliedCalls, ["0001_initial.sql", "0002_event_ledger.sql"]);
    },
  );
});

test("running migrations twice makes no changes", async () => {
  withFixture({ "0001_initial.sql": "select 1;" }, async (dir) => {
    const migrations = loadMigrations(dir);
    const store = new MemoryStore();
    await runMigrations(store, migrations);
    const second = await runMigrations(store, migrations);
    assert.deepEqual(second.pending, []);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(store.appliedCalls, ["0001_initial.sql"]);
  });
});

test("an older database upgrades without losing existing rows", async () => {
  withFixture(
    {
      "0001_initial.sql": "create table players (id text primary key);",
      "0002_event_ledger.sql": "alter table transactions add column event_index integer;",
    },
    async (dir) => {
      const migrations = loadMigrations(dir);
      const store = new MemoryStore();
      store.rows = ["existing player row"];
      store.migrations.set(migrations[0].filename, migrations[0].checksum);

      const result = await runMigrations(store, migrations);
      assert.deepEqual(
        result.applied.map((migration) => migration.filename),
        ["0002_event_ledger.sql"],
      );
      assert.deepEqual(store.rows, ["existing player row"]);
    },
  );
});

test("refuses checksum drift, missing files, and out-of-order history", () => {
  const migrations: Migration[] = [
    { filename: "0001_initial.sql", checksum: "a", sql: "" },
    { filename: "0002_event_ledger.sql", checksum: "b", sql: "" },
  ];

  assert.throws(
    () => validateMigrationHistory(migrations, [{ filename: "0001_initial.sql", checksum: "stale" }]),
    /checksum changed for 0001_initial\.sql/,
  );
  assert.throws(
    () => validateMigrationHistory(migrations, [{ filename: "0000_removed.sql", checksum: "a" }]),
    /not an ordered prefix/,
  );
  assert.throws(
    () => validateMigrationHistory(migrations, [{ filename: "0002_event_ledger.sql", checksum: "b" }]),
    /0002_event_ledger\.sql exists without 0001_initial\.sql/,
  );
  assert.throws(
    () =>
      validateMigrationHistory(migrations, [
        { filename: "0001_initial.sql", checksum: "a" },
        { filename: "0002_event_ledger.sql", checksum: "b" },
        { filename: "0003_extra.sql", checksum: "c" },
      ]),
    /contains 0003_extra\.sql but only 2 migration file/,
  );
});

test("a newly introduced lower-numbered migration is refused", () => {
  const migrations: Migration[] = [
    { filename: "0000_new.sql", checksum: "z", sql: "" },
    { filename: "0001_initial.sql", checksum: "a", sql: "" },
  ];
  assert.throws(
    () => validateMigrationHistory(migrations, [{ filename: "0001_initial.sql", checksum: "a" }]),
    /not an ordered prefix/,
  );
});

test("valid history returns only the pending suffix", () => {
  const migrations: Migration[] = [
    { filename: "0001_initial.sql", checksum: "a", sql: "" },
    { filename: "0002_event_ledger.sql", checksum: "b", sql: "" },
    { filename: "0003_hardening.sql", checksum: "c", sql: "" },
  ];
  const pending = validateMigrationHistory(migrations, [
    { filename: "0001_initial.sql", checksum: "a" },
    { filename: "0002_event_ledger.sql", checksum: "b" },
  ]);
  assert.deepEqual(
    pending.map((migration) => migration.filename),
    ["0003_hardening.sql"],
  );
});

test("reset requires local/test, explicit confirmation, and a safe target", () => {
  const local = "postgresql://user:pass@127.0.0.1:5432/quizcity";
  assert.doesNotThrow(() => assertDestructiveResetAllowed("local", local, { confirm: true }));
  assert.throws(
    () => assertDestructiveResetAllowed("local", local, { confirm: false }),
    /without --confirm-local-reset/,
  );
  assert.throws(
    () => assertDestructiveResetAllowed("staging", local, { confirm: true }),
    /only local and test/,
  );
  assert.throws(
    () => assertDestructiveResetAllowed("production", local, { confirm: true }),
    /only local and test/,
  );
  assert.throws(
    () =>
      assertDestructiveResetAllowed("local", "postgresql://u:p@db.example.com/quizcity", {
        confirm: true,
      }),
    /requires a loopback database host/,
  );
  assert.throws(
    () =>
      assertDestructiveResetAllowed("test", "postgresql://u:p@db.example.com/postgres", { confirm: true }),
    /system database postgres/,
  );
  assert.doesNotThrow(() =>
    assertDestructiveResetAllowed("test", "postgresql://u:p@db.example.com/quizcity_test", {
      confirm: true,
    }),
  );
});

test("reset argument parsing rejects unknown flags", () => {
  assert.deepEqual(parseResetArgs(["--confirm-local-reset"]), { confirm: true, help: false });
  assert.deepEqual(parseResetArgs(["--help"]), { confirm: false, help: true });
  assert.throws(() => parseResetArgs(["--force"]), /unknown reset flag\(s\): --force/);
});
