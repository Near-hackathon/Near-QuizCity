import type { Sql, TransactionSql } from "postgres";

export type NpcRuntimePatch = {
  sceneId?: string;
  x?: number;
  y?: number;
  activity?: string;
  targetSceneId?: string | null;
  targetSpawnId?: string | null;
  targetX?: number | null;
  targetY?: number | null;
  state?: unknown;
};

/**
 * Optimistic concurrency with explicit patch semantics:
 * - undefined: leave the column unchanged
 * - null: clear a nullable target column
 * - value: replace the column
 * Only the writer holding the current state_version can advance runtime state.
 */
export async function updateNpcRuntime(
  client: Sql | TransactionSql,
  npcId: string,
  expectedVersion: number,
  patch: NpcRuntimePatch,
): Promise<boolean> {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  if (patch.sceneId !== undefined) set("scene_id", patch.sceneId);
  if (patch.x !== undefined) set("x", patch.x);
  if (patch.y !== undefined) set("y", patch.y);
  if (patch.activity !== undefined) set("activity", patch.activity);
  if (patch.targetSceneId !== undefined) set("target_scene_id", patch.targetSceneId);
  if (patch.targetSpawnId !== undefined) set("target_spawn_id", patch.targetSpawnId);
  if (patch.targetX !== undefined) set("target_x", patch.targetX);
  if (patch.targetY !== undefined) set("target_y", patch.targetY);
  if (patch.state !== undefined) {
    values.push(JSON.stringify(patch.state));
    assignments.push(`state = $${values.length}::jsonb`);
  }

  assignments.push("state_version = state_version + 1", "last_simulated_at = now()", "updated_at = now()");
  values.push(npcId);
  const npcParameter = values.length;
  values.push(expectedVersion);
  const versionParameter = values.length;

  const updated = await client.unsafe(
    `update npc_runtime set ${assignments.join(", ")}
     where npc_id = $${npcParameter} and state_version = $${versionParameter}
     returning npc_id`,
    values,
  );
  return updated.length > 0;
}

export async function expireStalePresence(
  client: Sql | TransactionSql,
  timeoutSeconds: number,
): Promise<number> {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("presence timeout must be a positive number of seconds");
  }
  const removed = await client`
    delete from player_presence
    where heartbeat_at < now() - make_interval(secs => ${timeoutSeconds})
    returning session_id
  `;
  return removed.length;
}
