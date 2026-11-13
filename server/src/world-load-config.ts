import { assertConfirmed, assertLocalOnly } from "./script-guards.js";
import { safeDatabaseLabel, validateTestDatabaseUrl } from "./test-database-url.js";

export type WorldLoadConfig = {
  databaseUrl: string;
  database: { host: string; port: string; database: string };
  events: number;
  replayPageSize: number;
};

export function worldLoadConfig(env: NodeJS.ProcessEnv): WorldLoadConfig {
  assertLocalOnly(env.APP_ENV ?? "", "world load test");
  assertConfirmed(env.WORLD_LOAD_CONFIRM === "1", "WORLD_LOAD_CONFIRM=1");
  const databaseUrl = validateTestDatabaseUrl(env.TEST_DATABASE_URL, env.DATABASE_URL);
  const events = Number(env.WORLD_LOAD_EVENTS ?? "100");
  if (!Number.isSafeInteger(events) || events < 1 || events > 10_000) {
    throw new Error("WORLD_LOAD_EVENTS must be an integer from 1 through 10000");
  }
  return {
    databaseUrl,
    database: safeDatabaseLabel(databaseUrl),
    events,
    replayPageSize: 200,
  };
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
