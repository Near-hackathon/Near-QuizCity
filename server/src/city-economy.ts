import { projectQuizMatchOperation } from "./quiz-match-projection.js";
import { supplierUnitPrice } from "./inventory-pricing.js";
import { presentPropertyServices } from "./property-services.js";
import { isDeepStrictEqual } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { CityCommandType } from "@quiz-city/protocol";
import { AppError } from "./errors.js";
import type { ValidatedEvent } from "./event-validation.js";
import { requireBusinessOwner } from "./commerce.js";
import { appendJobPresentation, appendBusinessPresentation } from "./world-projection.js";
const tag = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
export const chargeReference = (id: string, amount: string, from: string, to: string) =>
  `charge:${id}:${amount}:${tag(from)}:${tag(to)}`;
export type Operation = Record<string, any> & {
  id: string;
  actor_account: string;
  kind: string;
  method: string;
  args: Record<string, any>;
  expected_events: Record<string, any>[];
  reference: string;
  payload: Record<string, any>;
  status: string;
  tx_hash: string | null;
};
export const problem = (message: string, status = 409): never => {
  throw new AppError(
    status === 403
      ? "FORBIDDEN"
      : status === 404
        ? "NOT_FOUND"
        : status === 400
          ? "VALIDATION_ERROR"
          : status === 503
            ? "CHAIN_UNAVAILABLE"
            : "CONFLICT",
    message,
    status,
  );
};
const positive = (s: string, max = 10000n) => {
  if (!/^[1-9][0-9]*$/.test(s) || BigInt(s) > max)
    problem("Choose an amount within the displayed limits.", 400);
  return s;
};
export async function insertOperation(
  tx: TransactionSql,
  actor: string,
  kind: string,
  method: string,
  args: Record<string, any>,
  event: Record<string, any>,
  payload: Record<string, any>,
  id: string = randomUUID(),
): Promise<Operation> {
  const [row] = await tx<
    Operation[]
  >`insert into city_operations(id,actor_account,kind,method,args,expected_events,reference,payload) values (${id},${actor},${kind},${method},${tx.json(args)},${tx.json([event])},${method === "cancel_charge" ? `cancel:${String(args.reference).split(":")[1]}` : String(event.reference)},${tx.json(payload)}) returning *`;
  return row;
}
export async function prepareCityCommand(
  sql: Sql,
  actor: string,
  input: CityCommandType,
  now = new Date(),
): Promise<Operation> {
  if (
    ["supplier", "refund", "refund-admission", "cancel-order", "quiz-fund", "cancel-payment"].includes(
      input.action,
    ) &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.targetId)
  )
    problem("Invalid command target.", 400);
  if (
    ["job", "upkeep", "rent", "tax"].includes(input.action) &&
    (!/^[1-9][0-9]*$/.test(input.targetId) || !Number.isSafeInteger(Number(input.targetId)))
  )
    problem("Invalid asset identifier.", 400);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':city-command:'||${actor},0))`;
    const id = input.requestId;
    const [prior] = await tx<Operation[]>`select * from city_operations where id=${id}`;
    if (prior) {
      if (prior.actor_account !== actor || !isDeepStrictEqual(prior.payload.intent, input))
        problem("This request identifier belongs to a different command.");
      return prior;
    }
    const [pending] =
      await tx`select count(*)::int as n from city_operations where actor_account=${actor} and status in ('awaiting','unknown')`;
    if (pending.n >= 20) problem("Finish or permanently cancel a saved payment before reserving more.");
    let from = `player:${actor}`,
      to = "",
      amount = "0",
      kind = "",
      method = "pay_charge",
      payload: Record<string, any> = { intent: input };
    if (input.action === "tax") {
      const business = await requireBusinessOwner(tx, input.targetId, actor);
      const period = String(Math.floor(now.getTime() / 2592000000)),
        reference = `tax:${input.targetId}:${period}`;
      const [prior] = await tx<Operation[]>`select * from city_operations where reference=${reference}`;
      if (prior) {
        if (prior.status === "confirmed" || prior.actor_account === actor) return prior;
        const [reassigned] = await tx<
          Operation[]
        >`update city_operations set actor_account=${actor},payload=jsonb_set(payload,'{intent}',${tx.json(input)}) where id=${prior.id} returning *`;
        return reassigned;
      }
      const operation = await insertOperation(
        tx,
        actor,
        "charge",
        "pay_business_tax",
        { business_id: Number(input.targetId), period: Number(period) },
        {
          name: "charge_paid",
          entityId: "gov:council",
          walletFrom: business.treasury_wallet,
          walletTo: "gov:council",
          amount: "5",
          reference,
        },
        { intent: input, taxBusinessId: input.targetId, taxPeriod: period },
        id,
      );
      await tx`insert into business_tax_invoices(business_id,period,operation_id) values (${input.targetId},${period},${id}) on conflict(business_id,period) do nothing`;
      return operation;
    }
    if (input.action === "sponsor") {
      const [draft] =
        await tx`select d.* from quiz_drafts d join quizzes q on q.creator_draft_id=d.id where q.id=${input.targetId} and d.status='published' and q.status='live' for update of d,q`;
      if (!draft || new Date(draft.closes_at) <= now) problem("This prize pool is not accepting sponsors.");
      amount = positive(input.amount ?? "0");
      const reference = `sponsor:${draft.escrow_id}:${id}:${amount}:${tag(from)}`;
      return insertOperation(
        tx,
        actor,
        "quiz_fund",
        "sponsor_quiz",
        { id: draft.escrow_id, source_wallet: from, amount, reference },
        {
          name: "escrow_sponsored",
          entityId: `escrow:${draft.escrow_id}`,
          walletFrom: from,
          walletTo: `gov:escrow.${draft.escrow_id}`,
          amount,
          reference,
        },
        { intent: input, draftId: draft.id, topup: true },
        id,
      );
    }
    if (input.action === "cancel-payment") {
      const [original] = await tx<
        Operation[]
      >`select * from city_operations where id=${input.targetId} for update`;
      if (!original || original.actor_account !== actor) problem("Saved payment not found.", 404);
      if (
        !["awaiting", "unknown"].includes(original.status) ||
        !["pay_charge", "pay_rent", "pay_admission"].includes(original.method)
      )
        problem("This payment cannot be cancelled; request review of any reserved funds.");
      const [prior] = await tx<
        Operation[]
      >`select * from city_operations where payload->>'cancelOperationId'=${original.id}`;
      if (prior) return prior;
      const a = original.args;
      const source = a.source_wallet ?? `player:${actor}`,
        to = a.to_wallet ?? a.expected_owner ?? `biz:${a.business_id}`;
      return insertOperation(
        tx,
        actor,
        "cancel",
        "cancel_charge",
        { source_wallet: source, to_wallet: to, amount: a.amount, reference: a.reference },
        { name: "charge_cancelled", entityId: to, reference: a.reference },
        { intent: input, cancelOperationId: original.id },
        id,
      );
    }
    if (input.action === "refund-admission") {
      const [ticket] =
        await tx`select a.*,q.venue_business_id from quiz_admissions a join quizzes q on q.id=a.quiz_id where a.operation_id=${input.targetId} for update of a`;
      if (!ticket || !ticket.paid_at) problem("Paid admission not found.", 404);
      await requireBusinessOwner(tx, String(ticket.venue_business_id), actor);
      if (ticket.attempt_id) problem("An admission already used for a quiz cannot be refunded.");
      const [payment] = await tx<Operation[]>`select * from city_operations where id=${ticket.operation_id}`;
      const reference = `refund-ticket:${tag(payment.reference)}`;
      const [prior] = await tx<Operation[]>`select * from city_operations where reference=${reference}`;
      if (prior) return prior;
      const refundOperation = await insertOperation(
        tx,
        actor,
        "refund",
        "refund_admission",
        {
          business_id: Number(ticket.venue_business_id),
          buyer_wallet: `player:${ticket.player_account}`,
          amount: payment.args.amount,
          payment_reference: payment.reference,
        },
        {
          name: "admission_refunded",
          entityId: `business:${ticket.venue_business_id}`,
          walletFrom: `biz:${ticket.venue_business_id}`,
          walletTo: `player:${ticket.player_account}`,
          amount: payment.args.amount,
          reference,
        },
        { intent: input, admissionId: ticket.operation_id },
        id,
      );
      await tx`update quiz_admissions set refund_operation_id=${refundOperation.id} where operation_id=${ticket.operation_id}`;
      return refundOperation;
    }
    if (input.action === "supplier") {
      const [item] = await tx`select * from business_items where id=${input.targetId} for update`;
      if (!item) problem("Stock item not found.", 404);
      await requireBusinessOwner(tx, String(item.business_id), actor);
      const [offer] =
        await tx`select * from supplier_offers where active=true order by unit_price,id limit 1 for update`;
      const qty = input.quantity ?? 1;
      if (!offer || offer.on_hand - offer.reserved < qty) problem("The supplier does not have enough stock.");
      const [incoming] =
        await tx`select coalesce(sum(s.quantity),0)::int as n from supplier_orders s join city_operations o on o.id=s.operation_id where s.item_id=${item.id} and o.status in ('awaiting','unknown')`;
      if (item.on_hand + incoming.n + qty > 1000000) problem("This delivery would exceed the stock limit.");
      from = `biz:${item.business_id}`;
      to = offer.wallet_id;
      const quotedUnitPrice = supplierUnitPrice(String(offer.unit_price), offer.on_hand - offer.reserved);
      amount = positive((BigInt(quotedUnitPrice) * BigInt(qty)).toString());
      kind = "supplier";
      payload = { intent: input, itemId: item.id, offerId: offer.id, quantity: qty };
      const reference = chargeReference(id, amount, from, to);
      const operation = await insertOperation(
        tx,
        actor,
        kind,
        method,
        { source_wallet: from, to_wallet: to, amount, reference },
        { name: "charge_paid", entityId: to, walletFrom: from, walletTo: to, amount, reference },
        payload,
        id,
      );
      await tx`update supplier_offers set reserved=reserved+${qty} where id=${offer.id}`;
      await tx`insert into supplier_orders(operation_id,offer_id,item_id,quantity,unit_price,total) values (${id},${offer.id},${item.id},${qty},${quotedUnitPrice},${amount})`;
      return operation;
    }
    if (input.action === "job" || input.action === "public-job") {
      const publicJob = input.action === "public-job";
      const business = publicJob
        ? { treasury_wallet: "gov:council" }
        : await requireBusinessOwner(tx, input.targetId, actor);
      if (!input.title || !input.description) problem("Describe the work and its deliverable.", 400);
      amount = positive(input.amount ?? "0");
      from = business.treasury_wallet;
      if (publicJob) {
        const [council] =
          await tx`select balance::text as balance from wallets where wallet_id='gov:council' and active=true for update`;
        const [held] = await tx`select coalesce(sum(committed),0)::text as amount from council_budgets`;
        if (!council || BigInt(council.balance) - BigInt(held.amount) < BigInt(amount))
          problem("Council funds are already committed.");
        const [category] =
          await tx`update council_budgets set committed=committed+${amount}::numeric where category='employment' and ceiling-spent-committed>=${amount}::numeric returning category`;
        if (!category) problem("The employment budget has insufficient funds.");
      }
      const reference = `fund:${id}`,
        jobId = `work-${id}`;
      const operation = await insertOperation(
        tx,
        actor,
        "job_fund",
        "fund_escrow",
        {
          id,
          source_wallet: from,
          beneficiary_wallet: null,
          amount,
          purpose: publicJob ? "public_contract" : "job",
        },
        {
          name: "escrow_funded",
          entityId: `escrow:${id}`,
          walletFrom: from,
          walletTo: `gov:escrow.${id}`,
          amount,
          reference,
        },
        { intent: input, jobId, council: publicJob },
        id,
      );
      await tx`insert into funded_jobs(job_id,operation_id,business_id,creator_account,escrow_id,title,description,payment,deadline) values (${jobId},${id},${publicJob ? null : input.targetId},${actor},${id},${input.title!},${input.description!},${amount},${new Date(now.getTime() + (input.days ?? 7) * 86400000)})`;
      if (publicJob)
        await tx`insert into council_commitments(operation_id,category,amount,purpose) values (${id},'employment',${amount},${input.description!})`;
      return operation;
    }
    if (input.action === "quiz-fund") {
      const [draft] = await tx`select * from quiz_drafts where id=${input.targetId} for update`;
      if (!draft || draft.status !== "approved")
        problem("A different moderator must approve this quiz first.");
      const b = await requireBusinessOwner(tx, String(draft.business_id), actor);
      if (draft.funding_operation_id) {
        const [existing] = await tx<
          Operation[]
        >`select * from city_operations where id=${draft.funding_operation_id}`;
        return existing;
      }
      amount = positive(input.amount ?? "0");
      if (BigInt(amount) < BigInt(draft.reward)) problem("Fund at least one full prize.");
      from = b.treasury_wallet;
      const operation = await insertOperation(
        tx,
        actor,
        "quiz_fund",
        "fund_escrow",
        { id, source_wallet: from, beneficiary_wallet: null, amount, purpose: "prize" },
        {
          name: "escrow_funded",
          entityId: `escrow:${id}`,
          walletFrom: from,
          walletTo: `gov:escrow.${id}`,
          amount,
          reference: `fund:${id}`,
        },
        { intent: input, draftId: draft.id },
        id,
      );
      await tx`update quiz_drafts set funding_operation_id=${id},escrow_id=${id} where id=${draft.id}`;
      return operation;
    }
    if (input.action === "admission") {
      const [quiz] =
        await tx`select q.*,d.capacity,d.opens_at,d.closes_at,d.author_account from quizzes q join quiz_drafts d on d.id=q.creator_draft_id where q.id=${input.targetId} and q.status='live' for update of q`;
      if (!quiz || now < quiz.opens_at || now >= quiz.closes_at)
        problem("This venue is not currently admitting players.");
      if (quiz.author_account === actor) problem("Quiz creators cannot collect their own prizes.", 403);
      const [prior] = await tx<
        Operation[]
      >`select o.* from city_operations o join quiz_admissions a on a.operation_id=o.id where a.quiz_id=${input.targetId} and a.player_account=${actor} and a.attempt_id is null and a.refunded_at is null and o.status<>'cancelled'`;
      if (prior) return prior;
      const [occupancy] =
        await tx`select count(*)::int as n from quiz_attempts where quiz_id=${input.targetId} and status='started' and expires_at>${now}`;
      const [reserved] =
        await tx`select count(*)::int as n from quiz_admissions where quiz_id=${input.targetId} and attempt_id is null and refunded_at is null`;
      if (occupancy.n + reserved.n >= quiz.capacity)
        problem("The venue is full. Try again after a player finishes.");
      to = `biz:${quiz.venue_business_id}`;
      amount = positive(String(quiz.entry_fee));
      kind = "admission";
      method = "pay_admission";
      payload = { intent: input, quizId: quiz.id, venueBusinessId: String(quiz.venue_business_id) };
    } else if (input.action === "rent") {
      await tx`update property_leases set status='expired' where property_id=${input.targetId} and status='active' and grace_ends_at<=${now}`;
      const [offer] =
        await tx`select r.* from property_rent_offers r join properties p on p.id=r.property_id and p.owner_wallet=r.owner_wallet where r.property_id=${input.targetId} and r.active=true for update of r`;
      if (!offer || offer.owner_wallet === from) problem("This rental is unavailable.");
      const [lease] =
        await tx`select id from property_leases where property_id=${input.targetId} and status in ('reserved','active')`;
      if (lease) problem("This property already has an active or reserved lease.");
      to = offer.owner_wallet;
      amount = positive(String(offer.rent));
      kind = "rent";
      method = "pay_rent";
      payload = { intent: input, propertyId: input.targetId, days: offer.period_days };
    } else if (input.action === "upkeep") {
      const [property] = await tx`select * from properties where id=${input.targetId} and active=true`;
      const [lease] =
        await tx`select id from property_leases where property_id=${input.targetId} and tenant_account=${actor} and status='active' and grace_ends_at>${now}`;
      if (property?.owner_wallet !== from && !lease)
        problem("Only the owner or current tenant may authorise property services.", 403);
      to = "gov:council";
      amount = "10";
      kind = "upkeep";
      payload = { intent: input, propertyId: input.targetId };
    } else if (input.action === "refund" || input.action === "cancel-order") {
      let [order] = await tx`select * from business_orders where id=${input.targetId} for update`;
      let npcVisit = false;
      if (!order && input.action === "refund") {
        [order] = await tx`select * from npc_shop_visits where id=${input.targetId} for update`;
        npcVisit = !!order;
      }
      if (!order) problem("Order not found.", 404);
      if (input.action === "cancel-order") {
        if (order.buyer_account !== actor) problem("Only the buyer can cancel.", 403);
        if (order.status === "paid") problem("A paid purchase needs a confirmed refund.");
        const [prior] = await tx<
          Operation[]
        >`select * from city_operations where reference=${order.reference}`;
        if (prior) return prior;
        return insertOperation(
          tx,
          actor,
          "cancel",
          "cancel_order",
          { reference: order.reference },
          { name: "order_cancelled", entityId: `order:${order.id}`, reference: order.reference },
          { intent: input, orderId: order.id },
          id,
        );
      }
      await requireBusinessOwner(tx, String(order.business_id), actor);
      if (!["paid", "refunded"].includes(order.status)) problem("Only a paid order can be refunded.");
      const reference = `refund:${tag(order.reference)}`;
      const [prior] = await tx<Operation[]>`select * from city_operations where reference=${reference}`;
      if (prior) return prior;
      return insertOperation(
        tx,
        actor,
        "refund",
        "refund_order",
        {
          business_id: Number(order.business_id),
          buyer_wallet: npcVisit ? `npc:${order.npc_id}` : `player:${order.buyer_account}`,
          amount: npcVisit ? order.amount : order.total,
          order_reference: order.reference,
        },
        {
          name: "order_refunded",
          entityId: `business:${order.business_id}`,
          walletFrom: `biz:${order.business_id}`,
          walletTo: npcVisit ? `npc:${order.npc_id}` : `player:${order.buyer_account}`,
          amount: npcVisit ? order.amount : order.total,
          reference,
        },
        { intent: input, ...(npcVisit ? { npcVisitId: order.id } : { orderId: order.id }) },
        id,
      );
    } else if (input.action === "settlement") {
      problem("Settlement requires a reviewed employer or moderator decision.", 403);
    } else if (input.action === "budget") {
      from = "gov:council";
      to = input.recipient ?? "";
      amount = positive(input.amount ?? "0");
      kind = "budget";
      payload = { intent: input, category: input.category, purpose: input.description };
      if (!input.category || !input.description || !to)
        problem("Choose a budget category, recipient and public purpose.", 400);
      const [council] =
        await tx`select balance::text as balance from wallets where wallet_id='gov:council' and active=true for update`;
      const [committed] = await tx`select coalesce(sum(committed),0)::text as amount from council_budgets`;
      if (!council || BigInt(council.balance) - BigInt(committed.amount) < BigInt(amount))
        problem("Council funds are already committed.");
      const [budget] =
        await tx`update council_budgets set committed=committed+${amount}::numeric where category=${input.category!} and ceiling-spent-committed>=${amount}::numeric returning category`;
      if (!budget) problem("This category has insufficient uncommitted funds.");
    } else if (input.action !== "admission") problem("Unknown city command.", 400);
    const reference = chargeReference(id, amount, from, to);
    const args: Record<string, any> =
      method === "pay_admission"
        ? { business_id: Number(payload.venueBusinessId), amount, reference }
        : method === "pay_rent"
          ? { property_id: Number(input.targetId), expected_owner: to, amount, reference }
          : { source_wallet: from, to_wallet: to, amount, reference };
    const operation = await insertOperation(
      tx,
      actor,
      kind,
      method,
      args,
      {
        name: method === "pay_admission" ? "service_paid" : "charge_paid",
        entityId: method === "pay_admission" ? `business:${payload.venueBusinessId}` : to,
        walletFrom: from,
        walletTo: to,
        amount,
        reference,
      },
      payload,
      id,
    );
    if (kind === "rent")
      await tx`update city_operations set expected_events=expected_events||${tx.json([{ name: "lease_started", entityId: `property:${input.targetId}`, reference }])}::jsonb where id=${id}`;
    if (kind === "rent")
      await tx`insert into property_leases(id,property_id,landlord_wallet,tenant_account) values (${id},${input.targetId},${to},${actor})`;
    if (kind === "admission")
      await tx`insert into quiz_admissions(operation_id,quiz_id,player_account) values (${id},${input.targetId},${actor})`;
    if (kind === "budget")
      await tx`insert into council_commitments(operation_id,category,amount,purpose) values (${id},${input.category!},${amount},${input.description!})`;
    return operation;
  });
}

/** Only a verified immutable event can advance these server-owned workflows. */
export async function projectCityOperation(tx: TransactionSql, event: ValidatedEvent) {
  const data = event.data[0];
  const reference = String(data.reference ?? "");
  if (event.event === "lease_started") {
    const [op] = await tx<Operation[]>`select * from city_operations where reference=${reference} for update`;
    if (!op) return;
    if (
      op.kind !== "rent" ||
      op.status !== "confirmed" ||
      op.tx_hash !== event.txHash ||
      op.actor_account !== data.tenant ||
      String(op.payload.propertyId) !== String(data.property_id)
    )
      problem("Lease rights are not bound to a confirmed rent payment.");
    const ends = new Date(Number(BigInt(String(data.ends_at)) / 1000000n));
    const grace = new Date(Number(BigInt(String(data.grace_ends_at)) / 1000000n));
    await tx`update property_leases set status='active',starts_at=${new Date(ends.getTime() - op.payload.days * 86400000)},ends_at=${ends},grace_ends_at=${grace} where id=${op.id}`;
    return;
  }
  const lookupReference =
    event.event === "charge_cancelled" ? `cancel:${reference.split(":")[1]}` : reference;
  const [operation] = await tx<
    Operation[]
  >`select * from city_operations where reference=${lookupReference} for update`;
  if (!operation) return;
  const expected = operation.expected_events[0];
  for (const [field, value] of Object.entries({
    event: expected.name,
    entity_id: expected.entityId,
    wallet_from: expected.walletFrom,
    wallet_to: expected.walletTo,
    amount: expected.amount,
  })) {
    if (value !== undefined && (field === "event" ? event.event : data[field]) !== value)
      problem("Confirmed payment does not match the reserved command.");
  }
  if (operation.status === "confirmed") {
    if (operation.receipt_id !== event.receiptId || operation.event_index !== event.eventIndex)
      problem("Command already has a different confirmed receipt.");
    return;
  }
  if (operation.status === "cancelled") problem("This command has been permanently cancelled.");
  const p = operation.payload;
  if (p.matchRoomId) {
    await projectQuizMatchOperation(tx, operation);
  } else if (operation.kind === "charge" && p.taxBusinessId) {
    await tx`update business_tax_invoices set paid_at=now() where business_id=${p.taxBusinessId} and period=${p.taxPeriod}`;
  } else if (operation.kind === "cancel" && p.cancelOperationId) {
    const [original] = await tx<
      Operation[]
    >`select * from city_operations where id=${p.cancelOperationId} for update`;
    if (original.status === "confirmed") problem("This payment was already confirmed.");
    if (original.kind === "supplier") {
      const [order] = await tx`select * from supplier_orders where operation_id=${original.id}`;
      await tx`update supplier_offers set reserved=reserved-${order.quantity} where id=${order.offer_id}`;
    }
    if (original.kind === "rent")
      await tx`update property_leases set status='cancelled' where id=${original.id}`;
    if (original.kind === "admission")
      await tx`delete from quiz_admissions where operation_id=${original.id} and paid_at is null`;
    if (original.kind === "budget") {
      const [c] = await tx`select * from council_commitments where operation_id=${original.id}`;
      await tx`update council_budgets set committed=committed-${String(c.amount)}::numeric where category=${c.category}`;
    }
    await tx`update city_operations set status='cancelled' where id=${original.id}`;
  } else if (operation.kind === "settlement" && p.quizId) {
    await tx`update quizzes set status='closed',reward_pool=reward_paid where id=${p.quizId}`;
    await tx`update quiz_drafts set status='suspended' where quiz_id=${p.quizId}`;
  } else if (operation.kind === "settlement" && p.jobId) {
    const [job] = await tx`select * from jobs where id=${p.jobId} for update`;
    if (!job || ["paid", "payment_pending", "payment_unknown"].includes(job.status))
      problem("A pending or paid assignment cannot be refunded.");
    await tx`update jobs set status='cancelled',cancelled_at=now() where id=${p.jobId}`;
    await tx`update funded_jobs set state='cancelled',review_note=${p.note} where job_id=${p.jobId}`;
    const [fund] = await tx`select business_id,operation_id from funded_jobs where job_id=${p.jobId}`;
    if (!fund.business_id)
      await tx`update council_budgets set spent=spent-${String(data.amount)}::numeric where category='employment'`;

    await tx`update business_staff set ended_at=now() where job_id=${p.jobId}`;
  } else if (operation.kind === "supplier") {
    const [order] = await tx`select * from supplier_orders where operation_id=${operation.id} for update`;
    await tx`update supplier_offers set on_hand=on_hand-${order.quantity},reserved=reserved-${order.quantity} where id=${order.offer_id}`;
    const [stock] =
      await tx`update business_items set on_hand=on_hand+${order.quantity} where id=${order.item_id} and on_hand+${order.quantity}<=1000000 returning id`;
    if (!stock) problem("Stock capacity changed; supplier payment needs operator review.");
    await tx`insert into stock_movements(item_id,quantity,kind,reference,actor_account) values (${order.item_id},${order.quantity},'delivery',${operation.reference},${operation.actor_account})`;
    await tx`update supplier_orders set fulfilled_at=now() where operation_id=${operation.id}`;
    const [item] = await tx`select business_id from business_items where id=${order.item_id}`;
    await appendBusinessPresentation(tx, String(item.business_id));
  } else if (operation.kind === "job_fund") {
    const [fund] = await tx`select * from funded_jobs where operation_id=${operation.id} for update`;
    await tx`insert into jobs(id,employer_wallet,title,description,payment,status,deadline,reference) values (${fund.job_id},${`gov:escrow.${fund.escrow_id}`},${fund.title},${fund.description},${String(fund.payment)},'open',${fund.deadline},${`job:${fund.job_id}`}) on conflict(id) do nothing`;
    await tx`update funded_jobs set state='active' where operation_id=${operation.id}`;
    if (p.council) {
      await tx`update council_budgets set committed=committed-${String(data.amount)}::numeric,spent=spent+${String(data.amount)}::numeric where category='employment'`;
      await tx`update council_commitments set paid_at=now() where operation_id=${operation.id}`;
    }
    await appendJobPresentation(tx, { jobId: fund.job_id, status: "open" });
  } else if (operation.kind === "quiz_fund") {
    const [draft] = await tx`select * from quiz_drafts where id=${p.draftId} for update`;
    if (p.topup) {
      if (draft.status !== "published") problem("This prize pool is no longer published.");
      await tx`update quizzes set reward_pool=reward_pool+${String(data.amount)}::numeric where creator_draft_id=${draft.id}`;
    } else {
      if (draft.status !== "approved") problem("This quiz is no longer approved.");
      const quizId = `venue-${draft.id}`;
      await tx`insert into quizzes(id,venue_business_id,title,reward_pool,entry_fee,status,question_count,pass_score,reward_amount,attempt_duration_seconds,funding_model,creator_draft_id) values (${quizId},${draft.business_id},${draft.title},${String(data.amount)},${String(draft.entry_fee)},'live',${draft.questions.length},${draft.pass_score},${String(draft.reward)},600,'funded',${draft.id})`;
      for (const [i, q] of draft.questions.entries())
        await tx`insert into quiz_questions(id,quiz_id,category,question,options,correct_index,source) values (${`${quizId}-${i}`},${quizId},'community',${q.question},${tx.json(q.options)},${q.correct},${q.source})`;
      await tx`update quiz_drafts set status='published',quiz_id=${quizId} where id=${draft.id}`;
    }
  } else if (operation.kind === "admission")
    await tx`update quiz_admissions set paid_at=now() where operation_id=${operation.id}`;
  else if (operation.kind === "rent") {
    // The separate lease_started registry fact activates use rights after this payment.
  } else if (operation.kind === "upkeep") {
    await tx`insert into property_condition(property_id,condition,last_maintained_at) values (${p.propertyId},100,now()) on conflict(property_id) do update set condition=100,last_maintained_at=now(),utilities_active=true,utilities_paid_until=greatest(now(),property_condition.utilities_paid_until)+interval '30 days'`;
    await presentPropertyServices(tx, String(p.propertyId));
  } else if (operation.kind === "budget") {
    const [commitment] =
      await tx`select * from council_commitments where operation_id=${operation.id} for update`;
    await tx`update council_budgets set committed=committed-${String(commitment.amount)}::numeric,spent=spent+${String(commitment.amount)}::numeric where category=${commitment.category}`;
    await tx`update council_commitments set paid_at=now() where operation_id=${operation.id}`;
  } else if (operation.kind === "refund" && p.admissionId) {
    const [ticket] = await tx`select * from quiz_admissions where operation_id=${p.admissionId} for update`;
    if (ticket.attempt_id) problem("This admission has already been used; refund needs review.");
    await tx`update quiz_admissions set refunded_at=now() where operation_id=${p.admissionId}`;
  } else if (operation.kind === "refund" && p.npcVisitId) {
    const [visit] = await tx`select * from npc_shop_visits where id=${p.npcVisitId} for update`;
    await returnInventory(tx, visit.item_id, 1, operation);
    await tx`update npc_shop_visits set status='refunded' where id=${visit.id}`;
  } else if (operation.kind === "cancel" || operation.kind === "refund") {
    const [order] = await tx`select * from business_orders where id=${p.orderId} for update`;
    if (operation.kind === "cancel") {
      if (order.status === "paid") problem("This order has already been paid.");
      await tx`update business_items set reserved=reserved-${order.quantity} where id=${order.item_id}`;
      await tx`update business_orders set status='cancelled' where id=${order.id}`;
    } else {
      await returnInventory(tx, order.item_id, order.quantity, operation);
      await tx`update business_orders set status='refunded' where id=${order.id}`;
    }
  }
  if (operation.kind === "refund" && operation.args.business_id)
    await appendBusinessPresentation(tx, String(operation.args.business_id));
  await tx`update city_operations set status='confirmed',tx_hash=${event.txHash!},receipt_id=${event.receiptId!},event_index=${event.eventIndex!},confirmed_at=now(),error_code=null where id=${operation.id}`;
}

async function returnInventory(tx: TransactionSql, itemId: string, quantity: number, operation: Operation) {
  const [item] = await tx`select on_hand from business_items where id=${itemId} for update`;
  const [incoming] =
    await tx`select coalesce(sum(s.quantity),0)::int as n from supplier_orders s join city_operations o on o.id=s.operation_id where s.item_id=${itemId} and o.status in ('awaiting','unknown')`;
  const restocked = Math.max(0, Math.min(quantity, 1000000 - item.on_hand - incoming.n));
  if (restocked) {
    await tx`update business_items set on_hand=on_hand+${restocked} where id=${itemId}`;
    await tx`insert into stock_movements(item_id,quantity,kind,reference,actor_account) values (${itemId},${restocked},'delivery',${operation.reference},${operation.actor_account})`;
  }
  await tx`insert into inventory_returns(operation_id,item_id,quantity,restocked,discarded,reason) values (${operation.id},${itemId},${quantity},${restocked},${quantity - restocked},${restocked < quantity ? "warehouse_capacity" : "returned_goods"})`;
}
