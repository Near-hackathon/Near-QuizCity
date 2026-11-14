import test from "node:test";
import assert from "node:assert/strict";
import { supplierUnitPrice } from "../src/inventory-pricing.js";
import { shopMinute } from "../src/shop-hours.js";
test("supplier quotes preserve exact integer prices, scarcity boundary and cap", () => {
  for (const [base, available, result] of [
    ["2", 1000, "2"],
    ["2", 999, "4"],
    ["2", 0, "4"],
    ["500", 1, "1000"],
    ["1000", 999, "1000"],
    ["1000", 1000, "1000"],
  ] as const)
    assert.equal(supplierUnitPrice(base, available), result);
  for (const [price, n] of [
    ["0", 1],
    ["1001", 1],
    ["-1", 1],
    ["1", -1],
    ["1", 1.5],
    ["1", Number.MAX_SAFE_INTEGER + 1],
  ] as const)
    assert.throws(() => supplierUnitPrice(price, n));
});
test("shop hours use city timezone consistently at midnight and across zones", () => {
  const date = new Date("2026-11-14T00:00:00Z");
  assert.equal(shopMinute(date, "Africa/Accra"), 0);
  assert.equal(shopMinute(date, "Asia/Tokyo"), 540);
  assert.equal(shopMinute(new Date("2026-11-14T23:59:00Z"), "Africa/Accra"), 1439);
});
