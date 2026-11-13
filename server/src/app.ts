import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { registerAuthPlugin } from "./auth/plugin.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerErrorHandler } from "./errors.js";
import { ajvOptions } from "./fastify-options.js";
import { registerRateLimit } from "./rate-limit.js";
import { registerPublicRoutes } from "./public-routes.js";
import { ErrorResponses, HealthResponse } from "./schemas/index.js";

export type ReadinessDeps = {
  database: () => Promise<boolean>;
  contract: () => Promise<boolean>;
  indexer: (() => Promise<boolean>) | null;
};

export type BuildAppOptions = {
  readiness?: Partial<ReadinessDeps>;
};

async function withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch(() => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}

async function defaultReadinessDeps(cfg: AppConfig): Promise<ReadinessDeps> {
  return {
    database: async () => {
      const { pingDb } = await import("./db.js");
      return pingDb();
    },
    contract: async () => {
      const { viewContract } = await import("./near.js");
      await viewContract("get_stats");
      return true;
    },
    indexer: cfg.chainEventSourceUrl
      ? async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), cfg.readinessTimeoutMs);
          try {
            const response = await fetch(cfg.chainEventSourceUrl!, {
              method: "HEAD",
              signal: controller.signal,
            });
            return response.ok;
          } finally {
            clearTimeout(timer);
          }
        }
      : null,
  };
}

function registerHealthRoutes(app: FastifyInstance, cfg: AppConfig, readiness: ReadinessDeps): void {
  app.get("/health/live", { schema: { response: { 200: HealthResponse, ...ErrorResponses } } }, async () => ({
    ok: true,
    service: "quiz-city-server",
    contract: cfg.contractId,
  }));

  app.get(
    "/health/ready",
    { schema: { response: { ...ErrorResponses, 200: HealthResponse, 503: HealthResponse } } },
    async (_request, reply) => {
      const database = await withTimeout(
        readiness.database().then((ok) => (ok ? "ok" : "failed")),
        "failed",
        cfg.readinessTimeoutMs,
      );
      const contract = await withTimeout(
        readiness.contract().then((ok) => (ok ? "ok" : "failed")),
        "failed",
        cfg.readinessTimeoutMs,
      );
      const indexer = readiness.indexer
        ? await withTimeout(
            readiness.indexer().then((ok) => (ok ? "ok" : "failed")),
            "failed",
            cfg.readinessTimeoutMs,
          )
        : "disabled";
      const indexerReady = indexer !== "failed" || !cfg.chainSourceRequired;
      const ready = database === "ok" && contract === "ok" && indexerReady;
      return reply.code(ready ? 200 : 503).send({
        ok: ready,
        service: "quiz-city-server",
        contract: cfg.contractId,
        checks: { database, contract, indexer },
      });
    },
  );
}

async function configureApp(cfg: AppConfig, options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: cfg.appEnv !== "test",
    bodyLimit: cfg.bodyLimit,
    trustProxy: cfg.trustProxy,
    genReqId: () => `req-${randomUUID()}`,
    ajv: { customOptions: ajvOptions },
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });
  registerErrorHandler(app);
  registerRateLimit(app, cfg);
  await app.register(helmet);
  await app.register(swagger, {
    openapi: {
      info: { title: "Quiz City API", version: "1.0.0" },
      servers: [{ url: "/" }],
    },
  });
  if (cfg.appEnv === "local" || cfg.enableApiDocs) {
    await app.register(swaggerUi, { routePrefix: "/documentation" });
  }
  await app.register(cors, { origin: cfg.webOrigin, credentials: true });
  registerAuthPlugin(app, {
    networkId: cfg.networkId,
    contractId: cfg.contractId,
    webOrigin: cfg.webOrigin,
    rpcUrl: cfg.rpcUrl,
  });
  registerAuthRoutes(app, cfg);
  const defaults = await defaultReadinessDeps(cfg);
  registerHealthRoutes(app, cfg, { ...defaults, ...options.readiness });
  return app;
}

export async function buildPublicApp(
  cfg: AppConfig,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = await configureApp(cfg, options);
  await app.register(
    async (v1) => {
      registerPublicRoutes(v1, cfg);
    },
    { prefix: "/v1" },
  );
  return app;
}

export async function buildApp(cfg: AppConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = await configureApp(cfg, options);
  await app.register(
    async (v1) => {
      registerPublicRoutes(v1, cfg);
      const { registerDataRoutes } = await import("./data-routes.js");
      registerDataRoutes(v1);
    },
    { prefix: "/v1" },
  );
  return app;
}
