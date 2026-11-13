export type SourceEvent = {
  receiptId: string;
  eventIndex: number;
  blockHeight: string;
  blockHash: string;
  chainTimestamp: string;
  txHash?: string | null;
  payload: unknown;
};

export type ChainEventPage = {
  events: SourceEvent[];
  nextCursor: string;
  lastFinalizedBlock: string;
  lastFinalizedHash?: string | null;
};

export type ChainEventSource = {
  name: string;
  fetchPage(cursor: string, limit: number): Promise<ChainEventPage>;
};

export type HttpSourceOptions = {
  url: string;
  networkId: string;
  contractId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  random?: () => number;
};

export const MAX_RECEIPT_ID_LENGTH = 128;
export const MAX_HASH_LENGTH = 128;
export const MAX_CURSOR_LENGTH = 39;
export const MAX_PAGE_SIZE = 1_000;

const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 5_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter, capped after jitter is added. */
export function computeBackoffMs(
  attempt: number,
  random: () => number = Math.random,
  baseMs = BACKOFF_BASE_MS,
  maxMs = BACKOFF_MAX_MS,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitter = Math.floor(random() * Math.min(baseMs, exponential * 0.2 + 1));
  return Math.min(maxMs, exponential + jitter);
}

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`chain event source ${name} is missing or too long`);
  }
  return value;
}

function canonicalUint(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH || !CANONICAL_UINT.test(value)) {
    throw new Error(`chain event source ${name} must be a canonical decimal string`);
  }
  return value;
}

/**
 * The indexer endpoint is an explicit external dependency:
 *   GET <url>?cursor=<cursor>&limit=<n>
 * Returning { networkId, contractId, events, nextCursor, lastFinalizedBlock,
 * lastFinalizedHash }. Events carry raw canonical payloads plus receipt/block
 * metadata. This keeps provider-specific JSON out of domain handlers.
 */
export function createHttpChainEventSource(options: HttpSourceOptions): ChainEventSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = new URL(options.url);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxRetries = options.maxRetries ?? 3;
  const random = options.random ?? Math.random;
  return {
    name: base.host,
    async fetchPage(cursor, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        throw new Error(`chain event source page size must be between 1 and ${MAX_PAGE_SIZE}`);
      }
      const url = new URL(base);
      url.searchParams.set("cursor", cursor);
      url.searchParams.set("limit", String(limit));

      let response: Response | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let retryable: boolean;
        let failure: unknown;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            response = await fetchImpl(url, { signal: controller.signal });
          } finally {
            clearTimeout(timer);
          }
          if (response.ok) break;
          retryable = response.status >= 500;
          failure = new Error(`chain event source returned ${response.status}`);
        } catch (error) {
          retryable = true;
          failure = error;
        }
        if (!retryable || attempt === maxRetries) {
          throw failure ?? new Error("chain event source unavailable");
        }
        await sleep(computeBackoffMs(attempt, random));
      }
      if (!response || !response.ok) throw new Error("chain event source unavailable");

      let body: Record<string, unknown>;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        throw new Error("chain event source returned invalid JSON");
      }
      if (body.networkId !== options.networkId || body.contractId !== options.contractId) {
        throw new Error("chain event source returned data for another network or contract");
      }
      if (!Array.isArray(body.events)) throw new Error("chain event source returned no events array");
      const events = body.events.map((item, index) => normalizeEvent(item, index));
      const nextCursor = canonicalUint(body.nextCursor, "next cursor");
      const finalized = canonicalUint(body.lastFinalizedBlock, "finalized block");
      return {
        events,
        nextCursor,
        lastFinalizedBlock: finalized,
        lastFinalizedHash:
          body.lastFinalizedHash === undefined || body.lastFinalizedHash === null
            ? null
            : boundedString(body.lastFinalizedHash, "finalized hash", MAX_HASH_LENGTH),
      };
    },
  };
}

function normalizeEvent(value: unknown, fallbackIndex: number): SourceEvent {
  if (typeof value !== "object" || value === null) {
    throw new Error(`chain event source item ${fallbackIndex} is not an object`);
  }
  const record = value as Record<string, unknown>;
  const receiptId = boundedString(record.receiptId, "receiptId", MAX_RECEIPT_ID_LENGTH);
  const eventIndex = record.eventIndex;
  if (typeof eventIndex !== "number" || !Number.isSafeInteger(eventIndex) || eventIndex < 0) {
    throw new Error("chain event source item has an invalid eventIndex");
  }
  const blockHeight = canonicalUint(record.blockHeight, "blockHeight");
  const blockHash = boundedString(record.blockHash, "blockHash", MAX_HASH_LENGTH);
  if (typeof record.chainTimestamp !== "string" || Number.isNaN(Date.parse(record.chainTimestamp))) {
    throw new Error("chain event source item has an invalid chainTimestamp");
  }
  let txHash: string | null = null;
  if (record.txHash !== undefined && record.txHash !== null) {
    txHash = boundedString(record.txHash, "txHash", MAX_HASH_LENGTH);
  }
  return {
    receiptId,
    eventIndex,
    blockHeight,
    blockHash,
    chainTimestamp: new Date(record.chainTimestamp).toISOString(),
    txHash,
    payload: record.payload,
  };
}
