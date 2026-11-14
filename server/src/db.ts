import postgres from "postgres";
import { config } from "./runtime-config.js";

function isPooled(connectionString: string): boolean {
  try {
    return new URL(connectionString).hostname.includes("-pooler.");
  } catch {
    return false;
  }
}

function sslOption(): "require" | false {
  return config.pgSsl === "require" ? "require" : false;
}

/**
 * Application connection. On Neon this is the pooled (`-pooler`) URL; prepared
 * statements are disabled because PgBouncer runs in transaction mode.
 */
export const sql = postgres(config.databaseUrl, {
  max: 5,
  ssl: sslOption(),
  prepare: !isPooled(config.databaseUrl),
  connect_timeout: 30,
  onnotice: () => {},
});

/**
 * Migration connection. Neon's direct URL avoids PgBouncer transaction-mode
 * limits around session state and advisory locks. Locally it falls back to
 * DATABASE_URL.
 */
export const migrationSql = postgres(config.migrationDatabaseUrl, {
  max: 1,
  ssl: sslOption(),
  prepare: !isPooled(config.migrationDatabaseUrl),
  connect_timeout: 30,
  onnotice: () => {},
});

export async function pingDb(): Promise<boolean> {
  const [row] = await sql<{ ok: number }[]>`select 1 as ok`;
  return row.ok === 1;
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
