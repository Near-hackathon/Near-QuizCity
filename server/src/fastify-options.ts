import type { FastifyServerOptions } from "fastify";
import { isQcString } from "./amount.js";

export const ajvOptions = {
  removeAdditional: false,
  coerceTypes: false,
  formats: {
    "qc-amount": (value: string) => isQcString(value),
  },
} as const;

export const fastifyOptions: Partial<FastifyServerOptions> = {
  ajv: { customOptions: ajvOptions },
};
