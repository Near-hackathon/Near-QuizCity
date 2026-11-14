import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withTestSchema } from "./db-test-utils.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { attachResearchTask, researchTask, submitResearchTask } from "../src/research-tasks.js";
const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
test("research assignments hide answers, reject another employee and preserve work through retries without payment", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    await sql`insert into jobs(id,employer_wallet,employee_account,title,description,payment,status,reference) values ('research','npc:professor-kofi','alice.testnet','NEAR research','Read and learn',100,'accepted','research')`;
    await sql.begin((tx) => attachResearchTask(tx, "research"));
    const task = await researchTask(sql, "research", "alice.testnet");
    assert.ok(task.questions.every((q) => !("correct" in q)));
    const before = await sql`select * from jobs`;
    await assert.rejects(
      submitResearchTask(sql, {
        jobId: "research",
        accountId: "bob.testnet",
        answers: {},
        summary: "A summary sufficiently long.",
      }),
      { code: "FORBIDDEN" },
    );
    assert.deepEqual([...(await sql`select * from jobs`)], [...before]);
    const wrong = await submitResearchTask(sql, {
      jobId: "research",
      accountId: "alice.testnet",
      answers: { infrastructure: 2, intents: 0, ownership: 0 },
      summary: "I learned about protecting wallet ownership.",
    });
    assert.equal(wrong.score, 0);
    assert.equal(wrong.job.status, "accepted");
    const passed = await submitResearchTask(sql, {
      jobId: "research",
      accountId: "alice.testnet",
      answers: { infrastructure: 0, intents: 1, ownership: 2 },
      summary: "NEAR enables apps and cross-chain execution. Private keys remain private.",
    });
    assert.equal(passed.job.status, "verified");
    assert.equal(passed.job.chain_tx, null);
    const replay = await submitResearchTask(sql, {
      jobId: "research",
      accountId: "alice.testnet",
      answers: { infrastructure: 0, intents: 1, ownership: 2 },
      summary: "NEAR enables apps and cross-chain execution. Private keys remain private.",
    });
    assert.equal(replay.replayed, true);
    const [counts] =
      await sql`select (select count(*)::int from job_research_submissions) as submissions,(select count(*)::int from transactions) as payments`;
    assert.deepEqual({ ...counts }, { submissions: 2, payments: 0 });
  });
});
