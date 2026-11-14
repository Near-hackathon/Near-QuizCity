import { Type } from "@sinclair/typebox";
import { JobResponse } from "./jobs.js";
export const ResearchTaskResponse = Type.Object(
  {
    version: Type.String(),
    title: Type.String(),
    reading: Type.String(),
    source: Type.String(),
    questions: Type.Array(
      Type.Object({ id: Type.String(), question: Type.String(), options: Type.Array(Type.String()) }),
    ),
  },
  { additionalProperties: false },
);
export const ResearchSubmitBody = Type.Object(
  {
    answers: Type.Record(Type.String({ maxLength: 60 }), Type.Integer({ minimum: 0, maximum: 2 }), {
      maxProperties: 10,
    }),
    summary: Type.String({ minLength: 20, maxLength: 2000 }),
  },
  { additionalProperties: false },
);
export const ResearchSubmitResponse = Type.Object({
  job: JobResponse,
  score: Type.Integer(),
  total: Type.Integer(),
  replayed: Type.Boolean(),
});
