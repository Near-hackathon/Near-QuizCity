import type { Sql, TransactionSql } from "postgres";
import { addQc, differenceQc, subtractQc } from "./amount.js";
import { AppError } from "./errors.js";
import { validateEvent, type ValidatedEvent } from "./event-validation.js";
import { insertLedgerEntries, LedgerConflictError, ledgerEntryFromEvent } from "./ledger.js";
import { rebuildLockKey } from "./locks.js";
import { classify } from "./sync.js";
import { projectJobReward, projectQuizReward } from "./projections.js";
import type { ChainEventPage, ChainEventSource, SourceEvent } from "./chain-source.js";
import { startWorker, type WorkerHandle } from "./worker.js";

export type ChainRuntime = { networkId: string; contractId: string };

export type IngestResult = {
  cursor: string;
  nextCursor: string;
  inserted: number;
  replayed: number;
};

export type RebuildResult = {
  pages: number;
  eventsStaged: number;
  eventsApplied: number;
  replays: number;
  startCursor: string;
  finalCursor: string;
  lastFinalizedBlock: string | null;
  lastFinalizedHash: string | null;
  properties: number;
  businesses: number;
  wallets: number;
  canonicalSupply: string;
  mirroredWalletSum: string;
  difference: string;
  clearedFailures: number;
};

type CursorRow = {
  next_cursor: string;
  last_finalized_block: string | null;
  last_finalized_hash: string | null;
};

type StagedEvent = {
  receipt_id: string;
  event_index: number;
  block_height: string;
  block_hash: string;
  tx_hash: string | null;
  chain_timestamp: Date;
  payload: unknown;
};

type EventOrder = {
  blockHeight: bigint;
  receiptId: string;
  eventIndex: number;
};

function compareEventOrder(left: EventOrder, right: EventOrder): number {
  if (left.blockHeight < right.blockHeight) return -1;
  if (left.blockHeight > right.blockHeight) return 1;
  const receipt = left.receiptId.localeCompare(right.receiptId);
  if (receipt !== 0) return receipt;
  return left.eventIndex - right.eventIndex;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Every immutable source field participates in exact-replay detection. */
function sourceEventFingerprint(item: SourceEvent): string {
  return canonicalJson({
    receiptId: item.receiptId,
    eventIndex: item.eventIndex,
    blockHeight: item.blockHeight,
    blockHash: item.blockHash,
    txHash: item.txHash ?? null,
    chainTimestamp: new Date(item.chainTimestamp).toISOString(),
    payload: item.payload,
  });
}

export { rebuildLockKey } from "./locks.js";

export async function ensureCursor(
  db: Sql,
  runtime: ChainRuntime,
  source: string,
  startBlock?: string,
): Promise<CursorRow> {
  const [existing] = await db<CursorRow[]>`
    select next_cursor, last_finalized_block, last_finalized_hash from chain_cursors
    where network_id = ${runtime.networkId} and contract_id = ${runtime.contractId} and source = ${source}
  `;
  if (existing) return existing;
  if (startBlock === undefined || !/^(0|[1-9][0-9]*)$/.test(startBlock)) {
    throw new AppError("CONFLICT", "chain cursor is not initialized; configure an explicit start block", 409);
  }
  await db`
    insert into chain_cursors (network_id, contract_id, source, next_cursor, last_finalized_block)
    values (${runtime.networkId}, ${runtime.contractId}, ${source}, ${startBlock},
            ${(BigInt(startBlock) - 1n).toString()})
    on conflict (network_id, contract_id, source) do nothing
  `;
  const [created] = await db<CursorRow[]>`
    select next_cursor, last_finalized_block, last_finalized_hash from chain_cursors
    where network_id = ${runtime.networkId} and contract_id = ${runtime.contractId} and source = ${source}
  `;
  return created;
}

async function recordFailure(
  client: Sql | TransactionSql,
  runtime: ChainRuntime,
  source: string,
  item: Pick<SourceEvent, "receiptId" | "eventIndex" | "payload" | "blockHeight">,
  code: string,
  message: string,
): Promise<void> {
  await client`
    insert into chain_event_failures (
      network_id, contract_id, source, receipt_id, event_index, block_height, payload,
      error_code, error_message
    ) values (
      ${runtime.networkId}, ${runtime.contractId}, ${source}, ${item.receiptId}, ${item.eventIndex},
      ${item.blockHeight}, ${client.json(item.payload as Parameters<typeof client.json>[0])},
      ${code}, ${message.slice(0, 500)}
    )
    on conflict (network_id, contract_id, receipt_id, event_index) do update set
      attempt_count = chain_event_failures.attempt_count + 1,
      source = excluded.source,
      block_height = excluded.block_height,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      resolved_at = null,
      resolved_by = null,
      last_seen_at = now()
  `;
}

async function resolveFailure(
  client: TransactionSql,
  runtime: ChainRuntime,
  item: Pick<SourceEvent, "receiptId" | "eventIndex">,
): Promise<void> {
  await client`
    update chain_event_failures
    set resolved_at = now(), resolved_by = 'chain-ingester', retry_requested_at = null
    where network_id = ${runtime.networkId}
      and contract_id = ${runtime.contractId}
      and receipt_id = ${item.receiptId}
      and event_index = ${item.eventIndex}
      and resolved_at is null
  `;
}

export async function retryFailure(
  db: Sql,
  runtime: ChainRuntime,
  receiptId: string,
  eventIndex: number,
): Promise<void> {
  await db.begin(async (transaction) => {
    const [failure] = await transaction<{ source: string | null; block_height: string | null }[]>`
      select source, block_height
      from chain_event_failures
      where network_id = ${runtime.networkId}
        and contract_id = ${runtime.contractId}
        and receipt_id = ${receiptId}
        and event_index = ${eventIndex}
      for update
    `;
    if (!failure) throw new AppError("NOT_FOUND", "chain failure not found", 404);
    if (!failure.source) {
      throw new AppError("CONFLICT", "chain failure has no recorded source; cannot retry safely", 409);
    }
    await transaction`
      update chain_event_failures
      set ignored_at = null, ignored_by = null, ignored_reason = null,
          retry_requested_at = now(), retry_count = retry_count + 1,
          resolved_at = null, resolved_by = null, last_seen_at = now()
      where network_id = ${runtime.networkId}
        and contract_id = ${runtime.contractId}
        and receipt_id = ${receiptId}
        and event_index = ${eventIndex}
    `;
    if (failure.block_height) {
      await transaction`
        update chain_cursors set
          next_cursor = least(next_cursor::bigint, ${failure.block_height}::bigint)::text,
          updated_at = now()
        where network_id = ${runtime.networkId}
          and contract_id = ${runtime.contractId}
          and source = ${failure.source}
      `;
    }
  });
}

export async function ignoreFailure(
  db: Sql,
  runtime: ChainRuntime,
  input: { receiptId: string; eventIndex: number; actor: string; reason: string },
): Promise<void> {
  const reason = input.reason.trim();
  const actor = input.actor.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new AppError("VALIDATION_ERROR", "ignore reason is required and bounded", 400);
  }
  if (actor.length === 0 || actor.length > 128) {
    throw new AppError("VALIDATION_ERROR", "ignore actor is required and bounded", 400);
  }
  const [row] = await db`
    update chain_event_failures
    set ignored_at = now(), ignored_by = ${actor}, ignored_reason = ${reason},
        retry_requested_at = null
    where network_id = ${runtime.networkId}
      and contract_id = ${runtime.contractId}
      and receipt_id = ${input.receiptId}
      and event_index = ${input.eventIndex}
    returning id
  `;
  if (!row) throw new AppError("NOT_FOUND", "chain failure not found", 404);
}

function enrich(item: SourceEvent, event: ValidatedEvent): ValidatedEvent {
  return {
    ...event,
    receiptId: item.receiptId,
    eventIndex: item.eventIndex,
    blockHeight: item.blockHeight,
    blockHash: item.blockHash,
    chainTimestamp: item.chainTimestamp,
    txHash: item.txHash ?? undefined,
    payload: item.payload,
  };
}

function walletDelta(amount: string, negative = false): string {
  return negative ? `-${amount}` : amount;
}

async function applyWalletDelta(transaction: TransactionSql, walletId: string, delta: string): Promise<void> {
  const { ownerType, ownerId } = classify(walletId);
  await transaction`
    insert into wallets (wallet_id, owner_type, owner_id, balance, updated_at, active, archived_at)
    values (${walletId}, ${ownerType}, ${ownerId}, ${delta}::numeric, now(), true, null)
    on conflict (wallet_id) do update set
      balance = wallets.balance + ${delta}::numeric,
      updated_at = now(),
      active = true,
      archived_at = null
  `;
}

export async function recordOwnershipHistory(
  transaction: TransactionSql,
  event: ValidatedEvent,
  assetType: "property" | "business",
  assetId: string,
  runtime: ChainRuntime,
): Promise<void> {
  const data = event.data[0];
  if (typeof event.receiptId !== "string" || !Number.isInteger(event.eventIndex)) return;
  const previousOwner = String(data.previous_owner ?? "");
  const newOwner = String(data.new_owner ?? "");
  if (!previousOwner || !newOwner) return;
  await transaction`
    insert into asset_ownership_history (
      network_id, contract_id, receipt_id, event_index, asset_type, asset_id,
      previous_owner, new_owner, reference, block_height, block_hash, payload
    ) values (
      ${runtime.networkId}, ${runtime.contractId}, ${event.receiptId}, ${event.eventIndex as number},
      ${assetType}, ${assetId}, ${previousOwner}, ${newOwner},
      ${typeof data.reference === "string" ? data.reference : null},
      ${event.blockHeight ?? null}, ${event.blockHash ?? null},
      ${transaction.json((event.payload ?? event) as Parameters<typeof transaction.json>[0])}
    )
    on conflict (network_id, contract_id, receipt_id, event_index) do nothing
  `;
}

/** Chain-owned mirror state: wallets, properties, businesses, ownership. */
export async function applyChainOwnedProjection(
  transaction: TransactionSql,
  event: ValidatedEvent,
  runtime: ChainRuntime,
): Promise<void> {
  const data = event.data[0];
  const amount = String(data.amount ?? "0");
  const walletFrom = typeof data.wallet_from === "string" ? data.wallet_from : null;
  const walletTo = typeof data.wallet_to === "string" ? data.wallet_to : null;

  if (walletFrom && walletTo) {
    await applyWalletDelta(transaction, walletFrom, walletDelta(amount, true));
    await applyWalletDelta(transaction, walletTo, amount);
  } else if (walletTo) {
    await applyWalletDelta(transaction, walletTo, amount);
  } else if (walletFrom) {
    await applyWalletDelta(transaction, walletFrom, walletDelta(amount, true));
  }

  switch (event.event) {
    case "property_created": {
      const id = Number(data.id);
      await transaction`
        insert into properties (
          id, district, x, y, owner_wallet, property_type, price, for_sale,
          transfer_count, updated_at, active, archived_at
        ) values (
          ${id}, ${String(data.district)}, ${Number(data.x)}, ${Number(data.y)},
          ${String(data.owner_wallet)}, ${String(data.kind)},
          ${String(data.listing_price)}, ${Boolean(data.for_sale)}, 0, now(), true, null
        )
        on conflict (id) do update set
          district = excluded.district,
          x = excluded.x,
          y = excluded.y,
          owner_wallet = excluded.owner_wallet,
          property_type = excluded.property_type,
          price = excluded.price,
          for_sale = excluded.for_sale,
          transfer_count = excluded.transfer_count,
          updated_at = now(),
          active = true,
          archived_at = null
      `;
      break;
    }
    case "property_listed": {
      const id = Number(data.id);
      await transaction`
        update properties set
          price = ${String(data.listing_price)}, for_sale = true,
          active = true, archived_at = null, updated_at = now()
        where id = ${id}
      `;
      break;
    }
    case "property_listing_cancelled": {
      const id = Number(data.id);
      await transaction`
        update properties set
          price = 0, for_sale = false, active = true, archived_at = null, updated_at = now()
        where id = ${id}
      `;
      break;
    }
    case "property_transferred": {
      const id = Number(data.id);
      await transaction`
        update properties set
          owner_wallet = ${String(data.new_owner)},
          price = 0,
          for_sale = false,
          transfer_count = ${Number(data.transfer_count)},
          active = true,
          archived_at = null,
          updated_at = now()
        where id = ${id}
      `;
      await recordOwnershipHistory(transaction, event, "property", String(id), runtime);
      break;
    }
    case "business_created": {
      const id = Number(data.id);
      await transaction`
        insert into businesses (
          id, name, owner_account, property_id, treasury_wallet, revenue_total,
          active, archived_at
        ) values (
          ${id}, ${String(data.name)}, ${String(data.owner)}, ${Number(data.property_id)},
          ${String(data.treasury)}, 0, true, null
        )
        on conflict (id) do update set
          name = excluded.name,
          owner_account = excluded.owner_account,
          property_id = excluded.property_id,
          treasury_wallet = excluded.treasury_wallet,
          revenue_total = excluded.revenue_total,
          active = true,
          archived_at = null
      `;
      break;
    }
    case "business_transferred": {
      const id = Number(data.id);
      await transaction`
        update businesses set
          owner_account = ${String(data.new_owner)}, active = true, archived_at = null
        where id = ${id}
      `;
      await recordOwnershipHistory(transaction, event, "business", String(id), runtime);
      break;
    }
    case "service_paid": {
      const id = Number(data.business_id);
      await transaction`
        update businesses set revenue_total = revenue_total + ${amount}::numeric where id = ${id}
      `;
      break;
    }
    case "business_withdrawal": {
      const id = Number(data.business_id);
      await transaction`
        update businesses set revenue_total = revenue_total - ${amount}::numeric where id = ${id}
      `;
      break;
    }
    default:
      break;
  }
}

/** Server-owned workflow state: players, job payments, quiz rewards. */
export async function applyServerWorkflowProjection(
  transaction: TransactionSql,
  event: ValidatedEvent,
  _runtime: ChainRuntime,
): Promise<void> {
  const data = event.data[0];
  const amount = String(data.amount ?? "0");
  const reference = typeof data.reference === "string" ? data.reference : null;

  switch (event.event) {
    case "player_registered": {
      const accountId = String(data.account);
      await transaction`
        insert into players (account_id, username) values (${accountId}, ${String(data.username)})
        on conflict (account_id) do update set username = excluded.username
      `;
      break;
    }
    case "job_reward": {
      if (reference?.startsWith("job:")) {
        await projectJobReward(transaction, {
          jobId: reference.slice(4),
          txHash: event.txHash ?? null,
        });
      }
      break;
    }
    case "reward_issued": {
      if (reference?.startsWith("quiz:")) {
        await projectQuizReward(transaction, {
          attemptId: reference.slice(5),
          txHash: event.txHash ?? null,
          amount,
        });
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Applies both projections for one canonical event. Request-time routes and the
 * live background ingester use this; rebuild uses only the chain-owned half.
 */
export async function applyMirrorEvent(
  transaction: TransactionSql,
  event: ValidatedEvent,
  runtime: ChainRuntime,
): Promise<void> {
  await applyChainOwnedProjection(transaction, event, runtime);
  await applyServerWorkflowProjection(transaction, event, runtime);
}

function validatePage(page: ChainEventPage, cursorNumber: bigint): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(page.nextCursor)) {
    throw new AppError("CONFLICT", "chain source returned an invalid cursor", 409);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(page.lastFinalizedBlock)) {
    throw new AppError("CONFLICT", "chain source returned an invalid finalized block", 409);
  }
  const nextNumber = BigInt(page.nextCursor);
  if (nextNumber < cursorNumber) {
    throw new AppError("CONFLICT", "chain source returned an out-of-order cursor", 409);
  }
  if (nextNumber === cursorNumber && page.events.length > 0) {
    throw new AppError("CONFLICT", "chain source returned events without advancing its block cursor", 409);
  }
  const finalized = BigInt(page.lastFinalizedBlock);
  let previousBlock = cursorNumber - 1n;
  let previousReceipt = "";
  let previousIndex = -1;
  for (const item of page.events) {
    if (!/^(0|[1-9][0-9]*)$/.test(item.blockHeight)) {
      throw new AppError("CONFLICT", "chain source returned an invalid event block", 409);
    }
    const block = BigInt(item.blockHeight);
    if (block < cursorNumber || block > finalized) {
      throw new AppError("CONFLICT", "chain source returned an event outside the finalized range", 409);
    }
    if (block >= nextNumber) {
      throw new AppError("CONFLICT", "chain source returned an event at or beyond its next cursor", 409);
    }
    if (block < previousBlock) {
      throw new AppError("CONFLICT", "chain source returned out-of-order events", 409);
    }
    if (block === previousBlock) {
      if (item.receiptId < previousReceipt) {
        throw new AppError("CONFLICT", "chain source returned out-of-order receipts", 409);
      }
      if (item.receiptId === previousReceipt && item.eventIndex <= previousIndex) {
        throw new AppError("CONFLICT", "chain source returned duplicate event ordering", 409);
      }
    }
    previousBlock = block;
    previousReceipt = item.receiptId;
    previousIndex = item.eventIndex;
  }
  return finalized;
}

export async function ingestPage(
  db: Sql,
  source: ChainEventSource,
  runtime: ChainRuntime,
  options: { pageSize?: number; startBlock?: string } = {},
): Promise<IngestResult> {
  const cursorRow = await ensureCursor(db, runtime, source.name, options.startBlock);
  const cursor = cursorRow.next_cursor;
  let cursorNumber: bigint;
  try {
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error("non-canonical");
    cursorNumber = BigInt(cursor);
  } catch {
    throw new AppError("CONFLICT", "chain cursor is invalid", 409);
  }

  const page = await source.fetchPage(cursor, options.pageSize ?? 100);
  validatePage(page, cursorNumber);

  let inserted = 0;
  let replayed = 0;
  let conflictItem: SourceEvent | null = null;
  let conflictMessage = "";
  let deadLetterItem: SourceEvent | null = null;
  let deadLetterMessage = "";

  try {
    await db.begin(async (transaction) => {
      const [rebuildLock] = await transaction<{ locked: boolean }[]>`
        select pg_try_advisory_xact_lock(
          hashtext(current_schema() || ':' || ${rebuildLockKey(runtime)})
        ) as locked
      `;
      if (!rebuildLock?.locked) {
        throw new AppError("CONFLICT", "a mirror rebuild is in progress", 409);
      }
      const [ingestLock] = await transaction<{ locked: boolean }[]>`
        select pg_try_advisory_xact_lock(
          hashtext(
            current_schema() || ':' ||
            ${`quizcity-ingest:${runtime.networkId}:${runtime.contractId}:${source.name}`}
          )
        ) as locked
      `;
      if (!ingestLock?.locked) {
        throw new AppError("CONFLICT", "another ingestion page is in progress", 409);
      }

      const [locked] = await transaction<CursorRow[]>`
        select next_cursor, last_finalized_block, last_finalized_hash from chain_cursors
        where network_id = ${runtime.networkId}
          and contract_id = ${runtime.contractId}
          and source = ${source.name}
        for update
      `;
      if (!locked || locked.next_cursor !== cursor) {
        throw new AppError("CONFLICT", "chain cursor moved during ingestion", 409);
      }

      for (const item of page.events) {
        const [ignored] = await transaction<{ ignored_at: Date | null }[]>`
          select ignored_at from chain_event_failures
          where network_id = ${runtime.networkId}
            and contract_id = ${runtime.contractId}
            and receipt_id = ${item.receiptId}
            and event_index = ${item.eventIndex}
        `;
        if (ignored?.ignored_at) {
          replayed += 1;
          continue;
        }
        let event: ValidatedEvent;
        try {
          event = enrich(item, validateEvent(item.payload as Parameters<typeof validateEvent>[0]));
        } catch (error) {
          deadLetterItem = item;
          deadLetterMessage = error instanceof Error ? error.message : "invalid canonical event";
          throw new AppError("CONFLICT", "unresolved dead-letter event blocks ingestion", 409);
        }

        const [existing] = await transaction<{ applied: boolean }[]>`
          select applied from chain_events
          where network_id = ${runtime.networkId}
            and receipt_id = ${item.receiptId}
            and event_index = ${item.eventIndex}
        `;
        if (existing?.applied) {
          const replayEntry = ledgerEntryFromEvent(event, runtime);
          if (replayEntry) {
            try {
              const replayResult = await insertLedgerEntries(transaction, [replayEntry]);
              replayed += replayResult.replayed;
            } catch (error) {
              if (error instanceof LedgerConflictError) {
                conflictItem = item;
                conflictMessage = error.message;
                throw error;
              }
              throw error;
            }
          }
          await resolveFailure(transaction, runtime, item);
          continue;
        }

        const entry = ledgerEntryFromEvent(event, runtime);
        if (!entry) {
          deadLetterItem = item;
          deadLetterMessage = "event is not canonical";
          throw new AppError("CONFLICT", "unresolved dead-letter event blocks ingestion", 409);
        }
        try {
          const result = await insertLedgerEntries(transaction, [entry]);
          inserted += result.inserted;
          replayed += result.replayed;
          await applyMirrorEvent(transaction, event, runtime);
          await resolveFailure(transaction, runtime, item);
        } catch (error) {
          if (error instanceof LedgerConflictError) {
            conflictItem = item;
            conflictMessage = error.message;
            throw error;
          }
          throw error;
        }
      }

      await transaction`
        update chain_cursors set
          next_cursor = ${page.nextCursor},
          last_finalized_block = ${page.lastFinalizedBlock},
          last_finalized_hash = ${page.lastFinalizedHash ?? null},
          version = version + 1,
          updated_at = now()
        where network_id = ${runtime.networkId}
          and contract_id = ${runtime.contractId}
          and source = ${source.name}
      `;
    });
  } catch (error) {
    if (error instanceof LedgerConflictError && conflictItem) {
      await recordFailure(db, runtime, source.name, conflictItem, "LEDGER_CONFLICT", conflictMessage);
    }
    if (deadLetterItem) {
      await recordFailure(db, runtime, source.name, deadLetterItem, "DEAD_LETTER", deadLetterMessage);
    }
    throw error;
  }

  return { cursor, nextCursor: page.nextCursor, inserted, replayed };
}

export function startChainIngester(options: {
  db: Sql;
  source: ChainEventSource;
  runtime: ChainRuntime;
  intervalMs: number;
  pageSize?: number;
  startBlock?: string;
  onError?: (error: unknown) => void;
}): WorkerHandle {
  return startWorker({
    intervalMs: options.intervalMs,
    run: async () => {
      await ingestPage(options.db, options.source, options.runtime, {
        pageSize: options.pageSize,
        startBlock: options.startBlock,
      });
    },
    onError: options.onError,
  });
}

/**
 * Two-stage rebuild: provider history is fetched and validated into a
 * connection-local staging table first, then chain-owned mirror tables are
 * replaced in one short transaction. Server-owned workflow state is untouched.
 */
export async function rebuildMirror(
  db: Sql,
  source: ChainEventSource,
  runtime: ChainRuntime,
  options: { startBlock: string; pageSize?: number; maxPages?: number },
): Promise<RebuildResult> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 10_000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new AppError("VALIDATION_ERROR", "maxPages must be a positive integer", 400);
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new AppError("VALIDATION_ERROR", "pageSize must be an integer between 1 and 1000", 400);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(options.startBlock)) {
    throw new AppError("VALIDATION_ERROR", "startBlock must be a canonical decimal string", 400);
  }

  const lockKey = rebuildLockKey(runtime);
  const reserved = await db.reserve();
  let lockHeld = false;
  let runId: string | null = null;

  try {
    const [lock] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(
        hashtext(current_schema() || ':' || ${lockKey})
      ) as locked
    `;
    if (!lock?.locked) {
      throw new AppError("CONFLICT", "another rebuild or ingestion is in progress", 409);
    }
    lockHeld = true;

    const [run] = await reserved<{ id: string }[]>`
      insert into rebuild_runs (
        network_id, contract_id, source, status, start_cursor
      ) values (
        ${runtime.networkId}, ${runtime.contractId}, ${source.name}, 'running', ${options.startBlock}
      )
      returning id
    `;
    runId = String(run.id);

    await reserved.unsafe(`drop table if exists pg_temp.rebuild_events`);
    await reserved.unsafe(`
      create temp table rebuild_events (
        ord              bigserial primary key,
        receipt_id       text not null,
        event_index      integer not null,
        block_height     text not null,
        block_hash       text not null,
        tx_hash          text,
        chain_timestamp  timestamptz not null,
        payload          jsonb not null,
        unique (receipt_id, event_index)
      )
    `);

    let pages = 0;
    let eventsStaged = 0;
    let replays = 0;
    let cursor = options.startBlock;
    let lastFinalizedBlock: string | null = null;
    let lastFinalizedHash: string | null = null;
    let createdProperties = 0;
    let createdBusinesses = 0;
    let completed = false;
    const seen = new Map<string, string>();
    let lastUniqueOrder: EventOrder | null = null;

    for (; pages < maxPages; pages += 1) {
      const page = await source.fetchPage(cursor, pageSize);
      validatePage(page, BigInt(cursor));
      for (const item of page.events) {
        const event = enrich(item, validateEvent(item.payload as Parameters<typeof validateEvent>[0]));
        if (!ledgerEntryFromEvent(event, runtime)) {
          throw new AppError("CONFLICT", "rebuild found a non-canonical event", 409);
        }
        const identity = `${item.receiptId}:${item.eventIndex}`;
        const fingerprint = sourceEventFingerprint(item);
        const previous = seen.get(identity);
        if (previous !== undefined) {
          if (previous !== fingerprint) {
            throw new AppError("CONFLICT", "chain source returned a conflicting duplicate event", 409);
          }
          replays += 1;
          continue;
        }
        const order: EventOrder = {
          blockHeight: BigInt(item.blockHeight),
          receiptId: item.receiptId,
          eventIndex: item.eventIndex,
        };
        if (lastUniqueOrder && compareEventOrder(order, lastUniqueOrder) <= 0) {
          throw new AppError("CONFLICT", "chain source returned out-of-order events across pages", 409);
        }
        lastUniqueOrder = order;
        seen.set(identity, fingerprint);
        if (event.event === "property_created") createdProperties += 1;
        if (event.event === "business_created") createdBusinesses += 1;
        await reserved`
          insert into rebuild_events (
            receipt_id, event_index, block_height, block_hash, tx_hash, chain_timestamp, payload
          ) values (
            ${item.receiptId}, ${item.eventIndex}, ${item.blockHeight}, ${item.blockHash},
            ${item.txHash ?? null}, ${item.chainTimestamp}, ${reserved.json(item.payload as never)}
          )
        `;
        eventsStaged += 1;
      }
      lastFinalizedBlock = page.lastFinalizedBlock;
      lastFinalizedHash = page.lastFinalizedHash ?? null;
      if (page.nextCursor === cursor) {
        completed = true;
        break;
      }
      cursor = page.nextCursor;
    }

    if (!completed) {
      throw new AppError(
        "CONFLICT",
        `rebuild stopped after ${maxPages} pages without reaching the end of provider history`,
        409,
      );
    }

    await reserved.unsafe("begin");
    let result: RebuildResult;
    try {
      const transaction = reserved as unknown as TransactionSql;
      result = await (async () => {
        const [held] = await transaction<{ held: boolean }[]>`
        select exists (
          select 1 from pg_locks
          where pid = pg_backend_pid() and locktype = 'advisory' and granted
        ) as held
      `;
        if (!held?.held) {
          throw new AppError("CONFLICT", "rebuild lock was lost before replacement", 409);
        }

        const [cleared] = await transaction<{ count: number }[]>`
        select count(*)::int as count from chain_event_failures
      `;
        await transaction`delete from chain_event_failures`;
        await transaction`truncate table chain_cursors, transactions, chain_events restart identity`;
        await transaction`delete from asset_ownership_history`;
        await transaction`truncate table wallets`;
        await transaction`update properties set active = false, archived_at = now()`;
        await transaction`update businesses set active = false, archived_at = now()`;

        const staged = await transaction<StagedEvent[]>`
        select receipt_id, event_index, block_height, block_hash, tx_hash, chain_timestamp, payload
        from rebuild_events
        order by ord
      `;
        let eventsApplied = 0;
        let eventReplays = 0;
        let canonicalSupply = "0";
        for (const row of staged) {
          const event = enrich(
            {
              receiptId: row.receipt_id,
              eventIndex: row.event_index,
              blockHeight: row.block_height,
              blockHash: row.block_hash,
              chainTimestamp: row.chain_timestamp.toISOString(),
              txHash: row.tx_hash,
              payload: row.payload,
            },
            validateEvent(row.payload as Parameters<typeof validateEvent>[0]),
          );
          const entry = ledgerEntryFromEvent(event, runtime);
          if (!entry) {
            throw new AppError("CONFLICT", "staged event is not canonical", 409);
          }
          const data = event.data[0];
          const amount = String(data.amount ?? "0");
          if (typeof data.wallet_from !== "string") {
            canonicalSupply = addQc(canonicalSupply, amount);
          }
          if (typeof data.wallet_to !== "string") {
            canonicalSupply = subtractQc(canonicalSupply, amount);
          }

          await transaction`
          insert into chain_events (
            network_id, contract_id, receipt_id, event_index, tx_hash, event,
            payload, event_name, event_version, block_height, block_hash, observed_at
          ) values (
            ${runtime.networkId}, ${runtime.contractId}, ${row.receipt_id}, ${row.event_index},
            ${row.tx_hash}, ${event.event},
            ${transaction.json((event.payload ?? event) as never)},
            ${event.event}, ${event.version ?? "1.0.0"}, ${row.block_height}, ${row.block_hash}, now()
          )
        `;
          const insert = await insertLedgerEntries(transaction, [entry]);
          if (insert.replayed) {
            eventReplays += 1;
            continue;
          }
          eventsApplied += 1;
          await applyChainOwnedProjection(transaction, event, runtime);
        }

        await transaction`
        insert into chain_cursors (
          network_id, contract_id, source, next_cursor, last_finalized_block, last_finalized_hash
        ) values (
          ${runtime.networkId}, ${runtime.contractId}, ${source.name}, ${cursor},
          ${lastFinalizedBlock}, ${lastFinalizedHash}
        )
      `;

        const [walletRow] = await transaction<{ count: number; total: string }[]>`
        select count(*)::int as count, coalesce(sum(balance), 0)::text as total from wallets
      `;
        const [propertyRow] = await transaction<{ count: number }[]>`
        select count(*)::int as count from properties where active = true
      `;
        const [businessRow] = await transaction<{ count: number }[]>`
        select count(*)::int as count from businesses where active = true
      `;
        if (propertyRow.count !== createdProperties) {
          throw new AppError("CONFLICT", "rebuilt property count does not match creation events", 409);
        }
        if (businessRow.count !== createdBusinesses) {
          throw new AppError("CONFLICT", "rebuilt business count does not match creation events", 409);
        }
        if (eventsApplied + eventReplays !== staged.length) {
          throw new AppError("CONFLICT", "rebuild lost staged events during replacement", 409);
        }
        const difference = differenceQc(canonicalSupply, walletRow.total);
        if (difference !== "0") {
          throw new AppError(
            "CONFLICT",
            `rebuild reconciliation mismatch: canonical supply ${canonicalSupply}, mirrored wallet sum ${walletRow.total}`,
            409,
          );
        }
        const summary: RebuildResult = {
          pages: pages + 1,
          eventsStaged,
          eventsApplied,
          replays: replays + eventReplays,
          startCursor: options.startBlock,
          finalCursor: cursor,
          lastFinalizedBlock,
          lastFinalizedHash,
          properties: propertyRow.count,
          businesses: businessRow.count,
          wallets: walletRow.count,
          canonicalSupply,
          mirroredWalletSum: walletRow.total,
          difference,
          clearedFailures: cleared.count,
        };

        await transaction`
        update rebuild_runs set
          status = 'success', finished_at = now(), final_cursor = ${cursor},
          last_finalized_block = ${lastFinalizedBlock}, last_finalized_hash = ${lastFinalizedHash},
          pages = ${summary.pages}, events_staged = ${eventsStaged},
          events_applied = ${eventsApplied}, replays = ${summary.replays},
          property_count = ${summary.properties}, business_count = ${summary.businesses},
          wallet_count = ${summary.wallets}, canonical_supply = ${summary.canonicalSupply},
          mirrored_wallet_sum = ${summary.mirroredWalletSum}, difference = ${summary.difference},
          cleared_failures = ${cleared.count}
        where id = ${runId}
      `;
        return summary;
      })();
      await reserved.unsafe("commit");
    } catch (error) {
      await reserved.unsafe("rollback").catch(() => {});
      throw error;
    }

    return result;
  } catch (error) {
    if (runId) {
      try {
        await reserved`
          update rebuild_runs set
            status = 'failed', finished_at = now(), error_message = ${String(
              error instanceof Error ? error.message : error,
            ).slice(0, 500)}
          where id = ${runId}
        `;
      } catch {
        // best-effort audit; the original error is more useful
      }
    }
    throw error;
  } finally {
    if (lockHeld) {
      try {
        await reserved`
          select pg_advisory_unlock(
            hashtext(current_schema() || ':' || ${lockKey})
          )
        `;
      } catch {
        // connection release below closes the session lock
      }
    }
    reserved.release();
  }
}
