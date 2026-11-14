import { Type } from "@sinclair/typebox";

export const ResidentProfile = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    username: Type.String({ minLength: 3, maxLength: 24 }),
    firstName: Type.String({ minLength: 1, maxLength: 40 }),
    accountId: Type.String(),
    walletLinked: Type.Boolean(),
    walletKind: Type.Optional(
      Type.Union([Type.Literal("browser"), Type.Literal("embedded"), Type.Literal("external")]),
    ),
    onboardingComplete: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const ProfilesResponse = Type.Object({ profiles: Type.Array(ResidentProfile, { maxItems: 8 }) });
export const CreateProfileBody = Type.Object(
  {
    username: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{2,23}$" }),
    firstName: Type.String({ minLength: 1, maxLength: 40, pattern: "^[^\\x00-\\x1f\\x7f<>]+$" }),
  },
  { additionalProperties: false },
);
export const EnterProfileBody = Type.Object(
  { id: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export const EnterProfileResponse = Type.Object({
  profile: ResidentProfile,
  csrfToken: Type.String(),
  expiresAt: Type.String(),
});
export const OnboardingBody = Type.Object(
  { answers: Type.Array(Type.Integer({ minimum: 0, maximum: 2 }), { minItems: 3, maxItems: 3 }) },
  { additionalProperties: false },
);
export const OnboardingResponse = Type.Object({
  complete: Type.Boolean(),
  score: Type.Integer(),
  total: Type.Integer(),
});

export const LinkProfileResponse = Type.Object({ profile: ResidentProfile });

/** Reserved game identities cannot be claimed through NEAR wallet authentication. */
export function isBrowserAccount(accountId: string): boolean {
  return /^guest-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(accountId);
}

export const ManagedWalletStatus = Type.Object(
  {
    enabled: Type.Boolean(),
    accountId: Type.Union([Type.String(), Type.Null()]),
    stage: Type.Union([
      Type.Literal("not_requested"),
      Type.Literal("creating_account"),
      Type.Literal("registering"),
      Type.Literal("claiming"),
      Type.Literal("ready"),
    ]),
    errorCode: Type.Union([Type.String(), Type.Null()]),
    retryAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export const ManagedWalletRequest = Type.Object(
  {
    requestId: Type.String({ format: "uuid" }),
    method: Type.String({ minLength: 1, maxLength: 40 }),
    args: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export const ManagedWalletSent = Type.Object(
  {
    txHash: Type.String(),
    state: Type.Union([Type.Literal("pending"), Type.Literal("confirmed"), Type.Literal("rejected")]),
  },
  { additionalProperties: false },
);
