import type { Sql } from "postgres";
import type { FastifyInstance } from "fastify";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { AppConfig } from "../config.js";
import { ErrorResponses } from "../schemas/index.js";
import {
  LogoutBody,
  MeResponse,
  NonceBody,
  NonceResponse,
  VerifyBody,
  VerifyResponse,
} from "../schemas/auth.js";
import { clearSessionCookie, parseSessionCookie, requireAuth, sessionCookie } from "./plugin.js";
import { issueNonce, logoutSession, SESSION_TTL_MS, verifyLogin, type AuthRuntime } from "./service.js";

const LogoutResponse = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });

async function defaultDb() {
  const module = await import("../db.js");
  return module.sql;
}

export function registerAuthRoutes(app: FastifyInstance, cfg: AppConfig, injected?: Sql): void {
  const db = async () => injected ?? (await defaultDb());
  const runtime: AuthRuntime = {
    networkId: cfg.networkId,
    contractId: cfg.contractId,
    webOrigin: cfg.webOrigin,
    rpcUrl: cfg.rpcUrl,
  };
  const secure =
    cfg.appEnv === "staging" || cfg.appEnv === "production" || new URL(cfg.webOrigin).protocol === "https:";

  app.post<{ Body: Static<typeof NonceBody> }>(
    "/v1/auth/nonce",
    {
      schema: {
        body: NonceBody,
        response: { 200: NonceResponse, ...ErrorResponses },
      },
    },
    async (request) => issueNonce(await db(), runtime, request.body.accountId),
  );

  app.post<{ Body: Static<typeof VerifyBody> }>(
    "/v1/auth/verify",
    {
      schema: {
        body: VerifyBody,
        response: { 200: VerifyResponse, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await verifyLogin(await db(), runtime, request.body);
      reply.header(
        "set-cookie",
        sessionCookie(result.sessionToken, Math.floor(SESSION_TTL_MS / 1000), secure),
      );
      return {
        accountId: result.accountId,
        roles: result.roles,
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt,
      };
    },
  );

  app.get(
    "/v1/auth/me",
    { schema: { response: { 200: MeResponse, ...ErrorResponses } } },
    async (request) => {
      const principal = requireAuth(request);
      return {
        accountId: principal.accountId,
        roles: principal.roles,
        expiresAt: principal.expiresAt,
      };
    },
  );

  app.post<{ Body: Static<typeof LogoutBody> }>(
    "/v1/auth/logout",
    {
      schema: {
        body: LogoutBody,
        response: { 200: LogoutResponse, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const token = parseSessionCookie(request.headers.cookie);
      if (token) await logoutSession(await db(), token, new Date());
      reply.header("set-cookie", clearSessionCookie(secure));
      return { ok: true };
    },
  );
}
