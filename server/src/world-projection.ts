import type { Sql, TransactionSql } from "postgres";
import type { ValidatedEvent } from "./event-validation.js";
import { appendWorldEvents, type WorldEventRow } from "./world-events.js";
import { projectEconomicWorldEvents } from "./world-economic-projection.js";

/** Resolve the authoritative presentation scene, never a hard-coded fallback. */
export async function resolveProjectionScene(
  client: Sql | TransactionSql,
  event: ValidatedEvent,
): Promise<string | null> {
  const data = event.data[0];
  if (event.event === "job_reward") {
    const reference = typeof data.reference === "string" ? data.reference : "";
    return reference.startsWith("job:") ? resolveJobProjectionScene(client, reference.slice(4)) : null;
  }
  if (
    event.event === "service_paid" ||
    event.event === "business_created" ||
    event.event === "business_transferred" ||
    event.event === "business_withdrawal"
  ) {
    const businessId = String(data.business_id ?? data.id ?? "");
    if (!businessId) return null;
    const [row] = await client<{ scene_id: string }[]>`
      select b.exterior_scene_id as scene_id
      from businesses bu join buildings b on b.business_id = bu.id
      where bu.id = ${Number(businessId)} limit 1
    `;
    return row?.scene_id ?? null;
  }
  if (
    event.event === "property_created" ||
    event.event === "property_listed" ||
    event.event === "property_listing_cancelled" ||
    event.event === "property_transferred"
  ) {
    const [row] = await client<{ scene_id: string }[]>`
      select b.exterior_scene_id as scene_id
      from buildings b where b.property_id = ${Number(data.id ?? 0)} limit 1
    `;
    return row?.scene_id ?? null;
  }
  return null;
}

/** Jobs are presented where their NPC employer currently exists. */
export async function resolveJobProjectionScene(
  client: Sql | TransactionSql,
  jobId: string,
): Promise<string | null> {
  const [row] = await client<{ scene_id: string }[]>`
    select runtime.scene_id
    from jobs job
    join npc_runtime runtime
      on job.employer_wallet = 'npc:' || runtime.npc_id
    join scenes scene on scene.id = runtime.scene_id and scene.active = true
    where job.id = ${jobId}
    limit 1
  `;
  return row?.scene_id ?? null;
}

export type JobPresentationStatus =
  | "open"
  | "accepted"
  | "submitted"
  | "verified"
  | "payment_pending"
  | "payment_unknown"
  | "payment_failed"
  | "paid"
  | "cancelled";

/** Append one server-owned workflow transition in the caller's transaction. */
export async function appendJobPresentation(
  transaction: TransactionSql,
  input: {
    jobId: string;
    status: JobPresentationStatus;
    txHash?: string | null;
    cityTime?: Date;
  },
): Promise<WorldEventRow[]> {
  const sceneId = await resolveJobProjectionScene(transaction, input.jobId);
  if (!sceneId) return [];
  const [latest] = await transaction<{ payload: { status?: string; txHash?: string | null } }[]>`
    select payload from world_events
    where entity_type = 'job' and entity_id = ${input.jobId}
      and event_type = 'job.presentation_changed'
    order by id desc limit 1
  `;
  if (
    latest?.payload?.status === input.status &&
    (latest.payload.txHash ?? null) === (input.txHash ?? null)
  ) {
    return [];
  }
  return appendWorldEvents(transaction, [
    {
      streamId: `scene:${sceneId}`,
      sceneId,
      cityTime: input.cityTime ?? new Date(),
      type: "job.presentation_changed",
      entity: { entityType: "job", entityId: input.jobId },
      payload: { jobId: input.jobId, status: input.status, txHash: input.txHash ?? null },
    },
  ]);
}

export async function appendResolvedEconomicProjection(
  transaction: TransactionSql,
  event: ValidatedEvent,
): Promise<WorldEventRow[]> {
  const sceneId = await resolveProjectionScene(transaction, event);
  return sceneId ? appendEconomicProjection(transaction, event, sceneId) : [];
}

/** Append presentation events in the caller's committing transaction. */
export async function appendEconomicProjection(
  transaction: TransactionSql,
  event: ValidatedEvent,
  sceneId: string,
): Promise<WorldEventRow[]> {
  const drafts = projectEconomicWorldEvents(event, sceneId);
  if (drafts.length === 0) return [];
  return appendWorldEvents(transaction, drafts);
}
