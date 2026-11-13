import assert from "node:assert/strict";
import test from "node:test";
import { assertConfirmed, assertLocalOnly, parseOperatorRole } from "../src/script-guards.js";

test("destructive script guards reject production, unconfirmed, and invalid roles", () => {
  assert.doesNotThrow(() => assertLocalOnly("local", "repair"));
  assert.doesNotThrow(() => assertLocalOnly("test", "repair"));
  assert.throws(() => assertLocalOnly("staging", "repair"), /only local and test/);
  assert.throws(() => assertLocalOnly("production", "repair"), /only local and test/);

  assert.doesNotThrow(() => assertConfirmed(true, "--confirm"));
  assert.throws(() => assertConfirmed(false, "--confirm"), /--confirm/);

  assert.equal(parseOperatorRole("admin"), "admin");
  assert.throws(() => parseOperatorRole("owner"), /player, operator, or admin/);
  assert.throws(() => parseOperatorRole(undefined), /player, operator, or admin/);
});
