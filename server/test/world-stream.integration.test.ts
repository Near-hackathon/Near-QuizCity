import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { seedWorld } from "../db/seeds/world.js";
import { AppError } from "../src/errors.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { appendWorldEvent, replayAfter, streamHead, worldEventFromRow } from "../src/world-events.js";
import { connectTestPool, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
const worldMigrationIndex = migrations.findIndex(
  (migration) => migration.filename === "0020_world_stream.sql",
);
const cityTime = new Date("2026-11-13T08:00:00.000Z");

async function migrate(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

function checkpoint(sceneId = "city-district") {
  return {
    streamId: `scene:${sceneId}`,
    sceneId,
    cityTime,
    type: "player.checkpoint" as const,
    entity: { entityType: "player" as const, entityId: "alice.testnet" },
    payload: {
      accountId: "alice.testnet",
      x: 1,
      y: 2,
      facing: "south" as const,
      sceneId,
    },
  };
}

test("world stream allocates independently, paginates replay, and maps valid wire events", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    const first = await sql.begin((tx) => appendWorldEvent(tx, { ...checkpoint(), idempotencyKey: "evt-1" }));
    const retry = await sql.begin((tx) => appendWorldEvent(tx, { ...checkpoint(), idempotencyKey: "evt-1" }));
    assert.equal(retry.event_id, first.event_id);
    assert.equal(await streamHead(sql, "scene:city-district"), "1");

    const second = await sql.begin((tx) => appendWorldEvent(tx, checkpoint()));
    assert.equal(second.sequence, "2");
    const other = await sql.begin((tx) => appendWorldEvent(tx, checkpoint("quiz-centre-interior")));
    assert.equal(other.sequence, "1");

    const firstPage = await replayAfter(sql, "scene:city-district", "0", 1);
    const secondPage = await replayAfter(sql, "scene:city-district", firstPage[0].sequence, 1);
    assert.deepEqual(
      [...firstPage, ...secondPage].map((row) => row.sequence),
      ["1", "2"],
    );
    assert.equal(worldEventFromRow(firstPage[0]).type, "player.checkpoint");
  });
});

test("concurrent appends and idempotent retries serialize without duplicates", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    await seedWorld(sql);
    const pool = connectTestPool(url, schema, 6);
    try {
      const [first, second] = await Promise.all([
        pool.begin((tx) => appendWorldEvent(tx, checkpoint())),
        pool.begin((tx) => appendWorldEvent(tx, checkpoint())),
      ]);
      assert.deepEqual([first.sequence, second.sequence].sort(), ["1", "2"]);

      const input = { ...checkpoint(), idempotencyKey: "concurrent-source" };
      const [retryA, retryB] = await Promise.all([
        pool.begin((tx) => appendWorldEvent(tx, input)),
        pool.begin((tx) => appendWorldEvent(tx, input)),
      ]);
      assert.equal(retryA.event_id, retryB.event_id);
      const [count] = await pool<{ count: number }[]>`
        select count(*)::int as count from world_events where idempotency_key = 'concurrent-source'
      `;
      assert.equal(count.count, 1);
    } finally {
      await pool.end();
    }
  });
});

test("idempotency mismatch is rejected and rollback leaves no event or reserved sequence", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await sql.begin((tx) => appendWorldEvent(tx, { ...checkpoint(), idempotencyKey: "stable-source" }));
    await assert.rejects(
      sql.begin((tx) =>
        appendWorldEvent(tx, {
          ...checkpoint(),
          payload: { ...checkpoint().payload, x: 3 },
          idempotencyKey: "stable-source",
        }),
      ),
      (error: unknown) => error instanceof AppError && error.code === "CONFLICT",
    );

    await assert.rejects(
      sql.begin(async (tx) => {
        await appendWorldEvent(tx, checkpoint("quiz-centre-interior"));
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(await streamHead(sql, "scene:quiz-centre-interior"), "0");
  });
});

test("bigint sequences remain exact and protocol overflow rolls back", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await sql`
      insert into world_streams (stream_id, last_sequence)
      values ('scene:city-district', 9007199254740992)
    `;
    const high = await sql.begin((tx) => appendWorldEvent(tx, checkpoint()));
    assert.equal(high.sequence, "9007199254740993");
    assert.equal(typeof high.sequence, "string");

    await sql`
      update world_streams set last_sequence = 999999999999999999
      where stream_id = 'scene:city-district'
    `;
    await assert.rejects(
      sql.begin((tx) => appendWorldEvent(tx, checkpoint())),
      (error: unknown) => error instanceof AppError && error.code === "VALIDATION_ERROR",
    );
    assert.equal(await streamHead(sql, "scene:city-district"), "999999999999999999");
    await assert.rejects(
      replayAfter(sql, "scene:city-district", "9999999999999999999"),
      /invalid world sequence/,
    );
  });
});

test("world seed is idempotent on fresh databases", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    const [before] = await sql`
      select count(*)::int as events,
             (select last_sequence::text from world_streams where stream_id = 'scene:library-interior') as head
      from world_events
    `;
    await seedWorld(sql);
    const [after] = await sql`
      select count(*)::int as events,
             (select last_sequence::text from world_streams where stream_id = 'scene:library-interior') as head
      from world_events
    `;
    assert.deepEqual(after, before);
    const [event] = await sql`select * from world_events where event_id = 'seed:kofi-initial'`;
    assert.equal(worldEventFromRow(event).type, "npc.activity_changed");
  });
});

test("pre-0020 seeded data upgrades and reseeds without a sequence collision", async () => {
  assert.ok(worldMigrationIndex > 0);
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations.slice(0, worldMigrationIndex));
    await sql`
      insert into scenes (id, name, scene_type, asset_key, width, height)
      values ('library-interior', 'City Library', 'interior', 'maps/library', 24, 18)
    `;
    await sql`
      insert into world_events (event_type, scene_id, npc_id, x, y, payload, game_time)
      values (
        'npc_activity', 'library-interior', 'professor-kofi', 6, 8,
        '{"activity":"research"}'::jsonb, '2026-11-13T08:00:00.000Z'
      )
    `;

    await runMigrations(postgresMigrationStore(sql), migrations);
    await seedWorld(sql);
    await seedWorld(sql);

    const rows = await sql`select * from world_events where stream_id = 'scene:library-interior'`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_id, "seed:kofi-initial");
    assert.equal(worldEventFromRow(rows[0]).type, "npc.activity_changed");
    assert.equal(await streamHead(sql, "scene:library-interior"), "1");
  });
});
