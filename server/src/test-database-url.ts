const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TEST_DATABASE_PATTERN = /^quizcity_test(?:_[a-z0-9_]+)?$/;

function databaseTarget(url: URL): { host: string; port: string; database: string } {
  return {
    host: url.hostname,
    port: url.port || "5432",
    database: url.pathname.replace(/^\//, ""),
  };
}

/** Validate an explicitly selected, loopback-only disposable test database. */
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
  if (!target.database) throw new Error("TEST_DATABASE_URL must name a database");
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
    }
  }
  return raw;
}

export function safeDatabaseLabel(raw: string): { host: string; port: string; database: string } {
  return databaseTarget(new URL(raw));
}
