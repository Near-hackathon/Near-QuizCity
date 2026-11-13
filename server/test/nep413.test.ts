import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { nep413Digest as serverDigest } from "../src/auth/message.js";
import { verifySignatureWithPublicKey } from "../src/auth/service.js";
import { KeyPair } from "near-api-js";
import { decodeNonce, nep413Digest as webDigest } from "../../web/src/nep413.js";

test("browser and server produce the same NEP-413 digest", async () => {
  const payload = {
    message: "Sign in to http://localhost:5173 as alice.testnet",
    nonce: new Uint8Array(randomBytes(32)),
    recipient: "quizcity.testnet",
    callbackUrl: "http://localhost:5173",
  };
  const server = serverDigest(payload);
  const web = await webDigest(payload);
  assert.deepEqual(Buffer.from(web), Buffer.from(server));
  assert.equal(web.length, 32);
});

test("browser nonce decoding accepts only 32-byte base64", () => {
  const valid = randomBytes(32).toString("base64");
  assert.equal(decodeNonce(valid).length, 32);
  for (const invalid of [
    "",
    Buffer.alloc(0).toString("base64"),
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
    "not base64!!",
  ]) {
    assert.throws(() => decodeNonce(invalid), /32 bytes|valid base64/);
  }
});

test("demo-style signing over the browser digest verifies with the server verifier", async () => {
  const key = KeyPair.fromRandom("ed25519");
  const publicKey = key.getPublicKey().toString();
  const payload = {
    message: "Sign in to http://localhost:5173 as alice.testnet",
    nonce: new Uint8Array(randomBytes(32)),
    recipient: "quizcity.testnet",
    callbackUrl: "http://localhost:5173",
  };
  const digest = await webDigest(payload);
  const signature = Buffer.from(key.sign(digest).signature).toString("base64");
  assert.equal(verifySignatureWithPublicKey(publicKey, digest, signature), true);

  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const rawSignature = Buffer.from(key.sign(raw).signature).toString("base64");
  assert.equal(verifySignatureWithPublicKey(publicKey, digest, rawSignature), false);
});
