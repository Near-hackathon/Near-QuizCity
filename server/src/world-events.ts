import { isDeepStrictEqual } from "node:util";
import { PROTOCOL_VERSION, WorldEvent, type WorldEventType } from "@quiz-city/protocol";
import { Value } from "@sinclair/typebox/value";
import type { Sql, TransactionSql } from "postgres";
import { AppError } from "./errors.js";

export type WorldEventRow = {
  id: string;
  event_id: string;
  stream_id: string;
  sequence: string;
  protocol_version: string;
  event_type: string;
  scene_id: string | null;
  entity_type: string;
  entity_id: string;
  payload: unknown;
  game_time: Date | string | null;
  observed_at: Date | string;
  idempotency_key: string | null;
};

type EventDraft<Event extends WorldEventType = WorldEventType> = Event extends WorldEventType
  ? Pick<Event, "type" | "sceneId" | "entity" | "payload">
  : never;

export type AppendWorldEvent = EventDraft & {
  streamId: string;
  cityTime: Date | string;
  idempotencyKey?: string | null;
};

const MAX_REPLAY = 500;
const STREAM_PATTERN = /^scene:[a-z0-9_-]{1,64}$/;
const SEQUENCE_PATTERN = /^(0|[1-9][0-9]{0,17})$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function assertStream(streamId: string): void {
  if (!STREAM_PATTERN.test(streamId)) {
    throw new AppError("VALIDATION_ERROR", "invalid world stream id", 400);
  }
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("VALIDATION_ERROR", "invalid world event city time", 400);
  }
  return parsed.toISOString();
}

function rowIso(value: Date | string | null, field: string): string {
  if (value === null) throw new AppError("INTERNAL_ERROR", `world event ${field} is missing`, 500);
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("INTERNAL_ERROR", `world event ${field} is invalid`, 500);
  }
  return parsed.toISOString();
}

export function worldEventFromRow(row: WorldEventRow): WorldEventType {
  const event = {
    protocolVersion: row.protocol_version,
    eventId: row.event_id,
    streamId: row.stream_id,
    sequence: String(row.sequence),
    serverTime: rowIso(row.observed_at, "observed_at"),
    cityTime: rowIso(row.game_time, "game_time"),
    sceneId: row.scene_id,
    entity: { entityType: row.entity_type, entityId: row.entity_id },
    type: row.event_type,
    payload: row.payload,
  };
  if (!Value.Check(WorldEvent, event)) {
    throw new AppError("INTERNAL_ERROR", `stored world event ${row.event_id} violates the protocol`, 500);
  }
  return event as WorldEventType;
}

function eventMatchesInput(event: WorldEventType, input: AppendWorldEvent): boolean {
  return (
    event.streamId === input.streamId &&
    event.sceneId === input.sceneId &&
    event.type === input.type &&
    event.cityTime === iso(input.cityTime) &&
    isDeepStrictEqual(event.entity, input.entity) &&
    isDeepStrictEqual(event.payload, input.payload)
  );
}

export async function streamHead(client: Sql | TransactionSql, streamId: string): Promise<string> {
  assertStream(streamId);
  const [row] = await client<{ last_sequence: string }[]>`
    select last_sequence::text as last_sequence from world_streams where stream_id = ${streamId}
  `;
  return row?.last_sequence ?? "0";
}

async function allocateSequence(transaction: TransactionSql, streamId: string): Promise<string> {
  const [row] = await transaction<{ last_sequence: string }[]>`
    insert into world_streams (stream_id, last_sequence)
    values (${streamId}, 1)
    on conflict (stream_id) do update set
      last_sequence = world_streams.last_sequence + 1,
      updated_at = now()
    returning last_sequence::text as last_sequence
  `;
  return row.last_sequence;
}

export async function appendWorldEvent(
  transaction: TransactionSql,
  input: AppendWorldEvent,
): Promise<WorldEventRow> {
  assertStream(input.streamId);
  if (input.streamId !== `scene:${input.sceneId}`) {
    throw new AppError("VALIDATION_ERROR", "world stream does not match event scene", 400);
  }
  const cityTime = iso(input.cityTime);
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    if (!IDEMPOTENCY_PATTERN.test(input.idempotencyKey)) {
      throw new AppError("VALIDATION_ERROR", "invalid world event idempotency key", 400);
    }
    await transaction`
      select pg_advisory_xact_lock(hashtextextended(${`world-event:${input.idempotencyKey}`}, 0))
    `;
    const [existing] = await transaction<WorldEventRow[]>`
      select * from world_events where idempotency_key = ${input.idempotencyKey}
    `;
    if (existing) {
      const event = worldEventFromRow(existing);
      if (!eventMatchesInput(event, input)) {
        throw new AppError("CONFLICT", "world event idempotency key was reused with different input", 409);
      }
      return existing;
    }
  }

  const sequence = await allocateSequence(transaction, input.streamId);
  const eventId = `evt-${input.sceneId}-${sequence}`;
  const serverTime = new Date().toISOString();
  const event = {
    protocolVersion: PROTOCOL_VERSION,
    eventId,
    streamId: input.streamId,
    sequence,
    serverTime,
    cityTime,
    sceneId: input.sceneId,
    entity: input.entity,
    type: input.type,
    payload: input.payload,
  };
  if (!Value.Check(WorldEvent, event)) {
    throw new AppError("VALIDATION_ERROR", "world event does not match the shared protocol", 400);
  }

  const [row] = await transaction<WorldEventRow[]>`
    insert into world_events (
      event_id, stream_id, sequence, protocol_version, event_type, scene_id,
      entity_type, entity_id, payload, game_time, observed_at, idempotency_key
    ) values (
      ${eventId}, ${input.streamId}, ${sequence}::bigint,
      ${PROTOCOL_VERSION}, ${input.type}, ${input.sceneId},
      ${input.entity.entityType}, ${input.entity.entityId},
      ${transaction.json(input.payload as never)}, ${cityTime}, ${serverTime},
      ${input.idempotencyKey ?? null}
    )
    returning *
  `;
  await transaction`select pg_notify('quizcity_world', ${`${input.streamId}:${sequence}`})`;
  return row;
}

export async function appendWorldEvents(
  transaction: TransactionSql,
  inputs: AppendWorldEvent[],
): Promise<WorldEventRow[]> {
  const ordered = [...inputs].sort((a, b) => a.streamId.localeCompare(b.streamId));
  const results: WorldEventRow[] = [];
  for (const input of ordered) results.push(await appendWorldEvent(transaction, input));
  return results;
}

export async function replayAfter(
  client: Sql | TransactionSql,
  streamId: string,
  after: string,
  limit = 100,
): Promise<WorldEventRow[]> {
  assertStream(streamId);
  if (!SEQUENCE_PATTERN.test(after)) {
    throw new AppError("VALIDATION_ERROR", "invalid world sequence", 400);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPLAY) {
    throw new AppError("VALIDATION_ERROR", "invalid replay page size", 400);
  }
  return client<WorldEventRow[]>`
    select * from world_events
    where stream_id = ${streamId}
      and sequence > ${after}::bigint
      and protocol_version = ${PROTOCOL_VERSION}
    order by sequence asc
    limit ${limit}
  `;
}

export async function oldestSequence(client: Sql | TransactionSql, streamId: string): Promise<string | null> {
  assertStream(streamId);
  const [row] = await client<{ sequence: string | null }[]>`
    select min(sequence)::text as sequence from world_events
    where stream_id = ${streamId} and protocol_version = ${PROTOCOL_VERSION}
  `;
  return row?.sequence ?? null;
}
