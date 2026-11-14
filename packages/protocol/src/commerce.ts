import { Type } from "@sinclair/typebox";
import { QcAmount, TxHash } from "./common.js";
export const ShopItem = Type.Object(
  {
    id: Type.String(),
    business_id: Type.String(),
    sku: Type.String(),
    name: Type.String(),
    unit_price: QcAmount,
    on_hand: Type.Integer(),
    reserved: Type.Integer(),
    low_stock: Type.Integer(),
    active: Type.Boolean(),
  },
  { additionalProperties: true },
);
export const ShopOrder = Type.Object(
  {
    id: Type.String(),
    buyer_account: Type.String(),
    business_id: Type.String(),
    item_id: Type.String(),
    item_name: Type.String(),
    quantity: Type.Integer(),
    unit_price: QcAmount,
    total: QcAmount,
    reference: Type.String(),
    status: Type.String(),
    tx_hash: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: true },
);
export const CatalogueResponse = Type.Object({ items: Type.Array(ShopItem, { maxItems: 100 }) });
export const OrdersResponse = Type.Object({ orders: Type.Array(ShopOrder, { maxItems: 50 }) });
export const ItemBody = Type.Object(
  {
    sku: Type.String({ pattern: "^[a-z0-9_-]{3,40}$" }),
    name: Type.String({ minLength: 1, maxLength: 60 }),
    unitPrice: QcAmount,
    quantity: Type.Integer({ minimum: 0, maximum: 10 }),
    lowStock: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
  },
  { additionalProperties: false },
);
export const OrderBody = Type.Object(
  { itemId: Type.String({ format: "uuid" }), quantity: Type.Integer({ minimum: 1, maximum: 1000 }) },
  { additionalProperties: false },
);
export const OrderResponse = Type.Object({ order: ShopOrder });
export const ConfirmOrderBody = Type.Object({ txHash: TxHash }, { additionalProperties: false });
export const StockBody = Type.Object(
  {
    quantity: Type.Integer({ minimum: 1, maximum: 1000000 }),
    reference: Type.String({ minLength: 3, maxLength: 100 }),
  },
  { additionalProperties: false },
);

export const CommerceCapabilities = Type.Object({ orderPayments: Type.Boolean() });
export const WithdrawResponse = Type.Object({ balance: QcAmount });
