import { createHash } from "node:crypto";
import { serialize, type Schema } from "borsh";

/**
 * NEP-413 sign-in payload.
 *
 * The signer and verifier build `{ message, nonce, recipient, callbackUrl }`,
 * Borsh-serialize it in the standard field order, prefix the four-byte Borsh
 * encoding of `2^31 + 413`, and sign/verify the SHA-256 digest of that buffer
 * with an account full-access key. See
 * https://github.com/near/NEPs/blob/master/neps/nep-0413.md.
 */
export type AuthPayload = {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
};

export type AuthPayloadInput = {
  accountId: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
  networkId: string;
  issuedAt: string;
  expiresAt: string;
};

export const NEP413_TAG = 2 ** 31 + 413;
export const NONCE_BYTES = 32;

const payloadSchema = {
  struct: {
    message: "string",
    nonce: { array: { type: "u8", len: NONCE_BYTES } },
    recipient: "string",
    callbackUrl: { option: "string" },
  },
} satisfies Schema;

export function buildAuthPayload(input: AuthPayloadInput): AuthPayload {
  return {
    message: [
      `Sign in to ${input.callbackUrl ?? ""} as ${input.accountId}`,
      `Network: ${input.networkId}`,
      `Issued: ${input.issuedAt}`,
      `Expires: ${input.expiresAt}`,
    ].join("\n"),
    nonce: input.nonce,
    recipient: input.recipient,
    callbackUrl: input.callbackUrl,
  };
}

/** Borsh encoding of the NEP-413 payload (without the tag prefix). */
export function borshSerializeAuthPayload(payload: AuthPayload): Uint8Array {
  return serialize(payloadSchema, {
    message: payload.message,
    nonce: payload.nonce,
    recipient: payload.recipient,
    callbackUrl: payload.callbackUrl,
  });
}

/** Exact 32-byte digest signed by NEP-413 wallets. */
export function nep413Digest(payload: AuthPayload): Uint8Array {
  if (payload.nonce.length !== NONCE_BYTES) {
    throw new Error("NEP-413 nonce must be exactly 32 bytes");
  }
  if (payload.recipient.length === 0) {
    throw new Error("NEP-413 recipient is required");
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(NEP413_TAG, 0);
  return createHash("sha256")
    .update(Buffer.concat([prefix, Buffer.from(borshSerializeAuthPayload(payload))]))
    .digest();
}

/** Decode the base64 nonce transport without accepting malformed input. */
export function decodeNonceBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("nonce must be valid base64");
  }
  const bytes = Buffer.from(value, "base64");
  const canonical = bytes.toString("base64");
  if (canonical !== value || bytes.length !== NONCE_BYTES) {
    throw new Error("nonce must be exactly 32 bytes of base64");
  }
  return bytes;
}
