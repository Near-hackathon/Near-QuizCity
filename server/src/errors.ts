import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_AMOUNT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "TX_NOT_FOUND"
  | "TX_PENDING"
  | "CHAIN_TIMEOUT"
  | "CHAIN_UNAVAILABLE"
  | "TX_FAILED"
  | "TX_MISMATCH"
  | "TX_ALREADY_CONSUMED"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  code: ErrorCode;
  statusCode: number;
  details: unknown[] | undefined;

  constructor(code: ErrorCode, message: string, statusCode: number, details?: unknown[]) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export type PublicError = {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: unknown[];
  };
};

export function publicError(
  requestId: string,
  code: ErrorCode,
  message: string,
  details?: unknown[],
): PublicError {
  return {
    error: {
      code,
      message,
      requestId,
      ...(details && details.length > 0 ? { details } : {}),
    },
  };
}

type ValidationError = Error & {
  validation?: { instancePath?: string; keyword?: string; message?: string }[];
  statusCode?: number;
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: ValidationError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = String(request.id);
    if (Array.isArray(error.validation)) {
      const details = error.validation.map((item) => ({
        path: item.instancePath ?? "",
        keyword: item.keyword ?? "validation",
        message: item.message ?? "invalid value",
      }));
      return reply
        .code(400)
        .send(publicError(requestId, "VALIDATION_ERROR", "Request validation failed", details));
    }
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send(publicError(requestId, error.code, error.message, error.details));
    }
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      const mapped = appErrorFromStatus(
        error.statusCode,
        error.statusCode === 415 ? "Unsupported media type" : "Request rejected",
      );
      return reply.code(error.statusCode).send(publicError(requestId, mapped.code, mapped.message));
    }
    request.log.error({ err: error, requestId }, "unhandled request error");
    return reply.code(500).send(publicError(requestId, "INTERNAL_ERROR", "Internal server error"));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(publicError(String(request.id), "NOT_FOUND", "Route not found"));
  });
}

/** Maps legacy statusCode errors from route helpers into the public envelope. */
export function appErrorFromStatus(statusCode: number, message: string): AppError {
  const code: ErrorCode =
    statusCode === 400
      ? "VALIDATION_ERROR"
      : statusCode === 401
        ? "UNAUTHORIZED"
        : statusCode === 403
          ? "FORBIDDEN"
          : statusCode === 404
            ? "NOT_FOUND"
            : statusCode === 409 || statusCode === 410
              ? "CONFLICT"
              : statusCode === 422
                ? "VALIDATION_ERROR"
                : statusCode === 429
                  ? "RATE_LIMITED"
                  : statusCode === 415
                    ? "UNSUPPORTED_MEDIA_TYPE"
                    : "INTERNAL_ERROR";
  return new AppError(code, message, statusCode);
}
