import type { Sql } from "postgres";
import { advancePresence, type PresenceRow } from "./world-authority.js";
import { startWorker, type WorkerHandle } from "./worker.js";

const MAX_PRESENCES_PER_TICK = 200;

export type WorldTickResult = {
  leader: boolean;
  selected: number;
  advanced: number;
};

/**
 * Advances persisted player paths under one cross-process leader lock. Paths and
 * their durable checkpoint events commit together, so a restart can continue
 * from the last authoritative checkpoint without replaying animation frames.
 */
export async function tickWorldMovement(
  db: Sql,
  options: { now: Date; tilesPerTick: number },
): Promise<WorldTickResult> {
  if (!Number.isInteger(options.tilesPerTick) || options.tilesPerTick < 1 || options.tilesPerTick > 8) {
    throw new Error("tilesPerTick must be an integer between 1 and 8");
  }
  return db.begin(async (transaction) => {
    const [lock] = await transaction<{ locked: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtextextended('quizcity-world-movement-tick', 0)) as locked
    `;
    if (!lock?.locked) return { leader: false, selected: 0, advanced: 0 };

    const rows = await transaction<PresenceRow[]>`
      select session_id, player_account, scene_id, x, y, facing,
             state_version::text as state_version,
             scene_version::text as scene_version,
             last_client_sequence::text as last_client_sequence,
             last_message_id, path, path_index,
             movement_cooldown_at, movement_tokens,
             interaction_cooldown_at, interaction_tokens
      from player_presence
      where jsonb_typeof(path) = 'array' and jsonb_array_length(path) > 1
      order by scene_id, session_id
      limit ${MAX_PRESENCES_PER_TICK}
      for update skip locked
    `;
    let advanced = 0;
    for (const row of rows) {
      if (await advancePresence(transaction, row, options.tilesPerTick, options.now)) advanced += 1;
    }
    return { leader: true, selected: rows.length, advanced };
  }) as Promise<WorldTickResult>;
}

export function startWorldMovementWorker(options: {
  db: Sql;
  intervalMs: number;
  tilesPerTick: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}): WorkerHandle {
  return startWorker({
    intervalMs: options.intervalMs,
    run: async () => {
      await tickWorldMovement(options.db, {
        now: (options.now ?? (() => new Date()))(),
        tilesPerTick: options.tilesPerTick,
      });
    },
    onError: options.onError,
  });
}
