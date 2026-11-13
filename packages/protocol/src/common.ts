import { FormatRegistry, Type } from "@sinclair/typebox";

export const AccountId = Type.String({
  minLength: 2,
  maxLength: 64,
  pattern: "^(?:[0-9a-f]{64}|[a-z0-9]+(?:[._-][a-z0-9]+)*)$",
});

export const TxHash = Type.String({
  minLength: 43,
  maxLength: 44,
  pattern: "^[1-9A-HJ-NP-Za-km-z]+$",
});

FormatRegistry.Set("qc-amount", isQcString);
FormatRegistry.Set("date-time", (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)));

export const U128_MAX = "340282366920938463463374607431768211455";

export function isQcString(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 39) {
    return false;
  }
  return BigInt(value) <= BigInt(U128_MAX);
}

export const QcAmount = Type.String({
  format: "qc-amount",
  minLength: 1,
  maxLength: 39,
});

export const Uuid = Type.String({
  minLength: 36,
  maxLength: 36,
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});

export const EntityId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:-]+$",
});

export const PageLimit = Type.Integer({ minimum: 1, maximum: 100, default: 50 });
export const PageCursor = Type.String({ minLength: 1, maxLength: 200 });
export const AnswerIndex = Type.Integer({ minimum: 0, maximum: 99 });
export const IsoTimestamp = Type.String({ format: "date-time" });

export function safeText(maxLength: number, minLength = 1) {
  return Type.String({ minLength, maxLength, pattern: "^[^\\u0000-\\u001f]*$" });
}

export const LooseObject = Type.Object({}, { additionalProperties: true });
export const LooseArray = Type.Array(LooseObject);

export const ErrorResponse = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
        requestId: Type.String(),
        details: Type.Optional(Type.Array(Type.Any())),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ErrorResponses = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  410: ErrorResponse,
  413: ErrorResponse,
  415: ErrorResponse,
  422: ErrorResponse,
  429: ErrorResponse,
  500: ErrorResponse,
  502: ErrorResponse,
  503: ErrorResponse,
  504: ErrorResponse,
} as const;

export const EmptyBody = Type.Object({}, { additionalProperties: false });
export const OkResponse = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
