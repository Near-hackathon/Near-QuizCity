import assert from "node:assert/strict";
import test from "node:test";
import { nextBackoffDelay, startWorker } from "../src/worker.js";

const microtask = () => new Promise((resolve) => setImmediate(resolve));

test("the first tick runs immediately and stop waits for it", async () => {
  let calls = 0;
  let release: (() => void) | null = null;
  const handle = startWorker({
    intervalMs: 60_000,
    run: async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  await microtask();
  assert.equal(calls, 1);
  assert.equal(handle.status().running, true);

  let stopped = false;
  const stopping = handle.stop().then(() => {
    stopped = true;
  });
  await microtask();
  assert.equal(stopped, false);
  release!();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(handle.status().running, false);
});

test("successful runs reset the delay and failures stay under the cap", async () => {
  let calls = 0;
  let fail = true;
  const handle = startWorker({
    intervalMs: 5,
    maxBackoffMs: 20,
    random: () => 0.999,
    run: async () => {
      calls += 1;
      if (fail) throw new Error("boom");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(calls > 1);
  fail = false;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await handle.stop();
  assert.ok(calls > 1);
});

test("backoff including jitter never exceeds the configured maximum", () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const delay = nextBackoffDelay(1_000, 1_000, 2_500, () => 0.999);
    assert.ok(delay <= 2_500, `delay ${delay} exceeded cap`);
  }
  assert.equal(
    nextBackoffDelay(1_000, 1_000, 2_500, () => 0),
    2_000,
  );
});
