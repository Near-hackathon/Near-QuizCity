import { ignoreFailure, retryFailure } from "../src/chain-ingester.js";
import { config } from "../src/runtime-config.js";
import { sql } from "../src/db.js";

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const receiptId = get("--receipt");
const eventIndex = Number(get("--index"));
if (!receiptId || !Number.isSafeInteger(eventIndex) || eventIndex < 0) {
  console.error("usage: chain:failure --retry|--ignore --receipt <id> --index <n> [--reason <text>]");
  process.exit(2);
}
const runtime = { networkId: config.networkId, contractId: config.contractId };
if (args.includes("--retry")) {
  await retryFailure(sql, runtime, receiptId, eventIndex);
  console.log(`queued retry for ${receiptId}:${eventIndex}`);
} else if (args.includes("--ignore")) {
  // Never accept a free-form actor: the configured operator account is the
  // only identity this local database CLI can honestly attribute the action to.
  const actor = config.operatorAccount;
  const reason = get("--reason");
  if (!reason) {
    console.error("--ignore requires --reason");
    process.exit(2);
  }
  await ignoreFailure(sql, runtime, { receiptId, eventIndex, actor, reason });
  console.log(`ignored ${receiptId}:${eventIndex}`);
} else {
  console.error("one of --retry or --ignore is required");
  process.exit(2);
}
await sql.end();
