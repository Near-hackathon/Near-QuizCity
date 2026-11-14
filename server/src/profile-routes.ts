import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { Type, type Static } from "@sinclair/typebox";
import {
  CreateProfileBody,
  EnterProfileBody,
  EnterProfileResponse,
  ProfilesResponse,
  ResidentProfile,
  OnboardingBody,
  OnboardingResponse,
} from "@quiz-city/protocol";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { ErrorResponses } from "./schemas/index.js";
import { requireAuth, sessionCookie } from "./auth/plugin.js";
import { SESSION_TTL_MS } from "./auth/service.js";
import {
  establishProfileDevice,
  isActiveProfileDevice,
  completeOnboarding,
  createProfile,
  DEVICE_TTL_SECONDS,
  enterProfile,
  listProfiles,
  linkProfileWallet,
} from "./profiles.js";
import {
  allocateManagedWallet,
  ensureManagedWalletForProfile,
  assertOwnedManagedProfile,
} from "./managed-wallets.js";
const DEVICE_COOKIE = "qc_device";
function deviceCookie(header?: string) {
  return (
    header
      ?.split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${DEVICE_COOKIE}=`))
      ?.slice(DEVICE_COOKIE.length + 1) ?? null
  );
}
export function registerProfileRoutes(app: FastifyInstance, cfg: AppConfig, injected?: Sql) {
  const db = async () => injected ?? (await import("./db.js")).sql;
  const secure =
    cfg.appEnv === "staging" || cfg.appEnv === "production" || cfg.webOrigin.startsWith("https:");
  const checkOrigin = (origin?: string) => {
    if (origin !== cfg.webOrigin) throw new AppError("FORBIDDEN", "Open the game from its own website.", 403);
  };
  app.post(
    "/v1/profiles/device",
    {
      schema: {
        body: Type.Object({}, { additionalProperties: false }),
        response: { 200: Type.Object({ ok: Type.Literal(true) }), ...ErrorResponses },
      },
    },
    async (req, reply) => {
      checkOrigin(req.headers.origin);
      const token = await establishProfileDevice(await db(), deviceCookie(req.headers.cookie));
      reply.header(
        "set-cookie",
        `${DEVICE_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${DEVICE_TTL_SECONDS}${secure ? "; Secure" : ""}`,
      );
      return { ok: true };
    },
  );
  app.get(
    "/v1/profiles",
    { schema: { response: { 200: ProfilesResponse, ...ErrorResponses } } },
    async (req) => ({ profiles: await listProfiles(await db(), deviceCookie(req.headers.cookie)) }),
  );
  app.post<{ Body: Static<typeof CreateProfileBody> }>(
    "/v1/profiles",
    { schema: { body: CreateProfileBody, response: { 200: EnterProfileResponse, ...ErrorResponses } } },
    async (req, reply) => {
      checkOrigin(req.headers.origin);
      if (
        cfg.autoTestnetWallets &&
        !(await isActiveProfileDevice(await db(), deviceCookie(req.headers.cookie)))
      )
        throw new AppError(
          "DEVICE_REQUIRED",
          "Prepare this browser for signup before creating a resident.",
          409,
        );
      const created = await createProfile(
        await db(),
        deviceCookie(req.headers.cookie),
        req.body,
        cfg.autoTestnetWallets ? allocateManagedWallet(cfg) : undefined,
      );
      const entered = await enterProfile(await db(), created.deviceToken, created.profile.id);
      reply.header("set-cookie", [
        `${DEVICE_COOKIE}=${created.deviceToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${DEVICE_TTL_SECONDS}${secure ? "; Secure" : ""}`,
        sessionCookie(entered.sessionToken, SESSION_TTL_MS / 1000, secure),
      ]);
      return { profile: entered.profile, csrfToken: entered.csrfToken, expiresAt: entered.expiresAt };
    },
  );
  app.post<{ Body: Static<typeof EnterProfileBody> }>(
    "/v1/profiles/enter",
    { schema: { body: EnterProfileBody, response: { 200: EnterProfileResponse, ...ErrorResponses } } },
    async (req, reply) => {
      checkOrigin(req.headers.origin);
      const client = await db();
      await assertOwnedManagedProfile(client, req.body.id, deviceCookie(req.headers.cookie));
      await ensureManagedWalletForProfile(client, cfg, req.body.id);
      const result = await enterProfile(client, deviceCookie(req.headers.cookie), req.body.id);
      reply.header("set-cookie", sessionCookie(result.sessionToken, SESSION_TTL_MS / 1000, secure));
      return { profile: result.profile, csrfToken: result.csrfToken, expiresAt: result.expiresAt };
    },
  );
  app.post<{ Body: Static<typeof OnboardingBody> }>(
    "/v1/profiles/onboarding",
    { schema: { body: OnboardingBody, response: { 200: OnboardingResponse, ...ErrorResponses } } },
    async (req) => completeOnboarding(await db(), requireAuth(req).accountId, req.body.answers),
  );
  app.post<{ Body: { profileId?: string } }>(
    "/v1/profiles/link-wallet",
    {
      schema: {
        body: Type.Object(
          { profileId: Type.Optional(Type.String({ format: "uuid" })) },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ profile: ResidentProfile }), ...ErrorResponses },
      },
    },
    async (req, reply) => {
      const principal = requireAuth(req);
      const client = await db();
      const [session] =
        await client`select session_kind from auth_sessions where token_hash=${principal.sessionTokenHash}`;
      if (session?.session_kind !== "wallet")
        throw new AppError(
          "FORBIDDEN",
          "Sign a fresh wallet login before linking or recovering a resident.",
          403,
        );
      const result = await linkProfileWallet(
        client,
        deviceCookie(req.headers.cookie),
        principal.accountId,
        req.body.profileId,
      );
      reply.header(
        "set-cookie",
        `${DEVICE_COOKIE}=${result.deviceToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${DEVICE_TTL_SECONDS}${secure ? "; Secure" : ""}`,
      );
      return { profile: result.profile };
    },
  );
}
