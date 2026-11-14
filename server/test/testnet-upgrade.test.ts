import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTestnetUpgradeTarget,
  assertUpgradeProof,
  digest,
  CITY_PAYOUT_METHODS,
} from "../src/testnet-upgrade.js";
import { makeTestConfig } from "./fixtures.js";
test("administrator upgrade is testnet-specific and binds exact rehearsal account, code, snapshot and artifact", () => {
  const cfg = makeTestConfig();
  assert.doesNotThrow(() => assertTestnetUpgradeTarget(cfg));
  for (const patch of [
    { appEnv: "production" },
    { appEnv: "staging" },
    { networkId: "mainnet" },
    { contractId: "other.testnet" },
    { operatorAccount: "other.testnet" },
  ])
    assert.throws(() => assertTestnetUpgradeTarget({ ...cfg, ...patch } as typeof cfg));
  const snapshot = { accountId: "quizcity.testnet", codeHash: "old" },
    bytes = Buffer.from("wasm"),
    raw = "snapshot";
  const proof = {
    accountId: snapshot.accountId,
    previousCodeHash: "old",
    wasmSha256: digest(bytes),
    snapshotSha256: digest(raw),
    passed: true,
  };
  assert.doesNotThrow(() => assertUpgradeProof(snapshot, bytes, raw, proof));
  for (const patch of [
    { accountId: "another.testnet" },
    { previousCodeHash: "other" },
    { wasmSha256: "wrong" },
    { snapshotSha256: "wrong" },
    { passed: false },
  ])
    assert.throws(() => assertUpgradeProof(snapshot, bytes, raw, { ...proof, ...patch }));
  assert.deepEqual([...CITY_PAYOUT_METHODS].sort(), [
    "credit_reward",
    "npc_purchase",
    "pay_job",
    "settle_escrow",
  ]);
});

test("retired key removal requires proven recovery, a restricted current server key and exactly the reviewed key set", async () => {
  const { assertRetiredKeyRemoval } = await import("../src/testnet-upgrade.js");
  const key = (public_key: string, permission: any) => ({ public_key, access_key: { permission } });
  const restricted = {
    FunctionCall: {
      receiver_id: "quizcity.testnet",
      method_names: [...CITY_PAYOUT_METHODS],
      allowance: "1000",
    },
  };
  const input = {
    oldPublicKey: "old",
    recoveryPublicKey: "recovery",
    payoutPublicKey: "payout",
    serverPublicKey: "payout",
    receiverId: "quizcity.testnet",
    keys: [key("old", "FullAccess"), key("recovery", "FullAccess"), key("payout", restricted)],
  };
  assert.doesNotThrow(() => assertRetiredKeyRemoval(input));
  assert.doesNotThrow(() => assertRetiredKeyRemoval({ ...input, keys: input.keys.slice(1) }));
  for (const patch of [
    { serverPublicKey: "old" },
    { recoveryPublicKey: "old" },
    { keys: [...input.keys, key("unexpected", "FullAccess")] },
    { keys: input.keys.filter((k) => k.public_key !== "recovery") },
    { keys: [key("old", "FullAccess"), key("recovery", "FullAccess"), key("payout", "FullAccess")] },
  ])
    assert.throws(() => assertRetiredKeyRemoval({ ...input, ...patch }));
});
