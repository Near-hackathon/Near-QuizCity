import { isBrowserAccount } from "@quiz-city/protocol";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { AppError } from "./errors.js";
import { hashToken, randomToken, SESSION_TTL_MS } from "./auth/service.js";
import { insertSession } from "./auth/repository.js";

export const DEVICE_TTL_SECONDS = 365 * 24 * 60 * 60;
export type ProfileRow = {
  id: string;
  username: string;
  first_name: string;
  account_id: string;
  wallet_linked: boolean;
  onboarding_complete: boolean;
  wallet_kind?: "browser" | "embedded" | "external";
};
export function publicProfile(row: ProfileRow) {
  return {
    id: row.id,
    username: row.username,
    firstName: row.first_name,
    accountId: row.account_id,
    walletLinked: row.wallet_linked,
    walletKind: row.wallet_kind ?? (row.wallet_linked ? "external" : "browser"),
    onboardingComplete: row.onboarding_complete,
  };
}
export async function listProfiles(sql: Sql, deviceToken: string | null) {
  if (!deviceToken) return [];
  const rows = await sql<
    ProfileRow[]
  >`select p.* from resident_profiles p join browser_profile_access a on a.profile_id=p.id join browser_devices d on d.token_hash=a.device_hash where d.token_hash=${hashToken(deviceToken)} and d.expires_at>now() order by p.created_at limit 8`;
  return rows.map(publicProfile);
}
async function activeDeviceToken(sql: Sql, token: string | null): Promise<string> {
  if (token) {
    const [device] =
      await sql`select token_hash from browser_devices where token_hash=${hashToken(token)} and expires_at>now()`;
    if (device) return token;
  }
  return randomToken();
}

export async function createProfile(
  sql: Sql,
  deviceToken: string | null,
  input: { username: string; firstName: string },
  allocate?: (tx: import("postgres").TransactionSql, profile: ProfileRow) => Promise<void>,
) {
  const token = await activeDeviceToken(sql, deviceToken);
  const deviceHash = hashToken(token);
  const firstName = input.firstName.trim();
  if (!firstName) throw new AppError("VALIDATION_ERROR", "Enter your first name.", 400);
  try {
    const profile = await sql.begin(async (tx) => {
      await tx`insert into browser_devices(token_hash,expires_at) values (${deviceHash},now()+interval '365 days') on conflict(token_hash) do update set expires_at=excluded.expires_at`;
      await tx`select token_hash from browser_devices where token_hash=${deviceHash} for update`;
      const [existing] = await tx<
        ProfileRow[]
      >`select p.* from resident_profiles p join browser_profile_access a on a.profile_id=p.id where a.device_hash=${deviceHash} and lower(p.username)=${input.username.toLowerCase()}`;
      if (existing) {
        if (existing.first_name !== firstName)
          throw new AppError(
            "CONFLICT",
            "This username is already saved in your browser. Choose the existing resident.",
            409,
          );
        return publicProfile(existing);
      }
      const [count] =
        await tx`select count(*)::int as n from browser_profile_access where device_hash=${deviceHash}`;
      if (count.n >= 8) throw new AppError("PROFILE_LIMIT", "This browser already has eight residents.", 409);
      const id = randomUUID();
      const [row] = await tx<
        ProfileRow[]
      >`insert into resident_profiles(id,device_hash,username,first_name,account_id) values (${id},${deviceHash},${input.username.toLowerCase()},${firstName},${`guest-${id}`}) returning *`;
      await tx`insert into browser_profile_access(device_hash,profile_id) values (${deviceHash},${id})`;
      if (allocate) {
        await allocate(tx, row);
        row.wallet_kind = "embedded";
      }
      return publicProfile(row);
    });
    return { profile, deviceToken: token };
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new AppError("USERNAME_TAKEN", "That username is already in the city. Try another.", 409);
    throw error;
  }
}
export async function enterProfile(sql: Sql, deviceToken: string | null, id: string) {
  if (!deviceToken)
    throw new AppError("PROFILE_NOT_FOUND", "This resident is not saved in this browser.", 404);
  return sql.begin(async (tx) => {
    const [row] = await tx<
      ProfileRow[]
    >`select p.* from resident_profiles p join browser_profile_access a on a.profile_id=p.id join browser_devices d on d.token_hash=a.device_hash where p.id=${id} and d.token_hash=${hashToken(deviceToken)} and d.expires_at>now() for update of p`;
    if (!row) throw new AppError("PROFILE_NOT_FOUND", "This resident is not saved in this browser.", 404);
    const sessionToken = randomToken(),
      csrfToken = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    // Device sessions never inherit admin/operator roles, including after wallet linking.
    await insertSession(tx, {
      tokenHash: hashToken(sessionToken),
      accountId: row.account_id,
      csrfHash: hashToken(csrfToken),
      expiresAt,
      sessionKind: "browser",
    });
    return { profile: publicProfile(row), sessionToken, csrfToken, expiresAt: expiresAt.toISOString() };
  });
}
export async function completeOnboarding(sql: Sql, accountId: string, answers: number[]) {
  const score = answers.reduce((n, a, i) => n + (a === [0, 1, 2][i] ? 1 : 0), 0);
  if (score === 3)
    await sql`update resident_profiles set onboarding_complete=true where account_id=${accountId}`;
  return { complete: score === 3, score, total: 3 };
}

export async function linkProfileWallet(
  sql: Sql,
  deviceToken: string | null,
  accountId: string,
  profileId?: string,
) {
  if (isBrowserAccount(accountId)) throw new AppError("FORBIDDEN", "Prove wallet ownership first.", 403);
  const token = await activeDeviceToken(sql, deviceToken),
    deviceHash = hashToken(token);
  const profile = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`profile-wallet:${accountId}`},0))`;
    await tx`insert into browser_devices(token_hash,expires_at) values (${deviceHash},now()+interval '365 days') on conflict(token_hash) do update set expires_at=excluded.expires_at`;
    const [existing] = await tx<
      ProfileRow[]
    >`select p.* from resident_profiles p left join managed_wallets w on w.profile_id=p.id where (p.account_id=${accountId} and p.wallet_linked=true) or (w.account_id=${accountId} and w.stage<>'creating_account') for update of p`;
    if (existing) {
      if (profileId && profileId !== existing.id)
        throw new AppError("CONFLICT", "That wallet already belongs to another resident.", 409);
      const [access] =
        await tx`select profile_id from browser_profile_access where device_hash=${deviceHash} and profile_id=${existing.id}`;
      if (!access) {
        const [count] =
          await tx`select count(*)::int as n from browser_profile_access where device_hash=${deviceHash}`;
        if (count.n >= 8)
          throw new AppError("PROFILE_LIMIT", "This browser already has eight residents.", 409);
      }
      await tx`insert into browser_profile_access(device_hash,profile_id) values (${deviceHash},${existing.id}) on conflict do nothing`;
      return publicProfile(existing);
    }
    if (!profileId) throw new AppError("NOT_FOUND", "No resident is linked to this wallet yet.", 404);
    const [owned] = await tx<
      ProfileRow[]
    >`select p.* from resident_profiles p join browser_profile_access a on a.profile_id=p.id where p.id=${profileId} and a.device_hash=${deviceHash} for update of p`;
    if (!owned || owned.wallet_linked || owned.wallet_kind === "embedded")
      throw new AppError("FORBIDDEN", "Choose a resident saved in this browser.", 403);
    await tx`update player_presence set player_account=${accountId} where player_account=${owned.account_id}`;
    await tx`update auth_sessions set revoked_at=now() where account_id=${owned.account_id}`;
    const [linked] = await tx<
      ProfileRow[]
    >`update resident_profiles set account_id=${accountId},wallet_linked=true,wallet_kind='external' where id=${owned.id} returning *`;
    return publicProfile(linked);
  });
  return { profile, deviceToken: token };
}

export async function establishProfileDevice(sql: Sql, existing: string | null) {
  const token = await activeDeviceToken(sql, existing);
  await sql`insert into browser_devices(token_hash,expires_at) values(${hashToken(token)},now()+interval '365 days') on conflict(token_hash) do nothing`;
  return token;
}
export async function isActiveProfileDevice(sql: Sql, token: string | null) {
  if (!token) return false;
  const [d] =
    await sql`select token_hash from browser_devices where token_hash=${hashToken(token)} and expires_at>now()`;
  return !!d;
}
