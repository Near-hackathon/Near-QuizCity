import { assertRestrictedPayoutKey } from "./access-key.js";
import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
export const CITY_PAYOUT_METHODS = ["credit_reward", "pay_job", "settle_escrow", "npc_purchase"] as const;
export const UPGRADE_ALLOWANCE = 10n ** 24n;
export function assertTestnetUpgradeTarget(
  cfg: Pick<AppConfig, "appEnv" | "networkId" | "contractId" | "operatorAccount">,
) {
  if (
    !["local", "test"].includes(cfg.appEnv) ||
    cfg.networkId !== "testnet" ||
    cfg.contractId !== "quizcity.testnet" ||
    cfg.operatorAccount !== cfg.contractId
  )
    throw Error("This administrator procedure is limited to the local quizcity.testnet operator/contract.");
}
export function digest(data: Uint8Array | string) {
  return createHash("sha256").update(data).digest("hex");
}
export function assertUpgradeProof(
  snapshot: { accountId: string; codeHash: string },
  bytes: Uint8Array,
  snapshotBytes: string,
  proof: {
    accountId: string;
    previousCodeHash: string;
    wasmSha256: string;
    snapshotSha256: string;
    passed: boolean;
  },
) {
  if (
    !proof.passed ||
    proof.accountId !== snapshot.accountId ||
    proof.previousCodeHash !== snapshot.codeHash ||
    proof.wasmSha256 !== digest(bytes) ||
    proof.snapshotSha256 !== digest(snapshotBytes)
  )
    throw Error("The exact account, snapshot and WASM require a passing sandbox rehearsal.");
}

export function assertRetiredKeyRemoval(input: {
  oldPublicKey: string;
  recoveryPublicKey: string;
  payoutPublicKey: string;
  serverPublicKey: string;
  receiverId: string;
  keys: Array<{
    public_key: string;
    access_key: { permission: import("./access-key.js").AccessKeyPermission };
  }>;
}) {
  const { oldPublicKey: old, recoveryPublicKey: recovery, payoutPublicKey: payout } = input;
  if (new Set([old, recovery, payout]).size !== 3 || input.serverPublicKey !== payout)
    throw Error(
      "Recovery, server and retired keys must be separate; the server must already use the payout key.",
    );
  const expected = new Set([
    recovery,
    payout,
    ...(input.keys.some((k) => k.public_key === old) ? [old] : []),
  ]);
  if (input.keys.length !== expected.size || input.keys.some((k) => !expected.has(k.public_key)))
    throw Error("Unexpected account keys require review before revocation.");
  if (input.keys.find((k) => k.public_key === recovery)?.access_key.permission !== "FullAccess")
    throw Error("Recovery full access must be confirmed.");
  const permission = input.keys.find((k) => k.public_key === payout)?.access_key.permission;
  if (!permission) throw Error("Payout key is missing.");
  assertRestrictedPayoutKey(permission, { receiverId: input.receiverId, methods: CITY_PAYOUT_METHODS });
}
