import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import {
  ignoreFailure,
  ingestPage,
  rebuildMirror,
  retryFailure,
  type ChainRuntime,
} from "../src/chain-ingester.js";
import type { ChainEventPage, ChainEventSource, SourceEvent } from "../src/chain-source.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { reconcileMirror } from "../src/reconciler.js";
import { applyOwnershipRepairs, planOwnershipRepairs } from "../src/ownership-repair.js";
import { connectTestClient, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
const runtime: ChainRuntime = { networkId: "testnet", contractId: "quizcity.testnet" };

async function migrate(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

function event(name: string, data: Record<string, unknown>, seq = 1) {
  return {
    standard: "quizcity",
    version: "1.0.0",
    event: name,
    data: [
      {
        seq,
        wallet_from: null,
        wallet_to: null,
        amount: "0",
        reference: null,
        entity_id: "city",
        ...(name === "property_created"
          ? { kind: "plot", district: "knowledge", x: 1, y: 1 }
          : name === "business_created"
            ? { name: "Cafe" }
            : {}),
        ...data,
      },
    ],
  };
}

function sourceEvent(
  receiptId: string,
  eventIndex: number,
  blockHeight: number,
  payload: unknown,
): SourceEvent {
  return {
    receiptId,
    eventIndex,
    blockHeight,
    blockHash: `block-${blockHeight}`,
    chainTimestamp: `2026-11-12T00:00:${String(blockHeight).padStart(2, "0")}.000Z`,
    txHash: `tx-${receiptId}`,
    payload,
  };
}

class FixtureSource implements ChainEventSource {
  name = "fixture";
  pages: Map<string, ChainEventPage>;
  calls = 0;

  constructor(pages: Record<string, ChainEventPage>) {
    this.pages = new Map(Object.entries(pages));
  }

  async fetchPage(cursor: string): Promise<ChainEventPage> {
    this.calls += 1;
    return (
      this.pages.get(cursor) ?? {
        events: [],
        nextCursor: cursor,
        lastFinalizedBlock: cursor,
        lastFinalizedHash: null,
      }
    );
  }
}

function page(cursor: string, nextCursor: string, events: SourceEvent[]): ChainEventPage {
  return {
    events: [...events].sort((a, b) => a.receiptId.localeCompare(b.receiptId)),
    nextCursor,
    lastFinalizedBlock: nextCursor,
    lastFinalizedHash: `block-${nextCursor}`,
  };
}

const buyer = "player:buyer.testnet";
const seller = "player:seller.testnet";

function ledgerPage(): ChainEventPage {
  return page("10", "11", [
    sourceEvent(
      "r-created",
      0,
      10,
      event("property_created", {
        id: 1,
        owner_wallet: seller,
        listing_price: "300",
        for_sale: true,
        reference: "property:create:1",
        entity_id: "property:1",
      }),
    ),
    sourceEvent(
      "r-transfer",
      0,
      10,
      event(
        "property_transferred",
        {
          wallet_from: buyer,
          wallet_to: seller,
          amount: "300",
          reference: "property:1:1",
          entity_id: "property:1",
          id: 1,
          previous_owner: seller,
          new_owner: buyer,
          transfer_count: 1,
        },
        2,
      ),
    ),
    sourceEvent(
      "r-mint",
      0,
      10,
      event(
        "starter_allowance",
        {
          wallet_from: null,
          wallet_to: buyer,
          amount: "1000",
          reference: "starter:buyer.testnet",
          entity_id: buyer,
          account: "buyer.testnet",
        },
        3,
      ),
    ),
  ]);
}

test("cursor ingestion applies a page once and is restart-safe", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const source = new FixtureSource({ "10": ledgerPage() });
    const first = await ingestPage(sql, source, runtime, { startBlock: "10" });
    assert.deepEqual(
      { cursor: first.cursor, nextCursor: first.nextCursor, inserted: first.inserted },
      { cursor: "10", nextCursor: "11", inserted: 3 },
    );

    const [cursor] = await sql`select next_cursor, last_finalized_block from chain_cursors`;
    assert.equal(cursor.next_cursor, "11");
    assert.equal(Number(cursor.last_finalized_block), 11);
    const [counts] = await sql`
      select
        (select count(*)::int from chain_events) as raw,
        (select count(*)::int from transactions) as ledger
    `;
    assert.equal(counts.raw, 3);
    assert.equal(counts.ledger, 3);

    const wallets = await sql`select wallet_id, balance::text as balance from wallets order by wallet_id`;
    assert.deepEqual(
      [...wallets].map((wallet) => [wallet.wallet_id, wallet.balance]),
      [
        [buyer, "700"],
        [seller, "300"],
      ],
    );
    const [property] = await sql`select owner_wallet, transfer_count from properties where id = 1`;
    assert.equal(property.owner_wallet, buyer);
    assert.equal(Number(property.transfer_count), 1);

    // Simulate a restart that replays the same page from the old cursor.
    await sql`update chain_cursors set next_cursor = '10'`;
    const replay = await ingestPage(sql, source, runtime, {});
    assert.equal(replay.inserted, 0);
    assert.equal(replay.replayed, 3);
    const [after] = await sql`select balance::text as balance from wallets where wallet_id = ${buyer}`;
    assert.equal(after.balance, "700");
  });
});

test("malformed events are dead-lettered and block cursor progress", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const source = new FixtureSource({
      "10": page("10", "11", [sourceEvent("bad", 0, 10, { standard: "quizcity", version: "1.0.0" })]),
    });
    await assert.rejects(ingestPage(sql, source, runtime, { startBlock: "10" }), /dead-letter/);
    const [failure] = await sql`
      select error_code, attempt_count, block_height from chain_event_failures
    `;
    assert.equal(failure.error_code, "DEAD_LETTER");
    assert.equal(failure.attempt_count, 1);
    assert.equal(failure.block_height, "10");
    const [cursor] = await sql`select next_cursor from chain_cursors`;
    assert.equal(cursor.next_cursor, "10");
  });
});

test("conflicting duplicate payloads stop the cursor and record a failure", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const source = new FixtureSource({ "10": ledgerPage() });
    await ingestPage(sql, source, runtime, { startBlock: "10" });
    await sql`update chain_cursors set next_cursor = '10'`;

    const conflicting = ledgerPage();
    conflicting.events = conflicting.events.slice(0, 1).map((item) => ({
      ...item,
      payload: event("property_created", {
        id: 1,
        owner_wallet: seller,
        listing_price: "999",
        for_sale: true,
        reference: "property:create:1",
        entity_id: "property:1",
      }),
    }));
    const conflictSource = new FixtureSource({ "10": conflicting });
    await assert.rejects(ingestPage(sql, conflictSource, runtime, {}), /conflict/i);
    const [cursor] = await sql`select next_cursor from chain_cursors`;
    assert.equal(cursor.next_cursor, "10");
    const [failure] = await sql`
      select error_code from chain_event_failures where receipt_id = 'r-created'
    `;
    assert.equal(failure.error_code, "LEDGER_CONFLICT");
  });
});

test("provider failure and out-of-order cursors do not advance the cursor", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const failing: ChainEventSource = {
      name: "fixture",
      async fetchPage() {
        throw new Error("provider outage");
      },
    };
    await assert.rejects(ingestPage(sql, failing, runtime, { startBlock: "10" }), /provider outage/);
    const [cursor] = await sql`select next_cursor from chain_cursors`;
    assert.equal(cursor.next_cursor, "10");

    const outOfOrder = new FixtureSource({ "10": page("10", "9", []) });
    await assert.rejects(ingestPage(sql, outOfOrder, runtime, {}), /out-of-order/);
    const [after] = await sql`select next_cursor from chain_cursors`;
    assert.equal(after.next_cursor, "10");
  });
});

test("an event cannot cross the page's next block cursor", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const futureEvent = sourceEvent(
      "future-event",
      0,
      12,
      event("starter_allowance", {
        wallet_from: null,
        wallet_to: buyer,
        amount: "1",
        reference: "starter:buyer.testnet",
        entity_id: buyer,
        account: "buyer.testnet",
      }),
    );
    const source = new FixtureSource({
      "10": {
        events: [futureEvent],
        nextCursor: "11",
        lastFinalizedBlock: "12",
        lastFinalizedHash: "block-12",
      },
    });
    await assert.rejects(
      ingestPage(sql, source, runtime, { startBlock: "10" }),
      /at or beyond its next cursor/,
    );
    const [cursor] = await sql`select next_cursor from chain_cursors`;
    assert.equal(cursor.next_cursor, "10");
  });
});

test("database failure rolls back the page and cursor", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql`
      create function fail_wallet() returns trigger as $$
      begin
        if new.wallet_id = 'player:buyer.testnet' then raise exception 'wallet write failed'; end if;
        return new;
      end;
      $$ language plpgsql
    `;
    await sql`
      create trigger fail_wallet_trigger before insert or update on wallets
      for each row execute function fail_wallet()
    `;
    const source = new FixtureSource({ "10": ledgerPage() });
    await assert.rejects(ingestPage(sql, source, runtime, { startBlock: "10" }), /wallet write failed/);
    const [cursor] = await sql`select next_cursor from chain_cursors`;
    const [ledger] = await sql`select count(*)::int as count from transactions`;
    assert.equal(cursor.next_cursor, "10");
    assert.equal(ledger.count, 0);
  });
});

test("rebuild replays derived tables while preserving server-owned data", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql`
      insert into jobs (id, employer_wallet, employee_account, title, payment, status, reference)
      values ('job-keep', 'npc:professor-kofi', 'buyer.testnet', 'Keep', 100, 'verified', 'job:job-keep')
    `;
    await sql`insert into account_roles (account_id, role) values ('buyer.testnet', 'player')`;

    const source = new FixtureSource({
      "10": ledgerPage(),
      "11": page("11", "11", []),
    });
    const result = await rebuildMirror(sql, source, runtime, { startBlock: "10" });
    assert.equal(result.eventsStaged, 3);
    assert.equal(result.eventsApplied, 3);
    assert.equal(result.difference, "0");
    const [property] = await sql`
      select owner_wallet, active, archived_at from properties where id = 1
    `;
    assert.equal(property.owner_wallet, buyer);
    assert.equal(property.active, true);
    assert.equal(property.archived_at, null);
    const [job] = await sql`select status from jobs where id = 'job-keep'`;
    const [role] = await sql`select role from account_roles where account_id = 'buyer.testnet'`;
    assert.equal(job.status, "verified");
    assert.equal(role.role, "player");
    const [run] = await sql`select status, cleared_failures from rebuild_runs`;
    assert.equal(run.status, "success");
  });
});

test("reconciliation reports matching and mismatched mirrors", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await ingestPage(sql, new FixtureSource({ "10": ledgerPage() }), runtime, { startBlock: "10" });

    const matching = {
      viewContract: async <T>(method: string, args?: Record<string, unknown>) => {
        if (method === "get_stats") {
          return {
            players: 0,
            properties: 1,
            businesses: 0,
            total_issued: "1000",
            total_burned: "0",
            tx_count: 1,
          } as T;
        }
        if (method === "get_balance") {
          const wallet = String(args?.wallet);
          return (wallet === buyer ? "700" : "300") as T;
        }
        return null as T;
      },
      viewAllProperties: async () => [
        {
          id: 1,
          kind: "plot",
          district: "",
          x: 0,
          y: 0,
          owner: buyer,
          price: "0",
          for_sale: false,
          transfer_count: 1,
        },
      ],
      viewAllBusinesses: async () => [],
    };
    const ok = await reconcileMirror(sql, matching);
    assert.equal(ok.ok, true);
    assert.equal(ok.canonicalSupply, "1000");
    assert.equal(ok.mirroredWalletSum, "1000");

    const mismatched = await reconcileMirror(sql, {
      ...matching,
      viewContract: async <T>(method: string, args?: Record<string, unknown>) => {
        if (method === "get_balance") {
          return (String(args?.wallet) === buyer ? "701" : "300") as T;
        }
        return matching.viewContract<T>(method, args);
      },
    });
    assert.equal(mismatched.ok, false);
    assert.ok(mismatched.mismatches.some((mismatch) => mismatch.kind === "wallet"));
  });
});

test("ownership history is immutable and duplicate delivery does not duplicate it", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const source = new FixtureSource({ "10": ledgerPage() });
    await ingestPage(sql, source, runtime, { startBlock: "10" });
    const [history] = await sql`
      select asset_type, asset_id, previous_owner, new_owner, reference
      from asset_ownership_history
    `;
    assert.equal(history.asset_type, "property");
    assert.equal(history.asset_id, "1");
    assert.equal(history.previous_owner, seller);
    assert.equal(history.new_owner, buyer);
    assert.equal(history.reference, "property:1:1");

    await sql`update chain_cursors set next_cursor = '10'`;
    await ingestPage(sql, source, runtime, {});
    const [count] = await sql`select count(*)::int as count from asset_ownership_history`;
    assert.equal(count.count, 1);
  });
});

test("ownership repair plans without writing and applies only stale rows", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await ingestPage(sql, new FixtureSource({ "10": ledgerPage() }), runtime, { startBlock: "10" });
    await sql`update properties set owner_wallet = ${seller} where id = 1`;

    const plan = await planOwnershipRepairs(sql);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].expectedOwner, buyer);
    assert.equal(plan[0].actualOwner, seller);
    const [before] = await sql`select owner_wallet from properties where id = 1`;
    assert.equal(before.owner_wallet, seller);

    const changed = await applyOwnershipRepairs(sql, plan);
    assert.equal(changed, 1);
    const [after] = await sql`select owner_wallet from properties where id = 1`;
    assert.equal(after.owner_wallet, buyer);
    assert.deepEqual(await planOwnershipRepairs(sql), []);
  });
});

test("out-of-order or unfinalized events are rejected before cursor movement", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const unordered: ChainEventPage = {
      events: [
        sourceEvent(
          "z-receipt",
          0,
          10,
          event("property_created", {
            id: 1,
            owner_wallet: seller,
            listing_price: "0",
            for_sale: false,
            reference: "property:create:1",
            entity_id: "property:1",
          }),
        ),
        sourceEvent(
          "a-receipt",
          0,
          10,
          event("player_registered", {
            account: "alice.testnet",
            username: "alice",
            owner_wallet: "player:alice.testnet",
            reference: "player:alice.testnet",
            entity_id: "player:alice.testnet",
          }),
        ),
      ],
      nextCursor: "11",
      lastFinalizedBlock: "11",
      lastFinalizedHash: null,
    };
    await assert.rejects(
      ingestPage(sql, new FixtureSource({ "10": unordered }), runtime, { startBlock: "10" }),
      /out-of-order/,
    );
    const unfinalized: ChainEventPage = {
      events: [
        sourceEvent(
          "future",
          0,
          11,
          event("player_registered", {
            account: "alice.testnet",
            username: "alice",
            owner_wallet: "player:alice.testnet",
            reference: "player:alice.testnet",
            entity_id: "player:alice.testnet",
          }),
        ),
      ],
      nextCursor: "12",
      lastFinalizedBlock: "10",
      lastFinalizedHash: null,
    };
    await assert.rejects(
      ingestPage(sql, new FixtureSource({ "10": unfinalized }), runtime, {}),
      /outside the finalized range/,
    );
    const [cursor] = await sql`select next_cursor from chain_cursors`;
    assert.equal(cursor.next_cursor, "10");
  });
});

test("dead-letter retry and audited ignore controls work", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const malformed = new FixtureSource({
      "10": page("10", "11", [sourceEvent("bad", 0, 10, { standard: "quizcity" })]),
    });
    await assert.rejects(ingestPage(sql, malformed, runtime, { startBlock: "10" }), /dead-letter/);

    const [failureBefore] = await sql`select source from chain_event_failures`;
    assert.equal(failureBefore.source, "fixture");
    await retryFailure(sql, runtime, "bad", 0);
    const [afterRetry] = await sql`
      select resolved_at, retry_requested_at, retry_count from chain_event_failures
    `;
    assert.equal(afterRetry.resolved_at, null);
    assert.ok(afterRetry.retry_requested_at);
    assert.equal(afterRetry.retry_count, 1);

    const corrected = new FixtureSource({
      "10": page("10", "11", [
        sourceEvent(
          "bad",
          0,
          10,
          event("player_registered", {
            account: "alice.testnet",
            username: "alice",
            owner_wallet: "player:alice.testnet",
            reference: "player:alice.testnet",
            entity_id: "player:alice.testnet",
          }),
        ),
      ]),
    });
    const result = await ingestPage(sql, corrected, runtime, {});
    assert.equal(result.inserted, 1);
    const [resolved] = await sql`
      select resolved_at, resolved_by, retry_requested_at from chain_event_failures
    `;
    assert.ok(resolved.resolved_at);
    assert.equal(resolved.resolved_by, "chain-ingester");
    assert.equal(resolved.retry_requested_at, null);

    await sql`update chain_cursors set next_cursor = '10'`;
    await sql`update chain_event_failures set ignored_at = null, ignored_by = null, ignored_reason = null`;
    await assert.rejects(ingestPage(sql, malformed, runtime, {}), /dead-letter/);
    await assert.rejects(
      ignoreFailure(sql, runtime, { receiptId: "bad", eventIndex: 0, actor: "operator", reason: "" }),
      /reason/,
    );
    await ignoreFailure(sql, runtime, {
      receiptId: "bad",
      eventIndex: 0,
      actor: "operator.testnet",
      reason: "known unavailable legacy event",
    });
    const ignoredResult = await ingestPage(sql, malformed, runtime, {});
    assert.equal(ignoredResult.replayed, 1);
    const [failure] = await sql`select ignored_by, ignored_reason from chain_event_failures`;
    assert.equal(failure.ignored_by, "operator.testnet");
    assert.match(failure.ignored_reason, /legacy/);
  });
});

function fullCreationPage(): ChainEventPage {
  return page("10", "11", [
    sourceEvent(
      "a-property",
      0,
      10,
      event("property_created", {
        id: 1,
        kind: "venue",
        district: "knowledge",
        x: 3,
        y: 4,
        owner_wallet: seller,
        listing_price: "0",
        for_sale: false,
        reference: "property:create:1",
        entity_id: "property:1",
      }),
    ),
    sourceEvent(
      "b-business",
      0,
      10,
      event("business_created", {
        id: 1,
        name: "Cafe",
        owner: "buyer.testnet",
        owner_wallet: buyer,
        property_id: 1,
        treasury: "biz:1",
        permit_fee: "100",
        reference: "business:create:1",
        entity_id: "business:1",
      }),
    ),
    sourceEvent(
      "c-mint",
      0,
      10,
      event(
        "starter_allowance",
        {
          wallet_from: null,
          wallet_to: buyer,
          amount: "1000",
          reference: "starter:buyer.testnet",
          entity_id: buyer,
          account: "buyer.testnet",
        },
        2,
      ),
    ),
  ]);
}

async function seedMirrorSentinel(sql: Sql): Promise<void> {
  await sql`
    insert into properties (
      id, district, x, y, owner_wallet, property_type, price, for_sale,
      transfer_count, active
    ) values (99, 'old', 1, 1, 'player:old.testnet', 'plot', '0', false, 0, true)
  `;
  await sql`
    insert into wallets (wallet_id, owner_type, owner_id, balance)
    values ('gov:council', 'gov', 'council', '500')
  `;
}

async function assertSentinelUntouched(sql: Sql): Promise<void> {
  const [property] = await sql`select active from properties where id = 99`;
  assert.equal(property.active, true);
  const [wallet] = await sql`select balance::text as balance from wallets where wallet_id = 'gov:council'`;
  assert.equal(wallet.balance, "500");
  const [ledger] = await sql`select count(*)::int as count from transactions`;
  assert.equal(ledger.count, 0);
  const [cursors] = await sql`select count(*)::int as count from chain_cursors`;
  assert.equal(cursors.count, 0);
}

class FailingAfterFirstSource implements ChainEventSource {
  name = "fixture";
  calls = 0;

  async fetchPage(cursor: string): Promise<ChainEventPage> {
    this.calls += 1;
    if (cursor === "10") return fullCreationPage();
    throw new Error("provider outage on page two");
  }
}

test("rebuild failure paths leave the active mirror unchanged and exit incomplete", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedMirrorSentinel(sql);

    await assert.rejects(
      rebuildMirror(sql, new FailingAfterFirstSource(), runtime, { startBlock: "10" }),
      /provider outage/,
    );
    await assertSentinelUntouched(sql);

    const malformedLater = new FixtureSource({
      "10": fullCreationPage(),
      "11": page("11", "12", [sourceEvent("bad", 0, 11, { standard: "quizcity" })]),
    });
    await assert.rejects(
      rebuildMirror(sql, malformedLater, runtime, { startBlock: "10" }),
      /standard|version|invalid|event/i,
    );
    await assertSentinelUntouched(sql);

    const conflicting = new FixtureSource({
      "10": fullCreationPage(),
      "11": page("11", "12", [
        {
          ...sourceEvent(
            "a-property",
            0,
            11,
            event("property_created", {
              id: 1,
              kind: "venue",
              district: "knowledge",
              x: 3,
              y: 4,
              owner_wallet: seller,
              listing_price: "0",
              for_sale: false,
              reference: "property:create:1",
              entity_id: "property:1",
            }),
          ),
          blockHash: "conflicting-block-hash",
          txHash: "conflicting-transaction-hash",
          chainTimestamp: "2026-11-12T01:00:00.000Z",
        },
      ]),
    });
    await assert.rejects(
      rebuildMirror(sql, conflicting, runtime, { startBlock: "10" }),
      /conflicting duplicate/,
    );
    await assertSentinelUntouched(sql);

    await assert.rejects(
      rebuildMirror(sql, new FixtureSource({ "10": fullCreationPage() }), runtime, {
        startBlock: "10",
        maxPages: 1,
      }),
      /without reaching the end/,
    );
    await assertSentinelUntouched(sql);

    await assert.rejects(
      rebuildMirror(sql, new FixtureSource({}), runtime, { startBlock: "10", maxPages: 0 }),
      /maxPages/,
    );
    // Invalid options must be rejected before reserving this pool's only
    // connection, otherwise the following query would never acquire it.
    const [stillUsable] = await sql`select 1::int as value`;
    assert.equal(stillUsable.value, 1);

    const [failedRuns] = await sql`
      select count(*)::int as count from rebuild_runs where status = 'failed'
    `;
    assert.equal(failedRuns.count, 4);
  });
});

test("rebuild rolls back instead of committing a reconciliation mismatch", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedMirrorSentinel(sql);
    await sql`
      create function skew_rebuild_wallet() returns trigger as $$
      begin
        new.balance := new.balance + 1;
        return new;
      end;
      $$ language plpgsql
    `;
    await sql`
      create trigger skew_rebuild_wallet_trigger before insert on wallets
      for each row execute function skew_rebuild_wallet()
    `;

    await assert.rejects(
      rebuildMirror(
        sql,
        new FixtureSource({ "10": fullCreationPage(), "11": page("11", "11", []) }),
        runtime,
        { startBlock: "10" },
      ),
      /reconciliation mismatch/,
    );
    await assertSentinelUntouched(sql);
    const [run] = await sql`
      select status, error_message from rebuild_runs order by id desc limit 1
    `;
    assert.equal(run.status, "failed");
    assert.match(run.error_message, /reconciliation mismatch/);
  });
});

test("rebuild is exclusive and blocks the live ingester", async () => {
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    const holder = connectTestClient(testDatabaseUrl(), schema);
    try {
      await holder`
        select pg_advisory_lock(
          hashtext(
            current_schema() || ':' ||
            ${`quizcity-rebuild:testnet:quizcity.testnet`}
          )
        )
      `;
      await assert.rejects(
        rebuildMirror(sql, new FixtureSource({ "10": fullCreationPage() }), runtime, {
          startBlock: "10",
        }),
        /another rebuild or ingestion/,
      );
      await assert.rejects(
        ingestPage(sql, new FixtureSource({ "10": fullCreationPage() }), runtime, {
          startBlock: "10",
        }),
        /rebuild is in progress/,
      );
    } finally {
      await holder`
        select pg_advisory_unlock(
          hashtext(
            current_schema() || ':' ||
            ${`quizcity-rebuild:testnet:quizcity.testnet`}
          )
        )
      `;
      await holder.end();
    }
  });
});

test("rebuild rolls back a database failure during replacement", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await seedMirrorSentinel(sql);
    await sql`
      create function fail_rebuild_property() returns trigger as $$
      begin
        if new.id = 1 then raise exception 'replacement write failed'; end if;
        return new;
      end;
      $$ language plpgsql
    `;
    await sql`
      create trigger fail_rebuild_property_trigger before insert or update on properties
      for each row execute function fail_rebuild_property()
    `;
    await assert.rejects(
      rebuildMirror(
        sql,
        new FixtureSource({ "10": fullCreationPage(), "11": page("11", "11", []) }),
        runtime,
        { startBlock: "10" },
      ),
      /replacement write failed/,
    );
    await assertSentinelUntouched(sql);
  });
});

test("rebuild activates archived roots and reconstructs every creation field", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql`
      insert into properties (
        id, district, x, y, owner_wallet, property_type, price, for_sale,
        transfer_count, active, archived_at
      ) values (1, 'old', 0, 0, 'gov:council', 'plot', '0', false, 4, false, now())
    `;
    await sql`
      insert into businesses (
        id, name, owner_account, property_id, treasury_wallet, revenue_total,
        active, archived_at
      ) values (1, 'Old', 'old.testnet', 1, 'biz:1', 0, false, now())
    `;
    await sql`
      insert into players (account_id, username) values ('keep.testnet', 'keep')
    `;

    const result = await rebuildMirror(
      sql,
      new FixtureSource({ "10": fullCreationPage(), "11": page("11", "11", []) }),
      runtime,
      { startBlock: "10" },
    );
    assert.equal(result.properties, 1);
    assert.equal(result.businesses, 1);
    assert.equal(result.wallets, 1);

    const [property] = await sql`
      select district, x, y, owner_wallet, property_type, price::text as price,
             for_sale, transfer_count::text as transfer_count, active, archived_at
      from properties where id = 1
    `;
    assert.deepEqual(property, {
      district: "knowledge",
      x: 3,
      y: 4,
      owner_wallet: seller,
      property_type: "venue",
      price: "0",
      for_sale: false,
      transfer_count: "0",
      active: true,
      archived_at: null,
    });
    const [business] = await sql`
      select name, owner_account, property_id::text as property_id, treasury_wallet,
             revenue_total::text as revenue_total, active, archived_at
      from businesses where id = 1
    `;
    assert.deepEqual(business, {
      name: "Cafe",
      owner_account: "buyer.testnet",
      property_id: "1",
      treasury_wallet: "biz:1",
      revenue_total: "0",
      active: true,
      archived_at: null,
    });
    const [player] = await sql`select username from players where account_id = 'keep.testnet'`;
    assert.equal(player.username, "keep");
    const [cursor] = await sql`select next_cursor, source from chain_cursors`;
    assert.equal(cursor.next_cursor, "11");
    assert.equal(cursor.source, "fixture");
    const [run] = await sql`
      select status, canonical_supply::text as supply, mirrored_wallet_sum::text as mirrored,
             difference::text as difference, events_staged, events_applied
      from rebuild_runs
    `;
    assert.equal(run.status, "success");
    assert.equal(run.supply, "1000");
    assert.equal(run.mirrored, "1000");
    assert.equal(run.difference, "0");
    assert.equal(run.events_staged, 3);
    assert.equal(run.events_applied, 3);
  });
});

test("retry rewinds only the failed source and failed reprocessing stays unresolved", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql`
      insert into chain_cursors (network_id, contract_id, source, next_cursor, last_finalized_block)
      values
        ('testnet', 'quizcity.testnet', 'fixture', '10', '10'),
        ('testnet', 'quizcity.testnet', 'other-source', '20', '20')
    `;
    const malformed = new FixtureSource({
      "10": page("10", "11", [sourceEvent("bad", 0, 10, { standard: "quizcity" })]),
    });
    await assert.rejects(ingestPage(sql, malformed, runtime, {}), /dead-letter/);

    await retryFailure(sql, runtime, "bad", 0);
    const cursors = await sql`
      select source, next_cursor from chain_cursors order by source
    `;
    assert.deepEqual(
      cursors.map((row) => [row.source, row.next_cursor]),
      [
        ["fixture", "10"],
        ["other-source", "20"],
      ],
    );

    await assert.rejects(ingestPage(sql, malformed, runtime, {}), /dead-letter/);
    const [failure] = await sql`
      select resolved_at, retry_requested_at, attempt_count, source
      from chain_event_failures
    `;
    assert.equal(failure.resolved_at, null);
    assert.ok(failure.retry_requested_at);
    assert.equal(failure.attempt_count, 2);
    assert.equal(failure.source, "fixture");

    await assert.rejects(
      ignoreFailure(sql, runtime, { receiptId: "bad", eventIndex: 0, actor: "", reason: "why" }),
      /actor/,
    );
  });
});

test("a second ingester cannot enter the same source page concurrently", async () => {
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    const holder = connectTestClient(testDatabaseUrl(), schema);
    try {
      await holder.unsafe("begin");
      await holder`
        select pg_advisory_xact_lock(
          hashtext(current_schema() || ':' || ${"quizcity-ingest:testnet:quizcity.testnet:fixture"})
        )
      `;
      await assert.rejects(
        ingestPage(sql, new FixtureSource({ "10": fullCreationPage() }), runtime, {
          startBlock: "10",
        }),
        /another ingestion page/,
      );
    } finally {
      await holder.unsafe("rollback").catch(() => {});
      await holder.end();
    }
  });
});
