import { Type, type TProperties } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { QcAmount, AccountId } from "@quiz-city/protocol";
import { AppError } from "./errors.js";
const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const ref = Type.String({ minLength: 1, maxLength: 128 });
const wallet = Type.String({ minLength: 3, maxLength: 96, pattern: "^(player|biz|gov|npc):[a-z0-9._-]+$" });
const uuid = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
const object = (p: TProperties) => Type.Object(p, { additionalProperties: false });
const charge = { source_wallet: wallet, to_wallet: wallet, amount: QcAmount, reference: ref };
const methods = {
  register_player: object({ username: Type.String({ pattern: "^[a-z][a-z0-9_]{2,23}$" }) }),
  claim_starter: object({}),
  buy_property: object({ property_id: id }),
  create_business: object({ property_id: id, name: Type.String({ minLength: 1, maxLength: 48 }) }),
  pay_order: object({ business_id: id, amount: QcAmount, reference: ref }),
  business_withdraw: object({ business_id: id, amount: QcAmount }),
  transfer_business: object({ business_id: id, new_owner: AccountId }),
  list_property: object({ property_id: id, price: QcAmount }),
  cancel_property_listing: object({ property_id: id }),
  list_business: object({ business_id: id, price: QcAmount }),
  buy_business: object({ business_id: id, expected_owner: AccountId, expected_price: QcAmount }),
  list_lease: object({
    property_id: id,
    rent: QcAmount,
    period_days: Type.Union([Type.Literal(7), Type.Literal(30)]),
  }),
  pay_rent: object({ property_id: id, expected_owner: wallet, amount: QcAmount, reference: ref }),
  pay_charge: object(charge),
  cancel_charge: object(charge),
  pay_admission: object({ business_id: id, amount: QcAmount, reference: ref }),
  refund_order: object({ business_id: id, buyer_wallet: wallet, amount: QcAmount, order_reference: ref }),
  refund_admission: object({
    business_id: id,
    buyer_wallet: wallet,
    amount: QcAmount,
    payment_reference: ref,
  }),
  cancel_order: object({ reference: ref }),
  fund_escrow: object({
    id: uuid,
    source_wallet: wallet,
    beneficiary_wallet: Type.Union([wallet, Type.Null()]),
    amount: QcAmount,
    purpose: Type.Union(
      ["job", "prize", "supply", "admission", "rent", "upkeep", "public_contract"].map((p) =>
        Type.Literal(p),
      ),
    ),
  }),
  sponsor_quiz: object({ id: uuid, source_wallet: wallet, amount: QcAmount, reference: ref }),
  pay_business_tax: object({
    business_id: id,
    period: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }),
};
/** No arbitrary receiver, deposit, gas, account/key administration or operator method is signable. */
export function validateManagedWalletCall(method: string, args: Record<string, unknown>): void {
  const schema = methods[method as keyof typeof methods];
  if (!Object.hasOwn(methods, method) || !schema || !Value.Check(schema, args))
    throw new AppError(
      "VALIDATION_ERROR",
      "This wallet can sign only supported game actions with valid arguments.",
      400,
    );
}
