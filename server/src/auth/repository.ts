import type { Sql, TransactionSql } from "postgres";

export type AuthClient = Sql | TransactionSql;

export type NonceRow = {
  account_id: string;
  nonce_hash: string;
  domain: string;
  network_id: string;
  issued_at: Date;
  expires_at: Date;
  message_hash: string | null;
};

export type SessionRow = {
  token_hash: string;
  account_id: string;
  csrf_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  session_kind: "wallet" | "browser";
};

export async function recentNonceCount(client: AuthClient, accountId: string, since: Date): Promise<number> {
  const [row] = await client<{ count: number }[]>`
    select count(*)::int as count from auth_nonces
    where account_id = ${accountId} and issued_at >= ${since}
  `;
  return row?.count ?? 0;
}

export async function insertNonce(
  client: AuthClient,
  input: {
    accountId: string;
    nonceHash: string;
    domain: string;
    networkId: string;
    issuedAt: Date;
    expiresAt: Date;
    messageHash: string;
  },
): Promise<void> {
  await client`
    insert into auth_nonces (
      account_id, nonce_hash, domain, network_id, issued_at, expires_at, message_hash
    ) values (
      ${input.accountId}, ${input.nonceHash}, ${input.domain}, ${input.networkId},
      ${input.issuedAt}, ${input.expiresAt}, ${input.messageHash}
    )
  `;
}

export async function consumeNonce(
  client: AuthClient,
  accountId: string,
  nonceHash: string,
  now: Date,
): Promise<NonceRow | null> {
  const [row] = await client<NonceRow[]>`
    update auth_nonces set used_at = ${now}
    where nonce_hash = ${nonceHash}
      and account_id = ${accountId}
      and used_at is null
      and expires_at > ${now}
    returning account_id, nonce_hash, domain, network_id, issued_at, expires_at, message_hash
  `;
  return row ?? null;
}

export async function findNonce(
  client: AuthClient,
  accountId: string,
  nonceHash: string,
  now: Date,
): Promise<NonceRow | null> {
  const [row] = await client<NonceRow[]>`
    select account_id, nonce_hash, domain, network_id, issued_at, expires_at, message_hash
    from auth_nonces
    where nonce_hash = ${nonceHash}
      and account_id = ${accountId}
      and used_at is null
      and expires_at > ${now}
  `;
  return row ?? null;
}

export async function insertSession(
  client: AuthClient,
  input: {
    tokenHash: string;
    accountId: string;
    csrfHash: string;
    expiresAt: Date;
    sessionKind?: "wallet" | "browser";
  },
): Promise<void> {
  await client`
    insert into auth_sessions (token_hash, account_id, csrf_hash, expires_at, session_kind)
    values (${input.tokenHash}, ${input.accountId}, ${input.csrfHash}, ${input.expiresAt}, ${input.sessionKind ?? "wallet"})
  `;
}

export async function findSession(
  client: AuthClient,
  tokenHash: string,
  now: Date,
): Promise<SessionRow | null> {
  const [row] = await client<SessionRow[]>`
    update auth_sessions set last_seen_at = ${now}
    where token_hash = ${tokenHash}
      and revoked_at is null
      and expires_at > ${now}
    returning token_hash, account_id, csrf_hash, expires_at, revoked_at, session_kind
  `;
  return row ?? null;
}

export async function revokeSession(client: AuthClient, tokenHash: string, now: Date): Promise<void> {
  await client`
    update auth_sessions set revoked_at = ${now}
    where token_hash = ${tokenHash} and revoked_at is null
  `;
}

export async function rolesFor(client: AuthClient, accountId: string): Promise<string[]> {
  const rows = await client<{ role: string }[]>`
    select role from account_roles where account_id = ${accountId} order by role
  `;
  return rows.map((row) => row.role);
}

export async function ensureRole(
  client: AuthClient,
  accountId: string,
  role: "player" | "operator" | "admin",
): Promise<void> {
  await client`
    insert into account_roles (account_id, role) values (${accountId}, ${role})
    on conflict (account_id, role) do nothing
  `;
}
