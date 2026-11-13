import assert from "node:assert/strict";
import test from "node:test";
import type { WorldFanoutOptions } from "../src/world-fanout.js";
import { parseWorldFanoutHint, startWorldFanout } from "../src/world-fanout.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

type Notify = (payload: string) => void;

function fakeDb(
  options: {
    listening?: ReturnType<typeof deferred>;
    notify?: (callback: Notify) => void;
    unlisten?: () => Promise<void> | void;
  } = {},
): WorldFanoutOptions["db"] {
  return {
    listen: (async (_channel: string, onnotify: Notify, onlisten?: () => void) => {
      options.notify?.(onnotify);
      onlisten?.();
      options.listening?.resolve();
      return { unlisten: options.unlisten ?? (() => undefined) };
    }) as WorldFanoutOptions["db"]["listen"],
  };
}

test("fan-out hints require one exact bounded stream and canonical head", () => {
  assert.deepEqual(parseWorldFanoutHint("scene:city-district:12"), {
    streamId: "scene:city-district",
    head: "12",
  });
  assert.deepEqual(parseWorldFanoutHint("scene:a:0"), { streamId: "scene:a", head: "0" });
  for (const invalid of [
    "",
    "scene:city-district",
    "scene:city-district:01",
    "scene:city-district:-1",
    "scene:city-district:not-a-sequence",
    "scene:city-district:1:extra",
    "other:city-district:1",
    `scene:${"a".repeat(65)}:1`,
    "scene:city-district:1000000000000000000",
  ]) {
    assert.equal(parseWorldFanoutHint(invalid), null, invalid);
  }
});

test("notifications are deduplicated and serialized per stream", async () => {
  const listening = deferred();
  const twoDelivered = deferred();
  let notify: Notify = () => assert.fail("listener not installed");
  const calls: string[] = [];
  const fanout = startWorldFanout({
    db: fakeDb({ listening, notify: (callback) => (notify = callback) }),
    pollMs: 60_000,
    onPoll: () => undefined,
    async onHead(streamId, head) {
      calls.push(`${streamId}:${head}`);
      if (calls.length === 2) twoDelivered.resolve();
    },
  });
  try {
    await listening.promise;
    notify("invalid");
    notify("scene:city-district:1");
    notify("scene:city-district:1");
    notify("scene:city-district:0");
    notify("scene:city-district:2");
    await twoDelivered.promise;
    assert.deepEqual(calls, ["scene:city-district:1", "scene:city-district:2"]);
  } finally {
    await fanout.close();
  }
});

test("callback failures are consumed even without an error observer", async () => {
  const listening = deferred();
  const called = deferred();
  let notify: Notify = () => assert.fail("listener not installed");
  const fanout = startWorldFanout({
    db: fakeDb({ listening, notify: (callback) => (notify = callback) }),
    pollMs: 60_000,
    onPoll: () => undefined,
    onHead() {
      called.resolve();
      throw new Error("expected callback failure");
    },
  });
  await listening.promise;
  notify("scene:city-district:1");
  await called.promise;
  await fanout.close();
});

test("close waits for a pending listen and unlistens exactly once", async () => {
  const result = deferred<{ unlisten: () => Promise<void> }>();
  let unlistenCalls = 0;
  const db = {
    listen: (() => result.promise) as WorldFanoutOptions["db"]["listen"],
  };
  const fanout = startWorldFanout({
    db,
    pollMs: 60_000,
    onPoll: () => undefined,
    onHead: () => undefined,
  });
  const closing = fanout.close();
  result.resolve({
    async unlisten() {
      unlistenCalls += 1;
    },
  });
  await closing;
  await fanout.close();
  assert.equal(unlistenCalls, 1);
});

test("polling is overlap-safe and close awaits the active poll", async () => {
  const listening = deferred();
  const pollStarted = deferred();
  const releasePoll = deferred();
  let polls = 0;
  const fanout = startWorldFanout({
    db: fakeDb({ listening }),
    pollMs: 1,
    onHead: () => undefined,
    async onPoll() {
      polls += 1;
      pollStarted.resolve();
      await releasePoll.promise;
    },
  });
  await listening.promise;
  await pollStarted.promise;
  const closing = fanout.close();
  releasePoll.resolve();
  await closing;
  assert.equal(polls, 1);
});

test("initial listen failures are reported and shutdown cancels retry", async () => {
  const failed = deferred();
  let attempts = 0;
  const db = {
    listen: (async () => {
      attempts += 1;
      throw new Error("listener unavailable");
    }) as WorldFanoutOptions["db"]["listen"],
  };
  const fanout = startWorldFanout({
    db,
    pollMs: 60_000,
    retryMs: 60_000,
    onHead: () => undefined,
    onPoll: () => undefined,
    onError: () => failed.resolve(),
  });
  await failed.promise;
  await fanout.close();
  assert.equal(attempts, 1);
});
