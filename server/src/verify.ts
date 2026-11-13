import { providers } from "near-api-js";
import { config } from "./runtime-config.js";
import { AppError } from "./errors.js";
import { EventValidationError, validateEvent, type ValidatedEvent } from "./event-validation.js";

type FinalExecutionOutcome = Awaited<ReturnType<providers.JsonRpcProvider["txStatus"]>>;

const provider = new providers.JsonRpcProvider({ url: config.rpcUrl });

const TX_HASH_PATTERN = /^[A-Za-z0-9]{43,44}$/;
const DEFAULT_MAX_GAS = 30_000_000_000_000n;

export class ExpectedCallError extends AppError {
  constructor(message: string) {
    super("TX_MISMATCH", message, 422);
    this.name = "ExpectedCallError";
  }
}

export type BlockMetadata = { height: string; timestamp: string };
export type BlockMetadataResolver = (blockHash: string) => Promise<BlockMetadata>;

export type EventExpectation = {
  name: string;
  entityId?: string;
  walletFrom?: string | null;
  walletTo?: string | null;
  amount?: string;
  reference?: string | null;
};

export type ExpectedCall = {
  signerId: string;
  method: string;
  args: Record<string, unknown>;
  deposit?: bigint;
  maxGas?: bigint;
  events?: EventExpectation[];
};

export type VerifiedCall = {
  txHash: string;
  outcome: FinalExecutionOutcome;
  events: ValidatedEvent[];
};

type ReceiptOutcome = {
  id?: string;
  block_hash?: string;
  outcome?: { executor_id?: string; logs?: string[] };
};

type FunctionCallAction = {
  methodName: string;
  args: unknown;
  gas: bigint;
  deposit: bigint;
};

export function classifyProviderError(error: unknown): AppError {
  const record = error as { type?: unknown; message?: unknown; code?: unknown } | null;
  const detail = `${String(record?.type ?? "")} ${String(record?.code ?? "")} ${String(
    record?.message ?? error,
  )}`.toLowerCase();
  if (detail.includes("timeout")) {
    return new AppError("CHAIN_TIMEOUT", "chain provider timed out", 504);
  }
  if (detail.includes("unknown") || detail.includes("does not exist") || detail.includes("not found")) {
    return new AppError("TX_NOT_FOUND", "transaction not found on chain", 404);
  }
  return new AppError("CHAIN_UNAVAILABLE", "chain provider is unavailable", 503);
}

export function classifyFinalStatus(status: unknown): void {
  const record = (status ?? {}) as Record<string, unknown>;
  if ("SuccessValue" in record) return;
  if ("Failure" in record) {
    throw new AppError("TX_FAILED", "transaction failed on chain", 409);
  }
  throw new AppError("TX_PENDING", "transaction outcome is not final yet", 409);
}

export async function assertTxSucceeded(txHash: string, signerId: string): Promise<FinalExecutionOutcome> {
  if (!TX_HASH_PATTERN.test(txHash)) {
    throw new AppError("TX_NOT_FOUND", "invalid transaction hash", 400);
  }
  let outcome: FinalExecutionOutcome;
  try {
    outcome = await Promise.race([
      provider.txStatus(txHash, signerId, "FINAL"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new AppError("CHAIN_TIMEOUT", "transaction status timed out", 504)), 8000),
      ),
    ]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw classifyProviderError(error);
  }
  const signer = outcome.transaction?.signer_id ?? outcome.transaction?.signerId;
  if (signer && signer !== signerId) {
    throw new AppError("TX_MISMATCH", "transaction was not signed by the expected account", 422);
  }
  classifyFinalStatus(outcome.status);
  return outcome;
}

/**
 * Extracts only canonical events from receipts executed by the configured
 * contract. Missing or foreign executors are skipped; malformed trusted logs
 * fail instead of becoming ledger rows.
 */
export function extractEvents(outcome: unknown, txHash?: string): ValidatedEvent[] {
  const value = outcome as {
    transaction_outcome?: { id?: string };
    receipts_outcome?: ReceiptOutcome[];
  } | null;
  const resolvedTxHash = txHash ?? value?.transaction_outcome?.id;
  if (typeof resolvedTxHash !== "string" || resolvedTxHash.length === 0) {
    throw new EventValidationError("execution outcome is missing a transaction hash");
  }

  const events: ValidatedEvent[] = [];
  for (const receipt of value?.receipts_outcome ?? []) {
    if (receipt.outcome?.executor_id !== config.contractId) continue;
    if (typeof receipt.id !== "string" || receipt.id.length === 0) {
      throw new EventValidationError("trusted receipt is missing an id");
    }
    if (typeof receipt.block_hash !== "string" || receipt.block_hash.length === 0) {
      throw new EventValidationError("trusted receipt is missing a block hash");
    }
    let eventIndex = 0;
    for (const log of receipt.outcome?.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(log.slice("EVENT_JSON:".length));
      } catch {
        throw new EventValidationError(`receipt ${receipt.id} has malformed EVENT_JSON`);
      }
      const event = validateEvent(parsed as Parameters<typeof validateEvent>[0]);
      events.push({
        ...event,
        payload: parsed,
        txHash: resolvedTxHash,
        receiptId: receipt.id,
        eventIndex,
        blockHash: receipt.block_hash,
      });
      eventIndex += 1;
    }
  }
  return events;
}

/** Backwards-compatible name for callers that only need extracted events. */
export function parseEvents(outcome: unknown, txHash?: string): ValidatedEvent[] {
  return extractEvents(outcome, txHash);
}

export async function enrichBlockMetadata(
  events: ValidatedEvent[],
  resolveBlock: BlockMetadataResolver,
): Promise<ValidatedEvent[]> {
  const cache = new Map<string, BlockMetadata>();
  for (const event of events) {
    if (!event.blockHash) {
      throw new EventValidationError("canonical event is missing a block hash");
    }
    if (!cache.has(event.blockHash)) {
      const metadata = await resolveBlock(event.blockHash);
      if (
        !metadata ||
        typeof metadata.height !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(metadata.height) ||
        Number.isNaN(Date.parse(metadata.timestamp))
      ) {
        throw new EventValidationError(`invalid block metadata for ${event.blockHash}`);
      }
      cache.set(event.blockHash, metadata);
    }
  }
  return events.map((event) => {
    const metadata = cache.get(event.blockHash as string) as BlockMetadata;
    return { ...event, blockHeight: metadata.height, chainTimestamp: metadata.timestamp };
  });
}

export async function resolveNearBlock(blockHash: string): Promise<BlockMetadata> {
  const block = await provider.block({ blockId: blockHash });
  const nanoseconds = BigInt(String(block.header.timestamp));
  const milliseconds = nanoseconds / 1_000_000n;
  return {
    height: String(block.header.height),
    timestamp: new Date(Number(milliseconds)).toISOString(),
  };
}

function functionCallAction(action: unknown): FunctionCallAction | null {
  if (typeof action !== "object" || action === null) return null;
  const record = action as Record<string, unknown>;
  const call = (record.FunctionCall ?? record.functionCall) as Record<string, unknown> | undefined;
  if (!call) return null;
  const methodName = call.method_name ?? call.methodName;
  if (typeof methodName !== "string") return null;
  let args: unknown = call.args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(Buffer.from(args, "base64").toString("utf8"));
    } catch {
      return null;
    }
  } else if (args instanceof Uint8Array) {
    try {
      args = JSON.parse(Buffer.from(args).toString("utf8"));
    } catch {
      return null;
    }
  }
  return {
    methodName,
    args,
    gas: BigInt(String(call.gas ?? 0)),
    deposit: BigInt(String(call.deposit ?? 0)),
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

export function verifyTransactionAction(outcome: unknown, expectation: ExpectedCall): void {
  const transaction = (outcome as { transaction?: Record<string, unknown> } | null)?.transaction;
  if (!transaction) throw new ExpectedCallError("transaction details are missing");
  const signer = transaction.signer_id ?? transaction.signerId;
  const receiver = transaction.receiver_id ?? transaction.receiverId;
  if (signer !== expectation.signerId) {
    throw new ExpectedCallError("transaction signer does not match the request");
  }
  if (receiver !== config.contractId) {
    throw new ExpectedCallError("transaction receiver is not the configured contract");
  }
  const actions = Array.isArray(transaction.actions) ? transaction.actions : [];
  if (actions.length !== 1) {
    throw new ExpectedCallError("transaction must contain exactly one action");
  }
  const call = functionCallAction(actions[0]);
  if (!call) throw new ExpectedCallError("transaction action is not a function call");
  if (call.methodName !== expectation.method) {
    throw new ExpectedCallError(`transaction called ${call.methodName}, expected ${expectation.method}`);
  }
  if (stableJson(call.args) !== stableJson(expectation.args)) {
    throw new ExpectedCallError("transaction arguments do not match the request");
  }
  if (call.deposit !== (expectation.deposit ?? 0n)) {
    throw new ExpectedCallError("transaction deposit does not match policy");
  }
  if (call.gas <= 0n || call.gas > (expectation.maxGas ?? DEFAULT_MAX_GAS)) {
    throw new ExpectedCallError("transaction gas does not match policy");
  }
}

export function requireExpectedEvent(
  events: ValidatedEvent[],
  expectation: EventExpectation,
): ValidatedEvent {
  const has = (field: keyof EventExpectation) => Object.prototype.hasOwnProperty.call(expectation, field);
  const match = events.find((event) => {
    const data = event.data[0];
    return (
      event.event === expectation.name &&
      (!has("entityId") || data.entity_id === expectation.entityId) &&
      (!has("walletFrom") || data.wallet_from === expectation.walletFrom) &&
      (!has("walletTo") || data.wallet_to === expectation.walletTo) &&
      (!has("amount") || data.amount === expectation.amount) &&
      (!has("reference") || data.reference === expectation.reference)
    );
  });
  if (!match) {
    throw new ExpectedCallError(
      `expected ${expectation.name}${expectation.entityId ? ` for ${expectation.entityId}` : ""} was not emitted`,
    );
  }
  return match;
}

export function assertExpectedEvents(events: ValidatedEvent[], expectations: EventExpectation[]): void {
  for (const expectation of expectations) requireExpectedEvent(events, expectation);
}

async function verifyOutcome(
  outcome: unknown,
  txHash: string,
  expectation: ExpectedCall,
  resolveBlock: BlockMetadataResolver,
): Promise<VerifiedCall> {
  verifyTransactionAction(outcome, expectation);
  let extracted: ValidatedEvent[];
  try {
    extracted = extractEvents(outcome, txHash);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "TX_MISMATCH",
      error instanceof Error ? error.message : "invalid canonical event",
      422,
    );
  }
  let events: ValidatedEvent[];
  try {
    events = await enrichBlockMetadata(extracted, resolveBlock);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("CHAIN_UNAVAILABLE", "block metadata is unavailable", 503);
  }
  assertExpectedEvents(events, expectation.events ?? []);
  return {
    txHash,
    outcome: outcome as FinalExecutionOutcome,
    events,
  };
}

export async function verifyExpectedFunctionCall(
  txHash: string,
  expectation: ExpectedCall,
  resolveBlock: BlockMetadataResolver = resolveNearBlock,
): Promise<VerifiedCall> {
  const outcome = await assertTxSucceeded(txHash, expectation.signerId);
  return verifyOutcome(outcome, txHash, expectation, resolveBlock);
}

/** For operator calls where near-api-js already returned the final outcome. */
export async function verifyOperatorOutcome(
  outcome: unknown,
  txHash: string,
  expectation: ExpectedCall,
  resolveBlock: BlockMetadataResolver = resolveNearBlock,
): Promise<VerifiedCall> {
  return verifyOutcome(outcome, txHash, expectation, resolveBlock);
}
