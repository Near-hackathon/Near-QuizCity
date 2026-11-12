import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { seedWorld } from "../db/seeds/world.js";
import { jobPaymentReference, reserveJobPayment } from "../src/jobs.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import {
  attemptExpired,
  reserveQuizReward,
  scoreSnapshot,
  snapshotQuestions,
  startQuizAttempt,
} from "../src/quiz.js";
import { expireStalePresence, updateNpcRuntime } from "../src/world.js";
import { connectTestPool, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));

async function migrate(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

async function seedQuiz(sql: Sql): Promise<void> {
  await sql`insert into quizzes (id, title, status) values ('quiz-1', 'Snapshot Quiz', 'live')`;
  const questions = [
    { id: "q1", question: "One?", options: ["a", "b"], correct: 0 },
    { id: "q2", question: "Two?", options: ["a", "b"], correct: 1 },
    { id: "q3", question: "Three?", options: ["a", "b"], correct: 1 },
  ];
  for (const question of questions) {
    await sql`
      insert into quiz_questions (id, quiz_id, category, question, options, correct_index)
      values (${question.id}, ${"quiz-1"}, ${"test"}, ${question.question},
              ${sql.json(question.options)}, ${question.correct})
    `;
  }
}

test("quiz attempts score only immutable snapshots", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedQuiz(sql);
    const started = await startQuizAttempt(sql, {
      quizId: "quiz-1",
      accountId: "alice.testnet",
      now: new Date("2026-11-12T10:00:00.000Z"),
    });
    assert.deepEqual(
      started.questions.map((question) => question.position),
      [0, 1, 2],
    );

    await sql`update quiz_questions set correct_index = 0, question = 'changed' where id = 'q1'`;
    await sql`delete from quiz_questions where id = 'q3'`;
    await sql`
      insert into quiz_questions (id, quiz_id, category, question, options, correct_index)
      values ('q4', 'quiz-1', 'test', 'Four?', '["a","b"]'::jsonb, 0)
    `;

    const snapshots = [...(await snapshotQuestions(sql, started.attemptId))];
    assert.deepEqual(snapshots, started.questions);
    const allCorrect = Object.fromEntries(
      snapshots.map((question) => [question.question_id, question.correct_index]),
    );
    assert.deepEqual(scoreSnapshot(snapshots, allCorrect), { score: 3, total: 3 });

    const first = snapshots[0];
    assert.deepEqual(
      scoreSnapshot(snapshots, { ...allCorrect, [first.question_id]: first.correct_index === 0 ? 1 : 0 }),
      { score: 2, total: 3 },
    );
    assert.deepEqual(scoreSnapshot(snapshots, { [first.question_id]: first.correct_index }), {
      score: 1,
      total: 3,
    });
    assert.deepEqual(scoreSnapshot(snapshots, { ...allCorrect, q4: 0 }), {
      score: 3,
      total: 3,
    });
  });
});

test("expired attempts are detected from the stored expiry", () => {
  assert.equal(attemptExpired("2026-01-01T00:00:00.000Z", new Date("2026-01-02T00:00:00.000Z")), true);
  assert.equal(attemptExpired("2026-01-02T00:00:01.000Z", new Date("2026-01-02T00:00:00.000Z")), false);
  assert.equal(attemptExpired("not-a-date"), true);
});

test("a failure while inserting one snapshot rolls back the whole attempt", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql`insert into quizzes (id, title, status) values ('quiz-atomic', 'Atomic', 'live')`;
    for (const id of ["q-ok", "q-fail"]) {
      await sql`
        insert into quiz_questions (id, quiz_id, category, question, options, correct_index)
        values (${id}, ${"quiz-atomic"}, ${"test"}, ${"Question"}, '["a","b"]'::jsonb, 0)
      `;
    }
    await sql`
      create function fail_snapshot() returns trigger as $$
      begin
        if new.question_id = 'q-fail' then
          raise exception 'snapshot insert failed';
        end if;
        return new;
      end;
      $$ language plpgsql
    `;
    await sql`
      create trigger fail_snapshot_trigger before insert on quiz_attempt_questions
      for each row execute function fail_snapshot()
    `;

    await assert.rejects(
      startQuizAttempt(sql, { quizId: "quiz-atomic", accountId: "alice.testnet" }),
      /snapshot insert failed/,
    );
    const [attempts] = await sql`select count(*)::int as count from quiz_attempts`;
    const [snapshots] = await sql`select count(*)::int as count from quiz_attempt_questions`;
    assert.equal(attempts.count, 0);
    assert.equal(snapshots.count, 0);
  });
});

test("concurrent attempts reserve exactly one daily reward", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    await seedQuiz(sql);
    const first = await startQuizAttempt(sql, { quizId: "quiz-1", accountId: "alice.testnet" });
    const second = await startQuizAttempt(sql, { quizId: "quiz-1", accountId: "alice.testnet" });
    const day = "2026-11-12";

    const clientA = connectTestPool(url, schema, 2);
    const clientB = connectTestPool(url, schema, 2);
    try {
      const [a, b] = await Promise.all([
        clientA.begin((transaction) =>
          reserveQuizReward(transaction, {
            playerAccount: "alice.testnet",
            rewardDay: day,
            attemptId: first.attemptId,
          }),
        ),
        clientB.begin((transaction) =>
          reserveQuizReward(transaction, {
            playerAccount: "alice.testnet",
            rewardDay: day,
            attemptId: second.attemptId,
          }),
        ),
      ]);
      assert.equal(Number(a.ownedByAttempt) + Number(b.ownedByAttempt), 1);
      const [claims] = await sql`select count(*)::int as count from quiz_reward_claims`;
      assert.equal(claims.count, 1);
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });
});

test("job payment reservation is race-safe and deterministic", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    await sql`
      insert into jobs (id, employer_wallet, employee_account, title, payment, status, reference)
      values ('job-1', 'npc:professor-kofi', 'alice.testnet', 'Research', 100, 'verified', 'legacy-ref')
    `;

    const pool = connectTestPool(url, schema, 10);
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          pool.begin((transaction) => reserveJobPayment(transaction, "job-1")),
        ),
      );
      const winners = results.filter((result) => result !== null);
      assert.equal(winners.length, 1);
      assert.equal(winners[0].payment_reference, jobPaymentReference("job-1"));
      assert.equal(winners[0].payment_attempts, 1);
    } finally {
      await pool.end();
    }

    const [job] = await sql`select status, payment_reference, payment_attempts from jobs where id = 'job-1'`;
    assert.equal(job.status, "payment_pending");
    assert.equal(job.payment_reference, "job:job-1");
    assert.equal(job.payment_attempts, 1);

    await sql`update jobs set status = 'submitted' where id = 'job-1'`;
    const notVerified = await sql.begin((transaction) => reserveJobPayment(transaction, "job-1"));
    assert.equal(notVerified, null);
  });
});

test("world seed is idempotent and the demo city is connected", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    await seedWorld(sql);

    const counts = await sql<
      {
        scenes: number;
        spawns: number;
        buildings: number;
        schedules: number;
        runtime: number;
        events: number;
      }[]
    >`
      select
        (select count(*)::int from scenes) as scenes,
        (select count(*)::int from spawn_points) as spawns,
        (select count(*)::int from buildings) as buildings,
        (select count(*)::int from npc_schedules) as schedules,
        (select count(*)::int from npc_runtime) as runtime,
        (select count(*)::int from world_events) as events
    `;
    assert.deepEqual(counts[0], {
      scenes: 3,
      spawns: 5,
      buildings: 2,
      schedules: 2,
      runtime: 1,
      events: 1,
    });

    const entrances = await sql<{ count: number }[]>`
      select count(*)::int as count
      from buildings b
      join spawn_points s
        on s.scene_id = b.exterior_scene_id
       and s.x = b.entrance_x
       and s.y = b.entrance_y
       and s.kind = 'door'
    `;
    assert.equal(entrances[0].count, 2);

    const doors = await sql<{ count: number }[]>`
      select count(*)::int as count
      from spawn_points door
      join spawn_points destination on destination.id = door.destination_spawn_id
      where door.kind = 'door'
        and door.destination_scene_id is not null
        and destination.scene_id = door.destination_scene_id
    `;
    assert.equal(doors[0].count, 4);

    const schedules = await sql<{ npc_id: string; sequence: number; valid: boolean }[]>`
      select npc_id, sequence, end_minute > start_minute as valid
      from npc_schedules order by npc_id, sequence
    `;
    assert.equal(schedules.length, 2);
    assert.ok(schedules.every((schedule) => schedule.valid));

    const [runtime] = await sql`
      select r.state_version, s.id as scene_id
      from npc_runtime r join scenes s on s.id = r.scene_id
      where r.npc_id = 'professor-kofi'
    `;
    assert.equal(runtime.scene_id, "library-interior");
    const version = Number(runtime.state_version);
    assert.equal(await updateNpcRuntime(sql, "professor-kofi", version, { activity: "teach" }), true);
    assert.equal(await updateNpcRuntime(sql, "professor-kofi", version, { activity: "stale" }), false);

    await sql`
      insert into player_presence (session_id, player_account, scene_id, x, y, heartbeat_at)
      values ('old', 'alice.testnet', 'city-district', 1, 1, now() - interval '2 hours'),
             ('fresh', 'bob.testnet', 'city-district', 2, 2, now())
    `;
    assert.equal(await expireStalePresence(sql, 3600), 1);
    const presence = await sql`select session_id from player_presence order by session_id`;
    assert.deepEqual(
      [...presence].map((row) => row.session_id),
      ["fresh"],
    );

    const coordinateColumns = await sql`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = current_schema()
        and column_name in ('x', 'y', 'width', 'height')
        and table_name in ('scenes', 'buildings', 'spawn_points', 'npc_runtime', 'world_events')
    `;
    assert.ok(coordinateColumns.every((column) => column.data_type === "integer"));

    const frameColumns = await sql`
      select column_name from information_schema.columns
      where table_schema = current_schema() and column_name ilike '%frame%'
    `;
    assert.equal(frameColumns.length, 0);
  });
});

test("invalid quiz questions cannot be snapshotted", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const cases: { id: string; options: unknown; correct: number; pattern: RegExp }[] = [
      { id: "q-negative", options: ["a", "b"], correct: -1, pattern: /correct_index/ },
      { id: "q-too-high", options: ["a", "b"], correct: 2, pattern: /correct_index/ },
      { id: "q-not-array", options: { a: "b" }, correct: 0, pattern: /options must be an array/ },
      { id: "q-empty", options: [], correct: 0, pattern: /at least two options/ },
      { id: "q-non-string", options: ["a", 2], correct: 0, pattern: /options must all be strings/ },
    ];
    for (const item of cases) {
      await sql`insert into quizzes (id, title, status) values (${item.id}, ${"Invalid"}, ${"live"})`;
      await sql`
        insert into quiz_questions (id, quiz_id, category, question, options, correct_index)
        values (${`${item.id}-question`}, ${item.id}, ${"test"}, ${"Question"},
                ${sql.json(item.options as never)}, ${item.correct})
      `;
      await assert.rejects(
        startQuizAttempt(sql, { quizId: item.id, accountId: "alice.testnet" }),
        item.pattern,
      );
      const [attempts] = await sql`
        select count(*)::int as count from quiz_attempts where quiz_id = ${item.id}
      `;
      assert.equal(attempts.count, 0);
    }

    await sql`insert into quizzes (id, title, status) values ('q-mixed', 'Mixed', 'live')`;
    await sql`
      insert into quiz_questions (id, quiz_id, category, question, options, correct_index)
      values ('valid', 'q-mixed', 'test', 'Valid?', '["a","b"]'::jsonb, 0),
             ('invalid', 'q-mixed', 'test', 'Invalid?', '["a","b"]'::jsonb, 5)
    `;
    await assert.rejects(
      startQuizAttempt(sql, { quizId: "q-mixed", accountId: "alice.testnet" }),
      /correct_index/,
    );
    const [attempts] = await sql`select count(*)::int as count from quiz_attempts where quiz_id = 'q-mixed'`;
    const [snapshots] = await sql`select count(*)::int as count from quiz_attempt_questions`;
    assert.equal(attempts.count, 0);
    assert.equal(snapshots.count, 0);
  });
});

test("NPC runtime targets can be set, omitted, and explicitly cleared", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedWorld(sql);
    const [initial] = await sql`
      select state_version from npc_runtime where npc_id = 'professor-kofi'
    `;
    let version = Number(initial.state_version);

    assert.equal(
      await updateNpcRuntime(sql, "professor-kofi", version, {
        targetSceneId: "city-district",
        targetSpawnId: "city-spawn",
        targetX: 10,
        targetY: 20,
      }),
      true,
    );
    version += 1;
    let [row] = await sql`
      select target_scene_id, target_spawn_id, target_x, target_y, state_version
      from npc_runtime where npc_id = 'professor-kofi'
    `;
    assert.deepEqual(
      [row.target_scene_id, row.target_spawn_id, row.target_x, row.target_y],
      ["city-district", "city-spawn", 10, 20],
    );
    assert.equal(Number(row.state_version), version);

    assert.equal(await updateNpcRuntime(sql, "professor-kofi", version, { activity: "teach" }), true);
    version += 1;
    [row] = await sql`
      select target_scene_id, target_spawn_id, target_x, target_y, activity, state_version
      from npc_runtime where npc_id = 'professor-kofi'
    `;
    assert.deepEqual(
      [row.target_scene_id, row.target_spawn_id, row.target_x, row.target_y],
      ["city-district", "city-spawn", 10, 20],
    );
    assert.equal(row.activity, "teach");

    assert.equal(
      await updateNpcRuntime(sql, "professor-kofi", version, {
        targetSceneId: null,
        targetSpawnId: null,
        targetX: null,
        targetY: null,
      }),
      true,
    );
    version += 1;
    [row] = await sql`
      select target_scene_id, target_spawn_id, target_x, target_y, state_version
      from npc_runtime where npc_id = 'professor-kofi'
    `;
    assert.deepEqual(
      [row.target_scene_id, row.target_spawn_id, row.target_x, row.target_y],
      [null, null, null, null],
    );
    assert.equal(Number(row.state_version), version);

    assert.equal(
      await updateNpcRuntime(sql, "professor-kofi", version - 1, {
        targetSceneId: "city-district",
      }),
      false,
    );
    [row] = await sql`
      select target_scene_id, state_version from npc_runtime where npc_id = 'professor-kofi'
    `;
    assert.equal(row.target_scene_id, null);
    assert.equal(Number(row.state_version), version);
  });
});
