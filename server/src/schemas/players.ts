import { Type, type Static } from "@sinclair/typebox";
import { AccountId, LooseObject, QcAmount, TxHash, safeText } from "./common.js";

export const PlayerParams = Type.Object({ account: AccountId }, { additionalProperties: false });
export const RegisterBody = Type.Object(
  {
    username: safeText(32),
    txHash: TxHash,
  },
  { additionalProperties: false },
);
export const ClaimBody = Type.Object(
  {
    txHash: TxHash,
  },
  { additionalProperties: false },
);

export const PlayerResponse = Type.Object(
  {
    account_id: Type.String(),
    username: Type.String(),
    reputation: Type.Integer(),
    created_at: Type.String(),
    wallet: Type.Union([
      Type.Object({ balance: QcAmount, updated_at: Type.String() }, { additionalProperties: false }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const RegisterResponse = Type.Object(
  {
    accountId: Type.String(),
    username: Type.String(),
    starter_claimed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ClaimResponse = Type.Object({ balance: QcAmount }, { additionalProperties: false });

export type RegisterBodyType = Static<typeof RegisterBody>;
export type ClaimBodyType = Static<typeof ClaimBody>;
export type PlayerParamsType = Static<typeof PlayerParams>;
export { LooseObject };
