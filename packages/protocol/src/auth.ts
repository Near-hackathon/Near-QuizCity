import { Type, type Static } from "@sinclair/typebox";
import { AccountId } from "./common.js";

export const PublicKey = Type.String({
  minLength: 10,
  maxLength: 100,
  pattern: "^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$",
});

export const Signature = Type.String({ minLength: 40, maxLength: 200 });

export const NonceBody = Type.Object({ accountId: AccountId }, { additionalProperties: false });
export const VerifyBody = Type.Object(
  {
    accountId: AccountId,
    publicKey: PublicKey,
    signature: Signature,
    nonce: Type.String({ minLength: 20, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export const LogoutBody = Type.Object({}, { additionalProperties: false });

export const NonceResponse = Type.Object(
  {
    accountId: Type.String(),
    nonce: Type.String(),
    message: Type.String(),
    expiresAt: Type.String(),
    domain: Type.String(),
    networkId: Type.String(),
    recipient: Type.String(),
    callbackUrl: Type.String(),
  },
  { additionalProperties: false },
);

export const VerifyResponse = Type.Object(
  {
    accountId: Type.String(),
    roles: Type.Array(Type.String()),
    csrfToken: Type.String(),
    expiresAt: Type.String(),
  },
  { additionalProperties: false },
);

export const MeResponse = Type.Object(
  {
    accountId: Type.String(),
    roles: Type.Array(Type.String()),
    expiresAt: Type.String(),
  },
  { additionalProperties: false },
);

export type NonceBodyType = Static<typeof NonceBody>;
export type VerifyBodyType = Static<typeof VerifyBody>;
