import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { Sql } from "postgres";
import WebSocket from "ws";
import { seedWorld } from "../db/seeds/world.js";
import { registerAuthPlugin, SESSION_COOKIE } from "../src/auth/plugin.js";
import { hashToken } from "../src/auth/service.js";
import { registerErrorHandler } from "../src/errors.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { buildWorldBootstrap } from "../src/world-bootstrap.js";
import { appendWorldEvent } from "../src/world-events.js";
import { createWorldSocketRuntime, type WorldSocketDeps } from "../src/world-socket.js";
import type { WorkerOptions } from "../src/worker.js";
import type { WorldFanoutOptions } from "../src/world-fanout.js";
import { connectTestPool, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";
import { makeTestConfig } from "./fixtures.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
const origin = "http://localhost:5173";

type Message = Record<string, unknown>;

function inbox(socket: WebSocket) {
  const messages: Message[] = [];
  const waiters: Array<{
    predicate: (message: Message) => boolean;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Message;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  return {
    messages,
    waitFor(predicate: (message: Message) => boolean, timeoutMs = 2_000): Promise<Message> {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`timed out waiting for socket message; received ${JSON.stringify(messages)}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function insertSession(sql: Sql, token: string, accountId = "alice.testnet"): Promise<string> {
  const tokenHash = hashToken(token);
  await sql`
    insert into auth_sessions (token_hash, account_id, csrf_hash, expires_at)
    values (${tokenHash}, ${accountId}, ${"0".repeat(64)}, '2099-01-01T00:00:00.000Z')
  `;
  return tokenHash;
}

async function startSocketApp(
  sql: Sql,
  now: () => Date,
  overrides = {},
  dependencyOverrides: Partial<Omit<WorldSocketDeps, "db" | "now" | "logger">> = {},
) {
  let fanoutOptions: WorldFanoutOptions | null = null;
  let presenceOptions: WorkerOptions | null = null;
  let heartbeat: (() => void) | null = null;
  const app = Fastify();
  registerErrorHandler(app);
  registerAuthPlugin(
    app,
    {
      networkId: "testnet",
      contractId: "quizcity.testnet",
      webOrigin: origin,
      rpcUrl: "http://127.0.0.1:1",
    },
    { client: sql, deps: { now } },
  );
  const config = makeTestConfig({
    webOrigin: origin,
    worldMaxSocketsPerAccount: 1,
    worldMaxSocketsPerIp: 4,
    worldPresenceTimeoutMs: 60_000,
    ...overrides,
  });
  const runtime = createWorldSocketRuntime(
    {
      db: sql,
      now,
      logger: app.log,
      startFanout: (options) => {
        fanoutOptions = options;
        return { close: async () => undefined };
      },
      startPresenceWorker: (options) => {
        presenceOptions = options;
        return {
          stop: async () => undefined,
          status: () => ({ running: false, lastSuccessAt: null, lastErrorAt: null }),
        };
      },
      timers: {
        setInterval: (callback) => {
          heartbeat = callback;
          return { unref() {} } as NodeJS.Timeout;
        },
        clearInterval: () => undefined,
      },
      ...dependencyOverrides,
    },
    config,
  );
  await runtime.register(app);
  app.addHook("onClose", () => runtime.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  return {
    app,
    runtime,
    url: `ws://127.0.0.1:${address.port}/v1/world/ws`,
    fanout: () => {
      assert.ok(fanoutOptions);
      return fanoutOptions;
    },
    presence: () => {
      assert.ok(presenceOptions);
      return presenceOptions;
    },
    heartbeat: () => {
      assert.ok(heartbeat);
      heartbeat();
    },
  };
}

function connect(url: string, token: string, socketOrigin = origin, autoPong = true): WebSocket {
  return new WebSocket(url, {
    origin: socketOrigin,
    autoPong,
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

function rejectedUpgrade(socket: WebSocket): Promise<number> {
  socket.on("error", () => undefined);
  return new Promise((resolve) => {
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
  });
}

test("world socket bootstraps, fans out exactly once, validates ack, and survives resubscribe", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    await seedWorld(sql);
    const token = "socket-test-token";
    const sessionId = await insertSession(sql, token);
    const clock = { value: new Date("2026-11-13T10:00:00.000Z") };
    const server = await startSocketApp(sql, () => clock.value);
    const socket = connect(server.url, token);
    const received = inbox(socket);
    try {
      await waitForOpen(socket);
      socket.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: "subscribe-1",
          clientSequence: "1",
          sceneId: "city-district",
          lastSequence: null,
        }),
      );
      const bootstrap = await received.waitFor((message) => message.type === "world.bootstrap");
      await received.waitFor((message) => message.type === "world.ready");
      assert.equal((bootstrap.player as Message).x, 32);
      assert.equal((bootstrap.player as Message).y, 24);

      const [presence] = await sql<{ session_id: string; x: number; y: number }[]>`
        select session_id, x, y from player_presence where session_id = ${sessionId}
      `;
      assert.deepEqual(presence, { session_id: sessionId, x: 32, y: 24 });

      await sql.begin((transaction) =>
        appendWorldEvent(transaction, {
          streamId: "scene:city-district",
          sceneId: "city-district",
          cityTime: new Date("2026-11-13T12:34:56.000Z"),
          type: "player.checkpoint",
          entity: { entityType: "player", entityId: "alice.testnet" },
          payload: { accountId: "alice.testnet", x: 33, y: 24, facing: "east", sceneId: "city-district" },
        }),
      );
      await server.fanout().onHead("scene:city-district", "1");
      await server.fanout().onHead("scene:city-district", "1");
      const eventMessage = await received.waitFor((message) => message.type === "world.event");
      assert.equal((eventMessage.event as Message).cityTime, "2026-11-13T12:34:56.000Z");
      assert.equal(received.messages.filter((message) => message.type === "world.event").length, 1);

      socket.send(
        JSON.stringify({
          type: "world.ack",
          messageId: "ack-1",
          clientSequence: "2",
          sceneId: "city-district",
          sequence: "1",
        }),
      );
      await received.waitFor((message) => message.type === "world.ack");
      socket.send(
        JSON.stringify({
          type: "world.ack",
          messageId: "ack-rewind",
          clientSequence: "3",
          sceneId: "city-district",
          sequence: "0",
        }),
      );
      await received.waitFor(
        (message) => message.type === "world.error" && message.messageId === "ack-rewind",
      );

      socket.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: "subscribe-2",
          clientSequence: "4",
          sceneId: "city-district",
          lastSequence: "1",
        }),
      );
      await received.waitFor((message) => message.type === "world.ready" && message.sequence === "1");
      socket.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: "subscribe-2",
          clientSequence: "4",
          sceneId: "city-district",
          lastSequence: "1",
        }),
      );
      await received.waitFor(
        (message) => message.type === "world.error" && message.code === "DUPLICATE_COMMAND",
      );
      socket.send(
        JSON.stringify({
          type: "world.ping",
          messageId: "stale-sequence",
          clientSequence: "3",
          sceneId: "city-district",
        }),
      );
      await received.waitFor(
        (message) => message.type === "world.error" && message.messageId === "stale-sequence",
      );

      const limited = connect(server.url, token);
      const limitedClose = waitForClose(limited);
      await waitForOpen(limited);
      assert.equal((await limitedClose).code, 1013);
    } finally {
      socket.close();
      await server.app.close();
    }
  });
});

test("world socket binds resume and heartbeat to the session and expires presence atomically", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    await seedWorld(sql);
    const token = "socket-session-token";
    const sessionId = await insertSession(sql, token);
    const clock = { value: new Date("2026-11-13T10:00:00.000Z") };
    const server = await startSocketApp(sql, () => clock.value, { worldPresenceTimeoutMs: 10_000 });
    const missing = connect(server.url, token);
    const missingInbox = inbox(missing);
    try {
      await waitForOpen(missing);
      missing.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: "resume-missing",
          clientSequence: "1",
          sceneId: "city-district",
          lastSequence: "0",
        }),
      );
      await missingInbox.waitFor((message) => message.type === "world.resync_required");
      missing.close();
      await new Promise<void>((resolve) => missing.once("close", () => resolve()));

      await sql`
        insert into player_presence (
          session_id, player_account, scene_id, x, y, facing, heartbeat_at
        ) values (
          ${sessionId}, 'alice.testnet', 'city-district', 40, 41, 'north',
          ${new Date("2026-11-13T09:59:55.000Z")}
        )
      `;
      const socket = connect(server.url, token);
      const received = inbox(socket);
      await waitForOpen(socket);
      socket.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: "fresh-session",
          clientSequence: "2",
          sceneId: "city-district",
          lastSequence: null,
        }),
      );
      const bootstrap = await received.waitFor((message) => message.type === "world.bootstrap");
      assert.equal((bootstrap.player as Message).x, 40);
      assert.equal((bootstrap.player as Message).y, 41);
      await received.waitFor((message) => message.type === "world.ready");

      clock.value = new Date("2026-11-13T10:00:06.000Z");
      socket.send(
        JSON.stringify({
          type: "world.ping",
          messageId: "ping-1",
          clientSequence: "3",
          sceneId: "city-district",
        }),
      );
      await received.waitFor((message) => message.type === "world.pong");
      const [touched] = await sql<{ heartbeat_at: Date }[]>`
        select heartbeat_at from player_presence where session_id = ${sessionId}
      `;
      assert.equal(touched.heartbeat_at.toISOString(), clock.value.toISOString());

      await sql`
        insert into player_presence (
          session_id, player_account, scene_id, x, y, facing, heartbeat_at
        ) values (
          'expired-session', 'bob.testnet', 'city-district', 10, 11, 'south',
          ${new Date("2026-11-13T09:00:00.000Z")}
        )
      `;
      await server.presence().run();
      await server.presence().run();
      const [expiredCount] = await sql<{ count: string }[]>`
        select count(*)::text as count from player_presence where session_id = 'expired-session'
      `;
      assert.equal(expiredCount.count, "0");
      const leftEvents = await sql<{ event_type: string; payload: Message }[]>`
        select event_type, payload from world_events
        where event_type = 'player.left' and entity_id = 'bob.testnet'
      `;
      assert.equal(leftEvents.length, 1);
      assert.equal(leftEvents[0].payload.sceneId, "city-district");
      socket.close();
    } finally {
      await server.runtime.close();
      await server.runtime.close();
      await server.app.close();
    }
  });
});

test("door interaction bootstraps the destination and stops old-scene delivery", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    await seedWorld(sql);
    const token = "socket-door-token";
    const sessionId = await insertSession(sql, token);
    await sql`
      insert into player_presence (session_id, player_account, scene_id, x, y, facing)
      values (${sessionId}, 'alice.testnet', 'city-district', 20, 10, 'north')
    `;
    const now = () => new Date("2026-11-13T10:00:00.000Z");
    const server = await startSocketApp(sql, now);
    const socket = connect(server.url, token);
    const received = inbox(socket);
    try {
      await waitForOpen(socket);
      socket.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: "door-subscribe",
          clientSequence: "1",
          sceneId: "city-district",
          lastSequence: null,
        }),
      );
      await received.waitFor(
        (message) => message.type === "world.bootstrap" && (message.scene as Message).id === "city-district",
      );
      await received.waitFor((message) => message.type === "world.ready");
      socket.send(
        JSON.stringify({
          type: "world.interact",
          messageId: "use-library-door",
          clientSequence: "2",
          sceneId: "city-district",
          targetType: "door",
          targetId: "library-door-exterior",
        }),
      );
      await received.waitFor(
        (message) =>
          message.type === "world.bootstrap" && (message.scene as Message).id === "library-interior",
      );
      await received.waitFor(
        (message) => message.type === "world.ack" && message.messageId === "use-library-door",
      );
      const [saved] = await sql<{ scene_id: string; x: number; y: number }[]>`
        select scene_id, x, y from player_presence where session_id = ${sessionId}
      `;
      assert.deepEqual(saved, { scene_id: "library-interior", x: 12, y: 16 });

      await sql.begin((transaction) =>
        appendWorldEvent(transaction, {
          streamId: "scene:city-district",
          sceneId: "city-district",
          cityTime: now(),
          type: "player.checkpoint",
          entity: { entityType: "player", entityId: "bob.testnet" },
          payload: { accountId: "bob.testnet", x: 4, y: 4, facing: "south", sceneId: "city-district" },
        }),
      );
      await server.fanout().onHead("scene:city-district", "3");
      socket.send(
        JSON.stringify({
          type: "world.ping",
          messageId: "after-door-ping",
          clientSequence: "3",
          sceneId: "library-interior",
        }),
      );
      await received.waitFor(
        (message) => message.type === "world.pong" && message.messageId === "after-door-ping",
      );
      assert.equal(
        received.messages.some(
          (message) =>
            message.type === "world.event" &&
            (message.event as Message).streamId === "scene:city-district" &&
            ((message.event as Message).entity as Message).entityId === "bob.testnet",
        ),
        false,
      );
    } finally {
      socket.close();
      await server.app.close();
    }
  });
});

test("bootstrap/live handoff drains a barrier event before ready and resume paginates exactly", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    await seedWorld(sql);
    const token = "socket-handoff-token";
    const sessionId = await insertSession(sql, token);
    const now = () => new Date("2026-11-13T10:00:00.000Z");
    let injected = false;
    const server = await startSocketApp(
      sql,
      now,
      { worldReplayLimit: 1 },
      {
        buildBootstrap: async (db, accountId, sceneId, options) => {
          const snapshot = await buildWorldBootstrap(db, accountId, sceneId, options);
          if (!injected) {
            injected = true;
            await sql.begin((transaction) =>
              appendWorldEvent(transaction, {
                streamId: "scene:city-district",
                sceneId: "city-district",
                cityTime: now(),
                type: "player.checkpoint",
                entity: { entityType: "player", entityId: "alice.testnet" },
                payload: {
                  accountId: "alice.testnet",
                  x: 33,
                  y: 24,
                  facing: "east",
                  sceneId: "city-district",
                },
              }),
            );
          }
          return snapshot;
        },
      },
    );
    const fresh = connect(server.url, token);
    const freshInbox = inbox(fresh);
    try {
      await waitForOpen(fresh);
      fresh.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: "handoff-subscribe",
          clientSequence: "1",
          sceneId: "city-district",
          lastSequence: null,
        }),
      );
      await freshInbox.waitFor((message) => message.type === "world.ready");
      assert.deepEqual(
        freshInbox.messages.map((message) =>
          message.type === "world.event"
            ? `${message.type}:${(message.event as Message).sequence}`
            : message.type,
        ),
        ["world.bootstrap", "world.event:1", "world.ready"],
      );
      assert.equal(freshInbox.messages[2].sequence, "1");
      const freshClosed = waitForClose(fresh);
      fresh.close();
      await freshClosed;

      for (const x of [34, 35]) {
        await sql.begin((transaction) =>
          appendWorldEvent(transaction, {
            streamId: "scene:city-district",
            sceneId: "city-district",
            cityTime: now(),
            type: "player.checkpoint",
            entity: { entityType: "player", entityId: "alice.testnet" },
            payload: { accountId: "alice.testnet", x, y: 24, facing: "east", sceneId: "city-district" },
          }),
        );
      }
      const resume = connect(server.url, token);
      const resumeInbox = inbox(resume);
      await waitForOpen(resume);
      resume.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: "resume-paginated",
          clientSequence: "2",
          sceneId: "city-district",
          lastSequence: "0",
        }),
      );
      await resumeInbox.waitFor((message) => message.type === "world.ready" && message.sequence === "3");
      assert.deepEqual(
        resumeInbox.messages
          .filter((message) => message.type === "world.event")
          .map((message) => (message.event as Message).sequence as string),
        ["1", "2", "3"],
      );
      const [presence] = await sql<{ session_id: string }[]>`
        select session_id from player_presence where session_id = ${sessionId}
      `;
      assert.equal(presence.session_id, sessionId);
      resume.close();
    } finally {
      await server.app.close();
    }
  });
});

test("world socket rejects a foreign origin and releases connection caps after close", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    await seedWorld(sql);
    const token = "socket-origin-token";
    await insertSession(sql, token);
    const server = await startSocketApp(sql, () => new Date());
    try {
      const rejected = connect(server.url, token, "https://evil.example");
      const rejectedClose = waitForClose(rejected);
      await waitForOpen(rejected);
      assert.equal((await rejectedClose).code, 1008);

      const first = connect(server.url, token);
      await waitForOpen(first);
      const firstClosed = waitForClose(first);
      first.close();
      await firstClosed;

      const replacement = connect(server.url, token);
      await waitForOpen(replacement);
      replacement.close();
    } finally {
      await server.app.close();
    }
  });
});

test("two app runtimes keep sockets, counters, workers, and shutdown isolated", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    await seedWorld(sql);
    const token = "socket-isolation-token";
    await insertSession(sql, token);
    const now = () => new Date("2026-11-13T10:00:00.000Z");
    const firstServer = await startSocketApp(sql, now);
    const secondServer = await startSocketApp(sql, now);
    const first = connect(firstServer.url, token);
    const second = connect(secondServer.url, token);
    const secondInbox = inbox(second);
    try {
      await Promise.all([waitForOpen(first), waitForOpen(second)]);
      const firstClosed = waitForClose(first);
      await firstServer.app.close();
      await firstClosed;
      assert.equal(second.readyState, WebSocket.OPEN);

      second.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: "isolated-subscribe",
          clientSequence: "1",
          sceneId: "city-district",
          lastSequence: null,
        }),
      );
      await secondInbox.waitFor((message) => message.type === "world.ready");
      second.send(
        JSON.stringify({
          type: "world.ping",
          messageId: "isolated-ping",
          clientSequence: "2",
          sceneId: "city-district",
        }),
      );
      await secondInbox.waitFor(
        (message) => message.type === "world.pong" && message.messageId === "isolated-ping",
      );
    } finally {
      second.close();
      await firstServer.app.close();
      await secondServer.app.close();
    }
  });
});

test("a PostgreSQL event appended through instance A reaches instance B once", async () => {
  await withTestSchema(async ({ sql, schema }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    await seedWorld(sql);
    const token = "socket-two-instance-token";
    await insertSession(sql, token);
    const firstPool = connectTestPool(testDatabaseUrl(), schema, 3);
    const secondPool = connectTestPool(testDatabaseUrl(), schema, 3);
    const now = () => new Date("2026-11-13T10:00:00.000Z");
    const firstServer = await startSocketApp(
      firstPool,
      now,
      { worldFanoutPollMs: 25 },
      { startFanout: undefined },
    );
    const secondServer = await startSocketApp(
      secondPool,
      now,
      { worldFanoutPollMs: 25 },
      { startFanout: undefined },
    );
    const socket = connect(secondServer.url, token);
    const received = inbox(socket);
    try {
      await waitForOpen(socket);
      socket.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: "two-instance-subscribe",
          clientSequence: "1",
          sceneId: "city-district",
          lastSequence: null,
        }),
      );
      await received.waitFor((message) => message.type === "world.ready");
      await firstPool.begin((transaction) =>
        appendWorldEvent(transaction, {
          streamId: "scene:city-district",
          sceneId: "city-district",
          cityTime: now(),
          type: "player.checkpoint",
          entity: { entityType: "player", entityId: "alice.testnet" },
          payload: { accountId: "alice.testnet", x: 34, y: 24, facing: "east", sceneId: "city-district" },
        }),
      );
      await received.waitFor(
        (message) => message.type === "world.event" && (message.event as Message).sequence === "1",
      );
      await firstPool`select pg_notify('quizcity_world', 'scene:city-district:1')`;
      await firstPool`select pg_notify('quizcity_world', 'scene:city-district:1')`;

      await firstServer.app.close();
      await secondPool.begin((transaction) =>
        appendWorldEvent(transaction, {
          streamId: "scene:city-district",
          sceneId: "city-district",
          cityTime: now(),
          type: "player.checkpoint",
          entity: { entityType: "player", entityId: "alice.testnet" },
          payload: { accountId: "alice.testnet", x: 35, y: 24, facing: "east", sceneId: "city-district" },
        }),
      );
      await received.waitFor(
        (message) => message.type === "world.event" && (message.event as Message).sequence === "2",
      );
      assert.deepEqual(
        received.messages
          .filter((message) => message.type === "world.event")
          .map((message) => (message.event as Message).sequence),
        ["1", "2"],
      );
    } finally {
      socket.close();
      await firstServer.app.close();
      await secondServer.app.close();
      await firstPool.end();
      await secondPool.end();
    }
  });
});

test("fresh subscribe cannot relocate an existing authenticated presence", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    await seedWorld(sql);
    const token = "socket-no-teleport-token";
    const sessionId = await insertSession(sql, token);
    await sql`
      insert into player_presence (session_id, player_account, scene_id, x, y, facing)
      values (${sessionId}, 'alice.testnet', 'city-district', 20, 10, 'north')
    `;
    const server = await startSocketApp(sql, () => new Date("2026-11-13T10:00:00.000Z"));
    const socket = connect(server.url, token);
    const received = inbox(socket);
    try {
      await waitForOpen(socket);
      socket.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: "forged-scene",
          clientSequence: "1",
          sceneId: "library-interior",
          lastSequence: null,
        }),
      );
      await received.waitFor((message) => message.type === "world.resync_required");
      assert.equal(
        received.messages.some((message) => message.type === "world.bootstrap"),
        false,
      );
      const [saved] = await sql<{ scene_id: string; x: number; y: number }[]>`
        select scene_id, x, y from player_presence where session_id = ${sessionId}
      `;
      assert.deepEqual(saved, { scene_id: "city-district", x: 20, y: 10 });
    } finally {
      socket.close();
      await server.app.close();
    }
  });
});

test("world socket rejects invalid auth and bounds malformed, oversized, and dead clients", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    await seedWorld(sql);
    const token = "socket-protection-token";
    await insertSession(sql, token);
    const revokedToken = "socket-revoked-token";
    await insertSession(sql, revokedToken);
    await sql`update auth_sessions set revoked_at = now() where token_hash = ${hashToken(revokedToken)}`;
    const clock = { value: new Date("2026-11-13T10:00:00.000Z") };
    const server = await startSocketApp(sql, () => clock.value, {
      worldSocketMaxPayloadBytes: 1_024,
      worldHeartbeatTimeoutMs: 10,
    });
    try {
      const anonymous = new WebSocket(server.url, { origin });
      assert.equal(await rejectedUpgrade(anonymous), 401);
      const queryToken = new WebSocket(`${server.url}?token=${encodeURIComponent(token)}`, { origin });
      assert.equal(await rejectedUpgrade(queryToken), 401);
      const revoked = connect(server.url, revokedToken);
      assert.equal(await rejectedUpgrade(revoked), 401);

      const malformed = connect(server.url, token);
      const malformedInbox = inbox(malformed);
      await waitForOpen(malformed);
      malformed.send("{");
      await malformedInbox.waitFor(
        (message) => message.type === "world.error" && message.code === "INVALID_JSON",
      );
      malformed.send(JSON.stringify({ type: "world.subscribe", sceneId: "city-district" }));
      await malformedInbox.waitFor(
        (message) => message.type === "world.error" && message.code === "INVALID_MESSAGE",
      );
      const malformedClosed = waitForClose(malformed);
      malformed.close();
      await malformedClosed;

      const oversized = connect(server.url, token);
      await waitForOpen(oversized);
      const oversizedClosed = waitForClose(oversized);
      oversized.send("x".repeat(2_048));
      assert.equal((await oversizedClosed).code, 1009);

      const dead = connect(server.url, token, origin, false);
      await waitForOpen(dead);
      const deadClosed = waitForClose(dead);
      clock.value = new Date("2026-11-13T10:00:00.011Z");
      server.heartbeat();
      assert.equal((await deadClosed).code, 1006);
    } finally {
      await server.app.close();
    }
  });
});

test("world socket closes a slow consumer before sending more queued data", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    await seedWorld(sql);
    const token = "socket-backpressure-token";
    await insertSession(sql, token);
    const server = await startSocketApp(
      sql,
      () => new Date(),
      { worldMaxQueuedBytes: 16_384 },
      { bufferedAmount: () => 16_385 },
    );
    const socket = connect(server.url, token);
    try {
      await waitForOpen(socket);
      const closed = waitForClose(socket);
      socket.send("{");
      assert.deepEqual(await closed, { code: 1013, reason: "slow consumer" });
    } finally {
      await server.app.close();
    }
  });
});
