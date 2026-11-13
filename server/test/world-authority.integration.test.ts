import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { worldScenes } from "@quiz-city/world-data";
import { seedWorld } from "../db/seeds/world.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { advancePresence, applyInteraction, applyMoveIntent, lockPresence } from "../src/world-authority.js";
import { tickWorldMovement } from "../src/world-tick.js";
import { connectTestPool, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
async function migrate(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

async function presence(sql: Sql) {
  await sql`
    insert into player_presence (session_id, player_account, scene_id, x, y, facing)
    values ('s1', 'alice.testnet', 'city-district', 20, 10, 'north')
  `;
  return sql.begin((tx) => lockPresence(tx, "s1", "alice.testnet"));
}

test("move intents persist paths, reject stale sequences, and roll back atomically", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    const row = await presence(sql);
    const result = await sql.begin((tx) =>
      applyMoveIntent(
        tx,
        row,
        { messageId: "m1", clientSequence: "1", sceneId: "city-district", x: 22, y: 12 },
        { now: new Date("2026-11-13T00:00:00Z"), cooldownMs: 0 },
      ),
    );
    assert.ok(result.path.length > 0);
    const [saved] =
      await sql`select path, last_client_sequence::text as seq from player_presence where session_id = 's1'`;
    assert.ok(Array.isArray(saved.path));
    assert.equal(saved.seq, "1");
    const current = await sql.begin((tx) => lockPresence(tx, "s1", "alice.testnet"));
    await assert.rejects(
      sql.begin((tx) =>
        applyMoveIntent(
          tx,
          current,
          { messageId: "m2", clientSequence: "1", sceneId: "city-district", x: 30, y: 30 },
          { now: new Date(), cooldownMs: 0 },
        ),
      ),
      /stale client sequence/,
    );
    await assert.rejects(
      sql.begin(async (tx) => {
        const locked = await lockPresence(tx, "s1", "alice.testnet");
        await applyMoveIntent(
          tx,
          locked,
          { messageId: "m3", clientSequence: "3", sceneId: "city-district", x: 40, y: 30 },
          { now: new Date(), cooldownMs: 0 },
        );
        throw new Error("rollback");
      }),
      /rollback/,
    );
    const [after] =
      await sql`select last_client_sequence::text as seq from player_presence where session_id = 's1'`;
    assert.equal(after.seq, "1");
  });
});

test("door interactions move atomically to the reciprocal spawn and append stream events", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    const row = await presence(sql);
    const result = await sql.begin((tx) =>
      applyInteraction(
        tx,
        row,
        {
          messageId: "d1",
          clientSequence: "1",
          sceneId: "city-district",
          targetType: "door",
          targetId: "library-door-exterior",
        },
        { now: new Date(), cooldownMs: 0 },
      ),
    );
    assert.equal(result.sceneId, "library-interior");
    assert.equal(result.x, 12);
    const [saved] = await sql`select scene_id, x, y from player_presence where session_id = 's1'`;
    assert.deepEqual(saved, { scene_id: "library-interior", x: 12, y: 16 });
    const events = await sql<{ event_type: string; stream_id: string }[]>`
      select event_type, stream_id from world_events
      where entity_id = 'alice.testnet'
      order by stream_id, sequence
    `;
    assert.deepEqual(
      [...events],
      [
        { event_type: "player.left", stream_id: "scene:city-district" },
        { event_type: "player.scene_changed", stream_id: "scene:city-district" },
        { event_type: "player.joined", stream_id: "scene:library-interior" },
      ],
    );
  });
});

test("movement ticks continue persisted paths without skipping tiles and commit checkpoints atomically", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await sql`
      insert into player_presence (session_id, player_account, scene_id, x, y, facing)
      values ('walker', 'alice.testnet', 'city-district', 3, 3, 'south')
    `;
    const row = await sql.begin((tx) => lockPresence(tx, "walker", "alice.testnet"));
    await sql.begin((tx) =>
      applyMoveIntent(
        tx,
        row,
        { messageId: "walk", clientSequence: "1", sceneId: "city-district", x: 3, y: 6 },
        { now: new Date("2026-11-13T10:00:00Z"), cooldownMs: 0 },
      ),
    );

    for (const [index, expectedY] of [4, 5, 6].entries()) {
      const tick = await tickWorldMovement(sql, {
        now: new Date(`2026-11-13T10:00:0${index + 1}Z`),
        tilesPerTick: 1,
      });
      assert.deepEqual(tick, { leader: true, selected: 1, advanced: 1 });
      const [saved] = await sql<{ x: number; y: number; path: unknown[]; facing: string }[]>`
        select x, y, path, facing from player_presence where session_id = 'walker'
      `;
      assert.equal(saved.x, 3);
      assert.equal(saved.y, expectedY);
      assert.equal(saved.facing, "south");
      if (expectedY === 6) assert.deepEqual(saved.path, []);
    }
    const [eventCount] = await sql<{ count: number }[]>`
      select count(*)::int as count from world_events
      where entity_id = 'alice.testnet' and event_type = 'player.checkpoint'
    `;
    assert.equal(eventCount.count, 3);

    await assert.rejects(
      sql.begin(async (transaction) => {
        await transaction`
          update player_presence set path = '[{"x":3,"y":6},{"x":4,"y":6}]'::jsonb
          where session_id = 'walker'
        `;
        const locked = await lockPresence(transaction, "walker", "alice.testnet");
        await advancePresence(transaction, locked, 1, new Date("2026-11-13T10:01:00Z"));
        throw new Error("force rollback");
      }),
      /force rollback/,
    );
    const [afterRollback] = await sql<{ x: number; y: number; count: number }[]>`
      select presence.x, presence.y,
             (select count(*)::int from world_events
              where entity_id = 'alice.testnet' and event_type = 'player.checkpoint') as count
      from player_presence presence where session_id = 'walker'
    `;
    assert.deepEqual(afterRollback, { x: 3, y: 6, count: 3 });
  });
});

test("movement tick cancels a path created for a stale map version", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await sql`
      insert into player_presence (session_id, player_account, scene_id, x, y, facing)
      values ('stale-map', 'alice.testnet', 'city-district', 3, 3, 'south')
    `;
    const row = await sql.begin((tx) => lockPresence(tx, "stale-map", "alice.testnet"));
    await sql.begin((tx) =>
      applyMoveIntent(
        tx,
        row,
        { messageId: "stale-path", clientSequence: "1", sceneId: "city-district", x: 3, y: 5 },
        { now: new Date("2026-11-13T10:00:00Z"), cooldownMs: 0 },
      ),
    );
    await sql`update player_presence set scene_version = 0 where session_id = 'stale-map'`;
    assert.deepEqual(
      await tickWorldMovement(sql, { now: new Date("2026-11-13T10:00:01Z"), tilesPerTick: 1 }),
      { leader: true, selected: 1, advanced: 0 },
    );
    const [saved] = await sql<{ x: number; y: number; path: unknown[] }[]>`
      select x, y, path from player_presence where session_id = 'stale-map'
    `;
    assert.deepEqual(saved, { x: 3, y: 3, path: [] });
  });
});

test("movement and interaction limits are independent and concurrent stale versions cannot both win", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await sql`
      insert into player_presence (session_id, player_account, scene_id, x, y, facing)
      values ('limited', 'alice.testnet', 'city-district', 20, 10, 'south')
    `;
    const now = new Date("2026-11-13T10:00:00Z");
    let current = await sql.begin((tx) => lockPresence(tx, "limited", "alice.testnet"));
    await sql.begin((tx) =>
      applyInteraction(
        tx,
        current,
        {
          messageId: "talk-1",
          clientSequence: "1",
          sceneId: "city-district",
          targetType: "building",
          targetId: "building-library",
        },
        { now, cooldownMs: 500 },
      ),
    );
    current = await sql.begin((tx) => lockPresence(tx, "limited", "alice.testnet"));
    await sql.begin((tx) =>
      applyMoveIntent(
        tx,
        current,
        { messageId: "move-1", clientSequence: "2", sceneId: "city-district", x: 21, y: 10 },
        { now, cooldownMs: 250 },
      ),
    );
    current = await sql.begin((tx) => lockPresence(tx, "limited", "alice.testnet"));
    await assert.rejects(
      sql.begin((tx) =>
        applyInteraction(
          tx,
          current,
          {
            messageId: "talk-2",
            clientSequence: "3",
            sceneId: "city-district",
            targetType: "building",
            targetId: "building-library",
          },
          { now, cooldownMs: 500 },
        ),
      ),
      /interaction rate limited/,
    );
    await assert.rejects(
      sql.begin((tx) =>
        applyMoveIntent(
          tx,
          current,
          { messageId: "move-2", clientSequence: "4", sceneId: "city-district", x: 22, y: 10 },
          { now, cooldownMs: 250 },
        ),
      ),
      /movement rate limited/,
    );

    await sql`
      update player_presence
      set movement_cooldown_at = null, last_client_sequence = 4, last_message_id = 'move-2'
      where session_id = 'limited'
    `;
    const stale = await sql.begin((tx) => lockPresence(tx, "limited", "alice.testnet"));
    const attempts = await Promise.allSettled([
      sql.begin((tx) =>
        applyMoveIntent(
          tx,
          stale,
          { messageId: "race-a", clientSequence: "5", sceneId: "city-district", x: 22, y: 10 },
          { now: new Date(now.getTime() + 1_000), cooldownMs: 0 },
        ),
      ),
      sql.begin((tx) =>
        applyMoveIntent(
          tx,
          stale,
          { messageId: "race-b", clientSequence: "6", sceneId: "city-district", x: 23, y: 10 },
          { now: new Date(now.getTime() + 1_000), cooldownMs: 0 },
        ),
      ),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  });
});

test("authoritative interactions reject wrong scenes and out-of-range targets", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await sql`
      insert into player_presence (session_id, player_account, scene_id, x, y, facing)
      values ('attacker', 'alice.testnet', 'city-district', 3, 3, 'south')
    `;
    const row = await sql.begin((tx) => lockPresence(tx, "attacker", "alice.testnet"));
    await assert.rejects(
      sql.begin((tx) =>
        applyInteraction(
          tx,
          row,
          {
            messageId: "wrong-scene",
            clientSequence: "1",
            sceneId: "library-interior",
            targetType: "door",
            targetId: "library-spawn",
          },
          { now: new Date(), cooldownMs: 0 },
        ),
      ),
      /INVALID_SCENE/,
    );
    await assert.rejects(
      sql.begin((tx) =>
        applyInteraction(
          tx,
          row,
          {
            messageId: "too-far",
            clientSequence: "2",
            sceneId: "city-district",
            targetType: "door",
            targetId: "library-door-exterior",
          },
          { now: new Date(), cooldownMs: 0 },
        ),
      ),
      /OUT_OF_RANGE/,
    );
  });
});

test("accepted commands are restart-safe idempotent and conflicting reuse is rejected", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await presence(sql);
    let current = await sql.begin((tx) => lockPresence(tx, "s1", "alice.testnet"));
    const first = await sql.begin((tx) =>
      applyMoveIntent(
        tx,
        current,
        { messageId: "retry-me", clientSequence: "1", sceneId: "city-district", x: 22, y: 10 },
        { now: new Date("2026-11-13T10:00:00Z"), cooldownMs: 250, burst: 2 },
      ),
    );
    assert.equal(first.duplicate, false);
    current = await sql.begin((tx) => lockPresence(tx, "s1", "alice.testnet"));
    const retry = await sql.begin((tx) =>
      applyMoveIntent(
        tx,
        current,
        { messageId: "retry-me", clientSequence: "1", sceneId: "city-district", x: 22, y: 10 },
        { now: new Date("2026-11-13T10:00:01Z"), cooldownMs: 250, burst: 2 },
      ),
    );
    assert.equal(retry.duplicate, true);
    assert.deepEqual(retry.path, first.path);
    const [receiptCount] = await sql<{ count: number }[]>`
      select count(*)::int as count from world_command_receipts where session_id = 's1'
    `;
    assert.equal(receiptCount.count, 1);
    await assert.rejects(
      sql.begin((tx) =>
        applyMoveIntent(
          tx,
          current,
          { messageId: "retry-me", clientSequence: "1", sceneId: "city-district", x: 23, y: 10 },
          { now: new Date("2026-11-13T10:00:01Z"), cooldownMs: 250, burst: 2 },
        ),
      ),
      /message id reused/,
    );
  });
});

test("new movement replaces the persisted path and movement/interaction bursts are independent", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await presence(sql);
    const now = new Date("2026-11-13T10:00:00Z");
    let current = await sql.begin((tx) => lockPresence(tx, "s1", "alice.testnet"));
    await sql.begin((tx) =>
      applyMoveIntent(
        tx,
        current,
        { messageId: "path-a", clientSequence: "1", sceneId: "city-district", x: 24, y: 10 },
        { now, cooldownMs: 1_000, burst: 2 },
      ),
    );
    current = await sql.begin((tx) => lockPresence(tx, "s1", "alice.testnet"));
    await sql.begin((tx) =>
      applyMoveIntent(
        tx,
        current,
        { messageId: "path-b", clientSequence: "2", sceneId: "city-district", x: 18, y: 10 },
        { now, cooldownMs: 1_000, burst: 2 },
      ),
    );
    const [replaced] = await sql<{ path: Array<{ x: number; y: number }> }[]>`
      select path from player_presence where session_id = 's1'
    `;
    assert.deepEqual(replaced.path.at(-1), { x: 18, y: 10 });
    current = await sql.begin((tx) => lockPresence(tx, "s1", "alice.testnet"));
    await assert.rejects(
      sql.begin((tx) =>
        applyMoveIntent(
          tx,
          current,
          { messageId: "path-c", clientSequence: "3", sceneId: "city-district", x: 19, y: 10 },
          { now, cooldownMs: 1_000, burst: 2 },
        ),
      ),
      /movement rate limited/,
    );
    await sql.begin((tx) =>
      applyInteraction(
        tx,
        current,
        {
          messageId: "independent-interaction",
          clientSequence: "3",
          sceneId: "city-district",
          targetType: "building",
          targetId: "building-library",
        },
        { now, cooldownMs: 1_000, burst: 1 },
      ),
    );
  });
});

test("closed and hidden database targets are rejected without leaking hidden state", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await presence(sql);
    await sql`update buildings set status = 'closed' where id = 'building-library'`;
    let current = await sql.begin((tx) => lockPresence(tx, "s1", "alice.testnet"));
    await assert.rejects(
      sql.begin((tx) =>
        applyInteraction(
          tx,
          current,
          {
            messageId: "closed",
            clientSequence: "1",
            sceneId: "city-district",
            targetType: "building",
            targetId: "building-library",
          },
          { now: new Date(), cooldownMs: 0 },
        ),
      ),
      /TARGET_CLOSED/,
    );
    await sql`update buildings set status = 'hidden' where id = 'building-library'`;
    current = await sql.begin((tx) => lockPresence(tx, "s1", "alice.testnet"));
    await assert.rejects(
      sql.begin((tx) =>
        applyInteraction(
          tx,
          current,
          {
            messageId: "hidden",
            clientSequence: "2",
            sceneId: "city-district",
            targetType: "building",
            targetId: "building-library",
          },
          { now: new Date(), cooldownMs: 0 },
        ),
      ),
      /TARGET_NOT_FOUND/,
    );
    await sql`update buildings set status = 'active' where id = 'building-library'`;
    current = await sql.begin((tx) => lockPresence(tx, "s1", "alice.testnet"));
    await assert.rejects(
      sql.begin((tx) =>
        applyInteraction(
          tx,
          current,
          {
            messageId: "before-hours",
            clientSequence: "3",
            sceneId: "city-district",
            targetType: "building",
            targetId: "building-library",
          },
          { now: new Date("2026-11-13T07:00:00Z"), cooldownMs: 0 },
        ),
      ),
      /TARGET_CLOSED/,
    );
  });
});

test("rolling back a door transition preserves the old presence and emits no events or receipt", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await presence(sql);
    await assert.rejects(
      sql.begin(async (transaction) => {
        const current = await lockPresence(transaction, "s1", "alice.testnet");
        await applyInteraction(
          transaction,
          current,
          {
            messageId: "rolled-back-door",
            clientSequence: "1",
            sceneId: "city-district",
            targetType: "door",
            targetId: "library-door-exterior",
          },
          { now: new Date("2026-11-13T10:00:00Z"), cooldownMs: 0 },
        );
        throw new Error("force door rollback");
      }),
      /force door rollback/,
    );
    const [saved] = await sql<{ scene_id: string; x: number; y: number; last_client_sequence: string }[]>`
      select scene_id, x, y, last_client_sequence::text as last_client_sequence
      from player_presence where session_id = 's1'
    `;
    assert.deepEqual(saved, {
      scene_id: "city-district",
      x: 20,
      y: 10,
      last_client_sequence: "0",
    });
    const [counts] = await sql<{ events: number; receipts: number }[]>`
      select
        (select count(*)::int from world_events where entity_id = 'alice.testnet') as events,
        (select count(*)::int from world_command_receipts where session_id = 's1') as receipts
    `;
    assert.deepEqual(counts, { events: 0, receipts: 0 });
  });
});

test("versioned world scenes and every named spawn agree with seeded database references", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    for (const scene of worldScenes) {
      const [databaseScene] = await sql<
        { asset_version: string; width: number; height: number; active: boolean }[]
      >`
        select asset_version, width, height, active from scenes where id = ${scene.id}
      `;
      assert.deepEqual(databaseScene, {
        asset_version: scene.assetVersion,
        width: scene.width,
        height: scene.height,
        active: true,
      });
      for (const spawn of scene.spawns) {
        const [databaseSpawn] = await sql<{ x: number; y: number; active: boolean }[]>`
          select x, y, active from spawn_points where scene_id = ${scene.id} and id = ${spawn.id}
        `;
        assert.deepEqual(databaseSpawn, { x: spawn.x, y: spawn.y, active: true });
      }
    }
  });
});

test("a second movement worker skips while another instance owns the advisory lock", async () => {
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    await seedWorld(sql);
    const other = connectTestPool(testDatabaseUrl(), schema, 2);
    try {
      await sql.begin(async (transaction) => {
        await transaction`
          select pg_advisory_xact_lock(hashtextextended('quizcity-world-movement-tick', 0))
        `;
        assert.deepEqual(await tickWorldMovement(other, { now: new Date(), tilesPerTick: 1 }), {
          leader: false,
          selected: 0,
          advanced: 0,
        });
      });
    } finally {
      await other.end();
    }
  });
});
