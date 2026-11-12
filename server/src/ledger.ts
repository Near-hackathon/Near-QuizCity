import type { Sql, TransactionSql } from "postgres";
import { EVENT_STANDARD, EVENT_VERSION, type ChainEvent } from "./event-ledger.js";
import { U128_MAX } from "./event-validation.js";

export type LedgerContext = { networkId: string; contractId: string };

export type LedgerEntry = {
  networkId: string;
  contractId: string;
  txHash: string | null;
  receiptId: string;
  eventIndex: number;
  eventName: string;
  eventVersion: string | null;
  walletFrom: string | null;
  walletTo: string | null;
  amount: string;
  reference: string | null;
  entityType: string | null;
  entityId: string | null;
  blockHeight: number | null;
  blockHash: string | null;
  chainTimestamp: string | null;
  payload: unknown;
};

export type LedgerInsertResult = { inserted: number; replayed: number };

export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerConflictError";
  }
}

export function ledgerEntity(entityId: unknown): { entityType: string | null; entityId: string | null } {
  if (typeof entityId !== "string" || entityId.length === 0) {
    return { entityType: null, entityId: null };
  }
  const separator = entityId.indexOf(":");
  if (separator < 1) return { entityType: null, entityId };
  return {
    entityType: entityId.slice(0, separator),
    entityId: entityId.slice(separator + 1) || null,
  };
}

/** The natural key that replaces the old single-row-per-tx-hash assumption. */
export function ledgerEntryKey(entry: Pick<LedgerEntry, "networkId" | "receiptId" | "eventIndex">): string {
  return `${entry.networkId}:${entry.receiptId}:${entry.eventIndex}`;
}

/**
 * Maps one canonical contract event to one immutable ledger row. Issuance is
 * `walletFrom = null`; burn is `walletTo = null`. Non-canonical logs are skipped.
 */
export function ledgerEntryFromEvent(event: ChainEvent, context: LedgerContext): LedgerEntry | null {
  if (event.standard !== EVENT_STANDARD || event.version !== EVENT_VERSION) return null;
  const data = event.data[0];
  if (!data) return null;
  if (typeof event.receiptId !== "string" || !Number.isInteger(event.eventIndex)) {
    throw new Error("canonical ledger event is missing receipt/event identity");
  }
  const amount = typeof data.amount === "string" ? data.amount : String(data.amount ?? "0");
  if (!/^(0|[1-9]\d*)$/.test(amount) || BigInt(amount) > U128_MAX) {
    throw new Error(`invalid ledger amount in ${event.event} event`);
  }
  const entity = ledgerEntity(data.entity_id);
  return {
    networkId: context.networkId,
    contractId: context.contractId,
    txHash: event.txHash ?? null,
    receiptId: event.receiptId,
    eventIndex: event.eventIndex as number,
    eventName: event.event,
    eventVersion: event.version ?? null,
    walletFrom: typeof data.wallet_from === "string" ? data.wallet_from : null,
    walletTo: typeof data.wallet_to === "string" ? data.wallet_to : null,
    amount,
    reference: typeof data.reference === "string" ? data.reference : null,
    entityType: entity.entityType,
    entityId: entity.entityId,
    blockHeight: event.blockHeight ?? null,
    blockHash: event.blockHash ?? null,
    chainTimestamp: event.chainTimestamp ?? null,
    payload: event.payload ?? event,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameTimestamp(left: unknown, right: string | null): boolean {
  if (left === null || left === undefined) return right === null;
  if (right === null) return false;
  const leftDate = left instanceof Date ? left : new Date(String(left));
  const rightDate = new Date(right);
  if (Number.isNaN(leftDate.getTime()) || Number.isNaN(rightDate.getTime())) return false;
  return leftDate.toISOString() === rightDate.toISOString();
}

function requireNonEmpty(value: string | null, field: string): void {
  if (value === null || value.length === 0) {
    throw new LedgerConflictError(`ledger ${field} must not be empty`);
  }
}

function validateEntry(entry: LedgerEntry): void {
  requireNonEmpty(entry.networkId, "network_id");
  requireNonEmpty(entry.contractId, "contract_id");
  requireNonEmpty(entry.receiptId, "receipt_id");
  requireNonEmpty(entry.eventName, "event_name");
  requireNonEmpty(entry.eventVersion, "event_version");
  if (!Number.isSafeInteger(entry.eventIndex) || entry.eventIndex < 0) {
    throw new LedgerConflictError("ledger event_index must be a non-negative safe integer");
  }
  if (!/^(0|[1-9]\d*)$/.test(entry.amount) || BigInt(entry.amount) > U128_MAX) {
    throw new LedgerConflictError("ledger amount is not a valid U128 string");
  }
  if (entry.payload === null || typeof entry.payload !== "object") {
    throw new LedgerConflictError("ledger payload must be a canonical event object");
  }
}

function sameNullableText(existing: unknown, expected: string | null): boolean {
  if (existing === null || existing === undefined) return expected === null;
  return expected !== null && String(existing) === expected;
}

function sameNullableNumber(existing: unknown, expected: number | null): boolean {
  if (expected === null) return existing === null || existing === undefined;
  if (existing === null || existing === undefined) return false;
  const value = Number(existing);
  return Number.isSafeInteger(value) && value === expected;
}

function assertRawMatches(existing: Record<string, unknown>, entry: LedgerEntry): void {
  const mismatches: string[] = [];
  if (existing.contract_id !== entry.contractId) mismatches.push("contract_id");
  if (!sameNullableText(existing.tx_hash, entry.txHash)) mismatches.push("tx_hash");
  if (existing.event_name !== entry.eventName) mismatches.push("event_name");
  if (existing.event_version !== entry.eventVersion) mismatches.push("event_version");
  if (!sameNullableNumber(existing.block_height, entry.blockHeight)) mismatches.push("block_height");
  if (!sameNullableText(existing.block_hash, entry.blockHash)) mismatches.push("block_hash");
  if (stableJson(existing.payload) !== stableJson(entry.payload)) mismatches.push("payload");
  if (mismatches.length > 0) {
    throw new LedgerConflictError(
      `raw ledger identity conflict for ${ledgerEntryKey(entry)}: ${mismatches.join(", ")}`,
    );
  }
}

function assertExistingProjectionMatches(existing: Record<string, unknown>, entry: LedgerEntry): void {
  const mismatches: string[] = [];
  if (existing.contract_id !== entry.contractId) mismatches.push("contract_id");
  if (!sameNullableText(existing.tx_hash, entry.txHash)) mismatches.push("tx_hash");
  if (existing.event_name !== entry.eventName) mismatches.push("event_name");
  if (existing.event_version !== entry.eventVersion) mismatches.push("event_version");
  if (!sameNullableText(existing.wallet_from, entry.walletFrom)) mismatches.push("wallet_from");
  if (!sameNullableText(existing.wallet_to, entry.walletTo)) mismatches.push("wallet_to");
  if (String(existing.amount) !== entry.amount) mismatches.push("amount");
  if (!sameNullableText(existing.reference, entry.reference)) mismatches.push("reference");
  if (!sameNullableText(existing.entity_type, entry.entityType)) mismatches.push("entity_type");
  if (!sameNullableText(existing.entity_id, entry.entityId)) mismatches.push("entity_id");
  if (!sameNullableNumber(existing.block_height, entry.blockHeight)) mismatches.push("block_height");
  if (!sameNullableText(existing.block_hash, entry.blockHash)) mismatches.push("block_hash");
  if (!sameTimestamp(existing.chain_timestamp, entry.chainTimestamp)) {
    mismatches.push("chain_timestamp");
  }
  if (stableJson(existing.payload) !== stableJson(entry.payload)) mismatches.push("payload");
  if (mismatches.length > 0) {
    throw new LedgerConflictError(
      `ledger identity conflict for ${ledgerEntryKey(entry)}: ${mismatches.join(", ")}`,
    );
  }
}

export type LedgerSql = Sql | TransactionSql;

/**
 * Inserts raw events and their normalized projection atomically. Exact replays
 * are idempotent, including concurrent replays: inserts use
 * `on conflict do nothing`, then the existing row is compared in the same
 * transaction. Any immutable field mismatch rolls back the whole batch.
 * The caller must provide a transaction-scoped client.
 */
export async function insertLedgerEntries(
  transaction: LedgerSql,
  entries: LedgerEntry[],
): Promise<LedgerInsertResult> {
  for (const entry of entries) validateEntry(entry);
  if (entries.length === 0) return { inserted: 0, replayed: 0 };

  let inserted = 0;
  let replayed = 0;

  for (const entry of entries) {
    const [insertedRaw] = await transaction<Record<string, unknown>[]>`
      insert into chain_events (
        network_id, contract_id, receipt_id, event_index, event_name, event_version,
        tx_hash, block_height, block_hash, event, payload, applied
      ) values (
        ${entry.networkId}, ${entry.contractId}, ${entry.receiptId}, ${entry.eventIndex},
        ${entry.eventName}, ${entry.eventVersion}, ${entry.txHash}, ${entry.blockHeight},
        ${entry.blockHash}, ${entry.eventName},
        ${transaction.json(entry.payload as Parameters<typeof transaction.json>[0])}, false
      )
      on conflict (network_id, receipt_id, event_index) do nothing
      returning contract_id, event_name, event_version, tx_hash, block_height, block_hash, payload
    `;

    if (!insertedRaw) {
      const [existingRaw] = await transaction<Record<string, unknown>[]>`
        select contract_id, event_name, event_version, tx_hash, block_height, block_hash, payload
        from chain_events
        where network_id = ${entry.networkId}
          and receipt_id = ${entry.receiptId}
          and event_index = ${entry.eventIndex}
        for update
      `;
      if (!existingRaw) {
        throw new LedgerConflictError(`raw ledger row disappeared for ${ledgerEntryKey(entry)}`);
      }
      assertRawMatches(existingRaw, entry);
    }

    const [insertedProjection] = await transaction<Record<string, unknown>[]>`
      insert into transactions (
        network_id, contract_id, tx_hash, receipt_id, event_index, event_name, event_version,
        wallet_from, wallet_to, amount, kind, reference, entity_type, entity_id,
        block_height, block_hash, chain_timestamp, payload
      ) values (
        ${entry.networkId}, ${entry.contractId}, ${entry.txHash}, ${entry.receiptId},
        ${entry.eventIndex}, ${entry.eventName}, ${entry.eventVersion}, ${entry.walletFrom},
        ${entry.walletTo}, ${entry.amount}, ${entry.eventName}, ${entry.reference},
        ${entry.entityType}, ${entry.entityId}, ${entry.blockHeight}, ${entry.blockHash},
        ${entry.chainTimestamp}, ${transaction.json(entry.payload as Parameters<typeof transaction.json>[0])}
      )
      on conflict (network_id, receipt_id, event_index) do nothing
      returning seq
    `;

    if (insertedProjection) {
      inserted += 1;
    } else {
      const [existing] = await transaction<Record<string, unknown>[]>`
        select contract_id, tx_hash, event_name, event_version, wallet_from, wallet_to, amount,
               reference, entity_type, entity_id, block_height, block_hash, chain_timestamp, payload
        from transactions
        where network_id = ${entry.networkId}
          and receipt_id = ${entry.receiptId}
          and event_index = ${entry.eventIndex}
        for update
      `;
      if (!existing) {
        throw new LedgerConflictError(`ledger projection disappeared for ${ledgerEntryKey(entry)}`);
      }
      assertExistingProjectionMatches(existing, entry);
      replayed += 1;
    }

    await transaction`
      update chain_events set applied = true
      where network_id = ${entry.networkId}
        and receipt_id = ${entry.receiptId}
        and event_index = ${entry.eventIndex}
    `;
  }

  return { inserted, replayed };
}
