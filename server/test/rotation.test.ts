import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseRotationArgs,
  planDemoRotation,
  rotationConfigFromEnv,
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

test("demo rotation plan is player-only regardless of JSON property names", () => {
  const entries = [
    { name: "operator", accountId: "alice.testnet", publicKey: "a", secretKey: "s" },
    { name: "player", accountId: "quizcity.testnet", publicKey: "b", secretKey: "s" },
    { name: "contract", accountId: "quizcity.testnet", publicKey: "c", secretKey: "s" },
  ];
  const plan = planDemoRotation(entries, "quizcity.testnet", "quizcity.testnet");
  assert.deepEqual(
    plan.accounts.map((entry) => entry.accountId),
    ["alice.testnet"],
  );
  assert.equal(plan.scope, "demo-player-keys");
  assert.deepEqual(plan.backupFiles, ["demo-accounts.json"]);
  assert.equal(plan.mutatesOperator, false);
});

test("demo rotation script never touches the operator key or .env", () => {
  const source = readFileSync(new URL("../scripts/rotate-demo-keys.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /NEAR_OPERATOR_PRIVATE_KEY/);
  assert.doesNotMatch(source, /operatorPrivateKey/);
  assert.doesNotMatch(source, /runtime-config/);
  assert.doesNotMatch(source, /envPath/);
  assert.doesNotMatch(source, /"\.\.\/\.env"/);
  assert.match(source, /planDemoRotation/);
});

test("rotation config reads only non-secret fields", () => {
  const config = rotationConfigFromEnv({
    APP_ENV: "local",
    NEAR_NETWORK: "testnet",
    DEMO_MODE: "1",
    NEAR_CONTRACT_ID: "quizcity.testnet",
    NEAR_OPERATOR_ACCOUNT: "quizcity.testnet",
    NEAR_OPERATOR_PRIVATE_KEY: "ed25519:secret",
  });
  assert.equal(config.demoMode, true);
  assert.equal(config.rpcUrl, "https://rpc.testnet.fastnear.com");
  assert.equal("operatorPrivateKey" in config, false);
});
