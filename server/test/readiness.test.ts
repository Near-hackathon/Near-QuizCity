import assert from "node:assert/strict";
import test from "node:test";
import { makeTestConfig } from "./fixtures.js";

const { buildPublicApp } = await import("../src/app.js");

test("liveness stays up while readiness reflects each dependency", async () => {
  const app = await buildPublicApp(makeTestConfig(), {
    readiness: {
      database: async () => false,
      contract: async () => true,
      indexer: null,
    },
  });
  const live = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(live.statusCode, 200);
  assert.equal(live.json().ok, true);

  const ready = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json().checks, {
    database: "failed",
    contract: "ok",
    indexer: "disabled",
  });
  await app.close();

  const contractDown = await buildPublicApp(makeTestConfig(), {
    readiness: { database: async () => true, contract: async () => false, indexer: null },
  });
  const contractResponse = await contractDown.inject({ method: "GET", url: "/health/ready" });
  assert.equal(contractResponse.statusCode, 503);
  assert.equal(contractResponse.json().checks.contract, "failed");
  await contractDown.close();
});

test("a required indexer failure makes readiness fail, optional indexer is disabled", async () => {
  const required = await buildPublicApp(
    makeTestConfig({ chainSourceRequired: true, chainEventSourceUrl: "https://indexer.test/events" }),
    {
      readiness: {
        database: async () => true,
        contract: async () => true,
        indexer: async () => false,
      },
    },
  );
  const response = await required.inject({ method: "GET", url: "/health/ready" });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().checks.indexer, "failed");
  assert.doesNotMatch(response.body, /indexer\.test/);
  await required.close();

  const optional = await buildPublicApp(
    makeTestConfig({ chainSourceRequired: false, chainEventSourceUrl: "https://optional.test/events" }),
    {
      readiness: {
        database: async () => true,
        contract: async () => true,
        indexer: async () => false,
      },
    },
  );
  const optionalResponse = await optional.inject({ method: "GET", url: "/health/ready" });
  assert.equal(optionalResponse.statusCode, 200);
  assert.equal(optionalResponse.json().checks.indexer, "failed");
  await optional.close();
});

test("every readiness dependency is bounded by the configured timeout", async () => {
  const app = await buildPublicApp(makeTestConfig({ readinessTimeoutMs: 50 }), {
    readiness: {
      database: () => new Promise<boolean>(() => {}),
      contract: () => new Promise<boolean>(() => {}),
      indexer: () => new Promise<boolean>(() => {}),
    },
  });
  const started = Date.now();
  const response = await app.inject({ method: "GET", url: "/health/ready" });
  const elapsed = Date.now() - started;
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json().checks, {
    database: "failed",
    contract: "failed",
    indexer: "failed",
  });
  assert.ok(elapsed < 1_000, `readiness took ${elapsed}ms`);
  await app.close();
});
