import { EVENT_STANDARD, EVENT_VERSION, type ChainEvent } from "./event-ledger.js";

export const U128_MAX = 340282366920938463463374607431768211455n;

export type Movement = "mint" | "burn" | "transfer" | "registry";
export type ValidatedEvent = ChainEvent & { data: [Record<string, unknown>] };

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventValidationError";
  }
}

const MOVEMENTS: Record<string, Movement | "wallet_created"> = {
  escrow_funded: "transfer",
  escrow_sponsored: "transfer",
  charge_cancelled: "registry",
  lease_offered: "registry",
  lease_started: "registry",
  escrow_released: "transfer",
  escrow_refunded: "transfer",
  charge_paid: "transfer",
  admission_refunded: "transfer",
  order_refunded: "transfer",
  order_cancelled: "registry",
  business_listed: "registry",
  business_sold: "transfer",
  player_registered: "registry",
  starter_allowance: "mint",
  wallet_transfer: "transfer",
  reward_issued: "mint",
  wallet_created: "wallet_created",
  property_created: "registry",
  property_listed: "registry",
  property_listing_cancelled: "registry",
  property_transferred: "transfer",
  permit_burn: "burn",
  business_created: "registry",
  service_paid: "transfer",
  business_withdrawal: "transfer",
  business_transferred: "registry",
  job_reward: "transfer",
  paused: "registry",
  unpaused: "registry",
  operator_proposed: "registry",
  operator_changed: "registry",
  operator_change_cancelled: "registry",
  demo_reset: "registry",
};

const ECONOMIC_EVENTS = new Set([
  "starter_allowance",
  "wallet_transfer",
  "reward_issued",
  "property_transferred",
  "permit_burn",
  "service_paid",
  "business_withdrawal",
  "job_reward",
]);

export function supportedEventNames(): string[] {
  return Object.keys(MOVEMENTS);
}

function fail(message: string): never {
  throw new EventValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(data: Record<string, unknown>, field: string, allowEmpty = false): string {
  const value = data[field];
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (!allowEmpty && value.length === 0) fail(`${field} must not be empty`);
  return value;
}

function requireNullableString(data: Record<string, unknown>, field: string): string | null {
  if (!(field in data)) fail(`${field} is required (use null for none)`);
  const value = data[field];
  if (value === null) return null;
  if (typeof value !== "string") fail(`${field} must be a string or null`);
  if (value.length === 0) fail(`${field} must not be empty when present`);
  return value;
}

function requireInteger(data: Record<string, unknown>, field: string, minimum = 0): number {
  const value = data[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(`${field} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function requireBoolean(data: Record<string, unknown>, field: string): boolean {
  const value = data[field];
  if (typeof value !== "boolean") fail(`${field} must be a boolean`);
  return value;
}

function requireU128(data: Record<string, unknown>, field: string): bigint {
  const value = data[field];
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    fail(`${field} must be a decimal U128 string`);
  }
  const amount = BigInt(value);
  if (amount > U128_MAX) fail(`${field} exceeds u128 maximum`);
  return amount;
}

function validateMovement(
  movement: Movement,
  walletFrom: string | null,
  walletTo: string | null,
  amount: bigint,
): void {
  if (movement === "mint") {
    if (walletFrom !== null) fail("mint must have wallet_from = null");
    if (walletTo === null) fail("mint must have a wallet_to");
    if (amount <= 0n) fail("mint amount must be positive");
    return;
  }
  if (movement === "burn") {
    if (walletFrom === null) fail("burn must have a wallet_from");
    if (walletTo !== null) fail("burn must have wallet_to = null");
    if (amount <= 0n) fail("burn amount must be positive");
    return;
  }
  if (movement === "transfer") {
    if (walletFrom === null || walletTo === null) fail("transfer requires both wallets");
    if (walletFrom === walletTo) fail("transfer wallets must differ");
    if (amount <= 0n) fail("transfer amount must be positive");
    return;
  }
  if (walletFrom !== null || walletTo !== null) fail("registry event must have null wallets");
  if (amount !== 0n) fail("registry event amount must be zero");
}

function validateEntity(event: string, entityId: string, expected: string): void {
  if (entityId !== expected) {
    fail(`${event} entity_id must be ${expected}, got ${entityId}`);
  }
}

export function validateEventData(
  event: string,
  data: Record<string, unknown>,
): { walletFrom: string | null; walletTo: string | null; amount: bigint } {
  const movement = MOVEMENTS[event];
  if (!movement) fail(`unsupported event name ${event}`);

  if (requireInteger(data, "seq", 1) < 1) fail("seq must be positive");
  const walletFrom = requireNullableString(data, "wallet_from");
  const walletTo = requireNullableString(data, "wallet_to");
  const amount = requireU128(data, "amount");
  const reference = requireNullableString(data, "reference");
  const entityId = requireString(data, "entity_id");

  if (ECONOMIC_EVENTS.has(event) && reference === null) {
    fail(`${event} requires a reference`);
  }

  if (movement === "wallet_created") {
    const ownerWallet = requireString(data, "owner_wallet");
    const funded = requireBoolean(data, "funded");
    if (entityId !== ownerWallet) {
      fail(`wallet_created entity_id must equal owner_wallet (${ownerWallet})`);
    }
    if (funded !== amount > 0n) fail("wallet_created funded must match a positive amount");
    validateMovement(funded ? "mint" : "registry", walletFrom, walletTo, amount);
    if (funded && walletTo !== ownerWallet) {
      fail("funded wallet_created wallet_to must equal owner_wallet");
    }
    return { walletFrom, walletTo, amount };
  }

  validateMovement(movement, walletFrom, walletTo, amount);

  switch (event) {
    case "escrow_funded":
    case "escrow_released":
    case "escrow_refunded":
    case "escrow_sponsored": {
      const id = requireString(data, "escrow_id");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
        fail("invalid escrow ID");
      validateEntity(event, entityId, `escrow:${id}`);
      const purpose = requireString(data, "purpose");
      if (!["job", "prize", "supply", "admission", "rent", "upkeep", "public_contract"].includes(purpose))
        fail("invalid reservation purpose");
      if (event === "escrow_funded" || event === "escrow_sponsored") {
        if (walletTo !== `gov:escrow.${id}`) fail("reservation funding has the wrong recipient");
        if (event === "escrow_funded") {
          requireString(data, "owner");
          requireNullableString(data, "beneficiary");
        }
      } else if (walletFrom !== `gov:escrow.${id}`) fail("reservation settlement has the wrong source");
      break;
    }
    case "charge_paid":
      validateEntity(event, entityId, walletTo as string);
      break;
    case "charge_cancelled":
      requireString(data, "source_wallet");
      break;
    case "order_cancelled":
      requireString(data, "buyer");
      break;
    case "admission_refunded": {
      const id = requireInteger(data, "business_id", 1);
      requireString(data, "payment_reference");
      validateEntity(event, entityId, `business:${id}`);
      if (walletFrom !== `biz:${id}` || !walletTo?.startsWith("player:"))
        fail("ticket refund has invalid parties");
      break;
    }
    case "order_refunded": {
      const id = requireInteger(data, "business_id", 1);
      requireString(data, "order_reference");
      validateEntity(event, entityId, `business:${id}`);
      if (walletFrom !== `biz:${id}`) fail("refund must debit the original business");
      break;
    }
    case "business_listed": {
      const id = requireInteger(data, "business_id", 1);
      requireString(data, "owner");
      requireU128(data, "listing_price");
      validateEntity(event, entityId, `business:${id}`);
      break;
    }
    case "lease_offered": {
      const id = requireInteger(data, "property_id", 1);
      requireString(data, "owner_wallet");
      requireU128(data, "rent");
      if (![7, 30].includes(requireInteger(data, "period_days", 1))) fail("unsupported lease period");
      validateEntity(event, entityId, `property:${id}`);
      break;
    }
    case "lease_started": {
      const id = requireInteger(data, "property_id", 1);
      requireString(data, "tenant");
      const ends = requireU128(data, "ends_at"),
        grace = requireU128(data, "grace_ends_at");
      if (grace <= ends) fail("invalid lease grace period");
      validateEntity(event, entityId, `property:${id}`);
      break;
    }
    case "player_registered": {
      const account = requireString(data, "account");
      const ownerWallet = requireString(data, "owner_wallet");
      requireString(data, "username");
      const expected = `player:${account}`;
      validateEntity(event, entityId, expected);
      if (ownerWallet !== expected) {
        fail(`player_registered owner_wallet must be ${expected}`);
      }
      break;
    }
    case "starter_allowance": {
      const account = requireString(data, "account");
      const expected = `player:${account}`;
      if (walletTo !== expected) fail(`starter_allowance wallet_to must be ${expected}`);
      validateEntity(event, entityId, expected);
      break;
    }
    case "reward_issued":
      validateEntity(event, entityId, walletTo as string);
      break;
    case "wallet_transfer":
      validateEntity(event, entityId, walletTo as string);
      break;
    case "property_created": {
      const id = requireInteger(data, "id", 1);
      requireString(data, "kind");
      requireString(data, "district");
      requireInteger(data, "x", 0);
      requireInteger(data, "y", 0);
      requireString(data, "owner_wallet");
      requireU128(data, "listing_price");
      requireBoolean(data, "for_sale");
      validateEntity(event, entityId, `property:${id}`);
      break;
    }
    case "property_listed": {
      const id = requireInteger(data, "id", 1);
      requireString(data, "owner_wallet");
      requireU128(data, "listing_price");
      requireBoolean(data, "for_sale");
      validateEntity(event, entityId, `property:${id}`);
      break;
    }
    case "property_listing_cancelled": {
      const id = requireInteger(data, "id", 1);
      requireString(data, "owner_wallet");
      validateEntity(event, entityId, `property:${id}`);
      break;
    }
    case "property_transferred": {
      const id = requireInteger(data, "id", 1);
      const previousOwner = requireString(data, "previous_owner");
      const newOwner = requireString(data, "new_owner");
      requireInteger(data, "transfer_count", 1);
      if (walletFrom !== newOwner) fail("property_transferred wallet_from must be the buyer");
      if (walletTo !== previousOwner) fail("property_transferred wallet_to must be the seller");
      validateEntity(event, entityId, `property:${id}`);
      break;
    }
    case "permit_burn": {
      const id = requireInteger(data, "business_id", 1);
      validateEntity(event, entityId, `business:${id}`);
      break;
    }
    case "business_created": {
      const id = requireInteger(data, "id", 1);
      const name = requireString(data, "name");
      const owner = requireString(data, "owner");
      const ownerWallet = requireString(data, "owner_wallet");
      requireInteger(data, "property_id", 1);
      const treasury = requireString(data, "treasury");
      requireU128(data, "permit_fee");
      if (ownerWallet !== `player:${owner}`) {
        fail(`business_created owner_wallet must be player:${owner}`);
      }
      if (treasury !== `biz:${id}`) fail(`business_created treasury must be biz:${id}`);
      if (name.length === 0) fail("business_created name is required");
      validateEntity(event, entityId, `business:${id}`);
      break;
    }
    case "service_paid":
    case "business_withdrawal": {
      const id = requireInteger(data, "business_id", 1);
      validateEntity(event, entityId, `business:${id}`);
      break;
    }
    case "business_sold":
    case "business_transferred": {
      const id = requireInteger(data, "id", 1);
      const previousOwner = requireString(data, "previous_owner");
      const newOwner = requireString(data, "new_owner");
      const previousOwnerWallet = requireString(data, "previous_owner_wallet");
      const newOwnerWallet = requireString(data, "new_owner_wallet");
      if (previousOwnerWallet !== `player:${previousOwner}`) {
        fail(`business_transferred previous_owner_wallet must be player:${previousOwner}`);
      }
      if (newOwnerWallet !== `player:${newOwner}`) {
        fail(`business_transferred new_owner_wallet must be player:${newOwner}`);
      }
      if (event === "business_sold" && (walletFrom !== newOwnerWallet || walletTo !== previousOwnerWallet))
        fail("business sale must move QC from buyer to seller");
      validateEntity(event, entityId, `business:${id}`);
      break;
    }
    case "job_reward":
      validateEntity(event, entityId, walletTo as string);
      break;
    case "paused":
    case "unpaused":
      requireBoolean(data, "paused");
      break;
    case "operator_proposed":
      requireString(data, "new_operator");
      break;
    case "operator_changed":
      requireString(data, "previous_operator");
      requireString(data, "new_operator");
      break;
    default:
      break;
  }

  return { walletFrom, walletTo, amount };
}

export function validateEvent(event: ChainEvent): ValidatedEvent {
  if (!isRecord(event)) fail("canonical event must be an object");
  if (event.standard !== EVENT_STANDARD) fail(`unsupported event standard ${String(event.standard)}`);
  if (event.version !== EVENT_VERSION) fail(`unsupported event version ${String(event.version)}`);
  if (typeof event.event !== "string" || event.event.length === 0) fail("event name is required");
  if (!Array.isArray(event.data) || event.data.length !== 1 || !isRecord(event.data[0])) {
    fail(`${event.event} must contain exactly one data object`);
  }
  validateEventData(event.event, event.data[0]);
  return event as ValidatedEvent;
}
