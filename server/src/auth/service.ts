import { isBrowserAccount } from "@quiz-city/protocol";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Sql } from "postgres";
import { providers, utils } from "near-api-js";
import { AppError } from "../errors.js";
import { buildAuthPayload, decodeNonceBase64, nep413Digest } from "./message.js";
import {
  consumeNonce,
  findNonce,
  findSession,
  insertNonce,
  insertSession,
  recentNonceCount,
  revokeSession,
  rolesFor,
  type AuthClient,
} from "./repository.js";

export type AuthRuntime = {
  networkId: string;
  contractId: string;
  webOrigin: string;
  rpcUrl: string;
};

export type AccountAccessKey = {
  publicKey: string;
  permission: "FullAccess" | { FunctionCall: unknown };
};

export type AuthDeps = {
  listAccessKeys: (accountId: string) => Promise<AccountAccessKey[]>;
  verifySignature: (publicKey: string, message: Uint8Array, signature: string) => boolean;
  now: () => Date;
};

export const NONCE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const NONCE_RATE_LIMIT = 5;
const NONCE_RATE_WINDOW_MS = 60 * 1000;

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function domainFor(runtime: AuthRuntime): string {
  return new URL(runtime.webOrigin).origin;
}

export function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function defaultListAccessKeys(runtime: AuthRuntime) {
  const provider = new providers.JsonRpcProvider({ url: runtime.rpcUrl });
  return async (accountId: string): Promise<AccountAccessKey[]> => {
    const result = (await provider.query({
      request_type: "view_access_key_list",
      finality: "final",
      account_id: accountId,
    })) as unknown as {
      keys?: { public_key: string; access_key?: { permission?: unknown } }[];
    };
    return (result.keys ?? []).map((entry) => {
      const permission = entry.access_key?.permission;
      return {
        publicKey: entry.public_key,
        permission:
          permission === "FullAccess"
            ? "FullAccess"
            : { FunctionCall: (permission as { FunctionCall?: unknown } | undefined)?.FunctionCall },
      };
    });
  };
}

export function verifySignatureWithPublicKey(
  publicKey: string,
  message: Uint8Array,
  signature: string,
): boolean {
  try {
    const key = utils.PublicKey.fromString(publicKey);
    return key.verify(Buffer.from(message), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function defaultAuthDeps(runtime: AuthRuntime): AuthDeps {
  return {
    listAccessKeys: defaultListAccessKeys(runtime),
    verifySignature: verifySignatureWithPublicKey,
    now: () => new Date(),
  };
}

export type NonceResult = {
  accountId: string;
  nonce: string;
  message: string;
  expiresAt: string;
  domain: string;
  networkId: string;
  recipient: string;
  callbackUrl: string;
};

export async function issueNonce(
  client: Sql,
  runtime: AuthRuntime,
  accountId: string,
  deps: AuthDeps = defaultAuthDeps(runtime),
): Promise<NonceResult> {
  if (isBrowserAccount(accountId))
    throw new AppError("FORBIDDEN", "This account name is reserved for a browser resident.", 403);
  const issuedAt = deps.now();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
  const domain = domainFor(runtime);
  const nonceBytes = randomBytes(32);
  const nonce = nonceBytes.toString("base64");

  return client.begin(async (transaction) => {
    await transaction`
      select pg_advisory_xact_lock(hashtext(${`auth-nonce:${accountId}`}))
    `;
    await transaction`delete from auth_nonces where expires_at < ${issuedAt}`;
    await transaction`delete from auth_sessions where expires_at < ${issuedAt}`;
    const recent = await recentNonceCount(
      transaction,
      accountId,
      new Date(issuedAt.getTime() - NONCE_RATE_WINDOW_MS),
    );
    if (recent >= NONCE_RATE_LIMIT) {
      throw new AppError("RATE_LIMITED", "too many login nonces; try again shortly", 429);
    }

    const payload = buildAuthPayload({
      accountId,
      nonce: nonceBytes,
      recipient: runtime.contractId,
      callbackUrl: domain,
      networkId: runtime.networkId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const messageHash = createHash("sha256").update(nep413Digest(payload)).digest("hex");
    await insertNonce(transaction, {
      accountId,
      nonceHash: hashToken(nonce),
      domain,
      networkId: runtime.networkId,
      issuedAt,
      expiresAt,
      messageHash,
    });
    return {
      accountId,
      nonce,
      message: payload.message,
      expiresAt: expiresAt.toISOString(),
      domain,
      networkId: runtime.networkId,
      recipient: runtime.contractId,
      callbackUrl: payload.callbackUrl ?? domain,
    };
  });
}

export type LoginInput = {
  accountId: string;
  publicKey: string;
  signature: string;
  nonce: string;
};

export type LoginResult = {
  accountId: string;
  roles: string[];
  csrfToken: string;
  sessionToken: string;
  expiresAt: string;
};

export async function verifyLogin(
  client: Sql,
  runtime: AuthRuntime,
  input: LoginInput,
  deps: AuthDeps = defaultAuthDeps(runtime),
): Promise<LoginResult> {
  if (isBrowserAccount(input.accountId))
    throw new AppError("FORBIDDEN", "This account name is reserved for a browser resident.", 403);
  const now = deps.now();
  let nonceBytes: Uint8Array;
  try {
    nonceBytes = decodeNonceBase64(input.nonce);
  } catch {
    throw new AppError("UNAUTHORIZED", "nonce must be a 32-byte base64 value", 401);
  }
  const nonceHash = hashToken(input.nonce);
  const row = await findNonce(client, input.accountId, nonceHash, now);
  if (!row) {
    throw new AppError("UNAUTHORIZED", "nonce is invalid, expired, or already used", 401);
  }
  if (row.network_id !== runtime.networkId || row.domain !== domainFor(runtime)) {
    throw new AppError("UNAUTHORIZED", "login nonce does not match this application", 401);
  }

  const payload = buildAuthPayload({
    accountId: row.account_id,
    nonce: nonceBytes,
    recipient: runtime.contractId,
    callbackUrl: row.domain,
    networkId: row.network_id,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  });
  const digest = nep413Digest(payload);
  const messageHash = createHash("sha256").update(digest).digest("hex");
  if (!row.message_hash || !safeHashEqual(row.message_hash, messageHash)) {
    throw new AppError("UNAUTHORIZED", "login message does not match the issued nonce", 401);
  }

  const keys = await deps.listAccessKeys(input.accountId);
  const key = keys.find((entry) => entry.publicKey === input.publicKey);
  if (!key) {
    throw new AppError("UNAUTHORIZED", "public key is not an access key for this account", 401);
  }
  if (key.permission !== "FullAccess") {
    throw new AppError("UNAUTHORIZED", "login requires a full-access key", 401);
  }
  if (!deps.verifySignature(input.publicKey, digest, input.signature)) {
    throw new AppError("UNAUTHORIZED", "login signature is invalid", 401);
  }

  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  return client.begin(async (transaction) => {
    const consumed = await consumeNonce(transaction, input.accountId, nonceHash, now);
    if (!consumed) {
      throw new AppError("UNAUTHORIZED", "nonce was already used", 401);
    }
    await insertSession(transaction, {
      tokenHash: hashToken(sessionToken),
      accountId: input.accountId,
      csrfHash: hashToken(csrfToken),
      expiresAt,
    });
    return {
      accountId: input.accountId,
      roles: await rolesFor(transaction, input.accountId),
      csrfToken,
      sessionToken,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

export type AuthPrincipal = {
  accountId: string;
  roles: string[];
  sessionTokenHash: string;
  csrfHash: string;
  expiresAt: string;
};

export async function authenticateSession(
  client: AuthClient,
  sessionToken: string,
  now: Date,
): Promise<AuthPrincipal | null> {
  const row = await findSession(client, hashToken(sessionToken), now);
  if (!row) return null;
  return {
    accountId: row.account_id,
    roles: row.session_kind === "browser" ? ["player"] : await rolesFor(client, row.account_id),
    sessionTokenHash: row.token_hash,
    csrfHash: row.csrf_hash,
    expiresAt: row.expires_at.toISOString(),
  };
}

export async function logoutSession(client: AuthClient, sessionToken: string, now: Date): Promise<void> {
  await revokeSession(client, hashToken(sessionToken), now);
}
