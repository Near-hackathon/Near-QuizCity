import type { Sql } from "postgres";
import { appendWorldEvents, type AppendWorldEvent } from "./world-events.js";
import { advancePath, planMove, sceneById } from "./world-navigation.js";
import { assertNoScheduleOverlap, evaluateSchedule, type NpcSchedule } from "./world-schedules.js";
import { startWorker, type WorkerHandle } from "./worker.js";

const MAX_NPCS_PER_TICK = 200;

type RuntimeRow = {
  npc_id: string;
  scene_id: string;
  x: number;
  y: number;
  activity: string;
  target_scene_id: string | null;
  target_spawn_id: string | null;
  state: unknown;
  state_version: string;
  last_simulated_at: Date | null;
};

type ScheduleRow = {
  id: string;
  npc_id: string;
  sequence: number;
  day_mask: number;
  start_minute: number;
  end_minute: number;
  activity: string;
  destination_scene_id: string | null;
  destination_building_id: string | null;
  destination_spawn_id: string | null;
};

export type NpcSimulationResult = {
  leader: boolean;
  selected: number;
  advanced: number;
  recovered: number;
  inactive: number;
};

function schedule(row: ScheduleRow): NpcSchedule {
  return {
    id: row.id,
    npcId: row.npc_id,
    sequence: row.sequence,
    dayMask: row.day_mask,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    activity: row.activity,
    destinationSceneId: row.destination_scene_id,
    destinationBuildingId: row.destination_building_id,
    destinationSpawnId: row.destination_spawn_id,
  };
}

function objectState(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * Advances scheduled NPCs in one bounded, restart-safe transaction. The
 * transaction-level advisory lock elects one worker across all app instances;
 * runtime state and its presentation events therefore commit or roll back
 * together.
 */
export async function tickNpcSimulation(
  db: Sql,
  options: {
    now: Date;
    timeZone: string;
    tilesPerTick: number;
    catchupAfterMs: number;
  },
): Promise<NpcSimulationResult> {
  if (!Number.isInteger(options.tilesPerTick) || options.tilesPerTick < 1 || options.tilesPerTick > 8) {
    throw new Error("tilesPerTick must be an integer between 1 and 8");
  }
  if (!Number.isSafeInteger(options.catchupAfterMs) || options.catchupAfterMs < 1_000) {
    throw new Error("catchupAfterMs must be at least 1000");
  }

  return db.begin(async (transaction) => {
    const [lock] = await transaction<{ locked: boolean }[]>`
      select pg_try_advisory_xact_lock(
        hashtextextended(current_schema() || ':quizcity-npc-simulation', 0)
      ) as locked
    `;
    if (!lock?.locked) return { leader: false, selected: 0, advanced: 0, recovered: 0, inactive: 0 };

    const schedules = await transaction<ScheduleRow[]>`
      select id, npc_id, sequence, day_mask, start_minute, end_minute, activity,
             destination_scene_id, destination_building_id, destination_spawn_id
      from npc_schedules order by npc_id, sequence
    `;
    const byNpc = new Map<string, NpcSchedule[]>();
    for (const row of schedules) {
      const list = byNpc.get(row.npc_id) ?? [];
      list.push(schedule(row));
      byNpc.set(row.npc_id, list);
    }
    for (const list of byNpc.values()) assertNoScheduleOverlap(list);

    const runtimes = await transaction<RuntimeRow[]>`
      select npc_id, scene_id, x, y, activity, target_scene_id, target_spawn_id,
             state, state_version::text as state_version, last_simulated_at
      from npc_runtime order by npc_id limit ${MAX_NPCS_PER_TICK} for update skip locked
    `;

    let advanced = 0;
    let recovered = 0;
    let inactive = 0;
    for (const runtime of runtimes) {
      const decision = evaluateSchedule({
        now: options.now,
        timeZone: options.timeZone,
        schedules: byNpc.get(runtime.npc_id) ?? [],
        seed: runtime.npc_id,
      });
      const selected = decision.schedule;
      const previousState = objectState(runtime.state);
      if (!selected?.destinationSceneId || !selected.destinationSpawnId) {
        inactive += 1;
        if (runtime.activity === "idle" && previousState.schedule_id === null) continue;
        const nextVersion = (BigInt(runtime.state_version) + 1n).toString();
        const draft: AppendWorldEvent = {
          streamId: `scene:${runtime.scene_id}`,
          sceneId: runtime.scene_id,
          cityTime: options.now,
          type: "npc.activity_changed",
          entity: { entityType: "npc", entityId: runtime.npc_id },
          payload: { activity: "idle", stateVersion: nextVersion },
          idempotencyKey: `npc-sim:${runtime.npc_id}:${nextVersion}:idle`,
        };
        await appendWorldEvents(transaction, [draft]);
        await transaction`
          update npc_runtime set activity = 'idle', target_scene_id = null,
            target_spawn_id = null, state_version = state_version + 1,
            state = ${transaction.json({
              ...previousState,
              schedule_id: null,
              next_transition_at: decision.nextTransitionAt,
              recovery: "inactive_schedule",
            })},
            last_simulated_at = ${options.now}, updated_at = now()
          where npc_id = ${runtime.npc_id} and state_version = ${runtime.state_version}::bigint
        `;
        continue;
      }

      const [spawn] = await transaction<
        {
          id: string;
          scene_id: string;
          x: number;
          y: number;
        }[]
      >`
        select sp.id, sp.scene_id, sp.x, sp.y from spawn_points sp
        join scenes scene on scene.id = sp.scene_id
        where sp.id = ${selected.destinationSpawnId}
          and sp.scene_id = ${selected.destinationSceneId}
          and sp.active = true and scene.active = true
      `;
      if (!spawn) throw new Error(`invalid destination for NPC schedule ${selected.id}`);
      const mapSpawn = sceneById(spawn.scene_id).spawns.find((item) => item.id === spawn.id);
      if (!mapSpawn || mapSpawn.x !== spawn.x || mapSpawn.y !== spawn.y) {
        throw new Error(`database/map spawn mismatch for NPC schedule ${selected.id}`);
      }

      const elapsed = runtime.last_simulated_at
        ? options.now.getTime() - runtime.last_simulated_at.getTime()
        : Number.POSITIVE_INFINITY;
      const catchup = elapsed > options.catchupAfterMs;
      const changedTarget =
        runtime.target_scene_id !== spawn.scene_id ||
        runtime.target_spawn_id !== spawn.id ||
        previousState.schedule_id !== selected.id;
      const crossScene = runtime.scene_id !== spawn.scene_id;
      let x = runtime.x;
      let y = runtime.y;
      let sceneId = runtime.scene_id;
      let completed: boolean;

      if (catchup || crossScene) {
        sceneId = spawn.scene_id;
        x = spawn.x;
        y = spawn.y;
        completed = true;
        recovered += catchup ? 1 : 0;
      } else if (runtime.x === spawn.x && runtime.y === spawn.y) {
        completed = true;
      } else {
        const path = planMove(runtime.scene_id, { x: runtime.x, y: runtime.y }, spawn).path;
        const step = advancePath(path, options.tilesPerTick);
        x = step.position.x;
        y = step.position.y;
        completed = x === spawn.x && y === spawn.y;
      }

      const nextVersion = (BigInt(runtime.state_version) + 1n).toString();
      const drafts: AppendWorldEvent[] = [];
      if (changedTarget || runtime.activity !== selected.activity) {
        drafts.push({
          streamId: `scene:${sceneId}`,
          sceneId,
          cityTime: options.now,
          type: "npc.activity_changed",
          entity: { entityType: "npc", entityId: runtime.npc_id },
          payload: { activity: selected.activity, stateVersion: nextVersion },
          idempotencyKey: `npc-sim:${runtime.npc_id}:${nextVersion}:activity`,
        });
      }
      if (changedTarget && !completed) {
        drafts.push({
          streamId: `scene:${sceneId}`,
          sceneId,
          cityTime: options.now,
          type: "npc.path_started",
          entity: { entityType: "npc", entityId: runtime.npc_id },
          payload: { sceneId, toX: spawn.x, toY: spawn.y, stateVersion: nextVersion },
          idempotencyKey: `npc-sim:${runtime.npc_id}:${nextVersion}:path`,
        });
      }
      if (completed && (changedTarget || runtime.x !== x || runtime.y !== y || crossScene)) {
        drafts.push({
          streamId: `scene:${sceneId}`,
          sceneId,
          cityTime: options.now,
          type: "npc.path_completed",
          entity: { entityType: "npc", entityId: runtime.npc_id },
          payload: { sceneId, x, y },
          idempotencyKey: `npc-sim:${runtime.npc_id}:${nextVersion}:complete`,
        });
      }

      const [updated] = await transaction<{ npc_id: string }[]>`
        update npc_runtime set scene_id = ${sceneId}, x = ${x}, y = ${y},
          activity = ${selected.activity}, target_scene_id = ${spawn.scene_id},
          target_spawn_id = ${spawn.id}, target_x = ${spawn.x}, target_y = ${spawn.y},
          state_version = state_version + 1,
          state = ${transaction.json({
            ...previousState,
            schedule_id: selected.id,
            next_transition_at: decision.nextTransitionAt,
            variation: decision.variation,
            recovery: catchup ? "bounded_catchup" : null,
          })},
          last_simulated_at = ${options.now}, updated_at = now()
        where npc_id = ${runtime.npc_id} and state_version = ${runtime.state_version}::bigint
        returning npc_id
      `;
      if (!updated) throw new Error(`NPC runtime changed concurrently: ${runtime.npc_id}`);
      await appendWorldEvents(transaction, drafts);
      advanced += 1;
    }
    return { leader: true, selected: runtimes.length, advanced, recovered, inactive };
  }) as Promise<NpcSimulationResult>;
}

export function startNpcSimulationWorker(options: {
  db: Sql;
  intervalMs: number;
  timeZone: string;
  tilesPerTick: number;
  catchupAfterMs: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}): WorkerHandle {
  return startWorker({
    intervalMs: options.intervalMs,
    run: async () => {
      await tickNpcSimulation(options.db, {
        now: (options.now ?? (() => new Date()))(),
        timeZone: options.timeZone,
        tilesPerTick: options.tilesPerTick,
        catchupAfterMs: options.catchupAfterMs,
      });
    },
    onError: options.onError,
  });
}
