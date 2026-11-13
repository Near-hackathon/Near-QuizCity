import assert from "node:assert/strict";
import test, { after } from "node:test";
import { makeTestConfig, testEnv } from "./fixtures.js";

Object.assign(process.env, testEnv);
const { buildApp } = await import("../src/app.js");
const { isPublicRoute } = await import("../src/auth/plugin.js");

const app = await buildApp(makeTestConfig({ rateLimitMax: 1 }));
await app.ready();

test("security headers are present and live readiness does not require the database", async () => {
  const response = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(response.json().ok, true);
});

test("rate limits return the shared envelope with retry-after", async () => {
  const first = await app.inject({ method: "GET", url: "/v1/config" });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({ method: "GET", url: "/v1/config" });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, "RATE_LIMITED");
  assert.ok(Number(second.headers["retry-after"]) >= 1);
});

test("CORS reflects only the configured origin", async () => {
  const allowed = await app.inject({
    method: "OPTIONS",
    url: "/v1/config",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "GET",
    },
  });
  assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(allowed.headers["access-control-allow-credentials"], "true");

  const denied = await app.inject({
    method: "OPTIONS",
    url: "/v1/config",
    headers: {
      origin: "http://evil.example",
      "access-control-request-method": "GET",
    },
  });
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
});

test("financial wallet and ledger reads are never public", () => {
  assert.equal(isPublicRoute("GET", "/v1/wallets", "/v1/wallets"), false);
  assert.equal(isPublicRoute("GET", "/v1/transactions", "/v1/transactions"), false);
  assert.equal(isPublicRoute("GET", "/v1/properties", "/v1/properties"), true);
});

after(async () => {
  await app.close();
});
