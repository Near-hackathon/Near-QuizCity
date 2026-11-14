import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { seedWorld } from "../../db/seeds/world.js";
import { registerAuthPlugin, SESSION_COOKIE } from "../../src/auth/plugin.js";
import { hashToken } from "../../src/auth/service.js";
import { registerErrorHandler } from "../../src/errors.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../../src/migrations.js";
import { createWorldSocketRuntime } from "../../src/world-socket.js";
import { startWorldMovementWorker } from "../../src/world-tick.js";
import { tickNpcSimulation } from "../../src/world-simulation.js";
import { connectTestPool, testDatabaseUrl, withTestSchema } from "../db-test-utils.js";
import { makeTestConfig } from "../fixtures.js";

/** Real session, socket, movement, event fanout and database; no chain provider needed. */
export async function withWorldBrowserStack(
  origin: string,
  run: (stack: { apiBase: string; cookie: { name: string; value: string; url: string } }) => Promise<void>,
) {
  await withTestSchema(async ({ sql, schema }) => {
    await runMigrations(
      postgresMigrationStore(sql),
      loadMigrations(fileURLToPath(new URL("../../db/migrations", import.meta.url))),
    );
    await seedWorld(sql);
    await tickNpcSimulation(sql, {
      now: new Date("2026-11-13T13:00:00Z"),
      timeZone: "Africa/Accra",
      tilesPerTick: 1,
      catchupAfterMs: 1000,
    });
    const token = randomBytes(32).toString("hex");
    const sessionId = hashToken(token);
    await sql`insert into auth_sessions (token_hash, account_id, csrf_hash, expires_at)
      values (${sessionId}, 'alice.testnet', ${hashToken(randomBytes(32).toString("hex"))}, '2099-01-01')`;
    await sql`insert into player_presence (session_id, player_account, scene_id, x, y, facing, scene_version)
      values (${sessionId}, 'alice.testnet', 'city-district', 20, 11, 'north', 2)`;
    const pool = connectTestPool(testDatabaseUrl(), schema, 5);
    const app = Fastify();
    const started = Date.now();
    const now = () => new Date(new Date("2026-11-13T13:00:00Z").getTime() + Date.now() - started);
    const config = makeTestConfig({ webOrigin: origin, worldFanoutPollMs: 100, worldTickMs: 250 });
    registerErrorHandler(app);
    registerAuthPlugin(app, config, { client: pool, deps: { now } });
    const runtime = createWorldSocketRuntime({ db: pool, now, logger: app.log }, config);
    let worker: ReturnType<typeof startWorldMovementWorker> | undefined;
    try {
      await runtime.register(app);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("World server did not listen");
      worker = startWorldMovementWorker({ db: pool, intervalMs: config.worldTickMs, tilesPerTick: 1, now });
      const apiBase = `http://127.0.0.1:${address.port}`;
      await run({ apiBase, cookie: { name: SESSION_COOKIE, value: token, url: apiBase } });
      const [presence] =
        await pool`select scene_id, x, y from player_presence where session_id = ${sessionId}`;
      if (presence?.scene_id !== "apartment-interior")
        throw new Error("Browser transition did not persist to PostgreSQL");
    } finally {
      try {
        await worker?.stop();
      } finally {
        try {
          await runtime.close();
        } finally {
          try {
            await app.close();
          } finally {
            await pool.end();
          }
        }
      }
    }
  });
}
