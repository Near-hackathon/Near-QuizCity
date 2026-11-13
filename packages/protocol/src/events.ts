import { Type, type Static } from "@sinclair/typebox";
import { EntityId, IsoTimestamp, QcAmount } from "./common.js";

const EnvelopeBase = {
  eventId: Type.String({ minLength: 1, maxLength: 128 }),
  sequence: Type.Integer({ minimum: 0 }),
  serverTime: IsoTimestamp,
  entityId: EntityId,
};

export const JobStatusEvent = Type.Object(
  {
    ...EnvelopeBase,
    entityType: Type.Literal("job"),
    type: Type.Literal("job.status_changed"),
    payload: Type.Object(
      {
        jobId: Type.String({ minLength: 1, maxLength: 128 }),
        status: Type.String({ minLength: 1, maxLength: 64 }),
        txHash: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const WalletBalanceEvent = Type.Object(
  {
    ...EnvelopeBase,
    entityType: Type.Literal("wallet"),
    type: Type.Literal("wallet.balance_changed"),
    payload: Type.Object(
      {
        walletId: Type.String({ minLength: 1, maxLength: 128 }),
        balance: QcAmount,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const QuizRewardEvent = Type.Object(
  {
    ...EnvelopeBase,
    entityType: Type.Literal("quiz_attempt"),
    type: Type.Literal("quiz.reward_updated"),
    payload: Type.Object(
      {
        attemptId: Type.String({ minLength: 1, maxLength: 128 }),
        rewardState: Type.String({ minLength: 1, maxLength: 32 }),
        reward: QcAmount,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const EconomySnapshotEvent = Type.Object(
  {
    ...EnvelopeBase,
    entityType: Type.Literal("economy"),
    type: Type.Literal("economy.snapshot"),
    payload: Type.Object(
      {
        circulatingQc: QcAmount,
        mirroredWalletSum: QcAmount,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ProtocolEvent = Type.Union([
  JobStatusEvent,
  WalletBalanceEvent,
  QuizRewardEvent,
  EconomySnapshotEvent,
]);

export type JobStatusEventType = Static<typeof JobStatusEvent>;
export type WalletBalanceEventType = Static<typeof WalletBalanceEvent>;
export type QuizRewardEventType = Static<typeof QuizRewardEvent>;
export type EconomySnapshotEventType = Static<typeof EconomySnapshotEvent>;
export type ProtocolEventType = Static<typeof ProtocolEvent>;

/** Compile-time exhaustiveness helper for the event union. */
export function assertNeverEvent(event: never): never {
  throw new Error(`Unhandled protocol event: ${JSON.stringify(event)}`);
}
