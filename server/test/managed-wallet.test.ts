import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { KeyPair } from "near-api-js";
import { sealWalletKey, openWalletKey, walletContext, walletRequestHash } from "../src/wallet-vault.js";
import { validateManagedWalletCall } from "../src/managed-wallet-methods.js";
import { loadConfig, assertManagedWalletConfigurationIsSafe } from "../src/config.js";
import { testEnv, makeTestConfig } from "./fixtures.js";
test("wallet encryption authenticates account ownership, rejects tampering and never embeds a plaintext key", () => {
  const master = randomBytes(32).toString("base64"),
    other = randomBytes(32).toString("base64"),
    secret = KeyPair.fromRandom("ed25519").toString(),
    context = walletContext("profile-a", "qc-a.testnet"),
    sealed = sealWalletKey(master, secret, context);
  assert.ok(!sealed.includes(secret));
  assert.ok(openWalletKey(master, sealed, context) === secret);
  for (const [key, cipher, aad] of [
    [other, sealed, context],
    [master, sealed, walletContext("profile-b", "qc-a.testnet")],
    [master, sealed, walletContext("profile-a", "qc-b.testnet")],
    [master, sealed.replace(/^v1/, "v2"), context],
    [master, sealed.slice(0, -8) + "AAAAAAAA", context],
  ])
    assert.throws(() => openWalletKey(key, cipher, aad), /could not be unlocked/);
  assert.notEqual(sealWalletKey(master, secret, context), sealed);
});
test("managed signer accepts bounded game commands and denies account administration, deposits and operator powers", () => {
  for (const method of [
    "toString",
    "__proto__",
    "credit_reward",
    "pay_job",
    "npc_purchase",
    "settle_escrow",
    "create_wallet",
    "reset_demo",
    "migrate_economy",
    "add_key",
    "delete_key",
    "transfer",
    "deploy_contract",
    "pay_service",
  ])
    assert.throws(() => validateManagedWalletCall(method, {}));
  assert.doesNotThrow(() => validateManagedWalletCall("buy_property", { property_id: 1 }));
  assert.doesNotThrow(() => validateManagedWalletCall("business_withdraw", { business_id: 1, amount: "10" }));
  for (const args of [
    { property_id: 1, deposit: "1" },
    { property_id: 0 },
    { property_id: 1, receiverId: "attacker.testnet" },
  ])
    assert.throws(() => validateManagedWalletCall("buy_property", args));
  assert.throws(() => validateManagedWalletCall("business_withdraw", { business_id: 1, amount: "1e3" }));
  assert.equal(
    walletRequestHash("buy_property", { a: 1, b: 2 }),
    walletRequestHash("buy_property", { b: 2, a: 1 }),
  );
  assert.notEqual(walletRequestHash("buy_property", { a: 1 }), walletRequestHash("buy_property", { a: 2 }));
});
test("automatic custody is testnet-only, opt-in, encrypted and rejected for unsafe config overrides", () => {
  const key = randomBytes(32).toString("base64");
  assert.equal(loadConfig(testEnv).autoTestnetWallets, false);
  assert.equal(
    loadConfig({ ...testEnv, AUTO_TESTNET_WALLETS: "1", TESTNET_WALLET_ENCRYPTION_KEY: key })
      .autoTestnetWallets,
    true,
  );
  for (const env of [
    { AUTO_TESTNET_WALLETS: "yes" },
    { AUTO_TESTNET_WALLETS: "1" },
    { AUTO_TESTNET_WALLETS: "1", TESTNET_WALLET_ENCRYPTION_KEY: "bad" },
  ])
    assert.throws(() => loadConfig({ ...testEnv, ...env }));
  const cfg = makeTestConfig({ autoTestnetWallets: true, testnetWalletEncryptionKey: key });
  for (const patch of [
    { networkId: "mainnet" },
    { appEnv: "production" },
    { testnetWalletFaucetUrl: "http://helper.nearprotocol.com/account" },
    { testnetWalletFaucetUrl: "https://user:password@helper.nearprotocol.com/account" },
    { testnetWalletFaucetUrl: "https://helper.nearprotocol.com/account?secret=bad" },
  ])
    assert.throws(() => assertManagedWalletConfigurationIsSafe({ ...cfg, ...patch } as typeof cfg));
});

test("native account queries distinguish missing accounts from accounts without the expected access policy", async () => {
  const { createManagedWalletChain } = await import("../src/managed-wallet-chain.js");
  const cfg = makeTestConfig();
  let mode = "missing";
  const provider = {
    query: async (input: any) => {
      if (mode === "outage") throw Error("provider detail");
      if (input.request_type === "view_account") {
        if (mode === "missing") throw { type: "AccountDoesNotExist" };
        return {};
      }
      return {
        keys: mode === "empty" ? [] : [{ public_key: "public", access_key: { permission: "FullAccess" } }],
      };
    },
    sendTransaction: async () => ({}),
  };
  const chain = createManagedWalletChain(cfg, { provider: provider as never });
  assert.equal(await chain.accountKeys("a.testnet"), null);
  mode = "empty";
  assert.deepEqual(await chain.accountKeys("a.testnet"), []);
  mode = "ready";
  assert.deepEqual(await chain.accountKeys("a.testnet"), [{ publicKey: "public", permission: "FullAccess" }]);
  mode = "outage";
  await assert.rejects(
    chain.accountKeys("a.testnet"),
    (e: any) => e.code === "CHAIN_UNAVAILABLE" && !e.message.includes("provider detail"),
  );
});
test("testnet sponsor receives only the public key; rate limits, provider errors and invalid contract responses stay safe", async () => {
  const { createManagedWalletChain } = await import("../src/managed-wallet-chain.js");
  const cfg = makeTestConfig();
  let mode = "ok";
  let submitted: any;
  const provider = {
    query: async () => {
      if (mode === "old") throw Error("MethodNotFound");
      if (mode === "outage") throw Error("provider details");
      return { result: [...Buffer.from(JSON.stringify(mode === "supported"))] };
    },
    sendTransaction: async () => ({}),
  };
  const chain = createManagedWalletChain(cfg, {
    provider: provider as never,
    fetch: (async (_url, init) => {
      submitted = JSON.parse(String(init?.body));
      if (mode === "network") throw Error("provider details");
      return new Response("", { status: mode === "rate" ? 429 : mode === "bad" ? 500 : 200 });
    }) as typeof fetch,
  });
  await chain.createAccount("new.testnet", "public");
  assert.deepEqual(submitted, { newAccountId: "new.testnet", newAccountPublicKey: "public" });
  for (const [m, code] of [
    ["rate", "FAUCET_RATE_LIMITED"],
    ["bad", "FAUCET_UNAVAILABLE"],
    ["network", "FAUCET_UNAVAILABLE"],
  ]) {
    mode = m;
    await assert.rejects(chain.createAccount("new.testnet", "public"), (e: any) => e.code === code);
  }
  mode = "old";
  assert.equal(await chain.supportsGame(), false);
  mode = "supported";
  assert.equal(await chain.supportsGame(), true);
  mode = "ok";
  assert.equal(await chain.supportsGame(), false);
  mode = "outage";
  await assert.rejects(chain.supportsGame(), (e: any) => e.code === "CHAIN_UNAVAILABLE");
});
test("managed signing fixes receiver, method, gas and zero deposit and retains exact U64 nonce precision", async () => {
  const { createManagedWalletChain } = await import("../src/managed-wallet-chain.js");
  const { transactions, utils } = await import("near-api-js");
  const cfg = makeTestConfig();
  let permission = "FullAccess",
    nonce: number | string = "9007199254740994";
  let sent: any;
  const key = KeyPair.fromRandom("ed25519");
  const provider = {
    query: async () => ({ permission, nonce, block_hash: "1".repeat(32) }),
    sendTransaction: async (s: any) => {
      sent = s;
      return {};
    },
  };
  const chain = createManagedWalletChain(cfg, {
    provider: provider as never,
    verify: async (hash) => ({ txHash: hash, events: [], outcome: {} as never }),
  });
  const signed = await chain.sign(
    "new.testnet",
    key.toString(),
    "buy_property",
    { property_id: 1 },
    "9007199254741000",
  );
  assert.equal(signed.nonce, "9007199254741001");
  const decoded = transactions.SignedTransaction.decode(Buffer.from(signed.bytes, "base64"));
  assert.equal(decoded.transaction.receiverId, cfg.contractId);
  const action = decoded.transaction.actions[0].functionCall!;
  assert.equal(action.methodName, "buy_property");
  assert.equal(action.deposit, 0n);
  assert.equal(action.gas, 30000000000000n);
  assert.ok(
    key.verify(
      utils.serialize.base_decode(signed.hash),
      Uint8Array.from(decoded.signature.ed25519Signature.data),
    ),
  );
  await chain.broadcast(signed.bytes);
  assert.equal(sent.transaction.nonce, 9007199254741001n);
  assert.equal(
    (
      await chain.verify(signed.hash, {
        signerId: "new.testnet",
        method: "buy_property",
        args: { property_id: 1 },
      })
    ).txHash,
    signed.hash,
  );
  permission = "FunctionCall";
  await assert.rejects(chain.sign("new.testnet", key.toString(), "buy_property", {}, "0"));
  permission = "FullAccess";
  nonce = 9007199254740992;
  await assert.rejects(chain.sign("new.testnet", key.toString(), "buy_property", {}, "0"));
  nonce = "18446744073709551615";
  await assert.rejects(chain.sign("new.testnet", key.toString(), "buy_property", {}, "0"));
});
