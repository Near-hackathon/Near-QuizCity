import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import type { Static } from "@sinclair/typebox";
import {
  JobParams,
  ResearchTaskResponse,
  ResearchSubmitBody,
  ResearchSubmitResponse,
} from "@quiz-city/protocol";
import { ErrorResponses } from "./schemas/index.js";
import { requireAuth } from "./auth/plugin.js";
import { researchTask, submitResearchTask } from "./research-tasks.js";
export function registerResearchRoutes(app: FastifyInstance, db: Sql) {
  app.get<{ Params: Static<typeof JobParams> }>(
    "/jobs/:id/task",
    { schema: { params: JobParams, response: { 200: ResearchTaskResponse, ...ErrorResponses } } },
    (req) => researchTask(db, req.params.id, requireAuth(req).accountId),
  );
  app.post<{ Params: Static<typeof JobParams>; Body: Static<typeof ResearchSubmitBody> }>(
    "/jobs/:id/task",
    {
      schema: {
        params: JobParams,
        body: ResearchSubmitBody,
        response: { 200: ResearchSubmitResponse, ...ErrorResponses },
      },
    },
    (req) =>
      submitResearchTask(db, { jobId: req.params.id, accountId: requireAuth(req).accountId, ...req.body }),
  );
}
