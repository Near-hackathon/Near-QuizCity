import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPublicApp } from "../src/app.js";
import { loadDemoAccounts } from "../src/demo-accounts.js";
import { makeTestConfig, TEST_PRIVATE_KEY } from "./fixtures.js";

const dirs: string[] = [];

function demoFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "quizcity-demo-"));
  dirs.push(dir);
  const file = join(dir, "accounts.json");
  writeFileSync(
    file,
    JSON.stringify({
      alice: {
        accountId: "alice-quizcity.testnet",
        publicKey: "ed25519:11111111111111111111111111111111",
        secretKey: "ed25519:1111111111111111111111111111111111111111111111111111111111111111",
      },
      operator: {
        accountId: "quizcity.testnet",
        publicKey: "ed25519:22222222222222222222222222222222",
        secretKey: TEST_PRIVATE_KEY,
      },
      contract: {
        accountId: "quizcity.testnet",
        publicKey: "ed25519:33333333333333333333333333333333",
        secretKey: "ed25519:3333333333333333333333333333333333333333333333333333333333333333",
      },
      leaked: {
        accountId: "mallory-quizcity.testnet",
        publicKey: "ed25519:44444444444444444444444444444444",
        secretKey: TEST_PRIVATE_KEY,
      },
    }),
  );
  return file;
}

test("demo accounts are default-deny", async () => {
  const app = await buildPublicApp(makeTestConfig({ demoMode: false, demoAccountsFile: demoFile() }));
  try {
    const res = await app.inject({ method: "GET", url: "/v1/demo/accounts" });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("demo mode serves only approved accounts and never operator credentials", async () => {
  const app = await buildPublicApp(makeTestConfig({ demoMode: true, demoAccountsFile: demoFile() }));
  try {
    const res = await app.inject({ method: "GET", url: "/v1/demo/accounts" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { accounts: { accountId: string; secretKey: string }[] };
    assert.deepEqual(
      body.accounts.map((a) => a.accountId),
      ["alice-quizcity.testnet"],
    );
    assert.ok(body.accounts.every((a) => a.secretKey !== TEST_PRIVATE_KEY));
  } finally {
    await app.close();
  }
});

test("an unsafe AppConfig override cannot serve secrets", async () => {
  const file = demoFile();
  const app = await buildPublicApp(
    makeTestConfig({ demoMode: true, appEnv: "staging", host: "0.0.0.0", demoAccountsFile: file }),
  );
  try {
    const res = await app.inject({ method: "GET", url: "/v1/demo/accounts" });
    assert.equal(res.statusCode, 503);
    assert.ok(!res.body.includes("ed25519:"));
  } finally {
    await app.close();
  }
  assert.throws(
    () =>
      loadDemoAccounts(makeTestConfig({ demoMode: true, host: "0.0.0.0", demoAccountsFile: "/nonexistent" })),
    /loopback HOST/,
  );
});

test("config endpoint exposes no secrets", async () => {
  const app = await buildPublicApp(makeTestConfig({ demoMode: true, demoAccountsFile: demoFile() }));
  try {
    const res = await app.inject({ method: "GET", url: "/v1/config" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      autoTestnetWallets: false,
      demoMode: true,
      networkId: "testnet",
      contractId: "quizcity.testnet",
      protocolVersion: "1.0.0",
    });
  } finally {
    await app.close();
  }
});

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
