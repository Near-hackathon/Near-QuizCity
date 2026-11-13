import { randomBytes } from "node:crypto";
import postgres from "postgres";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const SCHEMA_PATTERN = /^quizcity_test_[0-9a-f]{16}$/;
const TEST_DATABASE_PATTERN = /^quizcity_test(?:_[a-z0-9_]+)?$/;

function databaseTarget(url: URL): { host: string; port: string; database: string } {
  return {
    host: url.hostname,
    port: url.port || "5432",
    database: url.pathname.replace(/^\//, ""),
  };
}

/**
 * Integration and E2E tests require an explicitly selected disposable database.
 * There is deliberately no fallback to the normal DATABASE_URL.
 */
export function validateTestDatabaseUrl(rawValue: string | undefined, devValue?: string): string {
  const raw = rawValue?.trim();
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_URL is required for PostgreSQL integration tests. " +
        "Use an explicit disposable local test database; there is no DATABASE_URL fallback.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use the postgres:// or postgresql:// scheme");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`refusing database integration tests against non-loopback host ${parsed.hostname}`);
  }
  const target = databaseTarget(parsed);
  if (!target.database) {
    throw new Error("TEST_DATABASE_URL must name a database");
  }
  if (!TEST_DATABASE_PATTERN.test(target.database)) {
    throw new Error(
      `TEST_DATABASE_URL must name a dedicated test database such as quizcity_test (got ${target.database})`,
    );
  }
  const dev = devValue?.trim();
  if (dev) {
    try {
      const devTarget = databaseTarget(new URL(dev));
      if (
        devTarget.host === target.host &&
        devTarget.port === target.port &&
        devTarget.database === target.database
      ) {
        throw new Error("TEST_DATABASE_URL must not point at the configured DATABASE_URL database");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("TEST_DATABASE_URL must not")) throw error;
      // An invalid development URL does not make an otherwise valid test URL unsafe.
    }
  }
  return raw;
}

export function testDatabaseUrl(): string {
  return validateTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
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
