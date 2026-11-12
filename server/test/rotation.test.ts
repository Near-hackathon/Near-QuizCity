import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRotationArgs,
  rotationEnvironmentErrors,
  rotationTargets,
  ROTATION_CONFIRM_FLAG,
  isTestnetAccount,
} from "../src/rotation.js";

const safe = {
  appEnv: "local" as const,
  networkId: "testnet" as const,
  demoMode: true,
  contractId: "quizcity.testnet",
  operatorAccount: "quizcity.testnet",
};

test("production, staging, mainnet, and demo-off environments are refused", () => {
  assert.deepEqual(rotationEnvironmentErrors(safe), []);
  assert.match(rotationEnvironmentErrors({ ...safe, appEnv: "production" }).join(), /APP_ENV/);
  assert.match(rotationEnvironmentErrors({ ...safe, appEnv: "staging" }).join(), /APP_ENV/);
  assert.match(rotationEnvironmentErrors({ ...safe, networkId: "mainnet" }).join(), /NEAR_NETWORK/);
  assert.match(rotationEnvironmentErrors({ ...safe, demoMode: false }).join(), /DEMO_MODE/);
  assert.match(rotationEnvironmentErrors({ ...safe, operatorAccount: "ops.near" }).join(), /testnet account/);
});

test("confirmation is explicit and unknown flags fail", () => {
  assert.deepEqual(parseRotationArgs([]), { confirm: false, help: false });
  assert.deepEqual(parseRotationArgs([ROTATION_CONFIRM_FLAG]), { confirm: true, help: false });
  assert.deepEqual(parseRotationArgs(["--help"]), { confirm: false, help: true });
  assert.throws(() => parseRotationArgs(["--force"]), /unknown arguments/);
});

test("testnet detection includes implicit accounts", () => {
  assert.equal(isTestnetAccount("quizcity.testnet"), true);
  assert.equal(isTestnetAccount("a.test.near"), true);
  assert.equal(isTestnetAccount("a".repeat(64)), true);
  assert.equal(isTestnetAccount("quizcity.near"), false);
});

test("rotation targets exclude the operator and contract accounts", () => {
  const entries = [
    { accountId: "alice.testnet", publicKey: "a", secretKey: "s" },
    { accountId: "quizcity.testnet", publicKey: "b", secretKey: "s" },
  ];
  assert.deepEqual(
    rotationTargets(entries, "quizcity.testnet", "quizcity.testnet").map((e) => e.accountId),
    ["alice.testnet"],
  );
});
