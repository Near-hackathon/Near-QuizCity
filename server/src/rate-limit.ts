import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { publicError } from "./errors.js";

type Bucket = { count: number; resetAt: number };

/** Bounded in-process rate limiting with a fixed window per IP/method/route. */
export function registerRateLimit(app: FastifyInstance, cfg: AppConfig): void {
  const buckets = new Map<string, Bucket>();
  let requests = 0;

  app.addHook("onRequest", async (request, reply) => {
    requests += 1;
    if (requests % 1000 === 0) {
      const now = Date.now();
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }
    const key = `${request.ip}:${request.method}:${request.routeOptions.url ?? request.url}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + cfg.rateLimitWindowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > cfg.rateLimitMax) {
      reply.header("retry-after", Math.ceil((bucket.resetAt - now) / 1000));
      return reply.code(429).send(publicError(String(request.id), "RATE_LIMITED", "Too many requests"));
    }
  });
}
