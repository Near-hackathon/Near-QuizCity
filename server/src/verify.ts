import { providers } from "near-api-js";
import { config } from "./runtime-config.js";

type FinalExecutionOutcome = Awaited<ReturnType<providers.JsonRpcProvider["txStatus"]>>;

const provider = new providers.JsonRpcProvider({ url: config.rpcUrl });

const TX_HASH_PATTERN = /^[A-Za-z0-9]{43,44}$/;

export async function assertTxSucceeded(txHash: string, signerId: string): Promise<FinalExecutionOutcome> {
  if (!TX_HASH_PATTERN.test(txHash)) {
    throw new Error("invalid transaction hash");
  }
  let outcome: FinalExecutionOutcome;
  try {
    outcome = await Promise.race([
      provider.txStatus(txHash, signerId, "FINAL"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("tx status timeout")), 8000),
      ),
    ]);
  } catch {
    const error = new Error("transaction not found on chain") as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  if (outcome.transaction?.signer_id && outcome.transaction.signer_id !== signerId) {
    throw new Error("transaction was not signed by the expected account");
  }
  const status = outcome.status as Record<string, unknown>;
  if (!("SuccessValue" in status)) {
    throw new Error("transaction did not succeed");
  }
  return outcome;
}

import type { ChainEvent } from "./event-ledger.js";

export function parseEvents(outcome: FinalExecutionOutcome): ChainEvent[] {
  const events: ChainEvent[] = [];
  for (const receipt of outcome.receipts_outcome ?? []) {
    if (receipt.outcome?.executor_id && receipt.outcome.executor_id !== config.contractId) {
      continue;
    }
    for (const log of receipt.outcome?.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const parsed = JSON.parse(log.slice("EVENT_JSON:".length)) as ChainEvent;
        if (parsed && Array.isArray(parsed.data)) events.push(parsed);
      } catch {
        // ignore non-event logs
      }
    }
  }
  return events;
}
