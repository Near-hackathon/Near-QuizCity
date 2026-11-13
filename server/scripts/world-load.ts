import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import postgres from "postgres";
import { appendWorldEvent, replayAfter, streamHead } from "../src/world-events.js";
import { percentile, worldLoadConfig } from "../src/world-load-config.js";

let config: ReturnType<typeof worldLoadConfig>;
try {
  config = worldLoadConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const sql = postgres(config.databaseUrl, { max: 2, ssl: false, onnotice: () => {} });
const sceneId = `load-${randomUUID()}`;
const streamId = `scene:${sceneId}`;
const appendLatencies: number[] = [];
const replayLatencies: number[] = [];
let head: string;
let replayed: number;
let appendMs: number;
let replayMs: number;
let schemaReady = false;

try {
  const [schema] = await sql<{ events: string | null; streams: string | null }[]>`
    select to_regclass('world_events')::text as events,
           to_regclass('world_streams')::text as streams
  `;
  if (!schema?.events || !schema.streams) {
    throw new Error("world tables are missing; apply migrations to TEST_DATABASE_URL before running load");
  }
  schemaReady = true;
  await sql`
    insert into scenes (id, name, scene_type, asset_key, asset_version, width, height)
    values (${sceneId}, 'Disposable world load scene', 'exterior', 'load/generated', '1', 4, 4)
  `;

  const appendStarted = performance.now();
  for (let index = 0; index < config.events; index += 1) {
    const eventStarted = performance.now();
    await sql.begin((transaction) =>
      appendWorldEvent(transaction, {
        streamId,
        sceneId,
        type: "player.checkpoint",
        entity: { entityType: "player", entityId: "load.testnet" },
        payload: { accountId: "load.testnet", x: 1, y: 1, facing: "south", sceneId },
        idempotencyKey: `load:${sceneId}:${index}`,
        cityTime: new Date(),
      }),
    );
    appendLatencies.push(performance.now() - eventStarted);
  }
  appendMs = performance.now() - appendStarted;
  head = await streamHead(sql, streamId);

  const replayStarted = performance.now();
  replayed = 0;
  let cursor = "0";
  for (;;) {
    const pageStarted = performance.now();
    const rows = await replayAfter(sql, streamId, cursor, config.replayPageSize);
    replayLatencies.push(performance.now() - pageStarted);
    if (rows.length === 0) break;
    replayed += rows.length;
    cursor = rows[rows.length - 1].sequence;
  }
  replayMs = performance.now() - replayStarted;
  if (head !== String(config.events) || replayed !== config.events || cursor !== head) {
    throw new Error(
      `world load correctness failure: expected=${config.events} head=${head} replayed=${replayed} cursor=${cursor}`,
    );
  }
} finally {
  try {
    if (schemaReady) {
      await sql.begin(async (transaction) => {
        await transaction`delete from world_events where stream_id = ${streamId}`;
        await transaction`delete from world_streams where stream_id = ${streamId}`;
        await transaction`delete from scenes where id = ${sceneId}`;
      });
    }
  } finally {
    await sql.end();
  }
}

console.log(
  JSON.stringify(
    {
      scenario: "world-event-repository-microbenchmark",
      warning: "This does not satisfy the websocket or two-instance Gate 6F scenario.",
      machine: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        logicalCpuCount: cpus().length,
        memoryMiB: Math.round(totalmem() / 1024 / 1024),
      },
      database: config.database,
      configuration: { events: config.events, replayPageSize: config.replayPageSize },
      result: {
        head,
        replayed,
        appendMs: Math.round(appendMs),
        replayMs: Math.round(replayMs),
        appendPerSecond: Math.round((config.events / appendMs) * 1000),
        replayPerSecond: Math.round((config.events / replayMs) * 1000),
        appendLatencyMs: {
          p50: Number(percentile(appendLatencies, 0.5).toFixed(2)),
          p95: Number(percentile(appendLatencies, 0.95).toFixed(2)),
        },
        replayPageLatencyMs: {
          p50: Number(percentile(replayLatencies, 0.5).toFixed(2)),
          p95: Number(percentile(replayLatencies, 0.95).toFixed(2)),
        },
        correctness: "pass",
        cleanup: "pass",
      },
    },
    null,
    2,
  ),
);
