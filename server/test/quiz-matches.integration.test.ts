import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { withTestSchema, connectTestClient, testDatabaseUrl } from "./db-test-utils.js";
import { loadMigrations, runMigrations, postgresMigrationStore } from "../src/migrations.js";
import { seedWorld } from "../db/seeds/world.js";
import {
  createQuizMatch,
  findQuizOpponent,
  listPublicQuizRooms,
  joinQuizMatch,
  getQuizMatch,
  submitQuizMatch,
  cancelQuizMatch,
} from "../src/quiz-matches.js";
import { matchQuestions } from "../src/quiz-match-policy.js";
import { projectCityOperation } from "../src/city-economy.js";
import { validateEvent } from "../src/event-validation.js";
import { tickQuizMatches, tickQuizMatchRooms, type MatchWorkerDeps } from "../src/quiz-match-worker.js";
const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
const failureMigration = {
  filename: `${String(Number(migrations.at(-1)!.filename.slice(0, 4)) + 1).padStart(4, "0")}_fixture_failure.sql`,
  checksum: "failure",
  sql: "select 1/0",
};
async function setup(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
  await seedWorld(sql);
  for (const name of ["alice", "bob", "carol"]) {
    await sql`insert into players(account_id,username) values(${name + ".testnet"},${name})`;
    await sql`insert into player_presence(session_id,player_account,scene_id,x,y,facing) values(${name},${name + ".testnet"},'quiz-centre-interior',12,12,'south')`;
  }
}
function event(op: any) {
  const expected = op.expected_events[0];
  return validateEvent({
    standard: "quizcity",
    version: "1.0.0",
    event: expected.name,
    data: [
      {
        seq: 1,
        wallet_from: expected.walletFrom,
        wallet_to: expected.walletTo,
        amount: expected.amount,
        reference: expected.reference,
        entity_id: expected.entityId,
        escrow_id: op.args.id,
        owner: op.actor_account,
        purpose: "prize",
        beneficiary: null,
      },
    ],
    receiptId: `receipt-${op.id}`,
    eventIndex: 0,
    txHash: `hash-${op.id}`,
    blockHeight: "1",
    blockHash: "block",
    chainTimestamp: "1",
  });
}
async function confirm(sql: Sql, id: string) {
  await sql.begin(async (tx) => {
    const [op] = await tx`select * from city_operations where id=${id}`;
    await projectCityOperation(tx, event(op));
  });
}
function worker(sql: Sql, now: Date): MatchWorkerDeps {
  return {
    operator: "operator.testnet",
    now: () => now,
    submit: async () => ({ kind: "confirmed", txHash: "proof" }),
    confirm: async (_actor, id) => confirm(sql, id),
  };
}
async function roomPair(sql: Sql) {
  const a = await createQuizMatch(
    sql,
    "alice.testnet",
    { requestId: randomUUID(), stake: "100" },
    new Date(),
    matchQuestions(() => 0),
  );
  await joinQuizMatch(sql, "bob.testnet", { requestId: randomUUID(), code: a.code });
  await confirm(sql, a.operation.id);
  const b = await getQuizMatch(sql, "bob.testnet", a.id);
  await confirm(sql, b.operation.id);
  return getQuizMatch(sql, "alice.testnet", a.id);
}
test("friend room membership, immutable fee quote, question privacy, exact answer replay and four verified winner transfers", async () =>
  withTestSchema(async ({ sql }) => {
    await setup(sql);
    const requestId = randomUUID();
    let room = await createQuizMatch(
      sql,
      "alice.testnet",
      { requestId, stake: "100" },
      new Date(),
      matchQuestions(() => 0),
    );
    assert.equal(room.totalDue, "100");
    assert.equal(room.questions.length, 0);
    assert.equal(JSON.stringify(room).includes("correct"), false);
    assert.equal((await createQuizMatch(sql, "alice.testnet", { requestId, stake: "100" })).id, room.id);
    await assert.rejects(createQuizMatch(sql, "bob.testnet", { requestId, stake: "100" }));
    await assert.rejects(createQuizMatch(sql, "alice.testnet", { requestId, stake: "150" }));
    await assert.rejects(getQuizMatch(sql, "carol.testnet", room.id));
    await assert.rejects(submitQuizMatch(sql, "alice.testnet", room.id, {}));
    await joinQuizMatch(sql, "bob.testnet", { requestId: randomUUID(), code: room.code });
    await assert.rejects(joinQuizMatch(sql, "carol.testnet", { requestId: randomUUID(), code: room.code }));
    await confirm(sql, room.operation.id);
    const bob = await getQuizMatch(sql, "bob.testnet", room.id);
    await confirm(sql, bob.operation.id);
    room = await getQuizMatch(sql, "alice.testnet", room.id);
    assert.equal(room.state, "countdown");
    assert.equal(room.questions.length, 0);
    let now = new Date(Date.parse(room.startsAt!) + 1);
    await tickQuizMatches(sql, worker(sql, now));
    room = await getQuizMatch(sql, "alice.testnet", room.id, now);
    assert.equal(room.questions.length, 5);
    const [stored] = await sql`select questions from quiz_matches where id=${room.id}`;
    const correct = Object.fromEntries(stored.questions.map((q: any) => [q.id, q.correct]));
    const wrong = Object.fromEntries(
      stored.questions.map((q: any) => [q.id, (q.correct + 1) % q.options.length]),
    );
    await submitQuizMatch(sql, "alice.testnet", room.id, correct, now);
    let view = await getQuizMatch(sql, "bob.testnet", room.id, now);
    assert.equal(view.participants[0].score, null);
    assert.equal(view.review.length, 0);
    await submitQuizMatch(sql, "alice.testnet", room.id, correct, now);
    await assert.rejects(submitQuizMatch(sql, "alice.testnet", room.id, wrong, now));
    await submitQuizMatch(sql, "bob.testnet", room.id, wrong, now);
    now = new Date(now.getTime() + 3000);
    let calls = 0;
    const deps = worker(sql, now);
    deps.submit = async () => {
      calls++;
      return { kind: "confirmed", txHash: "proof" };
    };
    await tickQuizMatches(sql, deps);
    assert.equal(calls, 4);
    now = new Date(now.getTime() + 3000);
    await tickQuizMatches(sql, { ...deps, now: () => now });
    view = await getQuizMatch(sql, "alice.testnet", room.id, now);
    assert.equal(view.state, "completed");
    assert.equal(view.winnerAccount, "alice.testnet");
    assert.deepEqual(
      view.participants.map((p) => p.score),
      [5, 0],
    );
    assert.equal(view.transfers.length, 4);
    assert.equal(
      view.transfers.filter((t) => t.kind === "stake").reduce((v, t) => v + BigInt(t.amount), 0n),
      196n,
    );
    assert.equal(calls, 4);
    await confirm(sql, room.operation.id);
    assert.equal((await sql`select count(*)::int as n from quiz_match_transfers`)[0].n, 4);
  }));
test("expired lobby refunds all confirmed QC including fees, and a late deposit reopens refund settlement", async () =>
  withTestSchema(async ({ sql }) => {
    await setup(sql);
    let room = await createQuizMatch(sql, "alice.testnet", { requestId: randomUUID(), stake: "150" });
    const bob = await joinQuizMatch(sql, "bob.testnet", { requestId: randomUUID(), code: room.code });
    await confirm(sql, room.operation.id);
    let now = new Date(Date.parse(room.joinExpiresAt) + 1);
    const deps = worker(sql, now);
    await tickQuizMatches(sql, deps);
    now = new Date(now.getTime() + 3000);
    await tickQuizMatches(sql, { ...deps, now: () => now });
    room = await getQuizMatch(sql, "alice.testnet", room.id, now);
    assert.equal(room.state, "refunded");
    assert.equal(room.transfers[0].amount, "150");
    assert.equal(room.transfers[0].kind, "refund");
    await confirm(sql, bob.operation.id);
    assert.equal((await getQuizMatch(sql, "alice.testnet", room.id)).state, "settling");
    now = new Date(now.getTime() + 3000);
    await tickQuizMatches(sql, { ...deps, now: () => now });
    now = new Date(now.getTime() + 3000);
    await tickQuizMatches(sql, { ...deps, now: () => now });
    room = await getQuizMatch(sql, "bob.testnet", room.id, now);
    assert.equal(room.state, "refunded");
    assert.equal(room.transfers.length, 2);
    assert.ok(room.transfers.every((t) => t.kind === "refund" && t.amount === "150"));
  }));
test("tie, deadline forfeit, cancellation and unknown payout survive worker restarts without resubmission", async () =>
  withTestSchema(async ({ sql }) => {
    await setup(sql);
    let room = await roomPair(sql);
    let now = new Date(Date.parse(room.endsAt!) + 1);
    let submissions = 0;
    const deps = worker(sql, now);
    deps.submit = async () => {
      submissions++;
      return { kind: "unknown", code: "CHAIN_TIMEOUT" };
    };
    await tickQuizMatches(sql, deps);
    assert.equal(submissions, 2);
    room = await getQuizMatch(sql, "alice.testnet", room.id, now);
    assert.equal(room.outcome, "tie");
    assert.equal(room.transfers.length, 2);
    assert.ok(room.transfers.every((t) => t.state === "unknown" && t.amount === "100"));
    now = new Date(now.getTime() + 120000);
    await tickQuizMatches(sql, { ...deps, now: () => now });
    assert.equal(submissions, 2);
    for (const row of await sql`select operation_id from quiz_match_transfers`)
      await confirm(sql, row.operation_id);
    now = new Date(now.getTime() + 3000);
    await tickQuizMatches(sql, { ...deps, now: () => now });
    assert.equal((await getQuizMatch(sql, "alice.testnet", room.id)).state, "refunded");
    await sql`update player_presence set heartbeat_at=now()`;
    room = await createQuizMatch(sql, "alice.testnet", { requestId: randomUUID(), stake: "100" });
    await cancelQuizMatch(sql, "alice.testnet", room.id);
    await cancelQuizMatch(sql, "alice.testnet", room.id);
    await tickQuizMatches(sql, worker(sql, new Date(now.getTime() + 3000)));
    assert.equal((await getQuizMatch(sql, "alice.testnet", room.id)).state, "refunded");
  }));
test("two synchronized joiners compete for one seat without creating an orphan funding intent", async () =>
  withTestSchema(async ({ sql, schema }) => {
    await setup(sql);
    const room = await createQuizMatch(sql, "alice.testnet", { requestId: randomUUID(), stake: "100" });
    const a = connectTestClient(testDatabaseUrl(), schema),
      b = connectTestClient(testDatabaseUrl(), schema);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      held = new Promise<void>((r) => (locked = r));
    try {
      const holder = sql.begin(async (tx) => {
        await tx`select id from quiz_matches where id=${room.id} for update`;
        locked();
        await gate;
      });
      await held;
      const first = joinQuizMatch(a, "bob.testnet", { requestId: randomUUID(), code: room.code });
      const second = joinQuizMatch(b, "carol.testnet", { requestId: randomUUID(), code: room.code });
      // Both separate connections reach the shared room lock before it is released.
      const observer = connectTestClient(testDatabaseUrl(), schema);
      try {
        let waiting = 0;
        for (let i = 0; i < 500 && waiting < 2; i++) {
          const [r] =
            await observer`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%quiz_matches%for update%'`;
          waiting = r.n;
        }
        assert.equal(waiting, 2);
      } finally {
        await observer.end();
        release();
      }
      await holder;
      const results = await Promise.allSettled([first, second]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal((await sql`select count(*)::int as n from quiz_match_players`)[0].n, 2);
      assert.equal((await sql`select count(*)::int as n from city_operations`)[0].n, 2);
    } finally {
      release?.();
      await a.end();
      await b.end();
    }
  }));
test("new match migrations upgrade, preserve immutable attempts, enforce constraints, rerun cleanly and roll back as a batch", async () =>
  withTestSchema(async ({ sql }) => {
    const previous = migrations.filter((m) => m.filename < "0035");
    await runMigrations(postgresMigrationStore(sql), previous);
    await sql`insert into quizzes(id,title,reward_pool,entry_fee,status) values('daily-quiz','Old',1000,0,'live')`;
    await runMigrations(postgresMigrationStore(sql), migrations);
    assert.equal(
      (await sql`select count(*)::int as n from quiz_questions where quiz_id='daily-quiz'`)[0].n,
      19,
    );
    assert.equal((await runMigrations(postgresMigrationStore(sql), migrations)).applied.length, 0);
    await assert.rejects(
      sql`insert into quiz_matches(id,request_id,host_account,invite_code,stake,venue_fee,gas_fee,venue_wallet,gas_wallet,curriculum_version,questions,join_expires_at) values(${randomUUID()},${randomUUID()},'missing.testnet','AAAAAAAAAA',19,1,1,'gov:x','gov:y','v','[]',now())`,
    );
  }));
test("two payout workers claim a batch once; rejected, thrown and expired submissions remain non-retryable", async () =>
  withTestSchema(async ({ sql, schema }) => {
    await setup(sql);
    const room = await roomPair(sql);
    let now = new Date(Date.parse(room.endsAt!) + 1);
    const second = connectTestClient(testDatabaseUrl(), schema);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      inFlight = new Promise<void>((r) => (started = r));
    let calls = 0;
    const deps = worker(sql, now);
    deps.submit = async () => {
      calls++;
      if (calls === 1) {
        started();
        await gate;
      }
      return { kind: "rejected", code: "TX_FAILED" };
    };
    try {
      const first = tickQuizMatches(sql, deps);
      await inFlight;
      await tickQuizMatches(second, {
        ...worker(second, now),
        submit: async () => {
          calls++;
          throw Error("must not submit");
        },
      });
      release();
      await first;
      assert.equal(calls, 2);
      assert.ok(
        (await getQuizMatch(sql, "alice.testnet", room.id)).transfers.every((t) => t.state === "rejected"),
      );
      now = new Date(now.getTime() + 120000);
      await tickQuizMatches(sql, { ...deps, now: () => now });
      assert.equal(calls, 2);
      // A crash after the SQL reservation is indistinguishable from a lost RPC reply.
      const [transfer] = await sql`select * from quiz_match_transfers limit 1`;
      await sql`update quiz_match_transfers set state='submitting',lease_until=${new Date(now.getTime() - 1)},next_check_at=${new Date(now.getTime() - 1)} where id=${transfer.id}`;
      await tickQuizMatches(sql, { ...deps, now: () => now });
      assert.equal(calls, 2);
      assert.equal(
        (await sql`select state from quiz_match_transfers where id=${transfer.id}`)[0].state,
        "unknown",
      );
      // A known hash can be confirmed without another submission.
      await sql`update city_operations set tx_hash='saved-proof' where id=${transfer.operation_id}`;
      now = new Date(now.getTime() + 120000);
      await tickQuizMatches(sql, { ...deps, now: () => now });
      assert.equal(calls, 2);
      assert.equal(
        (await sql`select state from quiz_match_transfers where id=${transfer.id}`)[0].state,
        "confirmed",
      );
    } finally {
      release?.();
      await second.end();
    }
  }));
test("failed funding projection rolls back the room and payment state; venue and player checks create no intent", async () =>
  withTestSchema(async ({ sql }) => {
    await setup(sql);
    await sql`update player_presence set scene_id='library-interior' where player_account='alice.testnet'`;
    await assert.rejects(
      createQuizMatch(sql, "alice.testnet", { requestId: randomUUID(), stake: "100" }),
      /Visit the quiz centre/,
    );
    await assert.rejects(
      createQuizMatch(sql, "missing.testnet", { requestId: randomUUID(), stake: "100" }),
      /registration/,
    );
    assert.equal((await sql`select count(*)::int as n from city_operations`)[0].n, 0);
    await sql`update player_presence set scene_id='quiz-centre-interior' where player_account='alice.testnet'`;
    const room = await createQuizMatch(sql, "alice.testnet", { requestId: randomUUID(), stake: "100" });
    const before = await sql`select * from quiz_match_players`;
    const op = room.operation;
    const wrong = event(op);
    wrong.data[0].amount = "23";
    await assert.rejects(
      sql.begin((tx) => projectCityOperation(tx, wrong)),
      /does not match/,
    );
    assert.deepEqual([...(await sql`select * from quiz_match_players`)], [...before]);
    assert.equal((await sql`select status from city_operations where id=${op.id}`)[0].status, "awaiting");
    await sql`update city_operations set payload=payload||'{"matchPlayerId":"00000000-0000-4000-8000-000000000000"}'::jsonb where id=${op.id}`;
    await assert.rejects(confirm(sql, op.id), /participant/);
    assert.equal((await sql`select count(*)::int as n from quiz_match_transfers`)[0].n, 0);
    assert.equal((await sql`select state from quiz_matches`)[0].state, "waiting");
  }));
test("both new migrations roll back on a later SQL error and preserve an older attempt snapshot", async () =>
  withTestSchema(async ({ sql }) => {
    const previous = migrations.filter((m) => m.filename < "0035");
    await runMigrations(postgresMigrationStore(sql), previous);
    await sql`insert into quizzes(id,title,reward_pool,entry_fee,status) values('daily-quiz','Legacy quiz',1000,0,'live')`;
    await sql`insert into quiz_questions(id,quiz_id,category,question,options,correct_index) values('legacy','daily-quiz','near','Saved old prompt','["a","b"]',0)`;
    await sql`insert into quiz_attempts(id,quiz_id,player_account,total,status,pass_score,reward_amount,expires_at,reward_day) values('old','daily-quiz','alice.testnet',1,'started',1,25,now()+interval '1 hour',current_date)`;
    await sql`insert into quiz_attempt_questions(attempt_id,position,question_id,question,options,correct_index) values('old',0,'legacy','Saved old prompt','["a","b"]',0)`;
    const before = await sql`select * from quiz_attempt_questions`;
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), [...migrations, failureMigration]),
      /division by zero/,
    );
    assert.equal((await sql`select to_regclass('quiz_matches')::text as name`)[0].name, null);
    assert.equal((await sql`select title from quizzes`)[0].title, "Legacy quiz");
    assert.equal((await sql`select count(*)::int as n from quiz_questions`)[0].n, 1);
    await runMigrations(postgresMigrationStore(sql), migrations);
    assert.deepEqual([...(await sql`select * from quiz_attempt_questions`)], [...before]);
    assert.equal((await sql`select count(*)::int as n from quiz_questions`)[0].n, 19);
  }));
import { buildPublicApp } from "../src/app.js";
import { makeTestConfig } from "./fixtures.js";
import { hashToken } from "../src/auth/service.js";
import { registerQuizMatchRoutes } from "../src/quiz-match-routes.js";
import { AppError } from "../src/errors.js";
import { registerRoutes } from "../src/routes.js";
test("all friend-room HTTP commands enforce session, CSRF, ownership and frozen funding intent without exposing answers", async () =>
  withTestSchema(async ({ sql }) => {
    await setup(sql);
    const cfg = makeTestConfig();
    const app = await buildPublicApp(cfg, { database: sql });
    let verifyCalls = 0;
    await app.register(
      async (v1) => {
        registerRoutes(v1, { db: sql });
        registerQuizMatchRoutes(v1, sql, {
          verify: async () => {
            verifyCalls++;
            throw new AppError("TX_MISMATCH", "This transaction does not prove the saved payment.", 409);
          },
        });
      },
      { prefix: "/v1" },
    );
    const session = async (account: string) => {
      const token = randomUUID(),
        csrf = randomUUID();
      await sql`insert into auth_sessions(token_hash,account_id,csrf_hash,expires_at) values(${hashToken(token)},${account},${hashToken(csrf)},now()+interval '1 hour')`;
      return { cookie: `qc_session=${token}`, "x-csrf-token": csrf, origin: cfg.webOrigin };
    };
    const alice = await session("alice.testnet"),
      bob = await session("bob.testnet");
    const id = randomUUID(),
      body = { requestId: randomUUID(), stake: "100" };
    const endpoints: [string, "GET" | "POST", any][] = [
      ["/v1/quiz-matches", "GET", undefined],
      ["/v1/quiz-matches/public", "GET", undefined],
      ["/v1/quiz-matches/search", "POST", body],
      [`/v1/quiz-matches/public/${id}/join`, "POST", { requestId: randomUUID() }],
      ["/v1/quiz-matches", "POST", body],
      ["/v1/quiz-matches/join", "POST", { requestId: randomUUID(), code: "AAAAAAAAAA" }],
      [`/v1/quiz-matches/${id}`, "GET", undefined],
      [`/v1/quiz-matches/${id}/submit`, "POST", { answers: {} }],
      [`/v1/quiz-matches/${id}/cancel`, "POST", {}],
      [`/v1/quiz-matches/${id}/confirm`, "POST", { txHash: "1".repeat(43) }],
    ];
    try {
      for (const [url, method, payload] of endpoints) {
        const r = await app.inject({ url, method, ...(payload ? { payload } : {}) });
        assert.equal(r.statusCode, 401, url);
        if (method === "POST") {
          const denied = await app.inject({
            url,
            method,
            payload,
            headers: { cookie: alice.cookie, origin: cfg.webOrigin },
          });
          assert.equal(denied.statusCode, 403, url);
        }
      }
      let r = await app.inject({ method: "POST", url: "/v1/quiz-matches", payload: body, headers: alice });
      assert.equal(r.statusCode, 503);
      assert.equal((await sql`select count(*)::int as n from city_operations`)[0].n, 0);
      await sql`insert into wallets(wallet_id,owner_type,owner_id,balance) values('gov:quiz-centre','gov','quiz-centre',0),('gov:network-fees','gov','network-fees',0)`;
      r = await app.inject({
        method: "POST",
        url: "/v1/quiz-matches",
        payload: { ...body, accountId: "bob.testnet" },
        headers: alice,
      });
      assert.equal(r.statusCode, 400);
      r = await app.inject({ method: "POST", url: "/v1/quiz-matches", payload: body, headers: alice });
      assert.equal(r.statusCode, 200, r.body);
      await sql`insert into quizzes(id,title,question_count,pass_score) values ('near-bank','NEAR practice',8,6)`;
      await sql`insert into quiz_questions(id,quiz_id,category,question,options,correct_index,source) select 'bank-'||n,'near-bank','near','What is NEAR?','["A blockchain","A spreadsheet"]',0,'https://near.org' from generate_series(1,19) n`;
      const listing = await app.inject({ method: "GET", url: "/v1/quizzes" });
      assert.equal(listing.statusCode, 200);
      assert.equal(listing.json().items.find((q: any) => q.id === "near-bank").questions, 8);
      const room = r.json().match;
      assert.equal(room.operation.actor_account, "alice.testnet");
      assert.equal(room.questions.length, 0);
      assert.equal("correct" in room, false);
      for (const action of ["", "/cancel", "/submit", "/confirm"]) {
        const wrong = await app.inject({
          method: action ? "POST" : "GET",
          url: `/v1/quiz-matches/${room.id}${action}`,
          headers: bob,
          ...(action
            ? {
                payload:
                  action === "/submit"
                    ? { answers: {} }
                    : action === "/confirm"
                      ? { txHash: "1".repeat(43) }
                      : {},
              }
            : {}),
        });
        assert.equal(wrong.statusCode, 404, action);
      }
      r = await app.inject({
        method: "POST",
        url: `/v1/quiz-matches/${room.id}/confirm`,
        payload: { txHash: "1".repeat(43) },
        headers: alice,
      });
      assert.equal(r.statusCode, 409);
      assert.equal(verifyCalls, 1);
      assert.equal((await sql`select funded_at from quiz_match_players`)[0].funded_at, null);
      assert.equal((await sql`select count(*)::int as n from transactions`)[0].n, 0);
      assert.equal((await sql`select count(*)::int as n from transaction_consumptions`)[0].n, 0);
      const carol = await session("carol.testnet");
      const hosted = await app.inject({
        method: "POST",
        url: "/v1/quiz-matches",
        headers: bob,
        payload: { requestId: randomUUID(), stake: "150", visibility: "public" },
      });
      assert.equal(hosted.statusCode, 200, hosted.body);
      const publicRoom = hosted.json().match;
      const browse = await app.inject({
        method: "GET",
        url: "/v1/quiz-matches/public?q=BOB&stake=150",
        headers: carol,
      });
      assert.equal(browse.statusCode, 200, browse.body);
      assert.equal(browse.json().rooms[0].id, publicRoom.id);
      assert.equal("code" in browse.json().rooms[0], false);
      const admitted = await app.inject({
        method: "POST",
        url: `/v1/quiz-matches/public/${publicRoom.id}/join`,
        headers: carol,
        payload: { requestId: randomUUID() },
      });
      assert.equal(admitted.statusCode, 200, admitted.body);
      assert.equal(admitted.json().match.participants.length, 2);
    } finally {
      await app.close();
    }
  }));
test("a pending blockchain payout cannot hold another room in its countdown", async () =>
  withTestSchema(async ({ sql }) => {
    await setup(sql);
    const old = await roomPair(sql);
    await sql`update quiz_matches set starts_at=now()-interval '120 seconds',ends_at=now()-interval '1 second' where id=${old.id}`;
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      pending = new Promise<void>((r) => (started = r));
    let calls = 0;
    const deps = worker(sql, new Date(Date.now() + 1000));
    deps.submit = async () => {
      calls++;
      if (calls === 1) {
        started();
        await gate;
      }
      return { kind: "unknown", code: "CHAIN_TIMEOUT" };
    };
    const slow = tickQuizMatches(sql, deps);
    try {
      await pending;
      await sql`insert into players(account_id,username) values('dave.testnet','dave')`;
      await sql`insert into player_presence(session_id,player_account,scene_id,x,y,facing) values('dave','dave.testnet','quiz-centre-interior',12,12,'south')`;
      let next = await createQuizMatch(sql, "carol.testnet", { requestId: randomUUID(), stake: "100" });
      const dave = await joinQuizMatch(sql, "dave.testnet", { requestId: randomUUID(), code: next.code });
      await confirm(sql, next.operation.id);
      await confirm(sql, dave.operation.id);
      next = await getQuizMatch(sql, "carol.testnet", next.id);
      const clock = new Date(Date.parse(next.startsAt!) + 1);
      await tickQuizMatchRooms(sql, "operator.testnet", clock);
      next = await getQuizMatch(sql, "carol.testnet", next.id, clock);
      assert.equal(next.state, "playing");
      assert.equal(next.questions.length, 5);
      assert.equal(calls, 1);
    } finally {
      release();
      await slow;
    }
  }));
test("fee migration preserves funded legacy rooms, enforces exact new fees, upgrades once and rolls back atomically", async () =>
  withTestSchema(async ({ sql }) => {
    const before = migrations.filter((m) => m.filename < "0037");
    await runMigrations(postgresMigrationStore(sql), before);
    await seedWorld(sql);
    for (const name of ["alice", "bob"]) {
      await sql`insert into players(account_id,username) values(${name + ".testnet"},${name})`;
      await sql`insert into player_presence(session_id,player_account,scene_id,x,y,facing) values(${name},${name + ".testnet"},'quiz-centre-interior',12,12,'south')`;
    }
    const id = randomUUID(),
      requestId = randomUUID(),
      player = randomUUID(),
      escrow = randomUUID(),
      opId = randomUUID();
    const args = {
      id: escrow,
      source_wallet: "player:alice.testnet",
      beneficiary_wallet: null,
      amount: "22",
      purpose: "prize",
    };
    await sql`insert into city_operations(id,actor_account,kind,method,args,expected_events,reference,payload,status) values(${opId},'alice.testnet','quiz_fund','fund_escrow',${sql.json(args)},'[]',${"fund:" + escrow},'{}','confirmed')`;
    await sql`insert into quiz_matches(id,request_id,host_account,invite_code,stake,venue_fee,gas_fee,venue_wallet,gas_wallet,curriculum_version,questions,join_expires_at) values(${id},${requestId},'alice.testnet','1122334455',20,1,1,'gov:quiz-centre','gov:network-fees','legacy',${sql.json(matchQuestions(() => 0))},now()+interval '15 minutes')`;
    await sql`insert into quiz_match_players(id,match_id,request_id,account_id,seat,escrow_id,operation_id,funded_at) values(${player},${id},${requestId},'alice.testnet',0,${escrow},${opId},now())`;
    const funding = await sql`select * from city_operations`;
    const members = await sql`select * from quiz_match_players`;
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), [...migrations, failureMigration]),
      /division by zero/,
    );
    assert.equal(
      (
        await sql`select count(*)::int as n from information_schema.columns where table_schema=current_schema() and table_name='quiz_matches' and column_name='fee_policy'`
      )[0].n,
      0,
    );
    await runMigrations(postgresMigrationStore(sql), migrations);
    assert.equal((await runMigrations(postgresMigrationStore(sql), migrations)).applied.length, 0);
    assert.deepEqual([...(await sql`select * from city_operations`)], [...funding]);
    assert.deepEqual([...(await sql`select * from quiz_match_players`)], [...members]);
    const legacy = await createQuizMatch(sql, "alice.testnet", { requestId, stake: "20" });
    assert.equal(legacy.feePolicy, "added-5-v1");
    assert.equal(legacy.totalDue, "22");
    assert.equal(legacy.prize, "40");
    const bob = await joinQuizMatch(sql, "bob.testnet", { requestId: randomUUID(), code: legacy.code });
    assert.equal(bob.operation.args.amount, "22");
    await assert.rejects(sql`update quiz_matches set fee_policy='deducted-2-v2' where id=${id}`);
    await cancelQuizMatch(sql, "alice.testnet", id);
    await tickQuizMatches(sql, worker(sql, new Date(Date.now() + 1000)));
    const refunded = await getQuizMatch(sql, "alice.testnet", id);
    assert.equal(refunded.transfers[0].amount, "22");
    await sql`update quiz_match_transfers set next_check_at=now()`;
    await tickQuizMatchRooms(sql, "operator.testnet", new Date(Date.now() + 5000));
    await sql`update player_presence set heartbeat_at=now()`;
    const fresh = await createQuizMatch(sql, "alice.testnet", { requestId: randomUUID(), stake: "100" });
    assert.equal(fresh.feePolicy, "deducted-2-v2");
    assert.equal(fresh.operation.args.amount, "100");
    assert.equal(fresh.venueFee, "2");
    assert.equal(fresh.gasSupportFee, "0");
    assert.equal(fresh.prize, "196");
    for (const invalid of [
      sql`update quiz_matches set venue_fee=3 where id=${fresh.id}`,
      sql`update quiz_matches set gas_fee=1 where id=${fresh.id}`,
      sql`update quiz_matches set stake=101 where id=${fresh.id}`,
    ])
      await assert.rejects(invalid);
  }));

test("public discovery exposes safe summaries, respects stake/name filters and excludes private, expired and full rooms", async () =>
  withTestSchema(async ({ sql }) => {
    await setup(sql);
    const privateRoom = await createQuizMatch(sql, "alice.testnet", {
      requestId: randomUUID(),
      stake: "100",
    });
    const open = await createQuizMatch(sql, "bob.testnet", {
      requestId: randomUUID(),
      stake: "150",
      visibility: "public",
    });
    assert.equal(open.visibility, "public");
    const rooms = await listPublicQuizRooms(sql, "carol.testnet");
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].id, open.id);
    assert.deepEqual(Object.keys(rooms[0]).sort(), ["expiresAt", "host", "id", "prize", "stake", "venueFee"]);
    assert.equal(rooms[0].prize, "294");
    assert.equal((await listPublicQuizRooms(sql, "carol.testnet", { q: "BOB", stake: "150" })).length, 1);
    assert.equal((await listPublicQuizRooms(sql, "carol.testnet", { q: "%" })).length, 0);
    assert.equal((await listPublicQuizRooms(sql, "carol.testnet", { stake: "100" })).length, 0);
    assert.equal((await listPublicQuizRooms(sql, "bob.testnet")).length, 0);
    await assert.rejects(
      joinQuizMatch(sql, "carol.testnet", { requestId: randomUUID(), publicId: privateRoom.id }),
      /unavailable/,
    );
    const joined = await joinQuizMatch(sql, "carol.testnet", { requestId: randomUUID(), publicId: open.id });
    assert.equal(joined.participants.length, 2);
    assert.equal((await listPublicQuizRooms(sql, "alice.testnet")).length, 0);
    assert.equal(joined.questions.length, 0);
    assert.equal(joined.operation.args.amount, "150");
    assert.equal((await sql`select count(*)::int as n from transactions`)[0].n, 0);
    await sql`insert into players(account_id,username) values('dave.testnet','dave')`;
    await sql`insert into player_presence(session_id,player_account,scene_id,x,y,facing) values('dave','dave.testnet','quiz-centre-interior',12,12,'south')`;
    const expired = await createQuizMatch(
      sql,
      "dave.testnet",
      { requestId: randomUUID(), stake: "100", visibility: "public" },
      new Date(Date.now() - 16 * 60000),
    );
    assert.equal((await listPublicQuizRooms(sql, "alice.testnet")).length, 0);
    await assert.rejects(
      joinQuizMatch(sql, "alice.testnet", { requestId: randomUUID(), publicId: expired.id }),
      /no longer/,
    );
  }));
test("four synchronized opponent searches form two pairs once, recover by request id and never charge a deposit", async () =>
  withTestSchema(async ({ sql, schema }) => {
    await setup(sql);
    await sql`insert into players(account_id,username) values('dave.testnet','dave')`;
    await sql`insert into player_presence(session_id,player_account,scene_id,x,y,facing) values('dave','dave.testnet','quiz-centre-interior',12,12,'south')`;
    const accounts = ["alice", "bob", "carol", "dave"].map((n) => n + ".testnet"),
      clients = accounts.map(() => connectTestClient(testDatabaseUrl(), schema)),
      observer = connectTestClient(testDatabaseUrl(), schema),
      requests = accounts.map(() => randomUUID());
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      held = new Promise<void>((r) => (locked = r));
    try {
      const holder = sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':quiz-match-pool:100',0))`;
        locked();
        await gate;
      });
      await held;
      const outcomes = Promise.allSettled(
        accounts.map((account, i) =>
          findQuizOpponent(clients[i], account, { requestId: requests[i], stake: "100" }),
        ),
      );
      let waiting = 0;
      for (let i = 0; i < 500 && waiting < 4; i++) {
        const [row] =
          await observer`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%quiz-match-pool:%'`;
        waiting = row.n;
      }
      assert.equal(waiting, 4);
      release();
      await holder;
      const results = await outcomes;
      assert.ok(
        results.every((r) => r.status === "fulfilled"),
        JSON.stringify(results),
      );
      const matches = results.map((r) => (r as PromiseFulfilledResult<any>).value);
      assert.equal(new Set(matches.map((m) => m.id)).size, 2);
      assert.ok(
        matches.every(
          (m) => m.visibility === "public" && m.operation.status === "awaiting" && m.questions.length === 0,
        ),
      );
      const counts =
        await sql`select match_id,count(*)::int as n,count(distinct account_id)::int as people from quiz_match_players group by match_id`;
      assert.ok(counts.every((r) => r.n === 2 && r.people === 2));
      assert.equal((await sql`select count(*)::int as n from city_operations`)[0].n, 4);
      assert.equal((await sql`select count(*)::int as n from transactions`)[0].n, 0);
      assert.equal(
        (await findQuizOpponent(sql, accounts[0], { requestId: requests[0], stake: "100" })).id,
        matches[0].id,
      );
      await assert.rejects(findQuizOpponent(sql, accounts[1], { requestId: requests[0], stake: "100" }));
      await assert.rejects(findQuizOpponent(sql, accounts[0], { requestId: requests[0], stake: "150" }));
      await assert.rejects(
        createQuizMatch(sql, accounts[0], { requestId: requests[0], stake: "100", visibility: "public" }),
      );
      await assert.rejects(
        joinQuizMatch(sql, accounts[0], { requestId: requests[0], code: matches[0].code }),
      );
      assert.equal((await sql`select count(*)::int as n from city_operations`)[0].n, 4);
    } finally {
      release?.();
      await Promise.all([...clients, observer].map((c) => c.end()));
    }
  }));
test("search matches a published room at the same stake, resumes its own room, and leaves other stakes and private rooms alone", async () =>
  withTestSchema(async ({ sql }) => {
    await setup(sql);
    const privateRoom = await createQuizMatch(sql, "alice.testnet", {
      requestId: randomUUID(),
      stake: "100",
    });
    const publicRoom = await createQuizMatch(sql, "bob.testnet", {
      requestId: randomUUID(),
      stake: "150",
      visibility: "public",
    });
    await assert.rejects(
      findQuizOpponent(sql, "alice.testnet", { requestId: randomUUID(), stake: "100" }),
      /current room/,
    );
    const queued = await findQuizOpponent(sql, "carol.testnet", { requestId: randomUUID(), stake: "100" });
    assert.notEqual(queued.id, privateRoom.id);
    assert.notEqual(queued.id, publicRoom.id);
    assert.equal(queued.participants.length, 1);
    assert.equal(
      (await findQuizOpponent(sql, "carol.testnet", { requestId: randomUUID(), stake: "100" })).id,
      queued.id,
    );
    await assert.rejects(findQuizOpponent(sql, "carol.testnet", { requestId: randomUUID(), stake: "150" }));
    await cancelQuizMatch(sql, "alice.testnet", privateRoom.id);
    await tickQuizMatches(sql, worker(sql, new Date(Date.now() + 1000)));
    const matched = await findQuizOpponent(sql, "alice.testnet", { requestId: randomUUID(), stake: "150" });
    assert.equal(matched.id, publicRoom.id);
    assert.equal(matched.participants.length, 2);
    assert.equal(matched.totalDue, "150");
    assert.equal(matched.prize, "294");
    await cancelQuizMatch(sql, "carol.testnet", queued.id);
    await tickQuizMatches(sql, worker(sql, new Date(Date.now() + 3000)));
    assert.equal((await listPublicQuizRooms(sql, "carol.testnet")).length, 0);
  }));
test("public-room migration keeps old invites private and rolls back search records and indexes on failure", async () =>
  withTestSchema(async ({ sql }) => {
    const previous = migrations.filter((m) => m.filename < "0039");
    await runMigrations(postgresMigrationStore(sql), previous);
    await sql`insert into players(account_id,username) values('alice.testnet','alice')`;
    const id = randomUUID();
    await sql`insert into quiz_matches(id,request_id,host_account,invite_code,stake,venue_fee,gas_fee,fee_policy,venue_wallet,gas_wallet,curriculum_version,questions,join_expires_at) values(${id},${randomUUID()},'alice.testnet','0011223344',100,2,0,'deducted-2-v2','gov:quiz-centre','gov:network-fees','near',${sql.json(matchQuestions(() => 0))},now()+interval '15 minutes')`;
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), [...migrations, failureMigration]),
      /division by zero/,
    );
    assert.equal((await sql`select to_regclass('quiz_match_searches')::text as name`)[0].name, null);
    await runMigrations(postgresMigrationStore(sql), migrations);
    assert.equal((await sql`select visibility from quiz_matches where id=${id}`)[0].visibility, "private");
    assert.equal((await runMigrations(postgresMigrationStore(sql), migrations)).applied.length, 0);
    await assert.rejects(sql`update quiz_matches set visibility='everything' where id=${id}`);
    await assert.rejects(
      sql`insert into quiz_match_searches(request_id,account_id,match_id,stake) values(${randomUUID()},'alice.testnet',${id},150)`,
    );
  }));
test("search limits and conflicting commands leave memberships and funding intents unchanged", async () =>
  withTestSchema(async ({ sql }) => {
    await setup(sql);
    const requestId = randomUUID();
    const own = await createQuizMatch(sql, "alice.testnet", { requestId, stake: "100" });
    await assert.rejects(
      createQuizMatch(sql, "alice.testnet", { requestId, stake: "100", visibility: "public" }),
    );
    await assert.rejects(
      findQuizOpponent(sql, "alice.testnet", { requestId, stake: "100" }),
      /different match command/,
    );
    const open = await createQuizMatch(sql, "bob.testnet", {
      requestId: randomUUID(),
      stake: "100",
      visibility: "public",
    });
    const joinId = randomUUID();
    const member = await joinQuizMatch(sql, "carol.testnet", { requestId: joinId, publicId: open.id });
    assert.equal(
      (await joinQuizMatch(sql, "carol.testnet", { requestId: joinId, publicId: open.id })).id,
      member.id,
    );
    await assert.rejects(joinQuizMatch(sql, "carol.testnet", { requestId: joinId, publicId: own.id }));
    for (let i = 0; i < 100; i++)
      await sql`insert into quiz_match_searches(request_id,account_id,match_id,stake) values(${randomUUID()},'bob.testnet',${open.id},100)`;
    await assert.rejects(
      findQuizOpponent(sql, "bob.testnet", { requestId: randomUUID(), stake: "100" }),
      /Too many new searches/,
    );
    assert.equal((await sql`select count(*)::int as n from quiz_match_players`)[0].n, 3);
    assert.equal((await sql`select count(*)::int as n from city_operations`)[0].n, 3);
    assert.equal((await sql`select count(*)::int as n from transactions`)[0].n, 0);
  }));
test("a manual public join and automatic search cannot reserve the same last seat", async () =>
  withTestSchema(async ({ sql, schema }) => {
    await setup(sql);
    const room = await createQuizMatch(sql, "alice.testnet", {
      requestId: randomUUID(),
      stake: "100",
      visibility: "public",
    });
    const a = connectTestClient(testDatabaseUrl(), schema),
      b = connectTestClient(testDatabaseUrl(), schema),
      observer = connectTestClient(testDatabaseUrl(), schema);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      held = new Promise<void>((r) => (locked = r));
    try {
      const holder = sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':quiz-match-pool:100',0))`;
        locked();
        await gate;
      });
      await held;
      const outcomes = Promise.allSettled([
        joinQuizMatch(a, "bob.testnet", { requestId: randomUUID(), publicId: room.id }),
        findQuizOpponent(b, "carol.testnet", { requestId: randomUUID(), stake: "100" }),
      ]);
      let waiting = 0;
      for (let i = 0; i < 500 && waiting < 2; i++) {
        const [r] =
          await observer`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%quiz-match-pool:%'`;
        waiting = r.n;
      }
      assert.equal(waiting, 2);
      release();
      await holder;
      await outcomes;
      const groups = await sql`select match_id,count(*)::int as n from quiz_match_players group by match_id`;
      assert.equal(groups.find((r) => r.match_id === room.id)!.n, 2);
      assert.ok(groups.every((r) => r.n <= 2));
      assert.equal(
        (await sql`select count(*)::int as n from city_operations`)[0].n,
        (await sql`select count(*)::int as n from quiz_match_players`)[0].n,
      );
      assert.equal((await sql`select count(*)::int as n from transactions`)[0].n, 0);
    } finally {
      release?.();
      await Promise.all([a, b, observer].map((c) => c.end()));
    }
  }));
