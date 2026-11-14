import type { TransactionSql } from "postgres";
import { AppError } from "./errors.js";
import { appendWorldEvent, appendWorldEvents } from "./world-events.js";
import { advancePath, planMove, sceneById, validateInteraction } from "./world-navigation.js";
import { facingForStep, isVenueOpen as operatesAt } from "@quiz-city/world-data";

export type PresenceRow = {
  session_id: string;
  player_account: string;
  scene_id: string;
  x: number;
  y: number;
  facing: string;
  state_version: string;
  scene_version: string;
  last_client_sequence: string;
  last_message_id: string | null;
  path: { x: number; y: number }[];
  path_index: number;
  movement_cooldown_at: string | Date | null;
  movement_tokens: number | null;
  interaction_cooldown_at: string | Date | null;
  interaction_tokens: number | null;
};

export async function lockPresence(
  transaction: TransactionSql,
  sessionId: string,
  accountId: string,
): Promise<PresenceRow> {
  const [row] = await transaction<PresenceRow[]>`
    select session_id, player_account, scene_id, x, y, facing,
           state_version::text as state_version,
           scene_version::text as scene_version,
           last_client_sequence::text as last_client_sequence,
           last_message_id, path, path_index,
           movement_cooldown_at, movement_tokens,
           interaction_cooldown_at, interaction_tokens
    from player_presence
    where session_id = ${sessionId} and player_account = ${accountId}
    for update
  `;
  if (!row) throw new AppError("CONFLICT", "presence not found", 409);
  return row;
}

type MoveResult = {
  path: { x: number; y: number }[];
  stateVersion: string;
  duplicate: boolean;
};

type InteractionResult = {
  sceneId: string;
  x: number;
  y: number;
  facing: string;
  stateVersion: string;
  duplicate: boolean;
};

function bucketAfterConsumption(
  tokens: number | null,
  updatedAt: string | Date | null,
  now: Date,
  refillMs: number,
  burst: number,
): number | null {
  if (refillMs <= 0) return burst;
  const elapsed = updatedAt ? Math.max(0, now.getTime() - new Date(updatedAt).getTime()) : 0;
  const available = Math.min(burst, (tokens ?? burst) + elapsed / refillMs);
  return available >= 1 ? available - 1 : null;
}

async function priorReceipt<T>(
  transaction: TransactionSql,
  presence: PresenceRow,
  messageId: string,
  clientSequence: string,
  commandType: "world.move_intent" | "world.interact",
  fingerprint: string,
): Promise<T | null> {
  const [receipt] = await transaction<
    { client_sequence: string; command_type: string; fingerprint: string; result: T }[]
  >`
    select client_sequence::text as client_sequence, command_type, fingerprint, result
    from world_command_receipts
    where session_id = ${presence.session_id} and message_id = ${messageId}
  `;
  if (!receipt) return null;
  if (
    receipt.client_sequence !== clientSequence ||
    receipt.command_type !== commandType ||
    receipt.fingerprint !== fingerprint
  ) {
    throw new AppError("CONFLICT", "message id reused with different command data", 409);
  }
  return receipt.result;
}

async function recordReceipt(
  transaction: TransactionSql,
  presence: PresenceRow,
  messageId: string,
  clientSequence: string,
  commandType: "world.move_intent" | "world.interact",
  fingerprint: string,
  result: object,
): Promise<void> {
  await transaction`
    insert into world_command_receipts (
      session_id, message_id, client_sequence, command_type, fingerprint, result
    ) values (
      ${presence.session_id}, ${messageId}, ${clientSequence}::bigint,
      ${commandType}, ${fingerprint}, ${transaction.json(result as never)}
    )
  `;
}

function assertCommand(presence: PresenceRow, messageId: string, clientSequence: string): void {
  if (presence.last_message_id === messageId) {
    throw new AppError("CONFLICT", "duplicate command", 409);
  }
  if (BigInt(clientSequence) <= BigInt(presence.last_client_sequence)) {
    throw new AppError("CONFLICT", "stale client sequence", 409);
  }
}

export async function applyMoveIntent(
  transaction: TransactionSql,
  presence: PresenceRow,
  input: { messageId: string; clientSequence: string; sceneId: string; x: number; y: number },
  options: { now: Date; cooldownMs: number; burst?: number },
): Promise<MoveResult> {
  const fingerprint = JSON.stringify({ sceneId: input.sceneId, x: input.x, y: input.y });
  const prior = await priorReceipt<Omit<MoveResult, "duplicate">>(
    transaction,
    presence,
    input.messageId,
    input.clientSequence,
    "world.move_intent",
    fingerprint,
  );
  if (prior) return { ...prior, duplicate: true };
  if (presence.scene_id !== input.sceneId) throw new AppError("CONFLICT", "INVALID_SCENE", 409);
  assertCommand(presence, input.messageId, input.clientSequence);
  const movementTokens = bucketAfterConsumption(
    presence.movement_tokens,
    presence.movement_cooldown_at,
    options.now,
    options.cooldownMs,
    options.burst ?? 1,
  );
  if (movementTokens === null) {
    throw new AppError("RATE_LIMITED", "movement rate limited", 429);
  }
  const plan = planMove(input.sceneId, { x: presence.x, y: presence.y }, { x: input.x, y: input.y });
  const mapVersion = sceneById(input.sceneId).assetVersion;
  if (!/^(0|[1-9]\d{0,18})$/.test(mapVersion)) {
    throw new AppError("CONFLICT", "authoritative map version is invalid", 409);
  }
  const persistedPath = plan.path.length > 1 ? plan.path : [];
  const [updated] = await transaction<{ state_version: string }[]>`
    update player_presence set
      path = ${transaction.json(persistedPath as never)},
      path_index = 0,
      last_client_sequence = ${input.clientSequence}::bigint,
      last_message_id = ${input.messageId},
      movement_cooldown_at = ${options.now},
      movement_tokens = ${movementTokens},
      scene_version = ${mapVersion}::bigint,
      heartbeat_at = ${options.now},
      state_version = state_version + 1
    where session_id = ${presence.session_id} and state_version = ${presence.state_version}::bigint
    returning state_version::text as state_version
  `;
  if (!updated) throw new AppError("CONFLICT", "presence changed", 409);
  const result = { path: persistedPath, stateVersion: updated.state_version };
  await recordReceipt(
    transaction,
    presence,
    input.messageId,
    input.clientSequence,
    "world.move_intent",
    fingerprint,
    result,
  );
  return { ...result, duplicate: false };
}

export async function applyInteraction(
  transaction: TransactionSql,
  presence: PresenceRow,
  input: {
    messageId: string;
    clientSequence: string;
    sceneId: string;
    targetType: "building" | "door" | "npc" | "business";
    targetId: string;
  },
  options: { now: Date; cooldownMs: number; burst?: number },
): Promise<InteractionResult> {
  const fingerprint = JSON.stringify({
    sceneId: input.sceneId,
    targetType: input.targetType,
    targetId: input.targetId,
  });
  const prior = await priorReceipt<Omit<InteractionResult, "duplicate">>(
    transaction,
    presence,
    input.messageId,
    input.clientSequence,
    "world.interact",
    fingerprint,
  );
  if (prior) return { ...prior, duplicate: true };
  if (presence.scene_id !== input.sceneId) throw new AppError("CONFLICT", "INVALID_SCENE", 409);
  assertCommand(presence, input.messageId, input.clientSequence);
  const interactionTokens = bucketAfterConsumption(
    presence.interaction_tokens,
    presence.interaction_cooldown_at,
    options.now,
    options.cooldownMs,
    options.burst ?? 1,
  );
  if (interactionTokens === null) {
    throw new AppError("RATE_LIMITED", "interaction rate limited", 429);
  }
  let result = validateInteraction(
    input.sceneId,
    { x: presence.x, y: presence.y },
    input.targetId,
    input.targetType,
  );
  if (input.targetType === "npc") {
    const [npc] = await transaction<{ x: number; y: number }[]>`
      select x, y from npc_runtime where npc_id = ${input.targetId} and scene_id = ${presence.scene_id} for share
    `;
    if (!npc) throw new AppError("NOT_FOUND", "TARGET_NOT_FOUND", 404);
    const inRange = Math.max(Math.abs(presence.x - npc.x), Math.abs(presence.y - npc.y)) <= 2;
    result = {
      reason: inRange ? "OK" : "OUT_OF_RANGE",
      target: { id: input.targetId, x: npc.x, y: npc.y, radius: 2 },
    };
  }
  if (result.reason !== "OK" || !result.target) throw new AppError("CONFLICT", result.reason, 409);

  if (input.targetType === "building") {
    const [building] = await transaction<
      { status: "active" | "closed" | "hidden"; operating_hours: unknown }[]
    >`
      select status, operating_hours from buildings
      where id = ${input.targetId}
        and (exterior_scene_id = ${presence.scene_id} or interior_scene_id = ${presence.scene_id})
    `;
    if (!building || building.status === "hidden") throw new AppError("NOT_FOUND", "TARGET_NOT_FOUND", 404);
    if (building.status !== "active" || !operatesAt(building.operating_hours, options.now)) {
      throw new AppError("CONFLICT", "TARGET_CLOSED", 409);
    }
  } else if (input.targetType === "business") {
    const [business] = await transaction<
      { status: "open" | "closed" | "suspended"; operating_hours: unknown }[]
    >`
      select business.status, building.operating_hours
      from businesses business
      join buildings building on building.business_id = business.id
      where business.id::text = ${input.targetId}
        and business.active = true
        and building.status <> 'hidden'
        and (building.exterior_scene_id = ${presence.scene_id}
             or building.interior_scene_id = ${presence.scene_id})
    `;
    if (!business) throw new AppError("NOT_FOUND", "TARGET_NOT_FOUND", 404);
    if (business.status !== "open" || !operatesAt(business.operating_hours, options.now)) {
      throw new AppError("CONFLICT", "TARGET_CLOSED", 409);
    }
  }

  if (input.targetType === "door") {
    const door = sceneById(input.sceneId).doors.find((candidate) => candidate.id === input.targetId);
    if (!door) throw new AppError("NOT_FOUND", "TARGET_NOT_FOUND", 404);
    const targetScene = sceneById(door.targetSceneId);
    const expectedSpawn = targetScene.spawns.find((candidate) => candidate.id === door.targetSpawnId);
    if (!expectedSpawn) throw new AppError("CONFLICT", "TARGET_NOT_FOUND", 409);
    const [sourceDoor] = await transaction<{ id: string }[]>`
      select id from spawn_points
      where id = ${door.id}
        and scene_id = ${presence.scene_id}
        and destination_scene_id = ${door.targetSceneId}
        and destination_spawn_id = ${door.targetSpawnId}
        and active = true
    `;
    if (!sourceDoor) throw new AppError("NOT_FOUND", "TARGET_NOT_FOUND", 404);
    const [spawn] = await transaction<{ x: number; y: number; facing: string }[]>`
      select spawn.x, spawn.y, spawn.facing
      from spawn_points spawn
      join scenes scene on scene.id = spawn.scene_id
      where spawn.id = ${door.targetSpawnId}
        and spawn.scene_id = ${door.targetSceneId}
        and spawn.active = true
        and scene.active = true
      for share
    `;
    if (!spawn || spawn.x !== expectedSpawn.x || spawn.y !== expectedSpawn.y) {
      throw new AppError("CONFLICT", "TARGET_NOT_FOUND", 409);
    }
    const [destinationBuilding] = await transaction<
      { status: "active" | "closed" | "hidden"; operating_hours: unknown }[]
    >`
      select status, operating_hours from buildings
      where exterior_scene_id = ${presence.scene_id}
        and interior_scene_id = ${targetScene.id}
        and entrance_x = ${door.x} and entrance_y = ${door.y}
    `;
    if (destinationBuilding?.status === "hidden") {
      throw new AppError("NOT_FOUND", "TARGET_NOT_FOUND", 404);
    }
    if (
      destinationBuilding &&
      (destinationBuilding.status !== "active" ||
        !operatesAt(destinationBuilding.operating_hours, options.now))
    ) {
      throw new AppError("CONFLICT", "TARGET_CLOSED", 409);
    }
    const oldStream = `scene:${presence.scene_id}`;
    const newStream = `scene:${targetScene.id}`;
    const [updated] = await transaction<{ state_version: string }[]>`
      update player_presence set
        scene_id = ${targetScene.id}, x = ${spawn.x}, y = ${spawn.y},
        facing = ${spawn.facing},
        path = '[]'::jsonb, path_index = 0,
        last_client_sequence = ${input.clientSequence}::bigint,
        last_message_id = ${input.messageId},
        interaction_cooldown_at = ${options.now}, interaction_tokens = ${interactionTokens},
        heartbeat_at = ${options.now},
        state_version = state_version + 1,
        scene_version = ${targetScene.assetVersion}::bigint
      where session_id = ${presence.session_id} and state_version = ${presence.state_version}::bigint
      returning state_version::text as state_version
    `;
    if (!updated) throw new AppError("CONFLICT", "presence changed", 409);
    await appendWorldEvents(transaction, [
      {
        streamId: oldStream,
        sceneId: presence.scene_id,
        type: "player.left",
        entity: { entityType: "player", entityId: presence.player_account },
        payload: {
          accountId: presence.player_account,
          x: presence.x,
          y: presence.y,
          facing: presence.facing as "north" | "south" | "east" | "west",
          sceneId: presence.scene_id,
        },
        idempotencyKey: `presence:${presence.session_id}:${input.messageId}:left`,
        cityTime: options.now,
      },
      {
        streamId: oldStream,
        sceneId: presence.scene_id,
        type: "player.scene_changed",
        entity: { entityType: "player", entityId: presence.player_account },
        payload: {
          accountId: presence.player_account,
          x: spawn.x,
          y: spawn.y,
          facing: spawn.facing as "north" | "south" | "east" | "west",
          sceneId: targetScene.id,
        },
        idempotencyKey: `presence:${presence.session_id}:${input.messageId}:changed`,
        cityTime: options.now,
      },
      {
        streamId: newStream,
        sceneId: targetScene.id,
        type: "player.joined",
        entity: { entityType: "player", entityId: presence.player_account },
        payload: {
          accountId: presence.player_account,
          x: spawn.x,
          y: spawn.y,
          facing: spawn.facing as "north" | "south" | "east" | "west",
          sceneId: targetScene.id,
        },
        idempotencyKey: `presence:${presence.session_id}:${input.messageId}:joined`,
        cityTime: options.now,
      },
    ]);
    const interactionResult = {
      sceneId: targetScene.id,
      x: spawn.x,
      y: spawn.y,
      facing: spawn.facing,
      stateVersion: updated.state_version,
    };
    await recordReceipt(
      transaction,
      presence,
      input.messageId,
      input.clientSequence,
      "world.interact",
      fingerprint,
      interactionResult,
    );
    return { ...interactionResult, duplicate: false };
  }

  const [updated] = await transaction<{ state_version: string }[]>`
    update player_presence set
      last_client_sequence = ${input.clientSequence}::bigint,
      last_message_id = ${input.messageId},
      interaction_cooldown_at = ${options.now}, interaction_tokens = ${interactionTokens},
      heartbeat_at = ${options.now},
      state_version = state_version + 1
    where session_id = ${presence.session_id} and state_version = ${presence.state_version}::bigint
    returning state_version::text as state_version
  `;
  if (!updated) throw new AppError("CONFLICT", "presence changed", 409);
  const interactionResult = {
    sceneId: presence.scene_id,
    x: presence.x,
    y: presence.y,
    facing: presence.facing as
      "north" | "north_east" | "east" | "south_east" | "south" | "south_west" | "west" | "north_west",
    stateVersion: updated.state_version,
  };
  await recordReceipt(
    transaction,
    presence,
    input.messageId,
    input.clientSequence,
    "world.interact",
    fingerprint,
    interactionResult,
  );
  return { ...interactionResult, duplicate: false };
}

export async function advancePresence(
  transaction: TransactionSql,
  presence: PresenceRow,
  tiles: number,
  now: Date,
): Promise<{ position: { x: number; y: number }; stateVersion: string } | null> {
  if (!Array.isArray(presence.path) || presence.path.length === 0) return null;
  if (presence.scene_version !== sceneById(presence.scene_id).assetVersion) {
    await transaction`
      update player_presence set
        path = '[]'::jsonb, path_index = 0, state_version = state_version + 1
      where session_id = ${presence.session_id} and state_version = ${presence.state_version}::bigint
    `;
    return null;
  }
  const { position, remaining } = advancePath(presence.path, tiles);
  const persistedPath = remaining.length > 0 ? [position, ...remaining] : [];
  const facing = facingForStep(position.x - presence.x, position.y - presence.y);
  const steps = Math.min(tiles, Math.max(0, presence.path.length - 1));
  const [updated] = await transaction<{ state_version: string; presence_generation: string }[]>`
    update player_presence set
      x = ${position.x}, y = ${position.y}, facing = ${facing},
      path = ${transaction.json(persistedPath as never)},
      path_index = path_index + ${steps}, heartbeat_at = ${now}, state_version = state_version + 1
    where session_id = ${presence.session_id} and state_version = ${presence.state_version}::bigint
    returning state_version::text as state_version, presence_generation::text as presence_generation
  `;
  if (!updated) return null;
  await appendWorldEvent(transaction, {
    streamId: `scene:${presence.scene_id}`,
    sceneId: presence.scene_id,
    type: "player.checkpoint",
    entity: { entityType: "player", entityId: presence.player_account },
    payload: {
      accountId: presence.player_account,
      x: position.x,
      y: position.y,
      facing,
      sceneId: presence.scene_id,
    },
    cityTime: now,
    idempotencyKey: `movement:${updated.presence_generation}:${updated.state_version}`,
  });
  return { position, stateVersion: updated.state_version };
}
