import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";

export type Migration = { filename: string; checksum: string; sql: string };
export type AppliedMigration = { filename: string; checksum: string };

const MIGRATION_FILENAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function migrationChecksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no migrations found in ${dir}`);
  }
  const numbers = new Map<string, string>();
  return files.map((filename) => {
    const match = MIGRATION_FILENAME.exec(filename);
    if (!match) {
      throw new Error(`invalid migration filename: ${filename} (expected NNNN_name.sql)`);
    }
    const number = match[1];
    const duplicate = numbers.get(number);
    if (duplicate) {
      throw new Error(`duplicate migration number ${number}: ${duplicate} and ${filename}`);
    }
    numbers.set(number, filename);
    const contents = readFileSync(join(dir, filename), "utf8");
    return { filename, checksum: migrationChecksum(contents), sql: contents };
  });
}

/**
 * Applied history must be an exact prefix of the ordered migration files.
 * Returns the suffix that still needs to run. Throws on checksum drift,
 * missing files, out-of-order history, or a newly added earlier migration.
 */
export function validateMigrationHistory(all: Migration[], applied: AppliedMigration[]): Migration[] {
  const ordered = [...all].sort((a, b) => a.filename.localeCompare(b.filename));
  const recorded = [...applied].sort((a, b) => a.filename.localeCompare(b.filename));

  if (recorded.length > ordered.length) {
    const extra = recorded[ordered.length]?.filename ?? "unknown";
    throw new Error(
      `refusing to migrate: applied history contains ${extra} but only ${ordered.length} migration file(s) exist`,
    );
  }

  for (let index = 0; index < recorded.length; index += 1) {
    const expected = ordered[index];
    const actual = recorded[index];
    if (!expected || actual.filename !== expected.filename) {
      const missing = expected?.filename ?? "an earlier migration";
      throw new Error(
        `refusing to migrate: applied history is not an ordered prefix; ${actual.filename} exists without ${missing}`,
      );
    }
    if (actual.checksum !== expected.checksum) {
      throw new Error(
        `refusing to migrate: applied migration checksum changed for ${actual.filename}. ` +
          "Add a new migration instead of editing history.",
      );
    }
  }

  return ordered.slice(recorded.length);
}

export interface MigrationTransaction {
  ensureRegistry(): Promise<void>;
  applied(): Promise<AppliedMigration[]>;
  apply(migration: Migration): Promise<boolean>;
}

export interface MigrationStore {
  /** Runs the whole plan inside one serialized transaction. */
  transaction<T>(run: (transaction: MigrationTransaction) => Promise<T>): Promise<T>;
}

export async function runMigrations(
  store: MigrationStore,
  migrations: Migration[],
): Promise<{ pending: Migration[]; applied: Migration[] }> {
  return store.transaction(async (transaction) => {
    await transaction.ensureRegistry();
    const pending = validateMigrationHistory(migrations, await transaction.applied());
    const applied: Migration[] = [];
    for (const migration of pending) {
      if (await transaction.apply(migration)) applied.push(migration);
    }
    return { pending, applied };
  });
}

export function postgresMigrationStore(sql: Sql): MigrationStore {
  return {
    async transaction<T>(run: (transaction: MigrationTransaction) => Promise<T>): Promise<T> {
      return (await sql.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtext('quizcity-schema-migrations'))`;
        return run({
          async ensureRegistry() {
            await transaction`
              create table if not exists schema_migrations (
                filename    text primary key,
                checksum    text not null,
                applied_at  timestamptz not null default now()
              )
            `;
          },
          async applied() {
            return transaction<AppliedMigration[]>`
              select filename, checksum from schema_migrations order by filename
            `;
          },
          async apply(migration) {
            await transaction.unsafe(migration.sql);
            const inserted = await transaction`
              insert into schema_migrations (filename, checksum)
              values (${migration.filename}, ${migration.checksum})
              on conflict (filename) do nothing
              returning filename
            `;
            return inserted.length > 0;
          },
        });
      })) as T;
    },
  };
}

export function parseResetArgs(args: string[]): { confirm: boolean; help: boolean } {
  const known = new Set(["--confirm-local-reset", "--help"]);
  const unknown = args.filter((argument) => !known.has(argument));
  if (unknown.length > 0) {
    throw new Error(`unknown reset flag(s): ${unknown.join(", ")}`);
  }
  return {
    confirm: args.includes("--confirm-local-reset"),
    help: args.includes("--help"),
  };
}

export function resetTarget(databaseUrl: string): { host: string; database: string } {
  const parsed = new URL(databaseUrl);
  return {
    host: parsed.hostname,
    database: parsed.pathname.replace(/^\//, ""),
  };
}

export function assertDestructiveResetAllowed(
  appEnv: string,
  databaseUrl: string,
  options: { confirm: boolean },
): void {
  if (appEnv !== "local" && appEnv !== "test") {
    throw new Error(`refusing destructive reset for APP_ENV=${appEnv}; only local and test are allowed`);
  }
  if (!options.confirm) {
    throw new Error("refusing destructive reset without --confirm-local-reset");
  }
  const { host, database } = resetTarget(databaseUrl);
  if (!database) {
    throw new Error("refusing destructive reset: DATABASE_URL must name a database");
  }
  if (database === "postgres" || database === "template0" || database === "template1") {
    throw new Error(`refusing destructive reset of system database ${database}`);
  }
  if (appEnv === "local" && !LOOPBACK_HOSTS.has(host)) {
    throw new Error(`refusing destructive reset: local reset requires a loopback database host, got ${host}`);
  }
}
