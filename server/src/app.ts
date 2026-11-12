import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { registerPublicRoutes } from "./public-routes.js";

export async function buildPublicApp(cfg: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: cfg.appEnv !== "test" });
  await app.register(cors, { origin: cfg.webOrigin });
  registerPublicRoutes(app, cfg);
  return app;
}

export async function buildApp(cfg: AppConfig): Promise<FastifyInstance> {
  const app = await buildPublicApp(cfg);
  const { registerDataRoutes } = await import("./data-routes.js");
  registerDataRoutes(app, cfg);
  return app;
}
