import { Type, type Static } from "@sinclair/typebox";
import { AccountId, EntityId, LooseObject, QcAmount, TxHash, safeText } from "./common.js";

export const PropertyParams = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 20, pattern: "^[1-9][0-9]*$" }) },
  { additionalProperties: false },
);
export const BusinessParams = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 20, pattern: "^[1-9][0-9]*$" }) },
  { additionalProperties: false },
);

export const BuyPropertyBody = Type.Object({ txHash: TxHash }, { additionalProperties: false });
export const CreateBusinessBody = Type.Object(
  {
    propertyId: Type.Integer({ minimum: 1 }),
    name: safeText(48),
    txHash: TxHash,
  },
  { additionalProperties: false },
);
export const PayServiceBody = Type.Object(
  {
    amount: QcAmount,
    txHash: TxHash,
  },
  { additionalProperties: false },
);
export const TransferBusinessBody = Type.Object(
  {
    newOwner: AccountId,
    txHash: TxHash,
  },
  { additionalProperties: false },
);

export const PropertyResponse = Type.Object(
  {
    id: Type.Integer(),
    kind: Type.String(),
    district: Type.String(),
    x: Type.Integer(),
    y: Type.Integer(),
    owner: Type.String(),
    price: QcAmount,
    for_sale: Type.Boolean(),
    transfer_count: Type.Integer(),
  },
  { additionalProperties: true },
);
export const PropertyListResponse = Type.Array(LooseObject);
export const BusinessResponse = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    owner: Type.String(),
    property_id: Type.Integer(),
    treasury: Type.String(),
    revenue_total: QcAmount,
  },
  { additionalProperties: true },
);
export const BusinessListResponse = Type.Array(LooseObject);

export const BuyPropertyResponse = Type.Object(
  {
    property: PropertyResponse,
    seller: Type.String(),
    price: QcAmount,
  },
  { additionalProperties: false },
);
export const PayServiceResponse = Type.Object(
  {
    business: BusinessResponse,
    amount: QcAmount,
  },
  { additionalProperties: false },
);
export const TransferBusinessResponse = Type.Object(
  { business: BusinessResponse },
  { additionalProperties: false },
);

export { EntityId };

export type BuyPropertyBodyType = Static<typeof BuyPropertyBody>;
export type CreateBusinessBodyType = Static<typeof CreateBusinessBody>;
export type PayServiceBodyType = Static<typeof PayServiceBody>;
export type TransferBusinessBodyType = Static<typeof TransferBusinessBody>;
