import assert from "node:assert/strict";
import test from "node:test";
import { computeBackoffMs, createHttpChainEventSource } from "../src/chain-source.js";

const base = {
  networkId: "testnet",
  contractId: "quizcity.testnet",
  url: "https://indexer.example/events",
};

function page(overrides: Record<string, unknown> = {}) {
  return {
    networkId: "testnet",
    contractId: "quizcity.testnet",
    events: [
      {
        receiptId: "receipt-1",
        eventIndex: 0,
        blockHeight: "9007199254740993",
        blockHash: "block-hash",
        chainTimestamp: "2026-11-12T00:00:00.000Z",
        txHash: "tx-hash",
        payload: {},
      },
    ],
    nextCursor: "9007199254740994",
    lastFinalizedBlock: "9007199254740999",
    lastFinalizedHash: "final-hash",
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("canonical string heights above the safe integer range are preserved", async () => {
  const source = createHttpChainEventSource({ ...base, fetchImpl: async () => response(page()) });
  const result = await source.fetchPage("9007199254740993", 100);
  assert.equal(result.events[0].blockHeight, "9007199254740993");
  assert.equal(result.nextCursor, "9007199254740994");
  assert.equal(result.lastFinalizedBlock, "9007199254740999");
});

test("numeric or non-canonical heights, cursors, and finalized values are rejected", async () => {
  for (const value of [
    { events: [{ ...page().events[0], blockHeight: Number.MAX_SAFE_INTEGER }] },
    { lastFinalizedBlock: Number.MAX_SAFE_INTEGER },
    { nextCursor: Number.MAX_SAFE_INTEGER },
    { nextCursor: "01" },
    { lastFinalizedBlock: "-1" },
  ]) {
    const source = createHttpChainEventSource({
      ...base,
      fetchImpl: async () => response(page(value)),
    });
    await assert.rejects(source.fetchPage("1", 100), /canonical decimal string/);
  }
});

test("permanent HTTP and payload failures are attempted once", async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    const source = createHttpChainEventSource({
      ...base,
      fetchImpl: async () => {
        calls += 1;
        return response({}, status);
      },
    });
    await assert.rejects(source.fetchPage("1", 100), new RegExp(String(status)));
    assert.equal(calls, 1);
  }

  let wrongCalls = 0;
  const wrong = createHttpChainEventSource({
    ...base,
    fetchImpl: async () => {
      wrongCalls += 1;
      return response(page({ networkId: "mainnet" }));
    },
  });
  await assert.rejects(wrong.fetchPage("1", 100), /another network/);
  assert.equal(wrongCalls, 1);

  let jsonCalls = 0;
  const invalidJson = createHttpChainEventSource({
    ...base,
    fetchImpl: async () => {
      jsonCalls += 1;
      return new Response("{not-json", { status: 200 });
    },
  });
  await assert.rejects(invalidJson.fetchPage("1", 100), /invalid JSON/);
  assert.equal(jsonCalls, 1);

  let oversizedCalls = 0;
  const oversized = createHttpChainEventSource({
    ...base,
    fetchImpl: async () => {
      oversizedCalls += 1;
      return response(page({ events: [{ ...page().events[0], receiptId: "r".repeat(129) }] }));
    },
  });
  await assert.rejects(oversized.fetchPage("1", 100), /too long/);
  assert.equal(oversizedCalls, 1);
});

test("5xx and timeouts retry up to the configured limit", async () => {
  let serverCalls = 0;
  const server = createHttpChainEventSource({
    ...base,
    maxRetries: 2,
    random: () => 0,
    fetchImpl: async () => {
      serverCalls += 1;
      return response({}, 503);
    },
  });
  await assert.rejects(server.fetchPage("1", 100), /503/);
  assert.equal(serverCalls, 3);

  let timeoutCalls = 0;
  const timeout = createHttpChainEventSource({
    ...base,
    timeoutMs: 5,
    maxRetries: 1,
    random: () => 0,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        timeoutCalls += 1;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  await assert.rejects(timeout.fetchPage("1", 100), /aborted/);
  assert.equal(timeoutCalls, 2);
});

test("backoff including jitter never exceeds the maximum", () => {
  const highJitter = computeBackoffMs(20, () => 0.999, 250, 5_000);
  assert.ok(highJitter <= 5_000);
  assert.equal(highJitter, 5_000);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const delay = computeBackoffMs(attempt, () => 0.5, 250, 1_000);
    assert.ok(delay <= 1_000);
  }
});
