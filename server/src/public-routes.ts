import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { loadDemoAccounts } from "./demo-accounts.js";

export function registerPublicRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.get("/config", async () => ({
    demoMode: cfg.demoMode,
    networkId: cfg.networkId,
    contractId: cfg.contractId,
  }));

  app.get("/demo/accounts", async (_request, reply) => {
    if (!cfg.demoMode) return reply.code(404).send({ error: "demo mode is disabled" });
    try {
      return loadDemoAccounts(cfg);
    } catch (error) {
      app.log.error({ err: error }, "refused to serve demo credentials");
      return reply.code(503).send({ error: "demo mode is not safely configured" });
    }
  });
}
