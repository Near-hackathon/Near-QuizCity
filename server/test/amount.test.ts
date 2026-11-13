import assert from "node:assert/strict";
import test from "node:test";
import {
  QC_MAX,
  addQc,
  compareQc,
  formatQc,
  formatQcDisplay,
  isQcString,
  parseQc,
  subtractQc,
  sumQc,
} from "../src/amount.js";

test("parses canonical QC strings and rejects every non-canonical form", () => {
  assert.equal(parseQc("0"), 0n);
  assert.equal(parseQc("1"), 1n);
  assert.equal(parseQc(QC_MAX.toString()), QC_MAX);
  for (const value of ["", "00", "01", "+1", "-1", "1.0", "1e3", " 1", "1 ", "abc", null, 1]) {
    assert.throws(() => parseQc(value), /canonical decimal string/);
  }
  assert.throws(() => parseQc((QC_MAX + 1n).toString()), /exceeds the QC maximum/);
});

test("arithmetic stays exact above the JavaScript safe integer range", () => {
  const aboveSafe = "9007199254740993";
  assert.equal(addQc(aboveSafe, "1"), "9007199254740994");
  assert.equal(subtractQc(aboveSafe, "1"), "9007199254740992");
  assert.equal(compareQc(aboveSafe, "9007199254740992"), 1);
  assert.equal(sumQc([aboveSafe, aboveSafe]), "18014398509481986");
  assert.equal(formatQc(QC_MAX), QC_MAX.toString());
  assert.equal(formatQcDisplay("1234567"), "1,234,567");
  assert.equal(isQcString(aboveSafe), true);
  assert.equal(isQcString("01"), false);
});

test("subtraction underflow and invalid formatting fail", () => {
  assert.throws(() => subtractQc("1", "2"), /underflow/);
  assert.throws(() => formatQc(-1n), /negative/);
  assert.throws(() => formatQc(QC_MAX + 1n), /exceeds the QC maximum/);
});

test("bigint never reaches JSON.stringify directly", () => {
  const payload = { amount: formatQc(QC_MAX) };
  assert.equal(JSON.parse(JSON.stringify(payload)).amount, QC_MAX.toString());
  assert.throws(() => JSON.stringify({ amount: QC_MAX }), /BigInt/);
});
