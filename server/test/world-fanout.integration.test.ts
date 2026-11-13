import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { startWorldFanout } from "../src/world-fanout.js";
import { withTestSchema } from "./db-test-utils.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("PostgreSQL LISTEN delivers hints and polling remains a recovery path", async () => {
  await withTestSchema(async ({ sql }) => {
    const channel = `quizcity_world_${randomBytes(6).toString("hex")}`;
    const listening = deferred();
    const notified = deferred<{ streamId: string; head: string }>();
    const polled = deferred();
    const errors: unknown[] = [];
    const fanout = startWorldFanout({
      db: sql,
      channel,
      pollMs: 10,
      onListening: () => listening.resolve(),
      onHead: (streamId, head) => notified.resolve({ streamId, head }),
      onPoll: () => polled.resolve(),
      onError: (error) => errors.push(error),
    });
    try {
      await bounded(listening.promise, "PostgreSQL LISTEN");
      await sql`select pg_notify(${channel}, ${"scene:city-district:7"})`;
      assert.deepEqual(await bounded(notified.promise, "world notification"), {
        streamId: "scene:city-district",
        head: "7",
      });
      await bounded(polled.promise, "fan-out safety poll");
      assert.deepEqual(errors, []);
    } finally {
      await fanout.close();
    }
  });
});
