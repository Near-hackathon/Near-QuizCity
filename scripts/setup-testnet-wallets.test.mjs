import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { configureWalletEnvironment } from "./setup-testnet-wallets.mjs";
test("wallet setup is deliberate, testnet-only, idempotent and retains the encryption key", () => {
  const env = "APP_ENV=local\nNEAR_NETWORK=testnet\n";
  const dry = configureWalletEnvironment(env, undefined, false);
  assert.equal(dry.source, env);
  assert.equal(dry.apply, false);
  const enabled = configureWalletEnvironment(env, dry.key, true);
  assert.ok(enabled.source.includes("AUTO_TESTNET_WALLETS=1"));
  assert.ok(configureWalletEnvironment(enabled.source, dry.key, true).key === dry.key);
  for (const input of [
    env.replace("local", "production"),
    env.replace("local", "staging"),
    env.replace("testnet", "mainnet"),
  ])
    assert.throws(() => configureWalletEnvironment(input, undefined, true));
  assert.throws(() => configureWalletEnvironment(enabled.source, randomBytes(32).toString("base64"), true));
  assert.throws(() => configureWalletEnvironment(env + "TESTNET_WALLET_ENCRYPTION_KEY=bad", undefined, true));
});
