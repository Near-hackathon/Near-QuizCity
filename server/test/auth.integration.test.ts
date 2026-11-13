import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { Sql } from "postgres";
import { AppError, registerErrorHandler } from "../src/errors.js";
import { ajvOptions } from "../src/fastify-options.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import {
  authenticateSession,
  issueNonce,
  logoutSession,
  NONCE_RATE_LIMIT,
  verifyLogin,
  verifySignatureWithPublicKey,
  hashToken,
  type AccountAccessKey,
  type AuthDeps,
  type AuthRuntime,
} from "../src/auth/service.js";
import { buildAuthPayload, nep413Digest, decodeNonceBase64 } from "../src/auth/message.js";
import { KeyPair } from "near-api-js";
import {
  clearSessionCookie,
  registerAuthPlugin,
  requireRole,
  sessionCookie,
  SESSION_COOKIE,
} from "../src/auth/plugin.js";
import { withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));

async function migrate(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

const runtime: AuthRuntime = {
  networkId: "testnet",
  contractId: "quizcity.testnet",
  webOrigin: "http://localhost:5173",
  rpcUrl: "https://rpc.testnet.fastnear.com",
};

function authDeps(
  options: {
    now?: () => Date;
    valid?: boolean;
    keys?: AccountAccessKey[];
  } = {},
): AuthDeps {
  return {
    listAccessKeys: async () =>
      options.keys ?? [{ publicKey: "ed25519:11111111111111111111111111111111", permission: "FullAccess" }],
    verifySignature: () => options.valid ?? true,
    now: options.now ?? (() => new Date()),
  };
}

test("nonce issuance signs a bounded canonical login message", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const now = new Date("2026-11-12T10:00:00.000Z");
    const nonce = await issueNonce(sql, runtime, "alice.testnet", authDeps({ now: () => now }));
    assert.equal(nonce.accountId, "alice.testnet");
    assert.equal(nonce.domain, "http://localhost:5173");
    assert.equal(nonce.networkId, "testnet");
    assert.equal(nonce.recipient, "quizcity.testnet");
    assert.equal(nonce.recipient, "quizcity.testnet");
    assert.equal(nonce.callbackUrl, "http://localhost:5173");
    assert.match(nonce.message, /Sign in to http:\/\/localhost:5173 as alice\.testnet/);
    assert.match(nonce.message, /Network: testnet/);
    assert.match(nonce.message, /Issued: 2026-11-12T10:00:00\.000Z/);
    assert.match(nonce.message, /Expires: 2026-11-12T10:05:00\.000Z/);
    assert.equal(decodeNonceBase64(nonce.nonce).length, 32);
    const [row] = await sql`select nonce_hash, used_at, expires_at, message_hash from auth_nonces`;
    assert.notEqual(row.nonce_hash, nonce.nonce);
    assert.equal(row.message_hash.length, 64);
    assert.equal(row.used_at, null);
  });
});

test("nonce rate limiting refuses bursts", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const now = new Date("2026-11-12T10:00:00.000Z");
    for (let index = 0; index < NONCE_RATE_LIMIT; index += 1) {
      await issueNonce(sql, runtime, "alice.testnet", authDeps({ now: () => now }));
    }
    await assert.rejects(
      issueNonce(sql, runtime, "alice.testnet", authDeps({ now: () => now })),
      (error: unknown) => error instanceof AppError && error.code === "RATE_LIMITED",
    );
  });
});

test("login verification consumes a nonce once and creates an opaque session", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const now = new Date("2026-11-12T10:00:00.000Z");
    const deps = authDeps({ now: () => now });
    const nonce = await issueNonce(sql, runtime, "alice.testnet", deps);

    const login = await verifyLogin(
      sql,
      runtime,
      {
        accountId: "alice.testnet",
        publicKey: "ed25519:11111111111111111111111111111111",
        signature: "signature",
        nonce: nonce.nonce,
      },
      deps,
    );
    assert.equal(login.accountId, "alice.testnet");
    assert.ok(login.sessionToken.length > 20);
    assert.ok(login.csrfToken.length > 20);

    const [session] = await sql`select token_hash, csrf_hash from auth_sessions`;
    assert.notEqual(session.token_hash, login.sessionToken);
    assert.notEqual(session.csrf_hash, login.csrfToken);

    await assert.rejects(
      verifyLogin(
        sql,
        runtime,
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:11111111111111111111111111111111",
          signature: "signature",
          nonce: nonce.nonce,
        },
        deps,
      ),
      (error: unknown) => error instanceof AppError && error.code === "UNAUTHORIZED",
    );
  });
});

test("expired, wrong-account, wrong-domain, and invalid signatures fail", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    let now = new Date("2026-11-12T10:00:00.000Z");
    const deps = authDeps({ now: () => now });
    const nonce = await issueNonce(sql, runtime, "alice.testnet", deps);

    now = new Date("2026-11-12T10:06:00.000Z");
    await assert.rejects(
      verifyLogin(
        sql,
        runtime,
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:11111111111111111111111111111111",
          signature: "signature",
          nonce: nonce.nonce,
        },
        deps,
      ),
      (error: unknown) => error instanceof AppError && error.code === "UNAUTHORIZED",
    );

    now = new Date("2026-11-12T10:00:00.000Z");
    const second = await issueNonce(sql, runtime, "alice.testnet", deps);
    await assert.rejects(
      verifyLogin(
        sql,
        runtime,
        {
          accountId: "bob.testnet",
          publicKey: "ed25519:11111111111111111111111111111111",
          signature: "signature",
          nonce: second.nonce,
        },
        deps,
      ),
      (error: unknown) => error instanceof AppError && error.code === "UNAUTHORIZED",
    );

    const third = await issueNonce(sql, runtime, "alice.testnet", deps);
    await sql`update auth_nonces set domain = 'http://evil.example' where used_at is null`;
    await assert.rejects(
      verifyLogin(
        sql,
        runtime,
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:11111111111111111111111111111111",
          signature: "signature",
          nonce: third.nonce,
        },
        deps,
      ),
      (error: unknown) => error instanceof AppError && error.code === "UNAUTHORIZED",
    );

    const fourth = await issueNonce(sql, runtime, "alice.testnet", deps);
    await assert.rejects(
      verifyLogin(
        sql,
        runtime,
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:11111111111111111111111111111111",
          signature: "bad",
          nonce: fourth.nonce,
        },
        authDeps({ now: () => now, valid: false }),
      ),
      (error: unknown) => error instanceof AppError && error.code === "UNAUTHORIZED",
    );
  });
});

test("sessions expire and revoke", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    let now = new Date("2026-11-12T10:00:00.000Z");
    const deps = authDeps({ now: () => now });
    const nonce = await issueNonce(sql, runtime, "alice.testnet", deps);
    const login = await verifyLogin(
      sql,
      runtime,
      {
        accountId: "alice.testnet",
        publicKey: "ed25519:11111111111111111111111111111111",
        signature: "signature",
        nonce: nonce.nonce,
      },
      deps,
    );
    const active = await authenticateSession(sql, login.sessionToken, now);
    assert.equal(active?.accountId, "alice.testnet");

    now = new Date("2026-11-12T19:00:00.000Z");
    assert.equal(await authenticateSession(sql, login.sessionToken, now), null);

    now = new Date("2026-11-12T10:00:00.000Z");
    await logoutSession(sql, login.sessionToken, now);
    assert.equal(await authenticateSession(sql, login.sessionToken, now), null);
  });
});

test("auth plugin protects commands, enforces CSRF, and exposes only documented public routes", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const now = new Date("2026-11-12T10:00:00.000Z");
    const deps = authDeps({ now: () => now });
    const nonce = await issueNonce(sql, runtime, "alice.testnet", deps);
    const login = await verifyLogin(
      sql,
      runtime,
      {
        accountId: "alice.testnet",
        publicKey: "ed25519:11111111111111111111111111111111",
        signature: "signature",
        nonce: nonce.nonce,
      },
      deps,
    );

    const app = Fastify({ ajv: { customOptions: ajvOptions } });
    registerErrorHandler(app);
    registerAuthPlugin(app, runtime, { client: sql, deps });
    app.get("/v1/config", async () => ({ ok: true }));
    app.post("/protected", async (request) => ({
      accountId: request.auth?.accountId,
    }));
    app.post("/admin-only", async (request) => ({
      accountId: requireRole(request, ["admin"]).accountId,
    }));
    await app.ready();

    const publicRead = await app.inject({ method: "GET", url: "/v1/config" });
    assert.equal(publicRead.statusCode, 200);

    const anonymous = await app.inject({ method: "POST", url: "/protected", payload: {} });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().error.code, "UNAUTHORIZED");

    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(login.sessionToken)}`;
    const noCsrf = await app.inject({
      method: "POST",
      url: "/protected",
      payload: { accountId: "bob.testnet" },
      headers: { cookie },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.json().error.code, "FORBIDDEN");

    const authenticated = await app.inject({
      method: "POST",
      url: "/protected",
      payload: { accountId: "bob.testnet" },
      headers: { cookie, "x-csrf-token": login.csrfToken },
    });
    assert.equal(authenticated.statusCode, 200);
    assert.equal(authenticated.json().accountId, "alice.testnet");

    const forbidden = await app.inject({
      method: "POST",
      url: "/admin-only",
      payload: {},
      headers: { cookie, "x-csrf-token": login.csrfToken },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error.code, "FORBIDDEN");

    await app.close();
  });
});

test("a real Ed25519 signature over the returned bytes verifies", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const key = KeyPair.fromRandom("ed25519");
    const publicKey = key.getPublicKey().toString();
    const now = new Date("2026-11-12T10:00:00.000Z");
    const deps: AuthDeps = {
      listAccessKeys: async () => [{ publicKey, permission: "FullAccess" }],
      verifySignature: verifySignatureWithPublicKey,
      now: () => now,
    };
    const nonce = await issueNonce(sql, runtime, "alice.testnet", deps);
    const digest = nep413Digest(
      buildAuthPayload({
        accountId: "alice.testnet",
        nonce: decodeNonceBase64(nonce.nonce),
        recipient: runtime.contractId,
        callbackUrl: nonce.callbackUrl,
        networkId: runtime.networkId,
        issuedAt: "2026-11-12T10:00:00.000Z",
        expiresAt: "2026-11-12T10:05:00.000Z",
      }),
    );
    const signed = key.sign(digest);
    const login = await verifyLogin(
      sql,
      runtime,
      {
        accountId: "alice.testnet",
        publicKey,
        signature: Buffer.from(signed.signature).toString("base64"),
        nonce: nonce.nonce,
      },
      deps,
    );
    assert.equal(login.accountId, "alice.testnet");
    const [row] = await sql`select used_at from auth_nonces`;
    assert.ok(row.used_at);
  });
});

test("failed verification does not consume the nonce and concurrent verify creates one session", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const now = new Date("2026-11-12T10:00:00.000Z");
    const deps = authDeps({ now: () => now, valid: false });
    const nonce = await issueNonce(sql, runtime, "alice.testnet", deps);
    await assert.rejects(
      verifyLogin(
        sql,
        runtime,
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:11111111111111111111111111111111",
          signature: "bad",
          nonce: nonce.nonce,
        },
        deps,
      ),
      /signature is invalid/,
    );
    const [unused] = await sql`select used_at from auth_nonces`;
    assert.equal(unused.used_at, null);

    const validDeps = authDeps({ now: () => now });
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        verifyLogin(
          sql,
          runtime,
          {
            accountId: "alice.testnet",
            publicKey: "ed25519:11111111111111111111111111111111",
            signature: "signature",
            nonce: nonce.nonce,
          },
          validDeps,
        ),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const [sessions] = await sql`select count(*)::int as count from auth_sessions`;
    assert.equal(sessions.count, 1);
  });
});

test("concurrent nonce issuance cannot exceed the account limit", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const now = new Date("2026-11-12T10:00:00.000Z");
    const deps = authDeps({ now: () => now });
    const results = await Promise.allSettled(
      Array.from({ length: NONCE_RATE_LIMIT + 1 }, () => issueNonce(sql, runtime, "alice.testnet", deps)),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, NONCE_RATE_LIMIT);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  });
});

test("cookies use secure deployment policy and matching clear attributes", () => {
  const secure = sessionCookie("token", 100, true);
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /SameSite=Lax/);
  assert.match(secure, /Path=\//);
  assert.match(secure, /Secure/);
  const clearedSecure = clearSessionCookie(true);
  assert.match(clearedSecure, /Max-Age=0/);
  assert.match(clearedSecure, /Secure/);

  const local = sessionCookie("token", 100, false);
  assert.doesNotMatch(local, /Secure/);
  const clearedLocal = clearSessionCookie(false);
  assert.doesNotMatch(clearedLocal, /Secure/);
});

test("official NEP-413 example produces the expected digest", () => {
  const digest = nep413Digest({
    message: "hi",
    nonce: Uint8Array.from({ length: 32 }, (_, index) => index),
    recipient: "myapp.com",
    callbackUrl: "myapp.com/callback",
  });
  assert.equal(
    Buffer.from(digest).toString("hex"),
    "c9ce5de288f7de6d83e2303e56c7615949da83867ea33c0747ed45c47ef50148",
  );
});

test("a signature over raw JSON bytes or a function-call key cannot log in", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const key = KeyPair.fromRandom("ed25519");
    const publicKey = key.getPublicKey().toString();
    const now = new Date("2026-11-12T10:00:00.000Z");

    const rawDeps: AuthDeps = {
      listAccessKeys: async () => [{ publicKey, permission: "FullAccess" }],
      verifySignature: verifySignatureWithPublicKey,
      now: () => now,
    };
    const rawNonce = await issueNonce(sql, runtime, "alice.testnet", rawDeps);
    const rawSignature = key.sign(new TextEncoder().encode(rawNonce.message));
    await assert.rejects(
      verifyLogin(
        sql,
        runtime,
        {
          accountId: "alice.testnet",
          publicKey,
          signature: Buffer.from(rawSignature.signature).toString("base64"),
          nonce: rawNonce.nonce,
        },
        rawDeps,
      ),
      /signature is invalid/,
    );
    const [unused] = await sql`select used_at from auth_nonces where nonce_hash = ${hashToken(
      rawNonce.nonce,
    )}`;
    assert.equal(unused.used_at, null);

    const callDeps: AuthDeps = {
      listAccessKeys: async () => [{ publicKey, permission: { FunctionCall: {} } }],
      verifySignature: verifySignatureWithPublicKey,
      now: () => now,
    };
    const callNonce = await issueNonce(sql, runtime, "alice.testnet", callDeps);
    const digest = nep413Digest(
      buildAuthPayload({
        accountId: "alice.testnet",
        nonce: decodeNonceBase64(callNonce.nonce),
        recipient: runtime.contractId,
        callbackUrl: callNonce.callbackUrl,
        networkId: runtime.networkId,
        issuedAt: "2026-11-12T10:00:00.000Z",
        expiresAt: "2026-11-12T10:05:00.000Z",
      }),
    );
    const signed = key.sign(digest);
    await assert.rejects(
      verifyLogin(
        sql,
        runtime,
        {
          accountId: "alice.testnet",
          publicKey,
          signature: Buffer.from(signed.signature).toString("base64"),
          nonce: callNonce.nonce,
        },
        callDeps,
      ),
      /full-access/,
    );
  });
});

test("invalid nonce encodings and access-key provider failures do not consume the nonce", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const now = new Date("2026-11-12T10:00:00.000Z");
    const deps = authDeps({ now: () => now });
    const nonce = await issueNonce(sql, runtime, "alice.testnet", deps);

    for (const invalid of [
      "",
      Buffer.alloc(0).toString("base64"),
      Buffer.alloc(31).toString("base64"),
      Buffer.alloc(33).toString("base64"),
      "not base64!!",
    ]) {
      await assert.rejects(
        verifyLogin(
          sql,
          runtime,
          {
            accountId: "alice.testnet",
            publicKey: "ed25519:11111111111111111111111111111111",
            signature: "signature",
            nonce: invalid,
          },
          deps,
        ),
        (error: unknown) => error instanceof AppError && error.code === "UNAUTHORIZED",
      );
    }

    const failingDeps: AuthDeps = {
      listAccessKeys: async () => {
        throw new Error("provider unavailable");
      },
      verifySignature: () => true,
      now: () => now,
    };
    await assert.rejects(
      verifyLogin(
        sql,
        runtime,
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:11111111111111111111111111111111",
          signature: "signature",
          nonce: nonce.nonce,
        },
        failingDeps,
      ),
      /provider unavailable/,
    );
    const [row] = await sql`select used_at from auth_nonces`;
    assert.equal(row.used_at, null);
  });
});

test("wrong network, recipient, and stored message binding are rejected", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const now = new Date("2026-11-12T10:00:00.000Z");
    const deps = authDeps({ now: () => now });
    const nonce = await issueNonce(sql, runtime, "alice.testnet", deps);
    await sql`update auth_nonces set network_id = 'mainnet' where used_at is null`;
    await assert.rejects(
      verifyLogin(
        sql,
        runtime,
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:11111111111111111111111111111111",
          signature: "signature",
          nonce: nonce.nonce,
        },
        deps,
      ),
      (error: unknown) => error instanceof AppError && error.code === "UNAUTHORIZED",
    );

    const second = await issueNonce(sql, runtime, "alice.testnet", deps);
    await sql`update auth_nonces set message_hash = ${"0".repeat(64)} where used_at is null`;
    await assert.rejects(
      verifyLogin(
        sql,
        runtime,
        {
          accountId: "alice.testnet",
          publicKey: "ed25519:11111111111111111111111111111111",
          signature: "signature",
          nonce: second.nonce,
        },
        deps,
      ),
      /does not match/,
    );
  });
});
