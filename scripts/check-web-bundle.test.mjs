import assert from "node:assert/strict";
import test from "node:test";
import { overBudget } from "./check-web-bundle.mjs";

test("bundle budgets enforce both raw and gzip limits", () => {
  assert.deepEqual(overBudget("chunk", { raw: 10, gzip: 5 }, { raw: 10, gzip: 5 }), []);
  assert.deepEqual(overBudget("chunk", { raw: 11, gzip: 6 }, { raw: 10, gzip: 5 }), [
    "chunk raw 11 > 10",
    "chunk gzip 6 > 5",
  ]);
});
