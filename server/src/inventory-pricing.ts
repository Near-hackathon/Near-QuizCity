import { parseQc } from "./amount.js";
/** Scarcity doubles the catalogue base below 1,000 available units; the unit cap is 1,000 QC. */
export function supplierUnitPrice(base: string, available: number): string {
  const price = parseQc(base);
  if (price < 1n || price > 1000n || !Number.isSafeInteger(available) || available < 0)
    throw Error("Invalid supplier quote inputs");
  const adjusted = price * (available < 1000 ? 2n : 1n);
  return (adjusted > 1000n ? 1000n : adjusted).toString();
}
