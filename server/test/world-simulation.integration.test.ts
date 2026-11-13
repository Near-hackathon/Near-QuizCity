import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { seedWorld } from "../db/seeds/world.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { tickNpcSimulation } from "../src/world-simulation.js";
import { connectTestClient, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));

async function setup(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
  await seedWorld(sql);
}

const options = (now: string) => ({
  now: new Date(now),
  timeZone: "Africa/Accra",
  tilesPerTick: 2,
  catchupAfterMs: 1_000,
});

test("Professor Kofi follows a full deterministic day with bounded restart catch-up", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const checkpoints = [
      ["2026-11-13T06:00:00.000Z", "apartment-interior", "home", "apartment-home"],
      ["2026-11-13T09:00:00.000Z", "university-interior", "research", "research-desk"],
      ["2026-11-13T13:00:00.000Z", "library-interior", "library_research", "library-desk"],
      ["2026-11-13T16:00:00.000Z", "city-district", "park_break", "park-waypoint"],
      ["2026-11-13T18:00:00.000Z", "cafe-interior", "cafe", "cafe-table"],
      ["2026-11-13T21:00:00.000Z", "apartment-interior", "home", "apartment-home"],
    ] as const;

    for (const [at, sceneId, activity, spawnId] of checkpoints) {
      const result = await tickNpcSimulation(sql, options(at));
      assert.equal(result.leader, true);
      assert.equal(result.advanced, 1);
      const [runtime] = await sql`
        select scene_id, activity, target_spawn_id, state, last_simulated_at
        from npc_runtime where npc_id = 'professor-kofi'
      `;
      assert.equal(runtime.scene_id, sceneId);
      assert.equal(runtime.activity, activity);
      assert.equal(runtime.target_spawn_id, spawnId);
      assert.equal(runtime.state.recovery, "bounded_catchup");
    }

    const [events] = await sql<{ count: number }[]>`
      select count(*)::int as count from world_events
      where entity_type = 'npc' and entity_id = 'professor-kofi'
        and event_type in ('npc.activity_changed', 'npc.path_completed')
    `;
    assert.ok(events.count >= checkpoints.length * 2);
  });
});

test("invalid map/database destinations roll back runtime and presentation events together", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const [before] = await sql`
      select state_version::text as state_version from npc_runtime where npc_id = 'professor-kofi'
    `;
    const [eventCount] = await sql<{ count: number }[]>`select count(*)::int as count from world_events`;
    await sql`update spawn_points set x = x + 1 where id = 'research-desk'`;
    await assert.rejects(
      tickNpcSimulation(sql, options("2026-11-13T09:00:00.000Z")),
      /database\/map spawn mismatch/,
    );
    const [after] = await sql`
      select state_version::text as state_version from npc_runtime where npc_id = 'professor-kofi'
    `;
    const [afterEvents] = await sql<{ count: number }[]>`select count(*)::int as count from world_events`;
    assert.equal(after.state_version, before.state_version);
    assert.equal(afterEvents.count, eventCount.count);
  });
});

test("a second app instance skips while the simulation advisory lock is held", async () => {
  await withTestSchema(async ({ sql, schema }) => {
    await setup(sql);
    const blocker = connectTestClient(testDatabaseUrl(), schema);
    try {
      const [held] = await blocker<{ locked: boolean }[]>`
        select pg_try_advisory_lock(
          hashtextextended(current_schema() || ':quizcity-npc-simulation', 0)
        ) as locked
      `;
      assert.equal(held.locked, true);
      const skipped = await tickNpcSimulation(sql, options("2026-11-13T09:00:00.000Z"));
      assert.deepEqual(skipped, { leader: false, selected: 0, advanced: 0, recovered: 0, inactive: 0 });
      await blocker`
        select pg_advisory_unlock(
          hashtextextended(current_schema() || ':quizcity-npc-simulation', 0)
        )
      `;
    } finally {
      await blocker.end();
    }
  });
});
