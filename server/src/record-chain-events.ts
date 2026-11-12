import { sql } from "./db.js";
import {
  insertLedgerEntries,
  ledgerEntryFromEvent,
  type LedgerEntry,
  type LedgerInsertResult,
  type LedgerSql,
} from "./ledger.js";
import type { ValidatedEvent } from "./event-validation.js";
import { config } from "./runtime-config.js";

export function ledgerEntriesFromEvents(events: ValidatedEvent[]): LedgerEntry[] {
  const context = { networkId: config.networkId, contractId: config.contractId };
  return events
    .map((event) => ledgerEntryFromEvent(event, context))
    .filter((entry): entry is LedgerEntry => entry !== null);
}

/** Inserts events using a caller-owned transaction. */
export async function recordVerifiedEventsIn(
  client: LedgerSql,
  events: ValidatedEvent[],
): Promise<LedgerInsertResult> {
  return insertLedgerEntries(client, ledgerEntriesFromEvents(events));
}

/**
 * Persists only already-verified, strictly validated canonical events. Raw
 * outcomes must pass through verify.ts first; this function never parses
 * arbitrary transaction output.
 */
export async function recordVerifiedEvents(events: ValidatedEvent[]): Promise<LedgerInsertResult> {
  const entries = ledgerEntriesFromEvents(events);
  return sql.begin(async (transaction) => insertLedgerEntries(transaction, entries));
}
