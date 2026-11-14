import { isNearLearningSource } from "./near-curriculum.js";
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { Type, type Static } from "@sinclair/typebox";
import {
  CityId,
  CityUuid,
  CityAssetId,
  CityOk,
  CityCommand,
  CityOperationResponse,
  CityProof,
  CityRow,
  CityOverview,
  BusinessHoursBody,
  RentOfferBody,
  ReviewWorkBody,
  QuizDraftBody,
  QuizReviewBody,
  QuizReportBody,
  BudgetBody,
  MarketProofBody,
  type QuizDraftInput,
} from "@quiz-city/protocol";
import { ErrorResponses } from "./schemas/index.js";
import { requireAuth, requireRole } from "./auth/plugin.js";
import { config } from "./runtime-config.js";
import { viewContract } from "./near.js";
import { verifyExpectedFunctionCall, type ExpectedCall } from "./verify.js";
import { readChainBalance, setMirroredBalance } from "./sync.js";
import { insertLedgerEntries } from "./ledger.js";
import { ledgerEntriesFromEvents } from "./record-chain-events.js";
import { consumeTransaction } from "./transaction-context.js";
import { appendResolvedEconomicProjection } from "./world-projection.js";
import { recordOwnershipHistory } from "./chain-ingester.js";
import { submitCityPayment } from "./operator.js";
import { randomUUID } from "node:crypto";
import { prepareCityCommand, projectCityOperation, problem, type Operation } from "./city-economy.js";
import { requireBusinessOwner, refreshShopHours } from "./commerce.js";
export type CityDeps = {
  view: typeof viewContract;
  verify: typeof verifyExpectedFunctionCall;
  balance: typeof readChainBalance;
  now: () => Date;
  submit: typeof submitCityPayment;
};
const defaults: CityDeps = {
  view: viewContract,
  verify: verifyExpectedFunctionCall,
  balance: readChainBalance,
  now: () => new Date(),
  submit: submitCityPayment,
};
export async function confirmCityOperation(
  sql: Sql,
  actor: string,
  id: string,
  hash: string,
  overrides: Partial<CityDeps> = {},
) {
  const deps = { ...defaults, ...overrides };
  const [op] = await sql<
    Operation[]
  >`select * from city_operations where id=${id} and actor_account=${actor}`;
  if (!op) problem("Saved command not found.", 404);
  await sql`update city_operations set tx_hash=${hash},status='unknown',next_check_at=coalesce(next_check_at,now()+interval '30 seconds') where id=${id} and status in ('awaiting','unknown')`;
  const proof = await deps.verify(hash, {
    signerId: op.payload.signerAccount ?? actor,
    method: op.method,
    args: op.args,
    events: op.expected_events,
  } as ExpectedCall);
  const wallets = [
    ...new Set(
      proof.events
        .flatMap((e) => [e.data[0].wallet_from, e.data[0].wallet_to])
        .filter((v): v is string => typeof v === "string"),
    ),
  ];
  const balances = await Promise.all(wallets.map(async (w) => [w, await deps.balance(w)] as const));
  const revenues = await Promise.all(
    proof.events
      .filter((e) => e.event === "service_paid")
      .map(async (event) => {
        const id = Number(event.data[0].business_id);
        const business = await deps.view<{ revenue_total: string }>("get_business", { business_id: id });
        return { id, revenue: business.revenue_total };
      }),
  );
  await sql.begin(async (tx) => {
    const event = proof.events.find((e) => e.data[0].reference === op.expected_events[0].reference)!;
    if (!event) problem("The payment does not prove this saved command.");
    await consumeTransaction(tx, {
      txHash: hash,
      commandType: "city_operation",
      entityType: "operation",
      entityId: id,
      signerId: op.payload.signerAccount ?? actor,
      receiptId: event.receiptId!,
      eventIndex: event.eventIndex!,
    });
    await insertLedgerEntries(tx, ledgerEntriesFromEvents(proof.events));
    for (const event of proof.events) {
      await projectCityOperation(tx, event);
      await appendResolvedEconomicProjection(tx, event);
    }
    for (const [wallet, balance] of balances) await setMirroredBalance(tx, wallet, balance);
    for (const business of revenues)
      await tx`update businesses set revenue_total=${business.revenue} where id=${business.id}`;
  });
  const [operation] = await sql<Operation[]>`select * from city_operations where id=${id}`;
  return { operation };
}
export function registerCityEconomyRoutes(app: FastifyInstance, sql: Sql, overrides: Partial<CityDeps> = {}) {
  const deps = { ...defaults, ...overrides };
  const response = { 200: CityOk, ...ErrorResponses };
  const actor = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req).accountId;
  async function chainOwner(id: string, account: string) {
    let b: { owner: string } | null;
    try {
      b = await deps.view<{ owner: string } | null>("get_business", { business_id: Number(id) });
    } catch {
      return problem("Current business ownership could not be checked. Try again.", 503);
    }
    if (b?.owner !== account) problem("Only the current business owner may do that.", 403);
  }
  app.get(
    "/city/overview",
    { schema: { response: { 200: CityOverview, ...ErrorResponses } } },
    async (req) => {
      const account = actor(req);
      const [
        operations,
        suppliers,
        jobs,
        leases,
        rentOffers,
        drafts,
        staff,
        shops,
        market,
        items,
        businessSales,
        purchases,
        sales,
        admissions,
      ] = await Promise.all([
        sql`select * from city_operations where actor_account=${account} order by (status in ('awaiting','unknown')) desc,created_at desc,id limit 100`,
        sql`select * from supplier_offers where active=true order by id limit 100`,
        sql`select f.*,j.status,j.employee_account,j.deliverable from funded_jobs f left join jobs j on j.id=f.job_id where f.creator_account=${account} or j.employee_account=${account} order by f.created_at desc limit 100`,
        sql`select * from property_leases where tenant_account=${account} or landlord_wallet=${`player:${account}`} order by starts_at desc nulls first limit 100`,
        sql`select r.*,p.x,p.y from property_rent_offers r join properties p on p.id=r.property_id where r.active=true and r.owner_wallet=p.owner_wallet order by r.property_id limit 100`,
        sql`select * from quiz_drafts where author_account=${account} order by created_at desc limit 100`,
        sql`select s.* from business_staff s join businesses b on b.id=s.business_id where b.owner_account=${account} or s.account_id=${account} order by s.started_at desc limit 100`,
        sql`select b.id,b.name,b.owner_account,s.open_minute,s.close_minute,s.accepting_customers from businesses b left join business_settings s on s.business_id=b.id where b.active=true order by b.id limit 100`,
        sql`select p.*,c.condition,c.utilities_paid_until from properties p left join property_condition c on c.property_id=p.id where p.active=true and (p.for_sale or p.owner_wallet=${`player:${account}`}) order by p.id limit 100`,
        sql`select i.* from business_items i join businesses b on b.id=i.business_id where b.owner_account=${account} order by i.business_id,i.sku limit 100`,
        sql`select l.*,b.name,b.owner_account from market_listings l join businesses b on b.id=case when l.asset_type='business' and l.asset_id ~ '^[0-9]+$' then l.asset_id::bigint else null end where l.asset_type='business' and l.status='active' and b.active=true order by l.id limit 100`,
        sql`select id,item_name,quantity,total::text as total,status from business_orders where buyer_account=${account} order by created_at desc limit 100`,
        sql`select * from (select o.id,o.item_name,o.quantity,o.total::text as total,o.status,'player:'||o.buyer_account as customer_wallet,o.created_at from business_orders o join businesses b on b.id=o.business_id where b.owner_account=${account} union all select v.id,i.name,1,v.amount::text,v.status,'npc:'||v.npc_id,v.created_at from npc_shop_visits v join business_items i on i.id=v.item_id join businesses b on b.id=v.business_id where b.owner_account=${account}) sales order by created_at desc limit 100`,
        sql`select a.*,q.title,b.owner_account,o.args->>'amount' as total from quiz_admissions a join quizzes q on q.id=a.quiz_id join businesses b on b.id=q.venue_business_id join city_operations o on o.id=a.operation_id where a.player_account=${account} or b.owner_account=${account} order by o.created_at desc limit 100`,
      ]);
      let policy = { available: false, dailyCap: "0", issuedToday: "0" };
      try {
        const p = await deps.view<{ daily_cap: string; issued_today: string }>("get_reward_policy");
        policy = { available: true, dailyCap: p.daily_cap, issuedToday: p.issued_today };
      } catch {
        /* Old artifacts remain read-only for the new economy. */
      }
      return {
        operations: [...operations],
        items: [...items],
        businessSales: [...businessSales],
        purchases: [...purchases],
        sales: [...sales],
        admissions: [...admissions],
        suppliers: [...suppliers],
        jobs: [...jobs],
        leases: [...leases],
        rentOffers: [...rentOffers],
        drafts: [...drafts],
        staff: [...staff],
        shops: [...shops],
        market: [...market],
        policy,
      };
    },
  );
  app.post<{ Body: Static<typeof CityCommand> }>(
    "/city/commands",
    { schema: { body: CityCommand, response: { 200: CityOperationResponse, ...ErrorResponses } } },
    async (req) => {
      if (["budget", "public-job"].includes(req.body.action)) requireRole(req, ["operator", "admin"]);
      let available = false;
      try {
        available = await deps.view<boolean>("supports_city_economy");
      } catch {
        /* Capability gate. */
      }
      if (!available) problem("The city economy upgrade is awaiting its reviewed deployment.", 503);
      const input = req.body,
        account = actor(req);
      let businessId: string | undefined;
      if (["job", "tax"].includes(input.action)) businessId = input.targetId;
      if (
        ["supplier", "quiz-fund"].includes(input.action) &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.targetId)
      )
        problem("Invalid command target.", 400);
      if (input.action === "supplier")
        businessId = (await sql`select business_id from business_items where id=${input.targetId}`)[0]
          ?.business_id;
      if (input.action === "quiz-fund")
        businessId = (await sql`select business_id from quiz_drafts where id=${input.targetId}`)[0]
          ?.business_id;
      if (businessId) await chainOwner(String(businessId), account);
      return { operation: await prepareCityCommand(sql, account, input, deps.now()) };
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof CityProof> }>(
    "/city/operations/:id/confirm",
    {
      schema: {
        params: CityUuid,
        body: CityProof,
        response: { 200: CityOperationResponse, ...ErrorResponses },
      },
    },
    (req) => confirmCityOperation(sql, actor(req), req.params.id, req.body.txHash, deps),
  );
  app.post<{ Params: { id: string } }>(
    "/city/operations/:id/execute",
    {
      schema: {
        params: CityUuid,
        body: Type.Object({}, { additionalProperties: false }),
        response: { 200: CityOperationResponse, ...ErrorResponses },
      },
    },
    async (req) => {
      const account = requireRole(req, ["operator", "admin"]).accountId;
      const [op] = await sql<
        Operation[]
      >`select * from city_operations where id=${req.params.id} and actor_account=${account}`;
      if (
        !op ||
        op.payload.matchRoomId ||
        op.kind !== "settlement" ||
        op.method !== "settle_escrow" ||
        op.payload.signerAccount !== config.operatorAccount
      )
        problem("This is not an approved settlement.", 403);
      const [claimed] =
        await sql`update city_operations set status='unknown',next_check_at=now()+interval '30 seconds' where id=${op.id} and status='awaiting' returning id`;
      if (!claimed) return { operation: op };
      const result = await deps.submit("settle_escrow", op.args);
      if (result.kind === "rejected") {
        await sql`update city_operations set status='awaiting',error_code='TX_FAILED' where id=${op.id} and status='unknown'`;
        problem("The settlement was rejected without payment. Review the escrow before retrying.");
      }
      if (result.txHash) {
        await sql`update city_operations set tx_hash=${result.txHash} where id=${op.id} and status='unknown'`;
        try {
          return await confirmCityOperation(sql, account, op.id, result.txHash, deps);
        } catch {
          /* Persist the exact proof for independent reconciliation. */
        }
      }
      const [pending] = await sql<Operation[]>`select * from city_operations where id=${op.id}`;
      return { operation: pending };
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof BusinessHoursBody> }>(
    "/city/shops/:id/hours",
    { schema: { params: CityAssetId, body: BusinessHoursBody, response } },
    async (req) => {
      const id = req.params.id;
      await chainOwner(id, actor(req));
      if (req.body.closeMinute <= req.body.openMinute) problem("Closing time must follow opening time.", 400);
      await sql.begin(async (tx) => {
        await requireBusinessOwner(tx, id, actor(req));
        await tx`insert into business_settings(business_id,open_minute,close_minute,accepting_customers) values (${id},${req.body.openMinute},${req.body.closeMinute},${req.body.acceptingCustomers}) on conflict(business_id) do update set open_minute=excluded.open_minute,close_minute=excluded.close_minute,accepting_customers=excluded.accepting_customers`;
      });
      await refreshShopHours(sql, deps.now());
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof RentOfferBody> }>(
    "/city/property/:id/rent-offer",
    { schema: { params: CityAssetId, body: RentOfferBody, response } },
    async (req) => {
      const p = await deps.view<{ owner: string } | null>("get_property", {
        property_id: Number(req.params.id),
      });
      if (p?.owner !== `player:${actor(req)}`)
        problem("Only the current property owner may offer a lease.", 403);
      if (BigInt(req.body.rent) < 1n || BigInt(req.body.rent) > 10000n)
        problem("Rent must be between 1 and 10,000 QC.", 400);
      const args = {
        property_id: Number(req.params.id),
        rent: req.body.active ? req.body.rent : "0",
        period_days: req.body.periodDays,
      };
      const proof = await deps.verify(req.body.txHash, {
        signerId: actor(req),
        method: "list_lease",
        args,
        events: [{ name: "lease_offered", entityId: `property:${req.params.id}` }],
      });
      await sql.begin(async (tx) => {
        const event = proof.events[0];
        await consumeTransaction(tx, {
          txHash: req.body.txHash,
          commandType: "list_lease",
          entityType: "property",
          entityId: req.params.id,
          signerId: actor(req),
          receiptId: event.receiptId!,
          eventIndex: event.eventIndex!,
        });
        await tx`insert into property_rent_offers(property_id,owner_wallet,rent,period_days,active) values (${req.params.id},${p!.owner},${req.body.rent},${req.body.periodDays},${req.body.active}) on conflict(property_id) do update set owner_wallet=excluded.owner_wallet,rent=excluded.rent,period_days=excluded.period_days,active=excluded.active`;
        await insertLedgerEntries(tx, ledgerEntriesFromEvents(proof.events));
      });
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof ReviewWorkBody> }>(
    "/city/jobs/:id/review",
    { schema: { params: CityId, body: ReviewWorkBody, response } },
    async (req) => {
      const [f] = await sql`select * from funded_jobs where job_id=${req.params.id}`;
      if (!f) problem("Funded assignment not found.", 404);
      const [worker] = await sql`select employee_account from jobs where id=${f.job_id}`;
      if (req.body.decision === "dispute" && worker?.employee_account === actor(req)) {
        /* A worker may request independent review. */
      } else if (f.business_id) await chainOwner(String(f.business_id), actor(req));
      else requireRole(req, ["operator", "admin"]);
      await sql.begin(async (tx) => {
        const [locked] = await tx`select * from funded_jobs where job_id=${req.params.id} for update`;
        const [job] = await tx`select * from jobs where id=${req.params.id} for update`;
        if (!locked || (locked.state !== "active" && req.body.decision !== "dispute"))
          problem("This assignment needs independent review.");
        if (job.employee_account === actor(req) && req.body.decision !== "dispute")
          problem("Employers cannot approve their own work.", 403);
        if (req.body.decision === "dispute") {
          if (!["accepted", "submitted"].includes(job.status)) problem("This work cannot enter dispute.");
          await tx`update funded_jobs set state='disputed',review_note=${req.body.note} where job_id=${job.id}`;
        } else if (req.body.decision === "approve") {
          if (job.status !== "submitted" || locked.state === "disputed")
            problem("Review submitted work or resolve the dispute first.");
          await tx`update jobs set status='verified',verified_at=now(),verification_notes=${req.body.note} where id=${job.id}`;
        } else if (req.body.decision === "revise") {
          if (job.status !== "submitted") problem("Only submitted work can be returned.");
          await tx`update jobs set status='accepted',verification_notes=${req.body.note} where id=${job.id}`;
        } else {
          if (!["open", "accepted", "submitted"].includes(job.status))
            problem("This assignment cannot be cancelled while payment is pending.");
          await tx`update funded_jobs set state='disputed',review_note=${req.body.note} where job_id=${job.id}`;
        }
        await tx`update funded_jobs set review_note=${req.body.note} where job_id=${job.id}`;
      });
      return { ok: true };
    },
  );
  app.post<{ Body: QuizDraftInput }>(
    "/city/quizzes/drafts",
    {
      schema: {
        body: QuizDraftBody,
        response: { 200: Type.Object({ id: Type.String({ format: "uuid" }) }), ...ErrorResponses },
      },
    },
    async (req) => {
      const b = req.body;
      await chainOwner(b.businessId, actor(req));
      if (b.passScore > b.questions.length || BigInt(b.entryFee) > 1000n || BigInt(b.reward) > 1000n)
        problem("Quiz score, fee or prize exceeds its limits.", 400);
      if (
        new Date(b.closesAt) <= new Date(b.opensAt) ||
        new Date(b.closesAt) <= deps.now() ||
        new Date(b.closesAt).getTime() - new Date(b.opensAt).getTime() > 31 * 86400000
      )
        problem("Choose a future closing time within a 31-day venue window.", 400);
      for (const q of b.questions) {
        if (q.correct >= q.options.length || !isNearLearningSource(q.source))
          problem("Every NEAR question needs a valid answer and an official NEAR source.", 400);
      }
      const id = randomUUID();
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':quiz-author:'||${actor(req)},0))`;
        const [count] =
          await tx`select count(*)::int as n from quiz_drafts where author_account=${actor(req)} and status<>'rejected' and closes_at>${deps.now()}`;
        if (count.n >= 20) problem("A creator can keep up to twenty active quiz drafts.");
        await tx`insert into quiz_drafts(id,author_account,business_id,title,questions,pass_score,entry_fee,reward,capacity,opens_at,closes_at) values (${id},${actor(req)},${b.businessId},${b.title},${sql.json(b.questions)},${b.passScore},${b.entryFee},${b.reward},${b.capacity},${b.opensAt},${b.closesAt})`;
      });
      return { id };
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof QuizReviewBody> }>(
    "/city/quizzes/drafts/:id/review",
    { schema: { params: CityUuid, body: QuizReviewBody, response } },
    async (req) => {
      await sql.begin(async (tx) => {
        const [d] = await tx`select * from quiz_drafts where id=${req.params.id} for update`;
        if (!d) problem("Draft not found.", 404);
        if (req.body.decision === "submit") {
          if (d.author_account !== actor(req) || d.status !== "draft")
            problem("Only the author may submit a new draft.", 403);
          await tx`update quiz_drafts set status='review' where id=${d.id}`;
          return;
        }
        requireRole(req, ["operator", "admin"]);
        if (d.author_account === actor(req)) problem("Another moderator must review your own quiz.", 403);
        if (req.body.decision === "suspend") {
          await tx`update quiz_drafts set status='suspended',moderator_account=${actor(req)},moderation_note=${req.body.note} where id=${d.id}`;
          if (d.quiz_id) await tx`update quizzes set status='closed' where id=${d.quiz_id}`;
        } else {
          if (d.status !== "review") problem("This draft is not awaiting review.");
          if (
            req.body.decision === "approve" &&
            d.questions.some((q: { source: string }) => !isNearLearningSource(q.source))
          )
            problem("Every question must teach NEAR using an official NEAR source.", 400);
          await tx`update quiz_drafts set status=${req.body.decision === "approve" ? "approved" : "rejected"},moderator_account=${actor(req)},moderation_note=${req.body.note},approved_at=now() where id=${d.id}`;
        }
      });
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof QuizReportBody> }>(
    "/city/quizzes/drafts/:id/report",
    { schema: { params: CityUuid, body: QuizReportBody, response } },
    async (req) => {
      const [d] = await sql`select id from quiz_drafts where id=${req.params.id} and status='published'`;
      if (!d) problem("Published quiz not found.", 404);
      await sql`insert into quiz_reports(id,draft_id,reporter_account,reason) values (${randomUUID()},${d.id},${actor(req)},${req.body.reason}) on conflict(draft_id,reporter_account) do nothing`;
      return { ok: true };
    },
  );
  app.get(
    "/city/moderation",
    {
      schema: {
        response: {
          200: Type.Object({
            drafts: Type.Array(CityRow, { maxItems: 100 }),
            reports: Type.Array(CityRow, { maxItems: 100 }),
            disputes: Type.Array(CityRow, { maxItems: 100 }),
          }),
          ...ErrorResponses,
        },
      },
    },
    async (req) => {
      requireRole(req, ["operator", "admin"]);
      return {
        drafts: [
          ...(await sql`select * from quiz_drafts where status in ('review','approved','suspended','published') order by created_at limit 100`),
        ],
        reports: [...(await sql`select * from quiz_reports where resolved_at is null order by id limit 100`)],
        disputes: [
          ...(await sql`select f.*,j.deliverable,j.status as job_status from funded_jobs f join jobs j on j.id=f.job_id where f.state='disputed' order by f.created_at limit 100`),
        ],
      };
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof BudgetBody> }>(
    "/city/budgets/:id",
    { schema: { params: CityId, body: BudgetBody, response } },
    async (req) => {
      requireRole(req, ["operator", "admin"]);
      if (BigInt(req.body.ceiling) > 1000000n) problem("Budget ceiling exceeds 1,000,000 QC.", 400);
      const [b] =
        await sql`update council_budgets set ceiling=${req.body.ceiling} where category=${req.params.id} and committed+spent<=${req.body.ceiling}::numeric returning category`;
      if (!b) problem("The ceiling cannot be less than existing commitments and spending.");
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof MarketProofBody> }>(
    "/city/market/:id/confirm",
    { schema: { params: CityAssetId, body: MarketProofBody, response } },
    async (req) => {
      const id = Number(req.params.id),
        account = actor(req),
        body = req.body;
      if (!Number.isSafeInteger(id) || id < 1) problem("Invalid asset ID.", 400);
      const business = ["list_business", "buy_business", "transfer_business"].includes(body.method);
      const key = business ? "business_id" : "property_id";
      if ((body.args as Record<string, unknown>)[key] !== id)
        problem("The transaction belongs to another asset.", 400);
      const name =
        body.method === "list_property"
          ? "property_listed"
          : body.method === "cancel_property_listing"
            ? "property_listing_cancelled"
            : body.method === "list_business"
              ? "business_listed"
              : body.method === "buy_business"
                ? "business_sold"
                : "business_transferred";
      const proof = await deps.verify(body.txHash, {
        signerId: account,
        method: body.method,
        args: body.args,
        events: [{ name, entityId: `${business ? "business" : "property"}:${id}` }],
      });
      const state = await deps.view<any>(business ? "get_business" : "get_property", { [key]: id });
      const price = business
        ? await deps.view<string>("get_business_sale_price", { business_id: id })
        : state.price;
      const wallets = [
        ...new Set(
          proof.events
            .flatMap((e) => [e.data[0].wallet_from, e.data[0].wallet_to])
            .filter((s): s is string => typeof s === "string"),
        ),
      ];
      const balances = await Promise.all(wallets.map(async (w) => [w, await deps.balance(w)] as const));
      await sql.begin(async (tx) => {
        const e = proof.events[0];
        await consumeTransaction(tx, {
          txHash: body.txHash,
          commandType: body.method,
          entityType: business ? "business" : "property",
          entityId: String(id),
          signerId: account,
          receiptId: e.receiptId!,
          eventIndex: e.eventIndex!,
        });
        if (business) {
          await tx`update businesses set owner_account=${state.owner} where id=${id}`;
          await tx`insert into market_listings(id,seller_wallet,asset_type,asset_id,asking_price,status) values (${`business:${id}`},${`player:${state.owner}`},'business',${String(id)},${price},${price === "0" ? "cancelled" : "active"}) on conflict(id) do update set seller_wallet=excluded.seller_wallet,asking_price=excluded.asking_price,status=excluded.status`;
        } else
          await tx`update properties set owner_wallet=${state.owner},price=${state.price},for_sale=${state.for_sale} where id=${id}`;
        await insertLedgerEntries(tx, ledgerEntriesFromEvents(proof.events));
        for (const [w, b] of balances) await setMirroredBalance(tx, w, b);
        for (const e of proof.events) {
          if (e.event === "business_sold" || e.event === "business_transferred")
            await recordOwnershipHistory(tx, e, "business", String(id), {
              networkId: config.networkId,
              contractId: config.contractId,
            });
          await appendResolvedEconomicProjection(tx, e);
        }
      });
      return { ok: true };
    },
  );
}

export function registerCityReviewRoutes(app: FastifyInstance, sql: Sql) {
  const response = { 200: CityOperationResponse, ...ErrorResponses };
  app.post<{ Params: { id: string }; Body: Static<typeof ReviewWorkBody> }>(
    "/city/jobs/:id/resolve",
    { schema: { params: CityId, body: ReviewWorkBody, response: { 200: CityRow, ...ErrorResponses } } },
    async (req) => {
      const actor = requireRole(req, ["operator", "admin"]).accountId;
      return sql.begin(async (tx) => {
        const [f] =
          await tx`select f.*,j.status,j.employee_account,j.deliverable from funded_jobs f join jobs j on j.id=f.job_id where f.job_id=${req.params.id} for update of f,j`;
        if (!f) problem("Assignment not found.", 404);
        if (f.state !== "disputed") problem("Only a disputed assignment can be resolved.");
        const [pendingCancellation] =
          await tx`select id from city_operations where kind='settlement' and payload->>'jobId'=${f.job_id} and status in ('awaiting','unknown')`;
        if (pendingCancellation && req.body.decision !== "cancel")
          problem("A refund is awaiting confirmation; resolve its exact receipt first.");
        if (actor === f.creator_account || actor === f.employee_account)
          problem("Another operator must resolve your own dispute.", 403);
        if (["paid", "payment_pending", "payment_unknown"].includes(f.status))
          problem("A paid or unresolved payment cannot be cancelled.");
        if (req.body.decision === "approve") {
          if (f.status !== "submitted" || !f.deliverable)
            problem("Approval requires an assigned worker and a submitted deliverable.");
          await tx`update jobs set status='verified',verified_at=now(),verification_notes=${req.body.note} where id=${f.job_id}`;
          await tx`update funded_jobs set state='active',review_note=${req.body.note} where job_id=${f.job_id}`;
          return { ok: true };
        }
        if (req.body.decision === "revise") {
          if (!f.employee_account || !["accepted", "submitted"].includes(f.status))
            problem("Only assigned unfinished work can be returned.");
          await tx`update jobs set status='accepted',verification_notes=${req.body.note} where id=${f.job_id}`;
          await tx`update funded_jobs set state='active',review_note=${req.body.note} where job_id=${f.job_id}`;
          return { ok: true };
        }
        if (req.body.decision !== "cancel") problem("Choose a resolution.", 400);
        const reference = `settle:${f.escrow_id}:cancel-job`;
        const [prior] = await tx<Operation[]>`select * from city_operations where reference=${reference}`;
        if (prior) return { operation: prior };
        const source = f.business_id ? `biz:${f.business_id}` : "gov:council";
        const operation = await (
          await import("./city-economy.js")
        ).insertOperation(
          tx,
          actor,
          "settlement",
          "settle_escrow",
          { id: f.escrow_id, recipient_wallet: source, amount: f.payment, refund: true, reference },
          {
            name: "escrow_refunded",
            entityId: `escrow:${f.escrow_id}`,
            walletFrom: `gov:escrow.${f.escrow_id}`,
            walletTo: source,
            amount: f.payment,
            reference,
          },
          { jobId: f.job_id, note: req.body.note, signerAccount: config.operatorAccount },
        );
        return { operation };
      });
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof QuizReportBody> }>(
    "/city/reports/:id/resolve",
    { schema: { params: CityUuid, body: QuizReportBody, response: { 200: CityOk, ...ErrorResponses } } },
    async (req) => {
      requireRole(req, ["operator", "admin"]);
      const [r] =
        await sql`update quiz_reports set resolved_at=now(),resolution=${req.body.reason} where id=${req.params.id} and resolved_at is null returning id`;
      if (!r) problem("Report is already resolved or unavailable.");
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof QuizReportBody> }>(
    "/city/quizzes/:id/close",
    { schema: { params: CityId, body: QuizReportBody, response } },
    async (req) => {
      const actor = requireRole(req, ["operator", "admin"]).accountId;
      return sql.begin(async (tx) => {
        const [q] =
          await tx`select q.*,d.escrow_id,d.closes_at from quizzes q join quiz_drafts d on d.id=q.creator_draft_id where q.id=${req.params.id} for update of q,d`;
        if (!q) problem("Venue quiz not found.", 404);
        if (new Date(q.closes_at) > new Date()) problem("Wait until the advertised venue closing time.");
        const [pending] =
          await tx`select count(*)::int as n from quiz_attempts where quiz_id=${q.id} and (reward_state in ('pending','unknown') or (status='started' and expires_at>now()))`;
        if (pending.n) problem("Finish prize reconciliation before returning unused funds.");
        if (BigInt(q.reward_reserved) > 0n)
          problem("Finish reserved prize reconciliation before returning funds.");
        const amount = (BigInt(q.reward_pool) - BigInt(q.reward_paid)).toString();
        if (BigInt(amount) === 0n) problem("No unused prize funds remain.");
        const reference = `settle:${q.escrow_id}:close`;
        const [prior] = await tx<Operation[]>`select * from city_operations where reference=${reference}`;
        if (prior) return { operation: prior };
        const source = `biz:${q.venue_business_id}`;
        const operation = await (
          await import("./city-economy.js")
        ).insertOperation(
          tx,
          actor,
          "settlement",
          "settle_escrow",
          { id: q.escrow_id, recipient_wallet: source, amount, refund: true, reference },
          {
            name: "escrow_refunded",
            entityId: `escrow:${q.escrow_id}`,
            walletFrom: `gov:escrow.${q.escrow_id}`,
            walletTo: source,
            amount,
            reference,
          },
          { quizId: q.id, signerAccount: config.operatorAccount },
        );
        return { operation };
      });
    },
  );
}
