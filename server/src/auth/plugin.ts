import { isBrowserAccount } from "@quiz-city/protocol";
import type { Sql } from "postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import {
  authenticateSession,
  hashToken,
  safeHashEqual,
  type AuthDeps,
  type AuthPrincipal,
  type AuthRuntime,
} from "./service.js";

export const SESSION_COOKIE = "qc_session";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthPrincipal | null;
  }
}

const PUBLIC_ROUTES = new Set([
  "GET /health/live",
  "GET /health/ready",
  "GET /v1/config",
  "GET /v1/demo/accounts",
  "GET /v1/players",
  "GET /v1/players/:account",
  "GET /v1/properties",
  "GET /v1/businesses",
  "GET /v1/economy",
  "GET /v1/contract/stats",
  "GET /v1/snapshots",
  "GET /v1/npcs",
  "GET /v1/jobs",
  "GET /v1/quizzes",
  "GET /v1/profiles",
  "POST /v1/profiles",
  "POST /v1/profiles/device",
  "POST /v1/profiles/enter",
  "GET /v1/profiles/:id/wallet",
  "POST /v1/profiles/:id/wallet/retry",
  "POST /v1/auth/nonce",
  "POST /v1/auth/verify",
]);

export function isPublicRoute(method: string, url: string, rawUrl: string): boolean {
  if (rawUrl.startsWith("/documentation")) return true;
  return PUBLIC_ROUTES.has(`${method} ${url}`);
}

export function parseSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function registerAuthPlugin(
  app: FastifyInstance,
  runtime: AuthRuntime,
  options: { client?: Sql; deps?: Partial<AuthDeps> } = {},
): void {
  let defaultClient: Promise<Sql> | null = null;
  const resolveClient = async (): Promise<Sql> => {
    if (options.client) return options.client;
    defaultClient ??= import("../db.js").then((module) => module.sql);
    return defaultClient;
  };
  app.decorateRequest("auth", null);
  app.addHook("preValidation", async (request) => {
    if (isPublicRoute(request.method, request.routeOptions.url ?? request.url, request.url)) {
      return;
    }
    const token = parseSessionCookie(request.headers.cookie);
    if (!token) {
      throw new AppError("UNAUTHORIZED", "authentication required", 401);
    }
    const principal = await authenticateSession(
      await resolveClient(),
      token,
      (options.deps?.now ?? (() => new Date()))(),
    );
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "session is invalid, expired, or revoked", 401);
    }
    if (
      isBrowserAccount(principal.accountId) &&
      request.method === "POST" &&
      !["/v1/profiles/onboarding", "/v1/auth/logout", "/v1/profiles/:id/wallet/backup"].includes(
        request.routeOptions.url ?? "",
      )
    ) {
      throw new AppError(
        "WALLET_REQUIRED",
        "Connect a wallet in your phone before using the city economy.",
        403,
      );
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const csrf = request.headers["x-csrf-token"];
      if (typeof csrf !== "string" || !safeHashEqual(hashToken(csrf), principal.csrfHash)) {
        throw new AppError("FORBIDDEN", "missing or invalid CSRF token", 403);
      }
    }
    request.auth = principal;
  });

  app.log.info(
    { domain: new URL(runtime.webOrigin).origin, publicRoutes: [...PUBLIC_ROUTES] },
    "authentication plugin registered",
  );
}

export function requireAuth(request: FastifyRequest): AuthPrincipal {
  if (!request.auth) {
    throw new AppError("UNAUTHORIZED", "authentication required", 401);
  }
  return request.auth;
}

export function requireRole(
  request: FastifyRequest,
  roles: Array<"player" | "operator" | "admin">,
): AuthPrincipal {
  const principal = requireAuth(request);
  if (!roles.some((role) => principal.roles.includes(role))) {
    throw new AppError("FORBIDDEN", "insufficient role", 403);
  }
  return principal;
}
