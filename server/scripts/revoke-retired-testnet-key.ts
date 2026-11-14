import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair, providers, keyStores, connect } from "near-api-js";
import { config } from "../src/runtime-config.js";
import { assertTestnetUpgradeTarget, assertRetiredKeyRemoval, digest } from "../src/testnet-upgrade.js";
assertTestnetUpgradeTarget(config);
const confirm = process.argv[2] === "--confirm-retired-key-revocation";
if (process.argv.length > 3 || (process.argv[2] && !confirm && process.argv[2] !== "--dry-run"))
  throw Error("Use --dry-run or --confirm-retired-key-revocation.");
const root = fileURLToPath(new URL("../../", import.meta.url)),
  directory = resolve(
    homedir(),
    ".config",
    "quiz-city",
    digest(root).slice(0, 16),
    "deployment",
    config.contractId,
  );
const json = async (name: string) => JSON.parse(await readFile(resolve(directory, name), "utf8"));
async function main() {
  const old = await json("previous-server-key.json"),
    recovery = await json("recovery-key.json"),
    payout = await json("payout-key.json"),
    deployment = await json("deployment.json"),
    verified = await json("verified-deployment.json"),
    check = await json("payout-check.json");
  if (
    !check.passed ||
    check.publicKey !== payout.public_key ||
    check.steps.some((s: any) => s.state !== "verified") ||
    deployment.codeHash !== verified.codeHash
  )
    throw Error("Deployment and payout proof are incomplete.");
  const provider = new providers.JsonRpcProvider({ url: config.rpcUrl });
  const native = (await provider.query({
    request_type: "view_account",
    finality: "final",
    account_id: config.contractId,
  })) as any;
  if (native.code_hash !== deployment.codeHash)
    throw Error("The deployed code differs from the reviewed artifact.");
  const keys = (await provider.query({
    request_type: "view_access_key_list",
    finality: "final",
    account_id: config.contractId,
  })) as any;
  const serverPublicKey = KeyPair.fromString(config.operatorPrivateKey as never)
    .getPublicKey()
    .toString();
  const policy = {
    oldPublicKey: old.public_key,
    recoveryPublicKey: recovery.public_key,
    payoutPublicKey: payout.public_key,
    serverPublicKey,
    receiverId: config.contractId,
    keys: keys.keys,
  };
  assertRetiredKeyRemoval(policy);
  const present = keys.keys.some((k: any) => k.public_key === old.public_key);
  const plan = {
    account: config.contractId,
    retiredKey: old.public_key,
    recoveryKey: recovery.public_key,
    restrictedPayoutKey: payout.public_key,
    alreadyRevoked: !present,
  };
  if (!confirm || !present) {
    console.log(JSON.stringify({ dryRun: !confirm, ...plan }));
    return;
  }
  const store = new keyStores.InMemoryKeyStore(),
    recoveryKey = KeyPair.fromString(recovery.private_key);
  if (recoveryKey.getPublicKey().toString() !== recovery.public_key)
    throw Error("Recovery credential identity does not match.");
  await store.setKey("testnet", config.contractId, recoveryKey);
  const account = await (
    await connect({ networkId: "testnet", nodeUrl: config.rpcUrl, keyStore: store })
  ).account(config.contractId);
  const sent = await account.deleteKey(old.public_key);
  await writeFile(
    resolve(directory, "retired-key-revoked.json"),
    JSON.stringify({ txHash: sent.transaction_outcome.id, ...plan }, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  const after = (await provider.query({
    request_type: "view_access_key_list",
    finality: "optimistic",
    account_id: config.contractId,
  })) as any;
  assertRetiredKeyRemoval({ ...policy, keys: after.keys });
  if (after.keys.some((k: any) => k.public_key === old.public_key))
    throw Error("Revocation is not confirmed yet.");
  console.log(
    JSON.stringify({
      revoked: true,
      txHash: sent.transaction_outcome.id,
      ...plan,
      remainingKeys: after.keys,
    }),
  );
}
main().catch(() => {
  console.error(
    "Retired-key revocation stopped. Existing recovery credentials were kept. Audit the current keys and saved transaction before retrying.",
  );
  process.exitCode = 1;
});
