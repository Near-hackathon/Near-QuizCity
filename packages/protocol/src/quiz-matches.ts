import { Type } from "@sinclair/typebox";
import { AccountId, QcAmount, Uuid, IsoTimestamp, AnswerIndex } from "./common.js";
import { CityOperation } from "./city-economy.js";
export const MatchId = Type.Object({ id: Uuid }, { additionalProperties: false });
export const CreateMatch = Type.Object(
  {
    requestId: Uuid,
    stake: QcAmount,
    visibility: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("public")])),
  },
  { additionalProperties: false },
);
export const SearchMatch = Type.Object({ requestId: Uuid, stake: QcAmount }, { additionalProperties: false });
export const JoinPublicMatch = Type.Object({ requestId: Uuid }, { additionalProperties: false });
export const PublicMatchQuery = Type.Object(
  { q: Type.Optional(Type.String({ maxLength: 40 })), stake: Type.Optional(QcAmount) },
  { additionalProperties: false },
);
export const PublicMatchesResponse = Type.Object(
  {
    rooms: Type.Array(
      Type.Object(
        {
          id: Uuid,
          host: Type.String(),
          stake: QcAmount,
          venueFee: QcAmount,
          prize: QcAmount,
          expiresAt: IsoTimestamp,
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);
export const JoinMatch = Type.Object(
  { requestId: Uuid, code: Type.String({ pattern: "^[A-Fa-f0-9]{10}$" }) },
  { additionalProperties: false },
);
export const SubmitMatch = Type.Object(
  { answers: Type.Record(Type.String({ maxLength: 100 }), AnswerIndex, { maxProperties: 5 }) },
  { additionalProperties: false },
);
const date = Type.Union([IsoTimestamp, Type.Null()]);
const question = Type.Object(
  { id: Type.String(), question: Type.String(), options: Type.Array(Type.String()), source: Type.String() },
  { additionalProperties: false },
);
export const QuizMatch = Type.Object(
  {
    id: Uuid,
    code: Type.String(),
    visibility: Type.Union([Type.Literal("private"), Type.Literal("public")]),
    state: Type.String(),
    outcome: Type.Union([Type.String(), Type.Null()]),
    winnerAccount: Type.Union([AccountId, Type.Null()]),
    feePolicy: Type.Union([Type.Literal("added-5-v1"), Type.Literal("deducted-2-v2")]),
    stake: QcAmount,
    venueFee: QcAmount,
    gasSupportFee: QcAmount,
    totalDue: QcAmount,
    prize: QcAmount,
    joinExpiresAt: IsoTimestamp,
    startsAt: date,
    endsAt: date,
    participants: Type.Array(
      Type.Object(
        {
          accountId: AccountId,
          username: Type.String(),
          funded: Type.Boolean(),
          submitted: Type.Boolean(),
          score: Type.Union([Type.Integer(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
    operation: CityOperation,
    questions: Type.Array(question),
    review: Type.Array(
      Type.Object(
        { questionId: Type.String(), correctIndex: AnswerIndex, explanation: Type.String() },
        { additionalProperties: false },
      ),
    ),
    transfers: Type.Array(
      Type.Object(
        {
          kind: Type.String(),
          amount: QcAmount,
          recipientWallet: Type.String(),
          state: Type.String(),
          txHash: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const MatchResponse = Type.Object({ match: QuizMatch }, { additionalProperties: false });
export const MatchesResponse = Type.Object(
  { matches: Type.Array(QuizMatch) },
  { additionalProperties: false },
);
