import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { JOB_TEMPLATES, startNpcWorker, tickNpcs, type NpcDeps } from "../src/npc.js";
import { connectTestPool, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));

async function migrate(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

async function seedNpc(sql: Sql, budget = "1000") {
  await sql`
    insert into npc_state (npc_id, wallet_id, archetype, budget, state)
    values ('professor-kofi', 'npc:professor-kofi', 'researcher', ${budget}, '{}'::jsonb)
    on conflict (npc_id) do update set budget = excluded.budget, state = '{}'::jsonb
  `;
}

function deps(sql: Sql, balance = "1000"): NpcDeps {
  return {
    db: sql,
    readBalance: async () => balance,
    templates: JOB_TEMPLATES,
    now: () => new Date("2026-11-12T12:00:00.000Z"),
  };
}

test("the first NPC tick selects the first template", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedNpc(sql);
    const result = await tickNpcs(deps(sql));
    assert.equal(result.created, true);
    assert.equal(result.jobId, "job-npc-1");
    const [job] = await sql`select title, payment::text as payment from jobs where id = 'job-npc-1'`;
    assert.equal(job.title, JOB_TEMPLATES[0].title);
    assert.equal(job.payment, "100");
    const [state] = await sql`select state from npc_state`;
    assert.equal(state.state.jobs_posted, 1);
  });
});

test("accepted and pending obligations reserve budget", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedNpc(sql);
    await sql`
      insert into jobs (id, employer_wallet, title, payment, status, reference)
      values ('job-accepted', 'npc:professor-kofi', 'Accepted', 950, 'accepted', 'job:accepted')
    `;
    const result = await tickNpcs(deps(sql));
    assert.equal(result.created, false);
    assert.equal(result.reason, "insufficient budget");
    const [count] = await sql`select count(*)::int as count from jobs`;
    assert.equal(count.count, 1);

    const pending = await tickNpcs(deps(sql, "2000"));
    assert.equal(pending.created, true);
    await sql`update jobs set status = 'payment_unknown' where id = 'job-accepted'`;
    const blocked = await tickNpcs(deps(sql, "1100"));
    assert.equal(blocked.created, false);
  });
});

test("two worker instances produce one decision", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    await seedNpc(sql);
    const first = connectTestPool(url, schema, 2);
    const second = connectTestPool(url, schema, 2);
    const blocker = await first.reserve();
    const probe = await second.reserve();
    let pending: ReturnType<typeof tickNpcs> | undefined;
    try {
      // Hold the state row so the first worker keeps its leader lock while the
      // second worker attempts the same tick. Promise.all alone can run serially.
      await blocker`begin`;
      await blocker`select npc_id from npc_state where npc_id = 'professor-kofi' for update`;
      pending = tickNpcs(deps(first));
      const deadline = Date.now() + 3000;
      for (;;) {
        const [lock] = await probe`
          select exists (
            select 1 from pg_locks
            where locktype = 'advisory' and granted
              and objid = (hashtext('quizcity-npc-worker')::bigint & 4294967295)::oid
              and database = (select oid from pg_database where datname = current_database())
          ) as held
        `;
        if (lock.held) break;
        if (Date.now() > deadline) throw new Error("first worker did not acquire leadership");
      }
      const b = await tickNpcs(deps(second));
      assert.equal(b.reason, "leader");
      await blocker`commit`;
      const a = await pending;
      assert.equal(Number(a.created) + Number(b.created), 1);
      const [jobs] = await sql`select count(*)::int as count from jobs`;
      assert.equal(jobs.count, 1);
    } finally {
      await blocker`rollback`;
      blocker.release();
      probe.release();
      try {
        await pending;
      } finally {
        await first.end();
        await second.end();
      }
    }
  });
});

test("retrying the same idempotency key does not duplicate a job", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedNpc(sql);
    await tickNpcs(deps(sql));
    await sql`update npc_state set state = '{}'::jsonb`;
    const retry = await tickNpcs(deps(sql));
    assert.equal(retry.created, false);
    const [jobs] = await sql`select count(*)::int as count from jobs`;
    assert.equal(jobs.count, 1);
    const [state] = await sql`select state from npc_state`;
    assert.equal(state.state.jobs_posted, 1);
  });
});

test("large balances remain exact and insufficient balances post nothing", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedNpc(sql, "99999999999999999999");
    const large = await tickNpcs(deps(sql, "90071992547409930"));
    assert.equal(large.created, true);

    await sql`delete from job_research_tasks`;
    await sql`delete from jobs`;
    await sql`update npc_state set state = '{}'::jsonb, budget = '0'`;
    const insufficient = await tickNpcs(deps(sql, "50"));
    assert.equal(insufficient.created, false);
    const [jobs] = await sql`select count(*)::int as count from jobs`;
    assert.equal(jobs.count, 0);
  });
});

test("provider failure does not create work and the worker stops cleanly", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedNpc(sql);
    await assert.rejects(
      tickNpcs({ ...deps(sql), readBalance: async () => Promise.reject(new Error("provider down")) }),
      /provider down/,
    );
    const [jobs] = await sql`select count(*)::int as count from jobs`;
    assert.equal(jobs.count, 0);

    let reads = 0;
    const stop = startNpcWorker({
      intervalMs: 10,
      deps: {
        ...deps(sql),
        readBalance: async () => {
          reads += 1;
          return "1000";
        },
      },
    });
    await stop.stop();
    const afterStop = reads;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(reads, afterStop);
  });
});

test("NPC boundaries cover zero, exact, one-short, and no-template decisions", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);

    await seedNpc(sql, "1000");
    const zero = await tickNpcs(deps(sql, "0"));
    assert.equal(zero.created, false);
    assert.equal(zero.reason, "insufficient budget");

    await seedNpc(sql, "100");
    const short = await tickNpcs(deps(sql, "99"));
    assert.equal(short.created, false);
    assert.equal(short.reason, "insufficient budget");

    const exact = await tickNpcs(deps(sql, "100"));
    assert.equal(exact.created, true);
    const [jobs] = await sql`select count(*)::int as count from jobs`;
    assert.equal(jobs.count, 1);

    await sql`delete from job_research_tasks`;
    await sql`delete from jobs`;
    await sql`update npc_state set state = '{}'::jsonb, budget = '1000'`;
    const noTemplate = await tickNpcs({ ...deps(sql, "1000"), templates: [] });
    assert.equal(noTemplate.created, false);
    assert.equal(noTemplate.reason, "no job template");
    const [after] = await sql`select count(*)::int as count from jobs`;
    assert.equal(after.count, 0);
  });
});
