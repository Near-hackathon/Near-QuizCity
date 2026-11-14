import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { Type, type Static } from "@sinclair/typebox";
import {
  CatalogueResponse,
  ItemBody,
  OrderBody,
  OrderResponse,
  OrdersResponse,
  ConfirmOrderBody,
  StockBody,
  ShopItem,
} from "@quiz-city/protocol";
import { ErrorResponses } from "./schemas/index.js";
import { requireAuth } from "./auth/plugin.js";
import { AppError } from "./errors.js";
import { config } from "./runtime-config.js";
import { viewContract } from "./near.js";
import { verifyExpectedFunctionCall, requireExpectedEvent } from "./verify.js";
import { consumeTransaction } from "./transaction-context.js";
import { ledgerEntriesFromEvents } from "./record-chain-events.js";
import { insertLedgerEntries } from "./ledger.js";
import { readChainBalance } from "./sync.js";
import { setMirroredBalance } from "./sync.js";
import { appendResolvedEconomicProjection } from "./world-projection.js";
import {
  createShopItem,
  reserveShopOrder,
  projectConfirmedOrder,
  requireBusinessOwner,
  type CommerceOrder,
} from "./commerce.js";
const BusinessParams = Type.Object(
  { id: Type.String({ pattern: "^[1-9][0-9]{0,14}$" }) },
  { additionalProperties: false },
);
const IdParams = Type.Object({ id: Type.String({ format: "uuid" }) }, { additionalProperties: false });
export function registerCommerceRoutes(
  app: FastifyInstance,
  db: Sql,
  options: { readOwner?: (id: number) => Promise<string | null> } = {},
) {
  const readOwner =
    options.readOwner ??
    (async (id: number) =>
      (await viewContract<{ owner: string } | null>("get_business", { business_id: id }))?.owner ?? null);
  async function confirmedOwner(id: string, actor: string) {
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new AppError("VALIDATION_ERROR", "Invalid business identifier.", 400);
    let owner: string | null;
    try {
      owner = await readOwner(value);
    } catch {
      throw new AppError(
        "CHAIN_UNAVAILABLE",
        "Business ownership could not be checked. Please try again.",
        503,
      );
    }
    if (owner !== actor)
      throw new AppError("FORBIDDEN", "Only the confirmed business owner may change the shop.", 403);
  }
  async function confirmedItemOwner(id: string, actor: string) {
    const [item] = await db`select business_id from business_items where id=${id}`;
    if (!item) throw new AppError("NOT_FOUND", "Item not found.", 404);
    await confirmedOwner(String(item.business_id), actor);
  }

  app.get(
    "/commerce/capabilities",
    { schema: { response: { 200: Type.Object({ orderPayments: Type.Boolean() }), ...ErrorResponses } } },
    async () => {
      try {
        return { orderPayments: (await viewContract<boolean>("supports_orders")) === true };
      } catch {
        return { orderPayments: false };
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    "/businesses/:id/catalogue",
    { schema: { params: BusinessParams, response: { 200: CatalogueResponse, ...ErrorResponses } } },
    async (req) => ({
      items:
        await db`select * from business_items where business_id=${req.params.id} and active=true order by sku limit 100`,
    }),
  );
  app.post<{ Params: { id: string }; Body: Static<typeof ItemBody> }>(
    "/businesses/:id/catalogue",
    { schema: { params: BusinessParams, body: ItemBody, response: { 200: ShopItem, ...ErrorResponses } } },
    async (req) => {
      const actor = requireAuth(req).accountId;
      await confirmedOwner(req.params.id, actor);
      return createShopItem(db, req.params.id, actor, req.body, 10);
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof StockBody> }>(
    "/items/:id/deliveries",
    { schema: { params: IdParams, body: StockBody, response: { 200: ShopItem, ...ErrorResponses } } },
    async (req) => {
      await confirmedItemOwner(req.params.id, requireAuth(req).accountId);
      throw new AppError(
        "CONFLICT",
        "Stock deliveries require a confirmed supplier order in Business → Supplies.",
        409,
      );
    },
  );
  app.post<{ Params: { id: string }; Body: { unitPrice: string; active: boolean } }>(
    "/items/:id/settings",
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          { unitPrice: Type.String({ pattern: "^[1-9][0-9]{0,4}$" }), active: Type.Boolean() },
          { additionalProperties: false },
        ),
        response: { 200: ShopItem, ...ErrorResponses },
      },
    },
    async (req) => {
      await confirmedItemOwner(req.params.id, requireAuth(req).accountId);
      return db.begin(async (tx) => {
        const [item] = await tx`select * from business_items where id=${req.params.id} for update`;
        if (!item) throw new AppError("NOT_FOUND", "Item not found.", 404);
        await requireBusinessOwner(tx, String(item.business_id), requireAuth(req).accountId);
        if (BigInt(req.body.unitPrice) > 10000n)
          throw new AppError("INVALID_AMOUNT", "Price exceeds 10,000 QC.", 400);
        const [updated] =
          await tx`update business_items set unit_price=${req.body.unitPrice},active=${req.body.active} where id=${item.id} returning *`;
        return updated;
      });
    },
  );
  app.post<{ Params: { id: string }; Body: { amount: string; txHash: string } }>(
    "/businesses/:id/withdraw",
    {
      schema: {
        params: BusinessParams,
        body: Type.Object(
          {
            amount: Type.String({ pattern: "^[1-9][0-9]{0,6}$" }),
            txHash: ConfirmOrderBody.properties.txHash,
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ balance: Type.String() }), ...ErrorResponses },
      },
    },
    async (req) => {
      const actor = requireAuth(req).accountId,
        businessId = req.params.id,
        { amount, txHash } = req.body;
      await requireBusinessOwner(db, businessId, actor);
      const business = await viewContract<{ owner: string; treasury: string } | null>("get_business", {
        business_id: Number(businessId),
      });
      if (business?.owner !== actor)
        throw new AppError("FORBIDDEN", "Only the current business owner can withdraw.", 403);
      const verified = await verifyExpectedFunctionCall(txHash, {
        signerId: actor,
        method: "business_withdraw",
        args: { business_id: Number(businessId), amount },
        events: [
          {
            name: "business_withdrawal",
            entityId: `business:${businessId}`,
            walletFrom: business.treasury,
            walletTo: `player:${actor}`,
            amount,
          },
        ],
      });
      const proof = requireExpectedEvent(verified.events, {
        name: "business_withdrawal",
        entityId: `business:${businessId}`,
      });
      const [balance, treasury] = await Promise.all([
        readChainBalance(`player:${actor}`),
        readChainBalance(business.treasury),
      ]);
      await db.begin(async (tx) => {
        await consumeTransaction(tx, {
          txHash,
          commandType: "business_withdraw",
          entityType: "business",
          entityId: businessId,
          signerId: actor,
          receiptId: proof.receiptId!,
          eventIndex: proof.eventIndex!,
        });
        await setMirroredBalance(tx, `player:${actor}`, balance);
        await setMirroredBalance(tx, business.treasury, treasury);
        await insertLedgerEntries(tx, ledgerEntriesFromEvents(verified.events));
        await appendResolvedEconomicProjection(tx, proof);
      });
      return { balance };
    },
  );
  app.get("/orders", { schema: { response: { 200: OrdersResponse, ...ErrorResponses } } }, async (req) => ({
    orders:
      await db`select * from business_orders where buyer_account=${requireAuth(req).accountId} order by (status in ('paid','refunded','cancelled')),created_at desc,id limit 50`,
  }));
  app.post<{ Body: Static<typeof OrderBody> }>(
    "/orders",
    { schema: { body: OrderBody, response: { 200: OrderResponse, ...ErrorResponses } } },
    async (req) => ({
      order: await reserveShopOrder(db, requireAuth(req).accountId, req.body.itemId, req.body.quantity),
    }),
  );
  app.post<{ Params: { id: string }; Body: Static<typeof ConfirmOrderBody> }>(
    "/orders/:id/confirm",
    {
      schema: {
        params: IdParams,
        body: ConfirmOrderBody,
        response: { 200: OrderResponse, ...ErrorResponses },
      },
    },
    async (req) => {
      const actor = requireAuth(req).accountId,
        id = req.params.id,
        hash = req.body.txHash;
      const [order] = await db<
        CommerceOrder[]
      >`select * from business_orders where id=${id} and buyer_account=${actor}`;
      if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
      await db`update business_orders set status='confirming',tx_hash=${hash} where id=${id} and status='reserved' and tx_hash is null`;
      const verified = await verifyExpectedFunctionCall(hash, {
        signerId: actor,
        method: "pay_order",
        args: { business_id: Number(order.business_id), amount: order.total, reference: order.reference },
        events: [
          {
            name: "service_paid",
            entityId: `business:${order.business_id}`,
            walletFrom: `player:${actor}`,
            amount: order.total,
            reference: order.reference,
          },
        ],
      });
      const proof = requireExpectedEvent(verified.events, {
        name: "service_paid",
        entityId: `business:${order.business_id}`,
        reference: order.reference,
      });
      const chainBusiness = await viewContract<{ treasury: string; revenue_total: string } | null>(
        "get_business",
        { business_id: Number(order.business_id) },
      );
      if (!chainBusiness) throw new AppError("CONFLICT", "Business payment is not confirmed.", 409);
      const [buyerBalance, treasuryBalance] = await Promise.all([
        readChainBalance(`player:${actor}`),
        readChainBalance(chainBusiness.treasury),
      ]);
      await db.begin(async (tx) => {
        await consumeTransaction(tx, {
          networkId: config.networkId,
          contractId: config.contractId,
          txHash: hash,
          commandType: "pay_order",
          entityType: "order",
          entityId: id,
          signerId: actor,
          receiptId: proof.receiptId!,
          eventIndex: proof.eventIndex!,
        });
        await projectConfirmedOrder(tx, proof);
        await setMirroredBalance(tx, `player:${actor}`, buyerBalance);
        await setMirroredBalance(tx, chainBusiness.treasury, treasuryBalance);
        await tx`update businesses set revenue_total=${chainBusiness.revenue_total} where id=${order.business_id}`;
        await insertLedgerEntries(tx, ledgerEntriesFromEvents(verified.events));
        await appendResolvedEconomicProjection(tx, proof);
      });
      const [confirmed] = await db`select * from business_orders where id=${id}`;
      return { order: confirmed };
    },
  );
}
