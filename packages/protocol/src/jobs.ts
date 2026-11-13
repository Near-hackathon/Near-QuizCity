import { Type, type Static } from "@sinclair/typebox";
import { LooseObject, QcAmount, safeText } from "./common.js";

export const JobParams = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);

export const AcceptJobBody = Type.Object({}, { additionalProperties: false });
export const SubmitJobBody = Type.Object({ deliverable: safeText(2000) }, { additionalProperties: false });
export const VerifyJobBody = Type.Object(
  { notes: Type.Optional(safeText(500)) },
  { additionalProperties: false },
);
export const CompleteJobBody = Type.Object({}, { additionalProperties: false });
export const RetryJobBody = Type.Object({}, { additionalProperties: false });

export const JobResponse = Type.Object(
  {
    id: Type.String(),
    employer_wallet: Type.String(),
    employee_account: Type.Union([Type.String(), Type.Null()]),
    title: Type.String(),
    description: Type.String(),
    payment: QcAmount,
    status: Type.String(),
    reference: Type.String(),
    chain_tx: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: true },
);

export const CompleteJobResponse = Type.Object(
  {
    job: JobResponse,
    txHash: Type.Union([Type.String(), Type.Null()]),
    balance: Type.Optional(QcAmount),
    alreadyPaid: Type.Optional(Type.Boolean()),
    paymentPending: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const RetryJobResponse = Type.Object(
  {
    job: JobResponse,
    reconciled: Type.Optional(Type.Boolean()),
    alreadyPaid: Type.Optional(Type.Boolean()),
    retryAllowed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const JobsResponse = Type.Array(JobResponse);
export const JobsPage = Type.Object(
  {
    items: Type.Array(JobResponse),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export { LooseObject };

export type AcceptJobBodyType = Static<typeof AcceptJobBody>;
export type SubmitJobBodyType = Static<typeof SubmitJobBody>;
export type VerifyJobBodyType = Static<typeof VerifyJobBody>;
export type CompleteJobBodyType = Static<typeof CompleteJobBody>;
export type JobParamsType = Static<typeof JobParams>;
