import { describe, expect, it } from "vitest";
import { decodeNonce, nep413Digest } from "./nep413";

describe("NEP-413 browser signer", () => {
  it("matches the official NEP-413 example digest", async () => {
    const digest = await nep413Digest({
      message: "hi",
      nonce: Uint8Array.from({ length: 32 }, (_, index) => index),
      recipient: "myapp.com",
      callbackUrl: "myapp.com/callback",
    });
    const hex = Array.from(digest)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe("c9ce5de288f7de6d83e2303e56c7615949da83867ea33c0747ed45c47ef50148");
  });

  it("decodes only 32-byte base64 nonces", () => {
    const valid = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    expect(decodeNonce(valid)).toHaveLength(32);
    for (const invalid of ["", "abc", btoa("short"), "not base64!!"]) {
      expect(() => decodeNonce(invalid)).toThrow(/32 bytes|valid base64/);
    }
  });
});
