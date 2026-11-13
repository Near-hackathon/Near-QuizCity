import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { seedWorld } from "../db/seeds/world.js";
import type { ValidatedEvent } from "../src/event-validation.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { appendJobPresentation, appendResolvedEconomicProjection } from "../src/world-projection.js";
import { withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));

async function setup(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
  await seedWorld(sql);
  await sql`
    insert into jobs (id, employer_wallet, title, payment, status, reference)
    values ('job-visible', 'npc:professor-kofi', 'Visible research', 100, 'open', 'job:job-visible')
  `;
}

function reward(): ValidatedEvent {
  return {
    standard: "quizcity",
    version: "1.0.0",
    event: "job_reward",
    data: [{ reference: "job:job-visible", amount: "100" }],
    receiptId: "projection-receipt",
    eventIndex: 0,
    txHash: "1".repeat(43),
    blockHeight: "10",
    blockHash: "block-10",
    chainTimestamp: "2026-11-13T10:00:00.000Z",
    payload: {},
  };
}

test("job workflow and presentation changes commit together and suppress exact duplicate states", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    await sql.begin(async (transaction) => {
      await appendJobPresentation(transaction, { jobId: "job-visible", status: "open" });
      await transaction`update jobs set status = 'accepted' where id = 'job-visible'`;
      await appendJobPresentation(transaction, { jobId: "job-visible", status: "accepted" });
      await appendJobPresentation(transaction, { jobId: "job-visible", status: "accepted" });
    });
    const [committed] = await sql<{ count: number }[]>`
      select count(*)::int as count from world_events
      where entity_id = 'job-visible' and event_type = 'job.presentation_changed'
    `;
    assert.equal(committed.count, 2);

    await assert.rejects(
      sql.begin(async (transaction) => {
        await transaction`update jobs set status = 'submitted' where id = 'job-visible'`;
        await appendJobPresentation(transaction, { jobId: "job-visible", status: "submitted" });
        throw new Error("forced rollback");
      }),
      /forced rollback/,
    );
    const [job] = await sql`select status from jobs where id = 'job-visible'`;
    const [after] = await sql<{ count: number }[]>`
      select count(*)::int as count from world_events where entity_id = 'job-visible'
    `;
    assert.equal(job.status, "accepted");
    assert.equal(after.count, 2);
  });
});

test("projection scene follows the authoritative NPC and chain proof replay stays exactly once", async () => {
  await withTestSchema(async ({ sql }) => {
    await setup(sql);
    await sql`
      update npc_runtime set scene_id = 'university-interior', x = 14, y = 8
      where npc_id = 'professor-kofi'
    `;
    await sql.begin(async (transaction) => {
      await appendResolvedEconomicProjection(transaction, reward());
      await appendResolvedEconomicProjection(transaction, reward());
    });
    const rows = await sql<{ scene_id: string; payload: { status: string } }[]>`
      select scene_id, payload from world_events
      where idempotency_key = 'chain:projection-receipt:0:job'
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scene_id, "university-interior");
    assert.equal(rows[0].payload.status, "paid");
  });
});
