import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { connect, keyStores, KeyPair } from "near-api-js";
import { assertWasmExports } from "../../scripts/wasm-exports.mjs";
import { config } from "../src/runtime-config.js";
import { contractId, networkId } from "../src/near.js";

const artifactName = "quizcity-demo.wasm";
const wasmPath = new URL(`../../contract/target/near/${artifactName}`, import.meta.url);
if (basename(wasmPath.pathname) !== artifactName) {
  throw new Error(
    `refusing to deploy ${wasmPath.pathname}: expected the named demo artifact ${artifactName}`,
  );
}

const wasm = readFileSync(wasmPath);
try {
  assertWasmExports(wasm, { demo: true });
} catch (error) {
  throw new Error(
    `refusing to deploy ${artifactName}: ${error instanceof Error ? error.message : String(error)}. ` +
      "Run `npm run contract:build:demo` first.",
    { cause: error },
  );
}
const sha256 = createHash("sha256").update(wasm).digest("hex");
console.log("deploying demo artifact", wasm.length, "bytes", "sha256", sha256, "to", contractId);

const deployKey = process.env.NEAR_DEPLOY_PRIVATE_KEY?.trim();
if (!deployKey) {
  throw new Error(
    "NEAR_DEPLOY_PRIVATE_KEY is required for chain:seed. " +
      "Deployment and migrate_reset need the contract account's offline full-access key; " +
      "the server's NEAR_OPERATOR_PRIVATE_KEY is a payout-only function-call key.",
  );
}

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey(
  networkId,
  contractId,
  KeyPair.fromString(deployKey as Parameters<typeof KeyPair.fromString>[0]),
);
const near = await connect({ networkId, nodeUrl: config.rpcUrl, keyStore, deps: { keyStore } });
const account = await near.account(contractId);

async function call(method: string, args: Record<string, unknown>) {
  const outcome = await account.functionCall({
    contractId,
    methodName: method,
    args,
    gas: 30_000_000_000_000n,
    attachedDeposit: 0n,
  });
  return outcome.transaction_outcome.id;
}

await account.deployContract(wasm);
await call("migrate_reset", {});
await call("create_wallet", { wallet: "npc:professor-kofi", initial_balance: "1000" });
await call("create_wallet", { wallet: "gov:council", initial_balance: "0" });
await call("create_property", {
  kind: "plot",
  district: "knowledge",
  x: 4,
  y: 7,
  owner_wallet: "npc:professor-kofi",
  price: "300",
});
console.log("chain reset and seeded");
