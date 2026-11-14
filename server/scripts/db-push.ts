import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationSql as sql } from "../src/db.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = loadMigrations(join(here, "..", "db", "migrations"));

const result = await runMigrations(postgresMigrationStore(sql), migrations);
if (result.applied.length === 0) {
  console.log(`database is up to date (${migrations.length} migration(s) known)`);
} else {
  for (const migration of result.applied) {
    console.log(`applied ${migration.filename}`);
  }
}
await sql.end();
