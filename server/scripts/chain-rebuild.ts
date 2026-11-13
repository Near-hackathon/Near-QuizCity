import { rebuildMirror } from "../src/chain-ingester.js";
import { createHttpChainEventSource } from "../src/chain-source.js";
import { config } from "../src/runtime-config.js";
import { sql } from "../src/db.js";

const args = process.argv.slice(2);
const sourceUrl = process.env.CHAIN_EVENT_SOURCE_URL?.trim();
const startBlock = config.chainStartBlock;
if (!sourceUrl || !startBlock) {
  throw new Error("CHAIN_EVENT_SOURCE_URL and a canonical CHAIN_START_BLOCK are required");
}
if (config.appEnv !== "local" && config.appEnv !== "test") {
  throw new Error(`refusing rebuild for APP_ENV=${config.appEnv}; only local and test are allowed`);
}
if (!args.includes("--confirm-local-rebuild")) {
  throw new Error("refusing rebuild without --confirm-local-rebuild");
}

console.log(
  "rebuild allowlist: chain_event_failures, chain_cursors, transactions, chain_events, asset_ownership_history, wallets (delete); properties/businesses are archived then re-upserted; server-owned tables are untouched",
);
const result = await rebuildMirror(
  sql,
  createHttpChainEventSource({
    url: sourceUrl,
    networkId: config.networkId,
    contractId: config.contractId,
    timeoutMs: config.chainFetchTimeoutMs,
    maxRetries: config.chainMaxRetries,
  }),
  { networkId: config.networkId, contractId: config.contractId },
  { startBlock, pageSize: config.chainPageSize },
);
console.log(JSON.stringify(result, null, 2));
await sql.end();
if (result.difference !== "0") {
  console.error(
    `rebuild reconciliation mismatch: canonical=${result.canonicalSupply} mirrored=${result.mirroredWalletSum}`,
  );
  process.exitCode = 1;
}
