import assert from "node:assert/strict";
import test from "node:test";
import {
  AccessKeyPolicyError,
  assertRestrictedPayoutKey,
  type AccessKeyPermission,
} from "../src/access-key.js";

const policy = { receiverId: "quizcity.testnet", methods: ["credit_reward", "pay_job"] };

const functionCall = (overrides: Record<string, unknown> = {}): AccessKeyPermission => ({
  FunctionCall: {
    allowance: "1000000000000000000000000",
    receiver_id: "quizcity.testnet",
    method_names: ["credit_reward", "pay_job"],
    ...overrides,
  },
});

test("accepts an exact payout-only function-call key", () => {
  const permission = assertRestrictedPayoutKey(functionCall(), policy);
  assert.deepEqual(permission.method_names, ["credit_reward", "pay_job"]);
});

test("method order does not matter", () => {
  const permission = assertRestrictedPayoutKey(
    functionCall({ method_names: ["pay_job", "credit_reward"] }),
    policy,
  );
  assert.equal(permission.receiver_id, "quizcity.testnet");
});

test("rejects a full-access key", () => {
  assert.throws(() => assertRestrictedPayoutKey("FullAccess", policy), AccessKeyPolicyError);
});

test("rejects the wrong receiver", () => {
  assert.throws(
    () => assertRestrictedPayoutKey(functionCall({ receiver_id: "other.testnet" }), policy),
    /expected the configured contract/,
  );
});

test("rejects extra methods", () => {
  assert.throws(
    () =>
      assertRestrictedPayoutKey(
        functionCall({ method_names: ["credit_reward", "pay_job", "set_paused"] }),
        policy,
      ),
    /expected exactly/,
  );
});

test("rejects a missing payout method", () => {
  assert.throws(
    () => assertRestrictedPayoutKey(functionCall({ method_names: ["credit_reward"] }), policy),
    /expected exactly/,
  );
});

test("rejects an unrestricted function-call key", () => {
  assert.throws(() => assertRestrictedPayoutKey(functionCall({ method_names: [] }), policy), /every method/);
});

test("rejects a key without an allowance", () => {
  assert.throws(() => assertRestrictedPayoutKey(functionCall({ allowance: null }), policy), /no allowance/);
});

test("rejects a zero or negative allowance", () => {
  assert.throws(
    () => assertRestrictedPayoutKey(functionCall({ allowance: "0" }), policy),
    /greater than zero/,
  );
  assert.throws(
    () => assertRestrictedPayoutKey(functionCall({ allowance: "-1" }), policy),
    /greater than zero/,
  );
});

test("rejects a non-integer allowance", () => {
  assert.throws(
    () => assertRestrictedPayoutKey(functionCall({ allowance: "lots" }), policy),
    /valid integer/,
  );
});

test("allowance can be waived only explicitly", () => {
  const permission = assertRestrictedPayoutKey(functionCall({ allowance: null }), {
    ...policy,
    requireAllowance: false,
  });
  assert.equal(permission.allowance, null);
});
