import type { FastifyServerOptions } from "fastify";
import { isQcString } from "./amount.js";

export const ajvOptions = {
  removeAdditional: false,
  coerceTypes: false,
  formats: {
    "qc-amount": (value: string) => isQcString(value),
  },
} as const;

export const serializerOptions = {
  // fast-json-stringify creates a separate AJV instance for union/conditional
  // response schemas. Give it the same domain formats as request validation so
  // valid QC response schemas compile without "unknown format" warnings.
  ajv: ajvOptions,
} as const;

export const fastifyOptions: Partial<FastifyServerOptions> = {
  ajv: { customOptions: ajvOptions },
  serializerOpts: serializerOptions,
};
