import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WorldBootstrap } from "@quiz-city/protocol";
import { Value } from "@sinclair/typebox/value";
import Fastify from "fastify";
import type { Sql } from "postgres";
import { seedWorld } from "../db/seeds/world.js";
import { registerAuthPlugin, SESSION_COOKIE } from "../src/auth/plugin.js";
import { hashToken } from "../src/auth/service.js";
import { registerDataRoutes } from "../src/data-routes.js";
import { registerErrorHandler } from "../src/errors.js";
import { ajvOptions, serializerOptions } from "../src/fastify-options.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { buildWorldBootstrap } from "../src/world-bootstrap.js";
import { appendWorldEvent, streamHead } from "../src/world-events.js";
import { connectTestPool, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
const fixedNow = new Date("2026-11-13T10:00:00.000Z");

async function migrate(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

async function insertPresence(sql: Sql) {
  await sql`
    insert into player_presence (session_id, player_account, scene_id, x, y, facing)
    values ('session-hash', 'alice.testnet', 'city-district', 30, 20, 'north')
  `;
}

test("bootstrap is bounded, scene-scoped, privacy-safe, deterministic, and protocol-valid", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await insertPresence(sql);
    await sql`
      insert into scenes (id, name, scene_type, asset_key, width, height)
      values ('other-district', 'Other', 'exterior', 'maps/other', 10, 10)
    `;
    await sql`
      insert into properties (id, district, x, y, owner_wallet, property_type, price, for_sale)
      values
        (1, 'knowledge', 1, 1, 'private:city-owner', 'commercial', 100, true),
        (2, 'other', 1, 1, 'private:other-owner', 'commercial', 200, true)
    `;
    await sql`
      insert into businesses (id, name, owner_account, property_id, treasury_wallet, revenue_total, status)
      values
        (1, 'City Books', 'owner.testnet', 1, 'private:city-treasury', 99, 'open'),
        (2, 'Other Books', 'owner.testnet', 2, 'private:other-treasury', 88, 'closed')
    `;
    await sql`update buildings set property_id = 1, business_id = 1 where id = 'building-library'`;
    await sql`
      insert into buildings (
        id, exterior_scene_id, property_id, business_id, building_type,
        display_name, entrance_x, entrance_y, entrance_facing
      ) values ('other-shop', 'other-district', 2, 2, 'shop', 'Other Shop', 1, 1, 'south')
    `;

    const bootstrap = await buildWorldBootstrap(sql, "alice.testnet", "city-district", {
      now: () => fixedNow,
      cityTime: (value) => new Date(value.getTime() + 60 * 60 * 1000),
    });
    assert.equal(Value.Check(WorldBootstrap, bootstrap), true);
    assert.equal(bootstrap.serverTime, "2026-11-13T10:00:00.000Z");
    assert.equal(bootstrap.cityTime, "2026-11-13T11:00:00.000Z");
    assert.deepEqual(
      bootstrap.properties.map((property) => property.id),
      ["1"],
    );
    assert.deepEqual(
      bootstrap.businesses.map((business) => business.id),
      ["1"],
    );
    assert.ok(bootstrap.interactionZones.some((zone) => zone.kind === "door"));
    const serialized = JSON.stringify(bootstrap);
    assert.doesNotMatch(
      serialized,
      /session-hash|csrf|qc_session|private:|treasury|ownerWallet|revenueTotal/i,
    );
    assert.ok(bootstrap.buildings.length <= 500);
    assert.ok(bootstrap.players.length <= 200);
  });
});

test("bootstrap uses default spawn, rejects unavailable scenes, and caps collections", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    const spawned = await buildWorldBootstrap(sql, "alice.testnet", "city-district");
    assert.equal(spawned.player.x, 32);
    assert.equal(spawned.player.y, 24);

    await sql`
      insert into buildings (
        id, exterior_scene_id, building_type, display_name,
        entrance_x, entrance_y, entrance_facing
      )
      select 'bulk-' || value::text, 'city-district', 'shop', 'Shop ' || value::text,
             value % 64, value % 48, 'south'
      from generate_series(1, 501) value
    `;
    const capped = await buildWorldBootstrap(sql, "alice.testnet", "city-district");
    assert.equal(capped.buildings.length, 500);
    assert.ok(capped.interactionZones.length <= 500);

    await assert.rejects(buildWorldBootstrap(sql, "alice.testnet", "missing"), /scene not found/);
    await sql`update scenes set active = false where id = 'city-district'`;
    await assert.rejects(buildWorldBootstrap(sql, "alice.testnet", "city-district"), /scene not found/);
  });
});

test("bootstrap restores only the authenticated session presence", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await sql`
      insert into player_presence (session_id, player_account, scene_id, x, y, facing, heartbeat_at)
      values
        ('older-session', 'alice.testnet', 'city-district', 11, 12, 'west', ${new Date("2026-11-13T09:00:00Z")}),
        ('authenticated-session', 'alice.testnet', 'city-district', 21, 22, 'east', ${new Date("2026-11-13T08:00:00Z")})
    `;

    const bootstrap = await buildWorldBootstrap(sql, "alice.testnet", "city-district", {
      sessionId: "authenticated-session",
    });
    assert.equal(bootstrap.player.x, 21);
    assert.equal(bootstrap.player.y, 22);
    assert.equal(bootstrap.player.facing, "east");

    const newSession = await buildWorldBootstrap(sql, "alice.testnet", "city-district", {
      sessionId: "new-session",
    });
    assert.equal(newSession.player.x, 32);
    assert.equal(newSession.player.y, 24);
  });
});

test("bootstrap stream head and rows share one repeatable-read snapshot", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    await seedWorld(sql);
    const pool = connectTestPool(url, schema, 3);
    try {
      const bootstrap = await buildWorldBootstrap(pool, "alice.testnet", "city-district", {
        afterSnapshotEstablished: async () => {
          await pool.begin((transaction) =>
            appendWorldEvent(transaction, {
              streamId: "scene:city-district",
              sceneId: "city-district",
              cityTime: fixedNow,
              type: "player.checkpoint",
              entity: { entityType: "player", entityId: "alice.testnet" },
              payload: {
                accountId: "alice.testnet",
                x: 32,
                y: 24,
                facing: "south",
                sceneId: "city-district",
              },
            }),
          );
        },
      });
      assert.equal(bootstrap.lastSequence, "0");
      assert.equal(await streamHead(pool, "scene:city-district"), "1");
    } finally {
      await pool.end();
    }
  });
});

test("HTTP bootstrap route requires a live authenticated session", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    const token = "world-bootstrap-session-token";
    await sql`
      insert into auth_sessions (token_hash, account_id, csrf_hash, expires_at)
      values (${hashToken(token)}, 'alice.testnet', ${"0".repeat(64)}, '2099-01-01T00:00:00.000Z')
    `;
    const app = Fastify({
      ajv: { customOptions: ajvOptions },
      serializerOpts: serializerOptions,
    });
    registerErrorHandler(app);
    registerAuthPlugin(
      app,
      {
        networkId: "testnet",
        contractId: "quizcity.testnet",
        webOrigin: "http://localhost:5173",
        rpcUrl: "http://127.0.0.1:1",
      },
      { client: sql, deps: { now: () => fixedNow } },
    );
    await app.register(async (v1) => registerDataRoutes(v1, { db: sql }), { prefix: "/v1" });
    await app.ready();
    try {
      const anonymous = await app.inject({ method: "GET", url: "/v1/world/bootstrap?sceneId=city-district" });
      assert.equal(anonymous.statusCode, 401);
      const invalid = await app.inject({
        method: "GET",
        url: "/v1/world/bootstrap?sceneId=city-district",
        headers: { cookie: `${SESSION_COOKIE}=invalid` },
      });
      assert.equal(invalid.statusCode, 401);
      const authenticated = await app.inject({
        method: "GET",
        url: "/v1/world/bootstrap?sceneId=city-district",
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      assert.equal(authenticated.statusCode, 200, authenticated.body);
      assert.equal(Value.Check(WorldBootstrap, authenticated.json()), true);
      const invalidScene = await app.inject({
        method: "GET",
        url: "/v1/world/bootstrap?sceneId=INVALID!",
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      assert.equal(invalidScene.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});
