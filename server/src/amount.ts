export const QC_MAX = 340282366920938463463374607431768211455n;

export class AmountError extends Error {
  code = "INVALID_AMOUNT" as const;

  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

const CANONICAL = /^(0|[1-9][0-9]*)$/;

export function isQcString(value: unknown): value is string {
  return typeof value === "string" && CANONICAL.test(value) && BigInt(value) <= QC_MAX;
}

export function parseQc(value: unknown, name = "amount"): bigint {
  if (typeof value !== "string" || !CANONICAL.test(value)) {
    throw new AmountError(`${name} must be a canonical decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > QC_MAX) throw new AmountError(`${name} exceeds the QC maximum`);
  return parsed;
}

export function formatQc(value: bigint): string {
  if (value < 0n) throw new AmountError("QC amount cannot be negative");
  if (value > QC_MAX) throw new AmountError("QC amount exceeds the QC maximum");
  return value.toString();
}

export function addQc(left: string, right: string): string {
  return formatQc(parseQc(left, "left") + parseQc(right, "right"));
}

export function subtractQc(left: string, right: string): string {
  const result = parseQc(left, "left") - parseQc(right, "right");
  if (result < 0n) throw new AmountError("QC subtraction would underflow");
  return formatQc(result);
}

export function compareQc(left: string, right: string): -1 | 0 | 1 {
  const a = parseQc(left, "left");
  const b = parseQc(right, "right");
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Signed difference for reconciliation reports: left - right. */
export function differenceQc(left: string, right: string): string {
  const difference = parseQc(left, "left") - parseQc(right, "right");
  if (difference === 0n) return "0";
  const magnitude = difference < 0n ? -difference : difference;
  const formatted = formatQc(magnitude);
  return difference < 0n ? `-${formatted}` : formatted;
}

export function sumQc(values: string[]): string {
  return formatQc(values.reduce((total, value) => total + parseQc(value), 0n));
}

/** Formats a canonical decimal string with grouping, without Number coercion. */
export function formatQcDisplay(value: string): string {
  const canonical = formatQc(parseQc(value));
  return canonical.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
