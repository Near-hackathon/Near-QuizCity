import { cpus, totalmem } from "node:os";
import postgres, { type Sql } from "postgres";
import WebSocket from "ws";
import { seedWorld } from "../db/seeds/world.js";
import { buildApp } from "../src/app.js";
import { SESSION_COOKIE } from "../src/auth/plugin.js";
import { hashToken } from "../src/auth/service.js";
import { loadConfig } from "../src/config.js";
import { appendWorldEvent, streamHead } from "../src/world-events.js";
import { percentile, worldLoadConfig } from "../src/world-load-config.js";

const gate = worldLoadConfig(process.env);
const CONNECTIONS = 500;
const SUBSCRIBERS = 100;
const origin = "http://localhost:5173";
const sql = postgres(gate.databaseUrl, { max: 30, ssl: false, onnotice: () => {} });

type Message = Record<string, unknown>;
type Client = {
  index: number;
  token: string;
  socket: WebSocket;
  messages: Message[];
  sequence: string;
};

function account(index: number): string {
  return `load${String(index).padStart(4, "0")}.testnet`;
}

function waitFor(client: Client, predicate: (message: Message) => boolean, timeoutMs = 15_000) {
  const existing = client.messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise<Message>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Message;
      if (!predicate(message)) return;
      clearTimeout(timer);
      client.socket.off("message", onMessage);
      resolve(message);
    };
    const timer = setTimeout(() => {
      client.socket.off("message", onMessage);
      reject(
        new Error(`socket ${client.index} timed out; last=${JSON.stringify(client.messages.slice(-3))}`),
      );
    }, timeoutMs);
    client.socket.on("message", onMessage);
  });
}

async function connect(url: string, index: number, token: string): Promise<Client> {
  const socket = new WebSocket(url, {
    origin,
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  const client: Client = { index, token, socket, messages: [], sequence: "0" };
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Message;
    client.messages.push(message);
    if (message.type === "world.event") client.sequence = String((message.event as Message).sequence);
    if (message.type === "world.ready") client.sequence = String(message.sequence);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return client;
}

async function connectBatch(url: string, indexes: number[], tokens: string[]): Promise<Client[]> {
  const result: Client[] = [];
  for (let offset = 0; offset < indexes.length; offset += 25) {
    result.push(
      ...(await Promise.all(
        indexes.slice(offset, offset + 25).map((index) => connect(url, index, tokens[index])),
      )),
    );
  }
  return result;
}

async function subscribe(client: Client, clientSequence: string, lastSequence: string | null) {
  client.socket.send(
    JSON.stringify({
      type: "world.subscribe",
      messageId: `subscribe-${client.index}-${clientSequence}`,
      clientSequence,
      sceneId: "city-district",
      lastSequence,
    }),
  );
  await waitFor(client, (message) => message.type === "world.ready");
}

async function closeClient(client: Client): Promise<void> {
  if (client.socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    client.socket.once("close", () => resolve());
    client.socket.close(1000, "load scenario complete");
  });
}

async function startApp(db: Sql) {
  const base = loadConfig({
    ...process.env,
    APP_ENV: "test",
    DEMO_MODE: "0",
    DATABASE_URL: gate.databaseUrl,
    WEB_ORIGIN: origin,
    HOST: "127.0.0.1",
  });
  const app = await buildApp(
    {
      ...base,
      rateLimitMax: 10_000,
      worldMaxSocketsPerAccount: 1,
      worldMaxSocketsPerIp: 500,
      worldFanoutPollMs: 100,
      worldMoveCooldownMs: 50,
      worldMoveBurst: 32,
    },
    {
      database: db,
      readiness: { database: async () => true, contract: async () => true },
    },
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("load app did not bind TCP");
  return { app, url: `ws://127.0.0.1:${address.port}/v1/world/ws` };
}

async function appendProbe(db: Sql, runId: string, probe: number): Promise<string> {
  const row = await db.begin((transaction) =>
    appendWorldEvent(transaction, {
      streamId: "scene:city-district",
      sceneId: "city-district",
      cityTime: new Date(),
      type: "player.checkpoint",
      entity: { entityType: "player", entityId: "load-probe.testnet" },
      payload: {
        accountId: "load-probe.testnet",
        x: 32 + (probe % 2),
        y: 24,
        facing: "east",
        sceneId: "city-district",
      },
      idempotencyKey: `load-recovery:${runId}:${probe}`,
    }),
  );
  return row.sequence;
}

const runId = `${Date.now()}`;
let firstPool: ReturnType<typeof postgres> | null = null;
let secondPool: ReturnType<typeof postgres> | null = null;
let first: Awaited<ReturnType<typeof startApp>> | null = null;
let second: Awaited<ReturnType<typeof startApp>> | null = null;
let clients: Client[] = [];
let activeSubscribers: Client[] = [];
const deliveryLatencies: number[] = [];
const movementLatencies: number[] = [];
let initialHead = "0";
let recoverySequence = "0";

try {
  const [schema] = await sql<{ events: string | null }[]>`
    select to_regclass('world_events')::text as events
  `;
  if (!schema?.events) throw new Error("world tables are missing; run npm run db:push:test first");
  await seedWorld(sql);
  initialHead = await streamHead(sql, "scene:city-district");
  const tokens = Array.from({ length: CONNECTIONS }, (_, index) => `world-load-${runId}-${index}`);
  await sql.begin(async (transaction) => {
    for (let index = 0; index < CONNECTIONS; index += 1) {
      await transaction`
        insert into auth_sessions (token_hash, account_id, csrf_hash, expires_at)
        values (${hashToken(tokens[index])}, ${account(index)}, ${"0".repeat(64)}, now() + interval '1 hour')
      `;
    }
  });

  firstPool = postgres(gate.databaseUrl, { max: 20, ssl: false, onnotice: () => {} });
  secondPool = postgres(gate.databaseUrl, { max: 20, ssl: false, onnotice: () => {} });
  first = await startApp(firstPool);
  second = await startApp(secondPool);

  const [left, right] = await Promise.all([
    connectBatch(
      first.url,
      Array.from({ length: 250 }, (_, index) => index),
      tokens,
    ),
    connectBatch(
      second.url,
      Array.from({ length: 250 }, (_, index) => index + 250),
      tokens,
    ),
  ]);
  clients = [...left, ...right].sort((a, b) => a.index - b.index);
  if (first.app.worldSocket.stats().clients + second.app.worldSocket.stats().clients !== CONNECTIONS) {
    throw new Error("not all 500 sockets were registered");
  }

  activeSubscribers = [...clients.slice(0, 50), ...clients.slice(250, 300)];
  await Promise.all(activeSubscribers.map((client) => subscribe(client, "1", null)));
  const fanoutStarted = performance.now();
  const firstSequence = await appendProbe(firstPool, runId, 1);
  await Promise.all(
    activeSubscribers.map((client) =>
      waitFor(
        client,
        (message) =>
          message.type === "world.event" && String((message.event as Message).sequence) === firstSequence,
      ),
    ),
  );
  deliveryLatencies.push(performance.now() - fanoutStarted);

  const mover = activeSubscribers[50];
  for (let index = 0; index < 10; index += 1) {
    const messageId = `load-move-${index}`;
    const started = performance.now();
    mover.socket.send(
      JSON.stringify({
        type: "world.move_intent",
        messageId,
        clientSequence: String(index + 2),
        sceneId: "city-district",
        x: index % 2 === 0 ? 33 : 31,
        y: 24,
      }),
    );
    await waitFor(mover, (message) => message.type === "world.ack" && message.messageId === messageId);
    movementLatencies.push(performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const affected = activeSubscribers.slice(0, 50);
  await first.app.close();
  first = null;
  const unaffected = activeSubscribers.slice(50);
  const recovered = await connectBatch(
    second.url,
    affected.map((item) => item.index),
    tokens,
  );
  await Promise.all(recovered.map((client) => subscribe(client, "2", firstSequence)));
  activeSubscribers = [...recovered, ...unaffected];

  first = await startApp(firstPool);
  const returningOld = recovered.slice(0, 25);
  await Promise.all(returningOld.map(closeClient));
  const returning = await connectBatch(
    first.url,
    returningOld.map((item) => item.index),
    tokens,
  );
  await Promise.all(returning.map((client) => subscribe(client, "3", firstSequence)));
  activeSubscribers = [...returning, ...recovered.slice(25), ...unaffected];

  const recoveryStarted = performance.now();
  recoverySequence = await appendProbe(secondPool, runId, 2);
  await Promise.all(
    activeSubscribers.map((client) =>
      waitFor(
        client,
        (message) =>
          message.type === "world.event" && String((message.event as Message).sequence) === recoverySequence,
      ),
    ),
  );
  deliveryLatencies.push(performance.now() - recoveryStarted);
  for (const client of activeSubscribers) {
    const count = client.messages.filter(
      (message) =>
        message.type === "world.event" && String((message.event as Message).sequence) === recoverySequence,
    ).length;
    if (count !== 1) throw new Error(`socket ${client.index} received recovery event ${count} times`);
  }

  await Promise.all([...clients, ...activeSubscribers].map(closeClient));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const settled = { first: first.app.worldSocket.stats(), second: second.app.worldSocket.stats() };
  if (settled.first.clients !== 0 || settled.second.clients !== 0) {
    throw new Error(`socket resources did not settle: ${JSON.stringify(settled)}`);
  }

  console.log(
    JSON.stringify(
      {
        scenario: "world-websocket-two-instance-recovery",
        machine: {
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          logicalCpuCount: cpus().length,
          memoryMiB: Math.round(totalmem() / 1024 / 1024),
        },
        database: gate.database,
        configuration: { connections: CONNECTIONS, subscribers: SUBSCRIBERS, movementIntentsPerSecond: 10 },
        result: {
          initialFanoutSequence: firstSequence,
          recoverySequence,
          fanoutLatencyMs: {
            p50: Number(percentile(deliveryLatencies, 0.5).toFixed(2)),
            p95: Number(percentile(deliveryLatencies, 0.95).toFixed(2)),
          },
          movementAckLatencyMs: {
            p50: Number(percentile(movementLatencies, 0.5).toFixed(2)),
            p95: Number(percentile(movementLatencies, 0.95).toFixed(2)),
          },
          exactlyOnceRecovery: "pass",
          resourceSettling: "pass",
          correctness: "pass",
        },
      },
      null,
      2,
    ),
  );
} finally {
  for (const client of [...clients, ...activeSubscribers]) client.socket.terminate();
  await first?.app.close().catch(() => undefined);
  await second?.app.close().catch(() => undefined);
  await sql
    .begin(async (transaction) => {
      await transaction`delete from player_presence where player_account like 'load____.testnet'`;
      await transaction`delete from auth_sessions where account_id like 'load____.testnet'`;
      await transaction`
      delete from world_events where stream_id = 'scene:city-district'
        and sequence > ${initialHead}::bigint and entity_id = 'load-probe.testnet'
    `;
      await transaction`
      update world_streams set last_sequence = ${initialHead}::bigint
      where stream_id = 'scene:city-district' and last_sequence = ${recoverySequence}::bigint
    `;
    })
    .catch(() => undefined);
  await firstPool?.end().catch(() => undefined);
  await secondPool?.end().catch(() => undefined);
  await sql.end();
}
