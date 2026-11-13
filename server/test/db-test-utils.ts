import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { validateTestDatabaseUrl } from "../src/test-database-url.js";

export { validateTestDatabaseUrl } from "../src/test-database-url.js";

const SCHEMA_PATTERN = /^quizcity_test_[0-9a-f]{16}$/;

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
