/** Replays a downloaded public state snapshot against the real local sandbox. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "near-workspaces";
import { createHash } from "node:crypto";
import { utils } from "near-api-js";
import { digest } from "../src/testnet-upgrade.js";
import { assertWasmExports } from "../../scripts/wasm-exports.mjs";
const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw Error("Supply the prepared snapshot directory.");
const raw = await readFile(resolve(directory, "snapshot.json"), "utf8"),
  snapshot = JSON.parse(raw);
const old = await readFile(resolve(directory, "previous.wasm"));
const next = await readFile(
  fileURLToPath(new URL("../../contract/target/near/quizcity-production.wasm", import.meta.url)),
);
assertWasmExports(next, { demo: false });
assert.equal(utils.serialize.base_encode(createHash("sha256").update(old).digest()), snapshot.codeHash);
const worker = await Worker.init();
try {
  const target = await worker.rootAccount.createSubAccount("upgrade", {
    initialBalance: 50000000000000000000000000n,
  });
  await target.deploy(old);
  await worker.provider.patchStateRecords({
    records: snapshot.values.map((v: { key: string; value: string }) => ({
      Data: { account_id: target.accountId, data_key: v.key, value: v.value },
    })),
  });
  const call = <T>(method: string, args: Record<string, unknown> = {}) => target.view<T>(method, args);
  assert.deepEqual(await call("get_stats"), snapshot.facts.stats);
  assert.deepEqual(await call("get_properties", { from_index: 0, limit: 100 }), snapshot.facts.properties);
  assert.deepEqual(await call("get_businesses", { from_index: 0, limit: 100 }), snapshot.facts.businesses);
  const upgrade = await target
    .batch(target.accountId)
    .deployContract(next)
    .functionCall("migrate_economy", {}, { gas: 150000000000000n })
    .transact();
  if (!upgrade.succeeded)
    throw Error("The downloaded legacy state did not migrate; live deployment must stop.");
  assert.equal(await call("supports_city_economy"), true);
  assert.deepEqual(await call("get_stats"), snapshot.facts.stats);
  assert.deepEqual(
    (await call<any[]>("get_properties", { from_index: 0, limit: 100 })).map((p) => ({
      ...p,
      price: String(p.price),
    })),
    snapshot.facts.properties.map((p: any) => ({ ...p, price: String(p.price) })),
  );
  assert.deepEqual(await call("get_businesses", { from_index: 0, limit: 100 }), snapshot.facts.businesses);
  for (const p of snapshot.facts.players)
    assert.deepEqual(await call("get_player", { account: p.accountId }), p.value);
  for (const w of snapshot.facts.wallets)
    assert.equal(await call("get_balance", { wallet: w.wallet }), w.balance);
  const state = await worker.provider.viewStateRaw(target.accountId, "", { finality: "optimistic" });
  const after = new Map(state.map((v) => [v.key, v.value]));
  for (const before of snapshot.values) {
    if (Buffer.from(before.key, "base64").toString() === "STATE") continue;
    assert.equal(after.get(before.key), before.value, "Stored legacy collection entry changed.");
  }
  const unauthorized = await worker.rootAccount.callRaw(target.accountId, "migrate_economy", {});
  assert.equal(unauthorized.succeeded, false);
  assert.deepEqual(await call("get_stats"), snapshot.facts.stats);
  // A bad initializer must roll back its accompanying code deployment too.
  const nativeBefore = await worker.provider.viewAccount(target.accountId, { finality: "optimistic" });
  const invalid = await target
    .batch(target.accountId)
    .deployContract(old)
    .functionCall("method_that_does_not_exist", {})
    .transact();
  assert.equal(invalid.succeeded, false);
  const nativeAfter = await worker.provider.viewAccount(target.accountId, { finality: "optimistic" });
  assert.equal(nativeAfter.code_hash, nativeBefore.code_hash);
  assert.equal(await call("supports_city_economy"), true);
  const proof = {
    accountId: snapshot.accountId,
    previousCodeHash: snapshot.codeHash,
    wasmSha256: digest(next),
    snapshotSha256: digest(raw),
    passed: true,
    checkedAt: new Date().toISOString(),
    assertions: [
      "exact downloaded legacy state",
      "all legacy collection records unchanged",
      "all players/wallet balances/property/business owners preserved",
      "stats/supply/counters unchanged",
      "unauthorized migration rejected",
      "failed deploy+call is atomic",
    ],
  };
  await writeFile(resolve(directory, "rehearsal.json"), JSON.stringify(proof, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify(proof));
} finally {
  await worker.tearDown();
}
