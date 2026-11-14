import { Type, type Static } from "@sinclair/typebox";
import { AnswerIndex, LooseObject, QcAmount, Uuid, safeText } from "./common.js";

export const QuizParams = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
export const StartQuizBody = Type.Object({}, { additionalProperties: false });
export const SubmitQuizBody = Type.Object(
  {
    attemptId: Uuid,
    answers: Type.Record(Type.String({ maxLength: 128 }), AnswerIndex, {
      maxProperties: 100,
    }),
  },
  { additionalProperties: false },
);

export const SnapshotQuestionResponse = Type.Object(
  {
    id: Type.String(),
    question: Type.String(),
    options: Type.Array(Type.String()),
    category: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const StartQuizResponse = Type.Object(
  {
    attemptId: Type.String(),
    expiresAt: Type.Optional(Type.String({ format: "date-time" })),
    passScore: Type.Optional(Type.Integer({ minimum: 1 })),
    rewardAmount: Type.Optional(QcAmount),
    quizId: Type.String(),
    questions: Type.Array(SnapshotQuestionResponse),
  },
  { additionalProperties: false },
);

export const SubmitQuizResponse = Type.Object(
  {
    score: Type.Integer(),
    total: Type.Integer(),
    reward: QcAmount,
    txHash: Type.Union([Type.String(), Type.Null()]),
    alreadySubmitted: Type.Boolean(),
    status: Type.String(),
  },
  { additionalProperties: false },
);

export const QuizResponse = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    draft_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    reward_pool: QcAmount,
    entry_fee: QcAmount,
    status: Type.String(),
    questions: Type.Integer(),
  },
  { additionalProperties: true },
);

export const QuizzesResponse = Type.Array(LooseObject);
export const QuizzesPage = Type.Object(
  {
    items: Type.Array(QuizResponse),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export { safeText };

export type StartQuizBodyType = Static<typeof StartQuizBody>;
export type SubmitQuizBodyType = Static<typeof SubmitQuizBody>;
export type QuizParamsType = Static<typeof QuizParams>;
