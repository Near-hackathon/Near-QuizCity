import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { EVENT_STANDARD, EVENT_VERSION } from "../src/event-ledger.js";
import { insertLedgerEntries, ledgerEntryFromEvent } from "../src/ledger.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { reconcileDueQuizRewards, reconcileQuizReward, type QuizRewardDeps } from "../src/quiz-reconciler.js";
import { projectQuizReward } from "../src/projections.js";
import { setMirroredBalance } from "../src/sync.js";
import { withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
const operatorAccount = "quizcity.testnet";

async function migrate(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

function rewardEvent(attemptId = "attempt-1") {
  return {
    standard: EVENT_STANDARD,
    version: EVENT_VERSION,
    event: "reward_issued",
    data: [
      {
        seq: 1,
        wallet_from: null,
        wallet_to: "player:alice.testnet",
        amount: "25",
        reference: `quiz:${attemptId}`,
        entity_id: "player:alice.testnet",
      },
    ],
    receiptId: "receipt-quiz",
    eventIndex: 0,
    blockHeight: 10,
    blockHash: "block-10",
    txHash: "reward-tx",
    chainTimestamp: "2026-11-12T00:00:00.000Z",
  };
}

async function seedAttempt(sql: Sql, options: { rewardTx?: string | null; state?: string } = {}) {
  await sql`
    insert into quizzes (
      id, title, status, question_count, pass_score, reward_amount,
      attempt_duration_seconds, reward_pool, reward_reserved, reward_paid
    ) values (
      'quiz-1', 'Quiz', 'live', 6, 6, '25', 600, '25', '25', '0'
    )
  `;
  await sql`
    insert into quiz_attempts (
      id, quiz_id, player_account, score, total, reward_paid, reward_amount,
      pass_score, status, reward_state, reward_tx, reward_day, expires_at, started_at,
      reward_first_checked_at, reward_next_check_at
    ) values (
      'attempt-1', 'quiz-1', 'alice.testnet', 6, 6, 0, '25', 6,
      'reward_pending', ${options.state ?? "pending"}, ${options.rewardTx === undefined ? "reward-tx" : options.rewardTx},
      '2026-11-12', now() + interval '1 hour', now() - interval '5 minutes',
      now() - interval '5 minutes', now() - interval '1 minute'
    )
  `;
  await sql`
    insert into quiz_reward_claims (player_account, reward_day, attempt_id, status)
    values ('alice.testnet', '2026-11-12', 'attempt-1', 'reserved')
  `;
}

function deps(sql: Sql, options: { processed?: boolean } = {}): QuizRewardDeps {
  return {
    db: sql,
    operatorAccount,
    verifyExpectedFunctionCall: async () => ({ events: [rewardEvent() as never] }),
    readChainBalance: async () => "25",
    setMirroredBalance,
    insertLedgerEntries,
    viewContract: async () => (options.processed ?? false) as never,
    now: () => new Date("2026-11-12T12:00:00.000Z"),
  };
}

test("stored-hash quiz reconciliation finalizes wallet, ledger, claim, and pool", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedAttempt(sql);
    const [attempt] = await sql`select * from quiz_attempts where id = 'attempt-1'`;
    const result = await reconcileQuizReward(attempt, deps(sql));
    assert.equal(result.reconciled, true);

    const [rewarded] = await sql`
      select status, reward_state, reward_tx, reward_paid::text as reward_paid
      from quiz_attempts where id = 'attempt-1'
    `;
    assert.equal(rewarded.status, "rewarded");
    assert.equal(rewarded.reward_state, "paid");
    assert.equal(rewarded.reward_tx, "reward-tx");
    assert.equal(rewarded.reward_paid, "25");
    const [claim] = await sql`select status from quiz_reward_claims`;
    assert.equal(claim.status, "paid");
    const [pool] = await sql`
      select reward_reserved::text as reserved, reward_paid::text as paid from quizzes
    `;
    assert.equal(pool.reserved, "0");
    assert.equal(pool.paid, "25");
    const [ledger] = await sql`select count(*)::int as count from transactions`;
    assert.equal(ledger.count, 1);
    const [wallet] = await sql`
      select balance::text as balance from wallets where wallet_id = 'player:alice.testnet'
    `;
    assert.equal(wallet.balance, "25");
  });
});

test("late quiz reward event reconciles a no-hash unknown reward", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedAttempt(sql, { rewardTx: null, state: "unknown" });
    const entry = ledgerEntryFromEvent(rewardEvent() as never, {
      networkId: "testnet",
      contractId: "quizcity.testnet",
    });
    assert.ok(entry);
    await sql.begin((transaction) => insertLedgerEntries(transaction, [entry]));

    const result = await reconcileDueQuizRewards(deps(sql));
    assert.equal(result.claimed, 1);
    assert.equal(result.reconciled, 1);
    const [attempt] = await sql`
      select status, reward_state, reward_tx from quiz_attempts where id = 'attempt-1'
    `;
    assert.equal(attempt.status, "rewarded");
    assert.equal(attempt.reward_state, "paid");
    assert.equal(attempt.reward_tx, "reward-tx");
  });
});

test("processed quiz reference without a verified event stays unknown", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedAttempt(sql, { rewardTx: null, state: "unknown" });
    const [attempt] = await sql`select * from quiz_attempts where id = 'attempt-1'`;
    const result = await reconcileQuizReward(attempt, deps(sql, { processed: true }));
    assert.equal(result.reconciled, false);
    const [after] = await sql`
      select status, reward_state, reward_error_code, last_error
      from quiz_attempts where id = 'attempt-1'
    `;
    assert.equal(after.status, "reward_pending");
    assert.equal(after.reward_state, "unknown");
    assert.equal(after.reward_error_code, "TX_MISMATCH");
    assert.match(after.last_error, /processed/);
  });
});

test("repeated quiz reconciliation is idempotent", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedAttempt(sql);
    const [attempt] = await sql`select * from quiz_attempts where id = 'attempt-1'`;
    await reconcileQuizReward(attempt, deps(sql));
    const [current] = await sql`select * from quiz_attempts where id = 'attempt-1'`;
    const second = await reconcileQuizReward(current, deps(sql));
    assert.equal(second.reconciled, true);
    const [ledger] = await sql`select count(*)::int as count from transactions`;
    const [pool] = await sql`select reward_paid::text as paid from quizzes`;
    assert.equal(ledger.count, 1);
    assert.equal(pool.paid, "25");
  });
});

test("direct quiz projection changes pool accounting exactly once", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedAttempt(sql);
    const first = await sql.begin((transaction) =>
      projectQuizReward(transaction, { attemptId: "attempt-1", txHash: "reward-tx", amount: "25" }),
    );
    assert.deepEqual(first, { applied: true, replay: false });
    const second = await sql.begin((transaction) =>
      projectQuizReward(transaction, { attemptId: "attempt-1", txHash: "reward-tx", amount: "25" }),
    );
    assert.deepEqual(second, { applied: false, replay: true });

    const [pool] = await sql`
      select reward_reserved::text as reserved, reward_paid::text as paid from quizzes
    `;
    assert.equal(pool.reserved, "0");
    assert.equal(pool.paid, "25");
    const [attempt] = await sql`
      select status, reward_state, reward_tx, reward_paid::text as reward_paid
      from quiz_attempts where id = 'attempt-1'
    `;
    assert.equal(attempt.status, "rewarded");
    assert.equal(attempt.reward_state, "paid");
    assert.equal(attempt.reward_paid, "25");

    await assert.rejects(
      sql.begin((transaction) =>
        projectQuizReward(transaction, { attemptId: "attempt-1", txHash: "reward-tx", amount: "26" }),
      ),
      /snapshot amount/,
    );
    await assert.rejects(
      sql.begin((transaction) =>
        projectQuizReward(transaction, { attemptId: "attempt-1", txHash: "other-tx", amount: "25" }),
      ),
      /stored transaction hash/,
    );
  });
});

test("direct quiz projection refuses to spend unreserved pool funds", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedAttempt(sql);
    await sql`update quizzes set reward_reserved = '0'`;
    await assert.rejects(
      sql.begin((transaction) =>
        projectQuizReward(transaction, { attemptId: "attempt-1", txHash: "reward-tx", amount: "25" }),
      ),
      /reserved pool funds/,
    );
    const [pool] = await sql`
      select reward_reserved::text as reserved, reward_paid::text as paid from quizzes
    `;
    assert.equal(pool.reserved, "0");
    assert.equal(pool.paid, "0");
  });
});
