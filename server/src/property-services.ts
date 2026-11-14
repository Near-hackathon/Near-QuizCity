import type { Sql, TransactionSql } from "postgres";
import { appendWorldEvents } from "./world-events.js";
export async function presentPropertyServices(tx: TransactionSql, id: string, now = new Date()) {
  const [p] =
    await tx`select p.id,p.for_sale,p.price::text,c.condition,c.utilities_paid_until>${now} as utilities_active,coalesce(b.exterior_scene_id,case when p.district='knowledge' then 'city-district' end) as scene_id from properties p join property_condition c on c.property_id=p.id left join buildings b on b.property_id=p.id where p.id=${id} and exists(select 1 from scenes where id=coalesce(b.exterior_scene_id,case when p.district='knowledge' then 'city-district' end) and active=true)`;
  if (!p) return;
  await appendWorldEvents(tx, [
    {
      streamId: `scene:${p.scene_id}`,
      sceneId: p.scene_id,
      cityTime: now,
      type: "property.presentation_changed",
      entity: { entityType: "property", entityId: id },
      payload: {
        propertyId: id,
        forSale: p.for_sale,
        price: p.price,
        condition: p.condition,
        utilitiesActive: p.utilities_active,
      },
    },
  ]);
}
/** No title, treasury or business is removed when services lapse. */
export async function refreshPropertyServices(sql: Sql, now = new Date()) {
  await sql.begin(async (tx) => {
    await tx`insert into property_condition(property_id) select id from properties where active on conflict(property_id) do nothing`;
    const changes =
      await tx`update property_condition set utilities_active=utilities_paid_until>${now},condition=greatest(0,100-floor(greatest(0,extract(epoch from (${now}::timestamptz-last_maintained_at)))/604800)::int*5) where utilities_active<>(utilities_paid_until>${now}) or condition<>greatest(0,100-floor(greatest(0,extract(epoch from (${now}::timestamptz-last_maintained_at)))/604800)::int*5) returning property_id`;
    for (const p of changes) await presentPropertyServices(tx, String(p.property_id), now);
  });
}
