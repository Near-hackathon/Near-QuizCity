/** Read-only live smoke. Economic mutation tests run in the local sandbox suite. */
import assert from "node:assert/strict";
import { config } from "../src/runtime-config.js";
import { providers, KeyPair } from "near-api-js";
import { viewContract } from "../src/near.js";
import { assertRestrictedPayoutKey } from "../src/access-key.js";
import { CITY_PAYOUT_METHODS } from "../src/testnet-upgrade.js";
if (
  process.env.RUN_TESTNET_SMOKE !== "1" ||
  !["local", "test"].includes(config.appEnv) ||
  config.networkId !== "testnet"
) {
  console.error("Live smoke requires RUN_TESTNET_SMOKE=1, APP_ENV=local|test and testnet.");
  process.exit(2);
}
async function main() {
  const provider = new providers.JsonRpcProvider({ url: config.rpcUrl }),
    publicKey = KeyPair.fromString(config.operatorPrivateKey as never)
      .getPublicKey()
      .toString();
  const key = (await provider.query({
    request_type: "view_access_key",
    finality: "final",
    account_id: config.operatorAccount,
    public_key: publicKey,
  })) as any;
  assertRestrictedPayoutKey(key.permission, { receiverId: config.contractId, methods: CITY_PAYOUT_METHODS });
  assert.equal(await viewContract("supports_city_economy"), true);
  assert.equal(await viewContract("supports_orders"), true);
  for (const path of ["/health/live", "/health/ready", "/v1/config"]) {
    const r = await fetch(config.e2eApi + path);
    assert.equal(r.status, 200, `Readiness check failed at ${path}`);
  }
  const economyResponse = await fetch(config.e2eApi + "/v1/economy");
  assert.equal(economyResponse.status, 200);
  const economy = (await economyResponse.json()) as any;
  assert.equal(economy.supply_difference, "0");
  console.log(
    JSON.stringify({
      passed: true,
      contract: config.contractId,
      methods: CITY_PAYOUT_METHODS,
      serverKeyPermission: "FunctionCall",
      supplyDifference: economy.supply_difference,
      stats: await viewContract("get_stats"),
    }),
  );
}
main().catch(() => {
  console.error("Live smoke failed. Check readiness, capabilities, key policy and reconciliation.");
  process.exitCode = 1;
});
