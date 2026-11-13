import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { EVENT_STANDARD, EVENT_VERSION } from "../src/event-ledger.js";
import { insertLedgerEntries, ledgerEntryFromEvent } from "../src/ledger.js";
import { claimDueJobReconciliations, reserveJobPayment } from "../src/jobs.js";
import { projectJobReward } from "../src/projections.js";
import { reconcileDueJobs, reconcileJob, type JobPaymentDeps } from "../src/job-payment.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { setMirroredBalance } from "../src/sync.js";
import { connectTestPool, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
const operatorAccount = "quizcity.testnet";

async function migrate(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

function rewardEvent(reference = "job:job-1") {
  return {
    standard: EVENT_STANDARD,
    version: EVENT_VERSION,
    event: "job_reward",
    data: [
      {
        seq: 1,
        wallet_from: "npc:professor-kofi",
        wallet_to: "player:alice.testnet",
        amount: "100",
        reference,
        entity_id: "player:alice.testnet",
      },
    ],
    receiptId: "receipt-job",
    eventIndex: 0,
    blockHeight: 10,
    blockHash: "block-10",
    txHash: "job-tx",
    chainTimestamp: "2026-11-12T00:00:00.000Z",
  };
}

async function seedJob(
  sql: Sql,
  options: {
    status?: string;
    chainTx?: string | null;
    errorCode?: string | null;
  } = {},
) {
  await sql`
    insert into jobs (
      id, employer_wallet, employee_account, title, payment, status, reference,
      chain_tx, payment_attempts, payment_reference, payment_started_at,
      payment_next_check_at, payment_error_code
    ) values (
      'job-1', 'npc:professor-kofi', 'alice.testnet', 'Research', 100,
      ${options.status ?? "payment_pending"}, 'job:job-1', ${options.chainTx === undefined ? "job-tx" : options.chainTx},
      1, 'job:job-1', now() - interval '5 minutes', now() - interval '1 minute',
      ${options.errorCode ?? null}
    )
  `;
  await sql`
    insert into job_payment_attempts (job_id, attempt, reference, state)
    values ('job-1', 1, 'job:job-1', 'unknown')
    on conflict (job_id, attempt) do nothing
  `;
}

function deps(sql: Sql, options: { processed?: boolean } = {}): JobPaymentDeps {
  return {
    db: sql,
    operatorAccount,
    verifyExpectedFunctionCall: async () => ({
      events: [rewardEvent() as never],
    }),
    readChainBalance: async (wallet) => (wallet === "player:alice.testnet" ? "100" : "900"),
    setMirroredBalance,
    insertLedgerEntries,
    viewContract: async () => (options.processed ?? false) as never,
    now: () => new Date("2026-11-12T12:00:00.000Z"),
  };
}

test("stored-hash reconciliation finalizes wallet, ledger, job, and attempt state", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedJob(sql);
    const [job] = await sql`select * from jobs where id = 'job-1'`;
    const result = await reconcileJob(job, deps(sql));
    assert.equal(result.reconciled, true);

    const [paid] = await sql`select status, chain_tx, paid_at, last_error from jobs where id = 'job-1'`;
    assert.equal(paid.status, "paid");
    assert.equal(paid.chain_tx, "job-tx");
    assert.ok(paid.paid_at);
    assert.equal(paid.last_error, null);

    const wallets = await sql`select wallet_id, balance::text as balance from wallets order by wallet_id`;
    assert.deepEqual(
      [...wallets].map((wallet) => [wallet.wallet_id, wallet.balance]),
      [
        ["npc:professor-kofi", "900"],
        ["player:alice.testnet", "100"],
      ],
    );
    const [ledger] = await sql`select count(*)::int as count from transactions`;
    assert.equal(ledger.count, 1);
    const [attempt] = await sql`
      select state, tx_hash, check_count from job_payment_attempts where job_id = 'job-1'
    `;
    assert.equal(attempt.state, "confirmed");
    assert.equal(attempt.tx_hash, "job-tx");
    assert.ok(Number(attempt.check_count) >= 1);
    const [consumption] = await sql`select count(*)::int as count from transaction_consumptions`;
    assert.equal(consumption.count, 1);
  });
});

test("late verified event reconciles a no-hash unknown payment", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedJob(sql, { status: "payment_unknown", chainTx: null, errorCode: "CHAIN_TIMEOUT" });
    const entry = ledgerEntryFromEvent(rewardEvent() as never, {
      networkId: "testnet",
      contractId: "quizcity.testnet",
    });
    assert.ok(entry);
    await sql.begin((transaction) => insertLedgerEntries(transaction, [entry]));

    const result = await reconcileDueJobs(deps(sql));
    assert.equal(result.claimed, 1);
    assert.equal(result.reconciled, 1);
    const [job] = await sql`select status, chain_tx from jobs where id = 'job-1'`;
    assert.equal(job.status, "paid");
    assert.equal(job.chain_tx, "job-tx");
  });
});

test("processed reference without a verified event is not marked paid", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedJob(sql, { status: "payment_unknown", chainTx: null, errorCode: "CHAIN_TIMEOUT" });
    const [job] = await sql`select * from jobs where id = 'job-1'`;
    const result = await reconcileJob(job, deps(sql, { processed: true }));
    assert.equal(result.reconciled, false);
    const [after] = await sql`
      select status, chain_tx, payment_reconciliation_reason from jobs where id = 'job-1'
    `;
    assert.equal(after.status, "payment_unknown");
    assert.equal(after.chain_tx, null);
    assert.match(after.payment_reconciliation_reason, /processed/);
  });
});

test("two workers claim due rows without duplicating work", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    await seedJob(sql);
    await sql`
      insert into jobs (
        id, employer_wallet, employee_account, title, payment, status, reference,
        payment_attempts, payment_reference, payment_started_at, payment_next_check_at
      ) values (
        'job-2', 'npc:professor-kofi', 'alice.testnet', 'Research', 100, 'payment_unknown',
        'job:job-2', 1, 'job:job-2', now() - interval '5 minutes', now() - interval '1 minute'
      )
    `;
    const first = connectTestPool(url, schema, 2);
    const second = connectTestPool(url, schema, 2);
    try {
      const [a, b] = await Promise.all([
        claimDueJobReconciliations(first, 10),
        claimDueJobReconciliations(second, 10),
      ]);
      const ids = [...a, ...b].map((row) => String(row.id));
      assert.equal(new Set(ids).size, 2);
      assert.equal(ids.length, 2);
    } finally {
      await first.end();
      await second.end();
    }
    const [again] = await sql`select count(*)::int as count from jobs where payment_next_check_at <= now()`;
    assert.equal(again.count, 0);
  });
});

test("reservation records a durable attempt and rejection classes are stable", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql`
      insert into jobs (id, employer_wallet, employee_account, title, payment, status, reference)
      values ('job-1', 'npc:professor-kofi', 'alice.testnet', 'Research', 100, 'verified', 'job:job-1')
    `;
    const reserved = await sql.begin((transaction) => reserveJobPayment(transaction, "job-1"));
    assert.ok(reserved);
    const [attempt] = await sql`
      select attempt, state, reference from job_payment_attempts where job_id = 'job-1'
    `;
    assert.equal(attempt.attempt, 1);
    assert.equal(attempt.state, "pending");
    assert.equal(attempt.reference, "job:job-1");
  });
});

test("direct job projection does not increment reconciliation counters on replay", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedJob(sql);
    const first = await sql.begin((transaction) =>
      projectJobReward(transaction, { jobId: "job-1", txHash: "job-tx" }),
    );
    assert.deepEqual(first, { applied: true, replay: false });
    const second = await sql.begin((transaction) =>
      projectJobReward(transaction, { jobId: "job-1", txHash: "job-tx" }),
    );
    assert.deepEqual(second, { applied: false, replay: true });

    const [job] = await sql`select status, chain_tx from jobs where id = 'job-1'`;
    assert.equal(job.status, "paid");
    assert.equal(job.chain_tx, "job-tx");
    const [attempt] = await sql`
      select state, tx_hash, check_count from job_payment_attempts where job_id = 'job-1'
    `;
    assert.equal(attempt.state, "confirmed");
    assert.equal(attempt.tx_hash, "job-tx");
    assert.equal(attempt.check_count, 1);

    await assert.rejects(
      sql.begin((transaction) => projectJobReward(transaction, { jobId: "job-1", txHash: "other-tx" })),
      /transaction hash/,
    );
  });
});
