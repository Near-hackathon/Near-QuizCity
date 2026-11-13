import { ingestPage } from "../src/chain-ingester.js";
import { createHttpChainEventSource } from "../src/chain-source.js";
import { sql } from "../src/db.js";
import { config } from "../src/runtime-config.js";

const sourceUrl = process.env.CHAIN_EVENT_SOURCE_URL?.trim();
if (!sourceUrl) {
  throw new Error("CHAIN_EVENT_SOURCE_URL is required for chain ingestion");
}
const startBlock = config.chainStartBlock ?? undefined;
const source = createHttpChainEventSource({
  url: sourceUrl,
  networkId: config.networkId,
  contractId: config.contractId,
  timeoutMs: config.chainFetchTimeoutMs,
  maxRetries: config.chainMaxRetries,
});
const once = process.argv.includes("--once");

for (;;) {
  const result = await ingestPage(
    sql,
    source,
    { networkId: config.networkId, contractId: config.contractId },
    { startBlock },
  );
  console.log(
    `cursor ${result.cursor} -> ${result.nextCursor} inserted=${result.inserted} replayed=${result.replayed}`,
  );
  if (once || result.nextCursor === result.cursor) break;
}

await sql.end();
