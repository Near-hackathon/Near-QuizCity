import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { seedWorld } from "../db/seeds/world.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { tickNpcSimulation } from "../src/world-simulation.js";
import { seedResidents } from "../db/seeds/residents.js";
import { residentRoutines, worldScenes } from "@quiz-city/world-data";
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
      assert.equal(result.advanced, 6);
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
    const departures = await sql`
      select scene_id, payload from world_events
      where event_type in ('npc.entered_building', 'npc.exited_building')
        and entity_id = 'professor-kofi'
    `;
    assert.equal(departures.length, checkpoints.length);
    assert.ok(departures.some((event) => event.scene_id === "library-interior"));
    assert.ok(departures.every((event) => event.payload.buildingId.startsWith("building-")));
  });
});

test("new residents follow an accelerated day and seeding preserves runtime, hours and money", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    for (const minute of [0, 360, 540, 750, 900, 1080, 1380]) {
      const now = new Date(Date.UTC(2026, 10, 14, 0, minute));
      await tickNpcSimulation(sql, { ...options(now.toISOString()), now });
      const runtimes = await sql`select * from npc_runtime order by npc_id`;
      for (const [id, routine] of Object.entries(residentRoutines)) {
        const stop = routine.find((stop) => minute >= stop.start && minute < stop.end)!;
        const row = runtimes.find((row) => row.npc_id === id)!;
        assert.equal(row.scene_id, stop.scene);
        assert.equal(row.activity, stop.activity);
        assert.equal(row.target_spawn_id, stop.spawn);
      }
    }
    await sql`update buildings set operating_hours='{}'::jsonb where id='building-library'`;
    await sql`insert into wallets(wallet_id,owner_type,owner_id,balance) values ('player:fixture.testnet','player','fixture.testnet',9007199254740993)`;
    const before = await sql`select * from npc_runtime order by npc_id`;
    await seedResidents(sql);
    await seedResidents(sql);
    assert.deepEqual([...(await sql`select * from npc_runtime order by npc_id`)], [...before]);
    const [counts] =
      await sql`select (select count(*)::int from npc_runtime) as residents,(select count(*)::int from npc_schedules) as schedules`;
    assert.deepEqual({ ...counts }, { residents: 6, schedules: 33 });
    const [building] = await sql`select operating_hours from buildings where id='building-library'`;
    assert.deepEqual(building.operating_hours, {});
    const [wallet] =
      await sql`select balance::text as balance from wallets where wallet_id='player:fixture.testnet'`;
    assert.equal(wallet.balance, "9007199254740993");
  });
});

test("normal resident travel walks from the gardens through the library door instead of teleporting", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    await tickNpcSimulation(sql, options("2026-11-14T07:29:00Z"));
    const [baseline] = await sql`select coalesce(max(id),0)::text as id from world_events`;
    const [initial] = await sql`select scene_id,x,y from npc_runtime where npc_id='librarian-ama'`;
    let previous = initial,
      arrived = false,
      streetSteps = 0;
    for (let index = 0; index < 100; index++) {
      const now = new Date(Date.parse("2026-11-14T07:30:00Z") + index * 1000);
      await tickNpcSimulation(sql, {
        now,
        timeZone: "Africa/Accra",
        tilesPerTick: 2,
        catchupAfterMs: 86_400_000,
      });
      const [row] = await sql`select scene_id,x,y,activity from npc_runtime where npc_id='librarian-ama'`;
      if (row.scene_id !== previous.scene_id) {
        const door = worldScenes
          .find((scene) => scene.id === previous.scene_id)!
          .doors.find(
            (door) => door.x === previous.x && door.y === previous.y && door.targetSceneId === row.scene_id,
          );
        assert.ok(door, "transition only occurs at a real door");
        const arrival = worldScenes
          .find((scene) => scene.id === row.scene_id)!
          .spawns.find((point) => point.id === door.targetSpawnId)!;
        assert.equal(row.x, arrival.x);
        assert.equal(row.y, arrival.y);
      }
      if (row.scene_id === "city-district") streetSteps++;
      previous = row;
      if (row.scene_id === "library-interior" && row.activity === "helping_readers") {
        arrived = true;
        break;
      }
    }
    assert.ok(arrived);
    assert.ok(streetSteps > 2, "resident visibly traverses the city");
    const departures =
      await sql`select event_type,payload from world_events where id>${baseline.id}::bigint and entity_id='librarian-ama' and event_type in ('npc.entered_building','npc.exited_building') order by id`;
    assert.deepEqual(
      departures.map((row) => [row.event_type, row.payload.buildingId]),
      [["npc.entered_building", "building-library"]],
    );
  });
});

test("invalid map/database destinations roll back runtime and presentation events together", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const rosterBefore = await sql`select * from npc_runtime order by npc_id`;
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
    assert.deepEqual([...(await sql`select * from npc_runtime order by npc_id`)], [...rosterBefore]);
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

test("only the professor returns home; other residents walk and pause around the city at night", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const start = Date.parse("2026-11-14T03:00:00Z");
    await tickNpcSimulation(sql, options(new Date(start).toISOString()));
    const positions = new Set<string>();
    const activities = new Set<string>();
    for (let second = 1; second <= 70; second++) {
      await tickNpcSimulation(sql, {
        now: new Date(start + second * 1000),
        timeZone: "Africa/Accra",
        tilesPerTick: 1,
        catchupAfterMs: 60_000,
      });
      const rows = await sql`select npc_id,scene_id,x,y,activity,state from npc_runtime`;
      assert.deepEqual(
        rows.filter((row) => row.scene_id === "apartment-interior").map((row) => row.npc_id),
        ["professor-kofi"],
      );
      const reader = rows.find((row) => row.npc_id === "librarian-ama")!;
      assert.equal(reader.scene_id, "city-district");
      positions.add(`${reader.x},${reader.y}`);
      activities.add(reader.activity);
      if (second === 30) {
        const saved = await sql`select * from npc_runtime order by npc_id`;
        await seedResidents(sql);
        assert.deepEqual(
          [...(await sql`select * from npc_runtime order by npc_id`)],
          [...saved],
          "reseed preserves walking progress and pause deadline",
        );
      }
    }
    assert.ok(positions.size > 4, "night routine visibly moves through several cells");
    assert.deepEqual([...activities].sort(), ["garden_walk", "walking"]);
  });
});

test("invalid walking routes roll back positions and events for the entire roster", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    const before = await sql`select * from npc_runtime order by npc_id`;
    const events = await sql`select * from world_events order by id`;
    for (const patrol of [
      ["ama-park", "unknown-waypoint"],
      ["ama-park", "ama-park"],
    ]) {
      await sql`update npc_schedules set parameters=${sql.json({ patrol })} where id='ama-morning'`;
      await assert.rejects(tickNpcSimulation(sql, options("2026-11-14T03:00:00Z")), /patrol/);
      assert.deepEqual([...(await sql`select * from npc_runtime order by npc_id`)], [...before]);
      assert.deepEqual([...(await sql`select * from world_events order by id`)], [...events]);
    }
  });
});
