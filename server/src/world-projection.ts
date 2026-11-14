import { isDeepStrictEqual } from "node:util";
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
    event.event === "business_withdrawal" ||
    event.event === "business_sold" ||
    event.event === "order_refunded" ||
    event.event === "admission_refunded"
  ) {
    const businessId = String(data.business_id ?? data.id ?? "");
    if (!businessId) return null;
    const [row] = await client<{ scene_id: string }[]>`
      select coalesce(b.exterior_scene_id,case when p.district='knowledge' then 'city-district' end) as scene_id
      from businesses bu left join buildings b on b.business_id = bu.id join properties p on p.id=bu.property_id
      where bu.id = ${Number(businessId)} and exists(select 1 from scenes where id=coalesce(b.exterior_scene_id,case when p.district='knowledge' then 'city-district' end) and active=true) limit 1
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
      select coalesce(b.exterior_scene_id,case when p.district='knowledge' then 'city-district' end) as scene_id
      from properties p left join buildings b on b.property_id=p.id where p.id = ${Number(data.id ?? 0)} and exists(select 1 from scenes where id=coalesce(b.exterior_scene_id,case when p.district='knowledge' then 'city-district' end) and active=true) limit 1
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
  const [employer] = await transaction<
    { employer_wallet: string; has_open: boolean }[]
  >`select j.employer_wallet,exists(select 1 from jobs other where other.employer_wallet=j.employer_wallet and other.status='open') as has_open from jobs j where j.id=${input.jobId}`;
  const npc = employer?.employer_wallet.startsWith("npc:")
    ? { npcId: employer.employer_wallet.slice(4), hasOpenJobs: employer.has_open }
    : {};
  return appendWorldEvents(transaction, [
    {
      streamId: `scene:${sceneId}`,
      sceneId,
      cityTime: input.cityTime ?? new Date(),
      type: "job.presentation_changed",
      entity: { entityType: "job", entityId: input.jobId },
      payload: { jobId: input.jobId, status: input.status, txHash: input.txHash ?? null, ...npc },
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
  const rows = await appendWorldEvents(transaction, drafts);
  const businessId = String(
    event.data[0].business_id ??
      (String(event.data[0].entity_id ?? "").startsWith("business:")
        ? String(event.data[0].entity_id).slice(9)
        : ""),
  );
  if (/^[1-9][0-9]*$/.test(businessId))
    rows.push(
      ...(await appendBusinessPresentation(transaction, businessId, event.chainTimestamp ?? new Date())),
    );
  return rows;
}

export async function appendBusinessPresentation(
  tx: TransactionSql,
  businessId: string,
  now: Date | string = new Date(),
) {
  const [shop] =
    await tx`select b.id,b.name,b.property_id,b.status,b.revenue_total::text as revenue_total,coalesce((select sum(i.on_hand-i.reserved) from business_items i where i.business_id=b.id and i.active),0)::int as stock,coalesce(building.exterior_scene_id,case when p.district='knowledge' then 'city-district' end) as scene_id from businesses b join properties p on p.id=b.property_id left join buildings building on building.business_id=b.id where b.id=${businessId} and exists(select 1 from scenes where id=coalesce(building.exterior_scene_id,case when p.district='knowledge' then 'city-district' end) and active=true)`;
  if (!shop) return [];
  const payload = {
    businessId,
    name: shop.name,
    propertyId: String(shop.property_id),
    revenueTotal: shop.revenue_total,
    status: shop.status,
    stockAvailable: shop.stock,
  };
  const [latest] =
    await tx`select payload from world_events where entity_type='business' and entity_id=${businessId} and event_type='business.state_changed' order by id desc limit 1`;
  if (latest && isDeepStrictEqual(latest.payload, payload)) return [];
  return appendWorldEvents(tx, [
    {
      streamId: `scene:${shop.scene_id}`,
      sceneId: shop.scene_id,
      cityTime: now,
      type: "business.state_changed",
      entity: { entityType: "business", entityId: businessId },
      payload,
    },
  ]);
}
