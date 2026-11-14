import { shopMinute } from "./shop-hours.js";
import { randomUUID, createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { worldScenes } from "@quiz-city/world-data";
import type { ValidatedEvent } from "./event-validation.js";
import { problem } from "./city-economy.js";
import { startWorker } from "./worker.js";
import { submitCityPayment } from "./operator.js";
import { viewContract } from "./near.js";
import { verifyExpectedFunctionCall } from "./verify.js";
import { readChainBalance, setMirroredBalance } from "./sync.js";
import { ledgerEntriesFromEvents } from "./record-chain-events.js";
import { insertLedgerEntries } from "./ledger.js";
import { appendResolvedEconomicProjection } from "./world-projection.js";
import { config } from "./runtime-config.js";
export async function reserveNpcShopping(sql: Sql, now: Date) {
  return sql.begin(async (tx) => {
    const [lock] =
      await tx`select pg_try_advisory_xact_lock(hashtextextended(current_schema()||':npc-shopping',0)) as ok`;
    if (!lock.ok) return;
    const minute = shopMinute(now, config.cityTimezone);
    const candidates =
      await tx`select n.*,w.balance::text as balance,coalesce((select sum(payment) from jobs j where j.employer_wallet=w.wallet_id and j.status not in ('paid','cancelled')),0)::text as commitments from npc_runtime n join wallets w on w.wallet_id='npc:'||n.npc_id and w.active=true where n.activity in ('garden_walk','park_break','cafe','cafe_break') and not exists(select 1 from npc_shop_visits v where v.npc_id=n.npc_id and v.day=${now.toISOString().slice(0, 10)}::date) order by n.npc_id limit 6 for update of n skip locked`;
    for (const npc of candidates) {
      const [item] =
        await tx`select i.*,b.property_id,p.x,p.y from business_items i join businesses b on b.id=i.business_id and b.active=true join properties p on p.id=b.property_id left join business_settings s on s.business_id=b.id left join property_condition c on c.property_id=p.id where (c.utilities_paid_until is null or c.utilities_paid_until>${now}) and i.active=true and i.on_hand>i.reserved and i.unit_price<=100 and coalesce(s.accepting_customers,true)=true and ${minute}>=coalesce(s.open_minute,0) and ${minute}<coalesce(s.close_minute,1440) order by i.business_id,i.sku limit 1 for update of i skip locked`;
      if (!item || BigInt(npc.balance) - BigInt(npc.commitments) < BigInt(item.unit_price)) continue;
      const [building] =
        await tx`select interior_scene_id from buildings where business_id=${item.business_id} and status='active'`;
      const scene = worldScenes.find((s) => s.id === (building?.interior_scene_id ?? "city-district"))!;
      const points = scene.spawns
        .filter((p) => p.kind === "npc_waypoint" || (building && p.kind === "player_default"))
        .sort(
          (a, b) => (a.x - item.x) ** 2 + (a.y - item.y) ** 2 - ((b.x - item.x) ** 2 + (b.y - item.y) ** 2),
        );
      if (!points[0]) continue;
      const id = randomUUID(),
        amount = String(item.unit_price),
        wallet = `npc:${npc.npc_id}`,
        tag = createHash("sha256").update(wallet).digest("hex").slice(0, 32);
      await tx`insert into npc_shop_visits(id,npc_id,business_id,item_id,amount,reference,day,destination_scene_id,destination_spawn_id) values (${id},${npc.npc_id},${item.business_id},${item.id},${amount},${`npc-order:${id}:${item.business_id}:${amount}:${tag}`},${now.toISOString().slice(0, 10)},${scene.id},${points[0].id})`;
      await tx`update business_items set reserved=reserved+1 where id=${item.id}`;
    }
  });
}
export async function projectNpcPurchase(tx: TransactionSql, event: ValidatedEvent) {
  if (event.event !== "service_paid" || !String(event.data[0].reference ?? "").startsWith("npc-order:"))
    return;
  const data = event.data[0];
  const [v] = await tx`select * from npc_shop_visits where reference=${String(data.reference)} for update`;
  if (!v) return;
  if (
    data.wallet_from !== `npc:${v.npc_id}` ||
    data.wallet_to !== `biz:${v.business_id}` ||
    data.amount !== v.amount ||
    data.entity_id !== `business:${v.business_id}`
  )
    problem("NPC purchase conflicts with its reserved item.");
  if (["paid", "refunded"].includes(v.status)) {
    if (v.receipt_id !== event.receiptId || v.event_index !== event.eventIndex)
      problem("NPC purchase has a conflicting receipt.");
    return;
  }
  if (v.status === "cancelled") problem("NPC purchase was already cancelled.");
  const [item] =
    await tx`update business_items set on_hand=on_hand-1,reserved=reserved-1 where id=${v.item_id} and reserved>0 and on_hand>0 returning id`;
  if (!item) problem("NPC reserved stock is unavailable.");
  await tx`insert into stock_movements(item_id,quantity,kind,reference,npc_visit_id,actor_account) values (${v.item_id},-1,'sale',${v.reference},${v.id},${`npc:${v.npc_id}`})`;
  await tx`update npc_shop_visits set status='paid',tx_hash=${event.txHash!},receipt_id=${event.receiptId!},event_index=${event.eventIndex!},paid_at=now() where id=${v.id}`;
}
export type NpcShoppingDeps = {
  view: typeof viewContract;
  submit: typeof submitCityPayment;
  verify: typeof verifyExpectedFunctionCall;
  balance: typeof readChainBalance;
};
export async function tickNpcShopping(sql: Sql, now = new Date(), overrides: Partial<NpcShoppingDeps> = {}) {
  const deps = {
    view: viewContract,
    submit: submitCityPayment,
    verify: verifyExpectedFunctionCall,
    balance: readChainBalance,
    ...overrides,
  };
  let enabled: boolean;
  try {
    enabled = await deps.view<boolean>("supports_city_economy");
  } catch {
    return;
  }
  if (!enabled) return;
  await reserveNpcShopping(sql, now);
  const visits = await sql.begin<any[]>(async (tx) => {
    const [lock] =
      await tx`select pg_try_advisory_xact_lock(hashtextextended(current_schema()||':npc-shop-payments',0)) as ok`;
    if (!lock.ok) return [];
    await tx`update npc_shop_visits v set status='queued',queued_at=${now} from npc_runtime n,spawn_points p where v.npc_id=n.npc_id and p.id=v.destination_spawn_id and v.status='walking' and n.scene_id=v.destination_scene_id and n.x=p.x and n.y=p.y`;
    const rows =
      await tx`select * from npc_shop_visits where (status='queued' and queued_at<=${new Date(now.getTime() - 3000)}) or status in ('unknown','submitting') order by created_at limit 3 for update skip locked`;
    for (const row of rows)
      if (row.status === "queued")
        await tx`update npc_shop_visits set status='submitting' where id=${row.id}`;
    return rows;
  });
  for (const visit of visits) {
    const args = {
      npc_wallet: `npc:${visit.npc_id}`,
      business_id: Number(visit.business_id),
      amount: visit.amount,
      reference: visit.reference,
    };
    let hash = visit.tx_hash as string | null;
    if (!hash && visit.status === "queued") {
      const submitted = await deps.submit("npc_purchase", args);
      if (submitted.kind === "rejected") {
        await sql.begin(async (tx) => {
          const [v] = await tx`select * from npc_shop_visits where id=${visit.id} for update`;
          if (v.status === "paid") return;
          await tx`update business_items set reserved=reserved-1 where id=${v.item_id}`;
          await tx`update npc_shop_visits set status='cancelled' where id=${v.id}`;
        });
        continue;
      }
      hash = submitted.txHash ?? null;
      await sql`update npc_shop_visits set status='unknown',tx_hash=${hash} where id=${visit.id} and status<>'paid'`;
    }
    if (!hash) {
      const [event] =
        await sql`select tx_hash from transactions where reference=${visit.reference} and event_name='service_paid' order by seq limit 1`;
      hash = event?.tx_hash ?? null;
    }
    if (!hash) continue; // Unknown without a hash is never submitted again.
    try {
      const result = await deps.verify(hash, {
        signerId: config.operatorAccount,
        method: "npc_purchase",
        args,
        events: [
          {
            name: "service_paid",
            entityId: `business:${visit.business_id}`,
            walletFrom: args.npc_wallet,
            walletTo: `biz:${visit.business_id}`,
            amount: visit.amount,
            reference: visit.reference,
          },
        ],
      });
      const [balance, treasury, business] = await Promise.all([
        deps.balance(args.npc_wallet),
        deps.balance(`biz:${visit.business_id}`),
        deps.view<{ revenue_total: string }>("get_business", { business_id: Number(visit.business_id) }),
      ]);
      await sql.begin(async (tx) => {
        await insertLedgerEntries(tx, ledgerEntriesFromEvents(result.events));
        for (const event of result.events) {
          await projectNpcPurchase(tx, event);
          await appendResolvedEconomicProjection(tx, event);
        }
        await setMirroredBalance(tx, args.npc_wallet, balance);
        await setMirroredBalance(tx, `biz:${visit.business_id}`, treasury);
        await tx`update businesses set revenue_total=${business.revenue_total} where id=${visit.business_id}`;
      });
    } catch {
      await sql`update npc_shop_visits set status='unknown' where id=${visit.id} and status<>'paid'`;
    }
  }
}
export function startNpcShopping(sql: Sql, onError: (error: unknown) => void) {
  return startWorker({ intervalMs: 5000, run: () => tickNpcShopping(sql), onError });
}
