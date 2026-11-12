import { sql } from "../src/db.js";

const tables = [
  "chain_events",
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
  "wallets",
  "players",
];

await sql.unsafe(`truncate table ${tables.join(", ")} restart identity cascade;`);
console.log("mirror reset - rebuild from contract view calls and confirmed chain events");
await sql.end();
