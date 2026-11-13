import assert from "node:assert/strict";
import test from "node:test";
import { createShutdown } from "../src/lifecycle.js";

test("graceful shutdown stops timers, closes the app, and closes the DB exactly once", async () => {
  let stops = 0;
  let closes = 0;
  let dbCloses = 0;
  const shutdown = createShutdown({
    timeoutMs: 1000,
    app: {
      async close() {
        closes += 1;
      },
    },
    stop: [
      () => {
        stops += 1;
      },
      () => {
        stops += 1;
      },
    ],
    closeDb: async () => {
      dbCloses += 1;
    },
  });

  await Promise.all([shutdown("SIGTERM"), shutdown("SIGTERM")]);
  await shutdown("SIGTERM");
  assert.equal(stops, 2);
  assert.equal(closes, 1);
  assert.equal(dbCloses, 1);
});

test("a shutdown timeout is reported through onError", async () => {
  let reported: unknown = null;
  const shutdown = createShutdown({
    timeoutMs: 20,
    app: {
      close: () => new Promise(() => {}),
    },
    stop: [],
    closeDb: async () => {},
    onError: (error) => {
      reported = error;
    },
  });
  await shutdown("SIGTERM");
  assert.match(String(reported), /timed out/);
});

test("a failing worker stop still closes the database and reports the error", async () => {
  const errors: unknown[] = [];
  let closed = false;
  const shutdown = createShutdown({
    timeoutMs: 1_000,
    app: { close: async () => true },
    stop: [
      () => {
        throw new Error("worker stop failed");
      },
    ],
    closeDb: async () => {
      closed = true;
    },
    onError: (error) => errors.push(error),
  });
  await shutdown();
  assert.equal(closed, true);
  assert.match(String(errors[0]), /worker stop failed/);
});
