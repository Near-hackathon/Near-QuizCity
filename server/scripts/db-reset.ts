import { sql } from "../src/db.js";
import { assertDestructiveResetAllowed, parseResetArgs, resetTarget } from "../src/migrations.js";
import { config } from "../src/runtime-config.js";

let args: { confirm: boolean; help: boolean };
try {
  args = parseResetArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

if (args.help) {
  console.log(`Usage: node --env-file=.env --import tsx scripts/db-reset.ts --confirm-local-reset

Destructive: truncates the Quiz City read-model tables. Requires APP_ENV=local|test,
an explicit --confirm-local-reset flag, and (for local) a loopback database host.`);
  process.exit(0);
}

const target = resetTarget(config.databaseUrl);
try {
  assertDestructiveResetAllowed(config.appEnv, config.databaseUrl, args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`resetting ${target.database} on ${target.host} (APP_ENV=${config.appEnv})`);

const tables = [
  "player_presence",
  "world_events",
  "npc_runtime",
  "npc_schedules",
  "spawn_points",
  "buildings",
  "scenes",
  "quiz_reward_claims",
  "quiz_attempt_questions",
  "economy_snapshots",
  "npc_state",
  "market_listings",
  "quiz_attempts",
  "quizzes",
  "quiz_questions",
  "jobs",
  "businesses",
  "properties",
  "transactions",
  "chain_events",
  "wallets",
  "players",
];

await sql.unsafe(`truncate table ${tables.join(", ")} restart identity cascade;`);
console.log("mirror reset - rebuild from contract view calls and confirmed chain events");
await sql.end();
