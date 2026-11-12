import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, isValidAccountId, isLoopbackHost, loadConfig } from "../src/config.js";
import { testEnv } from "./fixtures.js";

const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...testEnv, ...overrides });

test("demo mode is default-deny when DEMO_MODE is absent", () => {
  const { DEMO_MODE: _omitted, ...rest } = env();
  assert.equal(loadConfig(rest).demoMode, false);
});

test("demo mode requires local/test + testnet + loopback", () => {
  assert.equal(loadConfig(env({ DEMO_MODE: "1" })).demoMode, true);
  assert.equal(loadConfig(env({ APP_ENV: "local", HOST: "localhost", DEMO_MODE: "1" })).host, "localhost");
  assert.throws(
    () => loadConfig(env({ APP_ENV: "staging", DEMO_MODE: "1" })),
    /only for APP_ENV=local or test/,
  );
  assert.throws(() => loadConfig(env({ APP_ENV: "production", DEMO_MODE: "1" })), /APP_ENV=production/);
  assert.throws(() => loadConfig(env({ NEAR_NETWORK: "mainnet", DEMO_MODE: "1" })), /only on testnet/);
  assert.throws(() => loadConfig(env({ HOST: "0.0.0.0", DEMO_MODE: "1" })), /loopback HOST/);
});

test("a public host is allowed when demo mode is disabled", () => {
  assert.equal(
    loadConfig(
      env({
        HOST: "0.0.0.0",
        APP_ENV: "staging",
        DEMO_MODE: "0",
        PGSSL: "require",
        WEB_ORIGIN: "https://quizcity.example",
        NEAR_CONTRACT_ID: "quizcity.testnet",
        NEAR_OPERATOR_ACCOUNT: "ops.testnet",
        NEAR_RPC_URL: "https://rpc.testnet.fastnear.com",
        NEAR_OPERATOR_PRIVATE_KEY: testEnv.NEAR_OPERATOR_PRIVATE_KEY,
        DATABASE_URL: "postgresql://u:p@db.example:5432/quizcity",
      }),
    ).host,
    "0.0.0.0",
  );
});

test("empty or malformed hosts are rejected", () => {
  assert.throws(() => loadConfig(env({ HOST: "" })), /HOST must not be empty/);
  assert.throws(() => loadConfig(env({ HOST: "https://example.com" })), /without a scheme or path/);
  assert.throws(() => loadConfig(env({ HOST: "example.com/path" })), /without a scheme or path/);
});

test("loopback helper accepts only the documented values", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) assert.equal(isLoopbackHost(host), true);
  for (const host of ["0.0.0.0", "127.0.0.2", "example.com", ""]) assert.equal(isLoopbackHost(host), false);
});

test("account IDs are validated syntactically", () => {
  const valid = [
    "alice.testnet",
    "a-b.testnet",
    "a_b.testnet",
    "sub.alice.testnet",
    "ab",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ];
  const invalid = [
    "a..b.testnet",
    "a-.testnet",
    "a_.testnet",
    ".alice.testnet",
    "alice.testnet.",
    "Alice.testnet",
    "alice testnet",
    "a",
    "alice--b.testnet",
    `${"a".repeat(65)}.testnet`,
    "-alice.testnet",
  ];
  for (const account of valid) assert.equal(isValidAccountId(account), true, account);
  for (const account of invalid) assert.equal(isValidAccountId(account), false, account);
});

test("contract and operator must match the configured network", () => {
  assert.throws(() => loadConfig(env({ NEAR_CONTRACT_ID: "quizcity.near" })), /does not belong to testnet/);
  assert.throws(
    () => loadConfig(env({ NEAR_NETWORK: "mainnet", NEAR_CONTRACT_ID: "quizcity.testnet" })),
    /does not belong to mainnet/,
  );
});

test("database URLs are parsed, not prefix-matched", () => {
  const invalid = [
    "postgresql://",
    "postgresql://?",
    "mysql://localhost/db",
    "https://localhost/db",
    "postgresql://localhost:5432",
    "postgresql://localhost:5432/",
    "postgresql://user:pass@localhost:5432/%ZZ",
  ];
  for (const url of invalid) {
    assert.throws(() => loadConfig(env({ DATABASE_URL: url })), ConfigError, url);
  }
  assert.match(
    loadConfig(env({ DATABASE_URL: "postgresql://user:pass@db.example:5432/quizcity?sslmode=require" }))
      .databaseUrl,
    /db\.example/,
  );
});

test("staging and production require TLS and URL credentials", () => {
  const base = {
    APP_ENV: "production",
    DEMO_MODE: "0",
    WEB_ORIGIN: "https://quizcity.example",
    DATABASE_URL: "postgresql://u:p@db.example:5432/quizcity",
    NEAR_NETWORK: "mainnet",
    NEAR_CONTRACT_ID: "quizcity.near",
    NEAR_OPERATOR_ACCOUNT: "quizcity.near",
    NEAR_RPC_URL: "https://rpc.mainnet.fastnear.com",
    PGSSL: "require",
  };
  assert.equal(loadConfig(env(base)).pgSsl, "require");
  assert.throws(() => loadConfig(env({ ...base, PGSSL: "disable" })), /PGSSL must be require/);
  assert.throws(() => loadConfig(env({ ...base, WEB_ORIGIN: "http://quizcity.example" })), /https/);
  assert.throws(
    () => loadConfig(env({ ...base, DATABASE_URL: "postgresql://db.example:5432/quizcity" })),
    /credentials/,
  );
});

test("WEB_ORIGIN must be a bare origin", () => {
  assert.throws(() => loadConfig(env({ WEB_ORIGIN: "https://example.com/app" })), /must not include a path/);
  assert.throws(() => loadConfig(env({ WEB_ORIGIN: "https://u:p@example.com" })), /without credentials/);
  assert.throws(
    () => loadConfig(env({ WEB_ORIGIN: "https://example.com/?a=1" })),
    /without credentials, query, or hash/,
  );
});

test("NODE_ENV=test maps to APP_ENV=test when APP_ENV is absent", () => {
  const { APP_ENV: _omitted, ...rest } = env({ NODE_ENV: "test" });
  assert.equal(loadConfig(rest).appEnv, "test");
});

test("ports, tick intervals, URLs, and keys are validated", () => {
  assert.throws(() => loadConfig(env({ PORT: "70000" })), /PORT must be between/);
  assert.throws(() => loadConfig(env({ NPC_TICK_MS: "5" })), /NPC_TICK_MS must be between/);
  assert.throws(() => loadConfig(env({ NEAR_RPC_URL: "http://example.com" })), /must use https/);
  assert.throws(() => loadConfig(env({ WEB_ORIGIN: "not-a-url" })), /must be a valid URL/);
  assert.throws(() => loadConfig(env({ NEAR_OPERATOR_PRIVATE_KEY: "secret" })), /private key/);
  assert.throws(() => loadConfig(env({ E2E_API: "ftp://localhost:8787" })), /must use https/);
  assert.equal(loadConfig(env({ E2E_API: "http://localhost:8787/" })).e2eApi, "http://localhost:8787");
});

test("operator credentials are required", () => {
  const { NEAR_OPERATOR_ACCOUNT: _account, ...withoutAccount } = env();
  assert.throws(() => loadConfig(withoutAccount), /NEAR_OPERATOR_ACCOUNT is required/);
  const { NEAR_OPERATOR_PRIVATE_KEY: _key, ...withoutKey } = env();
  assert.throws(() => loadConfig(withoutKey), /NEAR_OPERATOR_PRIVATE_KEY is required/);
});
