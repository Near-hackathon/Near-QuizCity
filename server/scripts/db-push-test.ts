import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { safeDatabaseLabel, validateTestDatabaseUrl } from "../src/test-database-url.js";

let databaseUrl: string;
try {
  databaseUrl = validateTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const target = safeDatabaseLabel(databaseUrl);
const here = dirname(fileURLToPath(import.meta.url));
const migrations = loadMigrations(join(here, "..", "db", "migrations"));
const sql = postgres(databaseUrl, { max: 1, ssl: false, onnotice: () => {} });
try {
  const result = await runMigrations(postgresMigrationStore(sql), migrations);
  console.log(
    `test database ${target.database}@${target.host}:${target.port}: ` +
      `${result.applied.length} applied, ${migrations.length} known`,
  );
} finally {
  await sql.end();
}
