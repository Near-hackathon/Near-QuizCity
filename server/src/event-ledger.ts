import { QC_MAX } from "./amount.js";

export const EVENT_STANDARD = "quizcity";
export const EVENT_VERSION = "1.0.0";

export type ChainEvent = {
  standard?: string;
  version?: string;
  event: string;
  data: Record<string, unknown>[];
  /** Receipt/event identity and block context, attached by parseEvents. */
  receiptId?: string;
  eventIndex?: number;
  blockHeight?: string;
  blockHash?: string;
  txHash?: string;
  chainTimestamp?: string;
  /** Untouched canonical log, stored in the ledger for replay/reconciliation. */
  payload?: unknown;
};

export class ReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptError";
  }
}

function canonicalEvent(events: ChainEvent[], name: string): Record<string, unknown> | null {
  const matches = events.filter(
    (event) => event.standard === EVENT_STANDARD && event.version === EVENT_VERSION && event.event === name,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1 || matches[0].data.length !== 1) {
    throw new ReceiptError(`ambiguous ${name} receipt`);
  }
  return matches[0].data[0];
}

function canonicalAmount(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new ReceiptError(`invalid ${name} amount`);
  }
  const amount = BigInt(value);
  if (amount <= 0n || amount > QC_MAX) {
    throw new ReceiptError(`invalid ${name} amount`);
  }
  return value;
}

export function propertySaleReceipt(
  events: ChainEvent[],
  buyer: string,
  propertyId: number,
  transferCount: number,
): { seller: string; price: string } | null {
  const sale = canonicalEvent(events, "property_transferred");
  if (!sale) return null;
  const seller = sale.wallet_to;
  if (
    sale.wallet_from !== buyer ||
    sale.new_owner !== buyer ||
    typeof seller !== "string" ||
    seller === buyer ||
    sale.previous_owner !== seller ||
    sale.entity_id !== `property:${propertyId}` ||
    Number(sale.transfer_count) !== transferCount
  ) {
    throw new ReceiptError("property sale receipt does not match confirmed chain state");
  }
  return { seller, price: canonicalAmount(sale.amount, "property sale") };
}

/**
 * Compatibility parser for pre-Phase-1 generic `transfer` events. The old
 * contract emitted `from = buyer` and `to = seller` for a property sale, so the
 * seller must be read from `to`, never `from`.
 *
 * Remove this helper and its route branch once pre-Phase-1 receipts age out.
 */
export function legacyPropertySaleReceipt(
  events: ChainEvent[],
  buyer: string,
): { seller: string; price: string } | null {
  const sales = events
    .filter((event) => event.event === "transfer")
    .flatMap((event) => event.data)
    .filter((entry) => entry.kind === "property_sale");
  if (sales.length === 0) return null;
  if (sales.length !== 1) {
    throw new ReceiptError("ambiguous legacy property sale receipt");
  }
  const entry = sales[0];
  if (entry.from !== buyer) {
    throw new ReceiptError("legacy property sale buyer does not match confirmed chain state");
  }
  if (typeof entry.to !== "string" || entry.to.length === 0 || entry.to === buyer) {
    throw new ReceiptError("invalid legacy property sale seller");
  }
  return { seller: entry.to, price: canonicalAmount(entry.amount, "property sale") };
}

/** Prefers the canonical event; falls back to the legacy receipt only when absent. */
export function propertySaleFromReceipts(
  events: ChainEvent[],
  buyer: string,
  propertyId: number,
  transferCount: number,
): { seller: string; price: string } | null {
  return (
    propertySaleReceipt(events, buyer, propertyId, transferCount) ?? legacyPropertySaleReceipt(events, buyer)
  );
}

export function servicePaymentReceipt(
  events: ChainEvent[],
  payer: string,
  treasury: string,
  businessId: number,
): { amount: string } | null {
  const payment = canonicalEvent(events, "service_paid");
  if (!payment) return null;
  if (
    payment.wallet_from !== payer ||
    payment.wallet_to !== treasury ||
    payment.entity_id !== `business:${businessId}`
  ) {
    throw new ReceiptError("service payment receipt does not match confirmed chain state");
  }
  return { amount: canonicalAmount(payment.amount, "service payment") };
}
