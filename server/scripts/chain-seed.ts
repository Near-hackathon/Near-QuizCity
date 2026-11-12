import { readFileSync } from "node:fs";
import { getOperator } from "../src/operator.js";
import { contractId } from "../src/near.js";

const wasmPath = new URL("../../contract/target/near/quizcity.wasm", import.meta.url);
const wasm = readFileSync(wasmPath);
const account = await getOperator();

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

console.log("deploying", wasm.length, "bytes to", contractId);
await account.deployContract(wasm);
await call("reset_demo", {});
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
