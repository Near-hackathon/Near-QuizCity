import { serialize, type Schema } from "borsh";

export const NEP413_TAG = 2 ** 31 + 413;
export const NONCE_BYTES = 32;

export type Nep413Payload = {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
};

const payloadSchema = {
  struct: {
    message: "string",
    nonce: { array: { type: "u8", len: NONCE_BYTES } },
    recipient: "string",
    callbackUrl: { option: "string" },
  },
} satisfies Schema;

/** SHA-256(Borsh(u32(2147484061)) || Borsh(payload)) — the NEP-413 digest. */
export async function nep413Digest(payload: Nep413Payload): Promise<Uint8Array> {
  if (payload.nonce.length !== NONCE_BYTES) {
    throw new Error("wallet nonce must be exactly 32 bytes");
  }
  const body = serialize(payloadSchema, {
    message: payload.message,
    nonce: payload.nonce,
    recipient: payload.recipient,
    callbackUrl: payload.callbackUrl,
  });
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, NEP413_TAG, true);
  const combined = new Uint8Array(prefix.length + body.length);
  combined.set(prefix, 0);
  combined.set(body, prefix.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
}

export function decodeNonce(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("wallet nonce is not valid base64");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("wallet nonce is not valid base64");
  }
  if (binary.length !== NONCE_BYTES) {
    throw new Error("wallet nonce must be exactly 32 bytes");
  }
  const bytes = new Uint8Array(NONCE_BYTES);
  for (let index = 0; index < NONCE_BYTES; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
