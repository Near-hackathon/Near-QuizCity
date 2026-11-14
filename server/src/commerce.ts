import { appendBusinessPresentation } from "./world-projection.js";
import { shopMinute } from "./shop-hours.js";
import { config } from "./runtime-config.js";
import { createHash, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { AppError } from "./errors.js";
import { parseQc } from "./amount.js";
import type { ValidatedEvent } from "./event-validation.js";
export type CommerceOrder = Record<string, unknown> & {
  id: string;
  buyer_account: string;
  business_id: string;
  item_id: string;
  item_name: string;
  quantity: number;
  unit_price: string;
  total: string;
  reference: string;
  status: string;
  tx_hash: string | null;
  receipt_id: string | null;
  event_index: number | null;
};
export async function requireBusinessOwner(tx: Sql | TransactionSql, businessId: string, actor: string) {
  const [business] = await tx`select * from businesses where id=${businessId} and active=true for update`;
  if (!business) throw new AppError("NOT_FOUND", "This business is not available.", 404);
  if (business.owner_account !== actor)
    throw new AppError("FORBIDDEN", "Only the business owner can do that.", 403);
  return business;
}
export async function createShopItem(
  sql: Sql,
  businessId: string,
  actor: string,
  input: { sku: string; name: string; unitPrice: string; quantity: number; lowStock?: number },
  openingLimit?: number,
) {
  if (!input.name.trim()) throw new AppError("VALIDATION_ERROR", "Give the item a name.", 400);
  const price = parseQc(input.unitPrice);
  if (price < 1n || price > 10000n)
    throw new AppError("INVALID_AMOUNT", "Item prices must be between 1 and 10,000 QC.", 400);
  return sql.begin(async (tx) => {
    await requireBusinessOwner(tx, businessId, actor);
    if (openingLimit !== undefined) {
      const [prior] =
        await tx`select coalesce(sum(m.quantity),0)::int as n from stock_movements m join business_items i on i.id=m.item_id where i.business_id=${businessId} and m.kind='opening'`;
      if (prior.n + input.quantity > openingLimit)
        throw new AppError(
          "CONFLICT",
          `A business receives ${openingLimit} starter units in total. Use Supplies to purchase further stock.`,
          409,
        );
    }
    const [count] = await tx`select count(*)::int as n from business_items where business_id=${businessId}`;
    if (count.n >= 100) throw new AppError("CONFLICT", "A shop can list up to 100 items.", 409);
    const [duplicate] =
      await tx`select id from business_items where business_id=${businessId} and sku=${input.sku}`;
    if (duplicate) throw new AppError("CONFLICT", "That stock code is already used by this shop.", 409);
    const id = randomUUID();
    const [item] =
      await tx`insert into business_items(id,business_id,sku,name,unit_price,on_hand,low_stock) values (${id},${businessId},${input.sku},${input.name.trim()},${input.unitPrice},${input.quantity},${input.lowStock ?? 5}) returning *`;
    if (input.quantity > 0)
      await tx`insert into stock_movements(item_id,quantity,kind,reference,actor_account) values (${id},${input.quantity},'opening','opening',${actor})`;
    await appendBusinessPresentation(tx, businessId);
    return item;
  });
}
export async function deliverStock(
  sql: Sql,
  itemId: string,
  actor: string,
  quantity: number,
  reference: string,
) {
  return sql.begin(async (tx) => {
    const [item] = await tx`select * from business_items where id=${itemId} for update`;
    if (!item) throw new AppError("NOT_FOUND", "Item not found.", 404);
    await requireBusinessOwner(tx, String(item.business_id), actor);
    const [prior] =
      await tx`select quantity from stock_movements where item_id=${itemId} and reference=${reference}`;
    if (prior) {
      if (prior.quantity !== quantity)
        throw new AppError("CONFLICT", "That delivery reference has different quantities.", 409);
      return item;
    }
    const [incoming] =
      await tx`select coalesce(sum(s.quantity),0)::int as n from supplier_orders s join city_operations o on o.id=s.operation_id where s.item_id=${itemId} and o.status in ('awaiting','unknown')`;
    if (item.on_hand + incoming.n + quantity > 1000000)
      throw new AppError("CONFLICT", "This delivery exceeds the stock limit.", 409);
    const [updated] =
      await tx`update business_items set on_hand=on_hand+${quantity} where id=${itemId} returning *`;
    await tx`insert into stock_movements(item_id,quantity,kind,reference,actor_account) values (${itemId},${quantity},'delivery',${reference},${actor})`;
    await appendBusinessPresentation(tx, String(item.business_id));
    return updated;
  });
}
export async function reserveShopOrder(
  sql: Sql,
  buyer: string,
  itemId: string,
  quantity: number,
  now = new Date(),
): Promise<CommerceOrder> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':order-buyer:' || ${buyer},0))`;
    const [item] =
      await tx`select i.*,b.owner_account,b.active as business_active from business_items i join businesses b on b.id=i.business_id where i.id=${itemId} for update of i`;
    if (!item?.active || !item.business_active)
      throw new AppError("NOT_FOUND", "This item is no longer available.", 404);
    const [services] =
      await tx`select c.utilities_paid_until from property_condition c join businesses b on b.property_id=c.property_id where b.id=${item.business_id}`;
    if (services && services.utilities_paid_until <= now)
      throw new AppError("CONFLICT", "Property utilities need renewal before new orders can be placed.", 409);
    const [hours] = await tx`select * from business_settings where business_id=${item.business_id}`;
    const minute = shopMinute(now, config.cityTimezone);
    if (hours && (!hours.accepting_customers || minute < hours.open_minute || minute >= hours.close_minute))
      throw new AppError("CONFLICT", "This shop is closed. Check its advertised opening hours.", 409);
    if (item.owner_account === buyer)
      throw new AppError("FORBIDDEN", "Buy from another resident's business.", 403);
    const [existing] = await tx<
      CommerceOrder[]
    >`select * from business_orders where buyer_account=${buyer} and item_id=${itemId} and status in ('reserved','confirming') order by created_at limit 1`;
    if (existing) {
      if (existing.quantity !== quantity)
        throw new AppError("CONFLICT", "Finish your existing order before changing its quantity.", 409);
      return existing;
    }
    const [pending] =
      await tx`select count(*)::int as n from business_orders where buyer_account=${buyer} and status in ('reserved','confirming')`;
    if (pending.n >= 10)
      throw new AppError("CONFLICT", "Finish a saved order before reserving more items.", 409);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000)
      throw new AppError("VALIDATION_ERROR", "Choose between 1 and 1,000 units.", 400);
    if (item.on_hand - item.reserved < quantity)
      throw new AppError("CONFLICT", "There is not enough stock for that order.", 409);
    const total = BigInt(item.unit_price) * BigInt(quantity);
    if (total > 10000n) throw new AppError("INVALID_AMOUNT", "One order may not exceed 10,000 QC.", 400);
    const id = randomUUID();
    const [order] = await tx<
      CommerceOrder[]
    >`insert into business_orders(id,buyer_account,business_id,item_id,item_name,quantity,unit_price,total,buyer_tag,reference) values (${id},${buyer},${item.business_id},${itemId},${item.name},${quantity},${String(item.unit_price)},${total.toString()},${createHash("sha256").update(buyer).digest("hex").slice(0, 32)},${`order:${id}:${item.business_id}:${total}:${createHash("sha256").update(buyer).digest("hex").slice(0, 32)}`}) returning *`;
    await tx`update business_items set reserved=reserved+${quantity} where id=${itemId}`;
    return order;
  });
}
/** Also used by the ingester, so an HTTP disconnect cannot strand confirmed inventory. */
export async function projectConfirmedOrder(tx: TransactionSql, event: ValidatedEvent) {
  const data = event.data[0],
    reference = data.reference;
  if (event.event !== "service_paid" || typeof reference !== "string" || !reference.startsWith("order:"))
    return;
  const [order] = await tx<
    CommerceOrder[]
  >`select * from business_orders where reference=${reference} for update`;
  if (!order) return;
  if (
    data.wallet_from !== `player:${order.buyer_account}` ||
    data.amount !== order.total ||
    data.entity_id !== `business:${order.business_id}`
  )
    throw new AppError("CONFLICT", "Order payment does not match its reserved items.", 409);
  const [business] = await tx`select treasury_wallet from businesses where id=${order.business_id}`;
  if (!business || data.wallet_to !== business.treasury_wallet)
    throw new AppError("CONFLICT", "Order payment has a different recipient.", 409);
  if (["paid", "refunded"].includes(order.status)) {
    if (
      order.tx_hash !== event.txHash ||
      order.receipt_id !== event.receiptId ||
      order.event_index !== event.eventIndex
    )
      throw new AppError("CONFLICT", "Order already has a different confirmed payment.", 409);
    return;
  }

  const [item] =
    await tx`update business_items set on_hand=on_hand-${order.quantity},reserved=reserved-${order.quantity} where id=${order.item_id} and on_hand>=${order.quantity} and reserved>=${order.quantity} returning id`;
  if (!item) throw new AppError("CONFLICT", "Reserved stock does not match this order.", 409);
  await tx`insert into stock_movements(item_id,quantity,kind,reference,order_id,actor_account) values (${order.item_id},${-order.quantity},'sale',${reference},${order.id},${order.buyer_account})`;
  await tx`update business_orders set status='paid',tx_hash=${event.txHash!},receipt_id=${event.receiptId!},event_index=${event.eventIndex!},paid_at=now() where id=${order.id}`;
}

/** Business status is a server-owned schedule; a price quote remains payable after closing. */
export async function refreshShopHours(sql: Sql, now = new Date(), timezone = config.cityTimezone) {
  const minute = shopMinute(now, timezone);
  await sql.begin(async (tx) => {
    const rows =
      await tx`update businesses b set status=case when s.accepting_customers and ${minute}>=s.open_minute and ${minute}<s.close_minute then 'open' else 'closed' end from business_settings s where s.business_id=b.id and b.active and b.status<>'suspended' and b.status<>case when s.accepting_customers and ${minute}>=s.open_minute and ${minute}<s.close_minute then 'open' else 'closed' end returning b.id`;
    for (const row of rows) await appendBusinessPresentation(tx, String(row.id), now);
  });
}
