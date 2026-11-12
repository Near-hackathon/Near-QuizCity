import { randomBytes } from "node:crypto";
import postgres from "postgres";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const SCHEMA_PATTERN = /^quizcity_test_[0-9a-f]{16}$/;

/**
 * Integration tests use a dedicated disposable database. Refuse anything that
 * is not clearly a local test target so a stray production URL cannot be
 * truncated or used to create schemas.
 */
export function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_URL is required for PostgreSQL integration tests. " +
        "Point it at a disposable local test database, never staging or production.",
    );
  }
  const parsed = new URL(raw);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use the postgres:// or postgresql:// scheme");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`refusing database integration tests against non-loopback host ${parsed.hostname}`);
  }
  return raw;
}

export type TestDatabase = {
  sql: ReturnType<typeof postgres>;
  schema: string;
};

export async function withTestSchema(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  const url = testDatabaseUrl();
  const schema = `quizcity_test_${randomBytes(8).toString("hex")}`;
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new Error(`refusing unsafe test schema name ${schema}`);
  }
  const sql = postgres(url, { max: 1, ssl: false, onnotice: () => {} });
  try {
    await sql.unsafe(`create schema ${schema}`);
    await sql.unsafe(`set search_path to ${schema}`);
    await run({ sql, schema });
  } finally {
    try {
      await sql.unsafe(`drop schema if exists ${schema} cascade`);
    } finally {
      await sql.end();
    }
  }
}

export function connectTestClient(url: string, schema?: string): ReturnType<typeof postgres> {
  return postgres(url, {
    max: 1,
    ssl: false,
    onnotice: () => {},
    connection: schema ? { search_path: schema } : undefined,
  });
}

export function connectTestPool(url: string, schema?: string, max = 10): ReturnType<typeof postgres> {
  return postgres(url, {
    max,
    ssl: false,
    onnotice: () => {},
    connection: schema ? { search_path: schema } : undefined,
  });
}
