import type { Sql } from "postgres";
import type { FastifyInstance } from "fastify";
import { CityHealth } from "@quiz-city/protocol";
import { ErrorResponses } from "./schemas/index.js";
import { requireAuth, requireRole } from "./auth/plugin.js";
import { viewContract } from "./near.js";
export async function cityHealth(
  sql: Sql,
  stats: {
    total_issued: string;
    total_burned: string;
    players?: number;
    properties?: number;
    businesses?: number;
    tx_count?: number;
    paused?: boolean;
  },
  diagnostics = false,
) {
  const issued = BigInt(stats.total_issued),
    burned = BigInt(stats.total_burned);
  const [walletGroups, jobs, businesses, inventory, rewardPools, budgets, wealthRows, mirrorRows] =
    await Promise.all([
      sql`select case when wallet_id like 'gov:escrow.%' then 'escrow' else split_part(wallet_id,':',1) end as kind,count(*)::int as count,sum(balance)::text as balance from wallets where active=true group by 1 order by 1`,
      sql`select case when deadline<now() and status in ('open','accepted','submitted') then 'expired' else status end as status,count(*)::int as count,sum(payment)::text as value from jobs group by 1 order by 1`,
      sql`select b.id,b.name,b.owner_account,b.revenue_total::text as gross_revenue,coalesce(w.balance,0)::text as treasury,coalesce((select sum(t.amount) from transactions t where t.wallet_from=b.treasury_wallet and t.event_name in ('charge_paid','escrow_funded','order_refunded','admission_refunded')),0)::text as expenses,(select count(*)::int from transactions t where t.wallet_to=b.treasury_wallet and t.event_name='service_paid') as customers,(select count(*)::int from business_staff s where s.business_id=b.id and s.ended_at is null) as employees,b.active from businesses b left join wallets w on w.wallet_id=b.treasury_wallet order by b.id limit 100`,
      sql`select i.id,i.business_id,i.name,i.on_hand,i.reserved,i.unit_price::text as price,i.low_stock,coalesce((select -sum(quantity) from stock_movements m where m.item_id=i.id and m.kind='sale'),0)::text as units_sold,coalesce((select -sum(quantity) from stock_movements m where m.item_id=i.id and m.kind='sale' and m.created_at>=now()-interval '1 day'),0)::text as units_sold_day,(select old_price::text from item_price_history h where h.item_id=i.id order by h.id desc limit 1) as previous_price from business_items i order by i.business_id,i.sku limit 100`,
      sql`select id,title,reward_pool::text as funded,reward_reserved::text as reserved,reward_paid::text as paid,(reward_pool-reward_reserved-reward_paid)::text as available from quizzes order by id limit 100`,
      sql`select * from council_budgets order by category`,
      sql`with ranked as (select balance,row_number() over(order by balance,wallet_id)::numeric as rank from wallets where active=true and wallet_id like 'player:%') select count(*)::int as residents,case when count(*)=0 or sum(balance)=0 then '0' else ((2*sum(rank*balance))/(count(*)*sum(balance))-(count(*)+1)::numeric/count(*))::text end as gini from ranked`,
      sql`select coalesce(sum(balance),0)::text as balance from wallets where active=true`,
    ]);
  const mirrored = mirrorRows[0].balance,
    difference = (issued - burned - BigInt(mirrored)).toString();
  const alerts: { code: string; entity: string; message: string }[] = [];
  if (issued > 1000000000n)
    alerts.push({
      code: "INFLATION_CAP",
      entity: "economy",
      message: "Issued QC exceeds the contract policy cap.",
    });
  const invalid = await sql`select wallet_id from wallets where balance<0 limit 100`;
  for (const wallet of invalid)
    alerts.push({
      code: "INVALID_BALANCE",
      entity: wallet.wallet_id,
      message: "A wallet balance is invalid.",
    });
  if (difference !== "0")
    alerts.push({
      code: "SUPPLY_DRIFT",
      entity: "economy",
      message: "Confirmed supply and the wallet mirror differ.",
    });
  for (const p of rewardPools)
    if (BigInt(p.available) < 1n)
      alerts.push({ code: "PRIZE_POOL_EMPTY", entity: p.id, message: "This prize pool is exhausted." });
  for (const i of inventory)
    if (i.on_hand - i.reserved <= i.low_stock)
      alerts.push({
        code: "LOW_STOCK",
        entity: i.id,
        message: "Confirmed stock is low; a supplier order is available.",
      });
  const obligations =
    await sql`select j.employer_wallet,sum(j.payment)::text as committed,coalesce(w.balance,0)::text as balance from jobs j left join wallets w on w.wallet_id=j.employer_wallet where j.status not in ('paid','cancelled') group by j.employer_wallet,w.balance`;
  for (const o of obligations)
    if (BigInt(o.balance) < BigInt(o.committed))
      alerts.push({
        code: "EMPLOYER_BUDGET_LOW",
        entity: o.employer_wallet,
        message: "Unfinished job commitments exceed the mirrored employer budget.",
      });
  const [failures] =
    await sql`select count(*)::int as n from chain_event_failures where resolved_at is null and ignored_at is null`;
  if (failures.n)
    alerts.push({
      code: "RECONCILIATION_FAILURES",
      entity: "chain",
      message: "Unresolved chain events need operator review.",
    });
  const [propertyUse] =
    await sql`select (select count(*)::int from properties where active) as plots,(select count(*)::int from properties p where p.active and (exists(select 1 from businesses b where b.property_id=p.id and b.active) or exists(select 1 from property_leases l where l.property_id=p.id and l.status='active' and l.grace_ends_at>now()))) as occupied,(select count(*)::int from businesses where active) as active_businesses,(select count(*)::int from businesses where not active) as archived_businesses`;
  const result: any = {
    propertyUse,
    contractStats: {
      players: stats.players,
      properties: stats.properties,
      businesses: stats.businesses,
      tx_count: stats.tx_count,
      paused: stats.paused,
    },
    supply: {
      issued: issued.toString(),
      burned: burned.toString(),
      circulating: (issued - burned).toString(),
      mirrored,
      difference,
    },
    walletGroups: [...walletGroups],
    jobs: [...jobs],
    businesses: [...businesses],
    inventory: [...inventory],
    rewardPools: [...rewardPools],
    budgets: [...budgets],
    wealth: wealthRows[0],
    alerts,
  };
  if (diagnostics)
    result.diagnostics = {
      properties: [
        ...(await sql`select id,owner_wallet,price::text,for_sale,active from properties order by id limit 200`),
      ],
      failures: [
        ...(await sql`select id,error_code,receipt_id,event_index,attempt_count from chain_event_failures where resolved_at is null order by id limit 100`),
      ],
      schedules: [
        ...(await sql`select s.npc_id,s.activity,s.start_minute,s.end_minute,s.destination_scene_id,r.scene_id,r.x,r.y from npc_schedules s left join npc_runtime r on r.npc_id=s.npc_id order by s.npc_id,s.sequence limit 200`),
      ],
      events: [
        ...(await sql`select event_name,amount::text,wallet_from,wallet_to,reference,tx_hash,receipt_id,event_index from transactions order by seq desc limit 100`),
      ],
      wallets: [
        ...(await sql`select wallet_id,balance::text as balance from wallets where active=true order by wallet_id limit 200`),
      ],
    };
  return result;
}
export function registerCityHealth(
  app: FastifyInstance,
  sql: Sql,
  readStats = () => viewContract<{ total_issued: string; total_burned: string }>("get_stats"),
) {
  app.get("/city/health", { schema: { response: { 200: CityHealth, ...ErrorResponses } } }, async (req) => {
    requireAuth(req);
    const stats = await readStats();
    return cityHealth(sql, stats);
  });
  app.get(
    "/city/diagnostics",
    { schema: { response: { 200: CityHealth, ...ErrorResponses } } },
    async (req) => {
      requireRole(req, ["operator", "admin"]);
      const stats = await readStats();
      return cityHealth(sql, stats, true);
    },
  );
}
