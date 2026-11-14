import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { loadDemoAccounts } from "./demo-accounts.js";
import { publicError } from "./errors.js";
import { ConfigResponse, DemoAccountsResponse, ErrorResponses } from "./schemas/index.js";
import { PROTOCOL_VERSION } from "@quiz-city/protocol";

export function registerPublicRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.get("/config", { schema: { response: { 200: ConfigResponse, ...ErrorResponses } } }, async () => ({
    demoMode: cfg.demoMode,
    autoTestnetWallets: cfg.autoTestnetWallets,
    networkId: cfg.networkId,
    contractId: cfg.contractId,
    protocolVersion: PROTOCOL_VERSION,
  }));

  app.get(
    "/demo/accounts",
    { schema: { response: { 200: DemoAccountsResponse, ...ErrorResponses } } },
    async (_request, reply) => {
      if (!cfg.demoMode) {
        return reply.code(404).send(publicError(String(_request.id), "NOT_FOUND", "demo mode is disabled"));
      }
      try {
        return loadDemoAccounts(cfg);
      } catch (error) {
        app.log.error({ err: error }, "refused to serve demo credentials");
        return reply
          .code(503)
          .send(publicError(String(_request.id), "INTERNAL_ERROR", "demo mode is not safely configured"));
      }
    },
  );
}
