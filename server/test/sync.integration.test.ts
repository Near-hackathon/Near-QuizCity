import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import { syncEconomy, type SyncDeps } from "../src/sync.js";
import { connectTestClient, connectTestPool, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";

const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));

async function migrate(sql: Sql) {
  await runMigrations(postgresMigrationStore(sql), migrations);
}

function property(id: number, owner: string) {
  return {
    id,
    kind: "plot",
    district: "knowledge",
    x: id,
    y: id,
    owner,
    price: "0",
    for_sale: false,
    transfer_count: 0,
  };
}

function business(id: number, owner: string, treasury: string) {
  return {
    id,
    name: `Business ${id}`,
    owner,
    property_id: 10,
    treasury,
    revenue_total: "0",
  };
}

function deps(sql: Sql, overrides: Partial<SyncDeps> = {}): SyncDeps {
  return {
    db: sql,
    networkId: "testnet",
    contractId: "quizcity.testnet",
    viewContract: async <T>(method: string, args?: Record<string, unknown>) => {
      if (method === "get_stats") {
        return {
          players: 0,
          properties: 1,
          businesses: 1,
          total_issued: "1000",
          total_burned: "0",
          tx_count: 5,
        } as T;
      }
      if (method === "get_balance") return String(args?.wallet === "gov:council" ? "1000" : "0") as T;
      return null as T;
    },
    viewAllProperties: async () => [property(10, "gov:council")],
    viewAllBusinesses: async () => [business(10, "alice.testnet", "gov:council")],
    viewAllWallets: async () => [{ wallet_id: "gov:council", balance: "1000" }],
    ...overrides,
  };
}

test("full sync archives stale derived rows and preserves server-owned data", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql`
      insert into properties (id, district, x, y, owner_wallet, property_type)
      values (1, 'old', 1, 1, 'player:old.testnet', 'plot')
    `;
    await sql`
      insert into businesses (id, name, owner_account, property_id, treasury_wallet)
      values (1, 'Old', 'old.testnet', 1, 'biz:1')
    `;
    await sql`
      insert into wallets (wallet_id, owner_type, owner_id, balance)
      values ('player:old.testnet', 'player', 'old.testnet', 10)
    `;
    await sql`
      insert into jobs (id, employer_wallet, title, payment, status, reference)
      values ('job-keep', 'npc:professor-kofi', 'Keep', 100, 'open', 'job:job-keep')
    `;
    await sql`
      insert into chain_events (
        network_id, contract_id, receipt_id, event_index, event_name, event_version, event, payload
      ) values (
        'testnet', 'quizcity.testnet', 'keep-receipt', 0, 'player_registered', '1.0.0',
        'player_registered', '{}'::jsonb
      )
    `;

    const result = await syncEconomy(deps(sql));
    assert.equal(result.skipped, false);
    assert.equal(result.canonicalSupply, "1000");
    assert.equal(result.mirroredWalletSum, "1000");
    assert.equal(result.difference, "0");

    const staleProperty = await sql`
      select active, archived_at from properties where id = 1
    `;
    assert.equal(staleProperty[0].active, false);
    assert.ok(staleProperty[0].archived_at);
    const currentProperty = await sql`select active from properties where id = 10`;
    assert.equal(currentProperty[0].active, true);
    const staleBusiness = await sql`select active from businesses where id = 1`;
    assert.equal(staleBusiness[0].active, false);
    const staleWallet = await sql`select active from wallets where wallet_id = 'player:old.testnet'`;
    assert.equal(staleWallet[0].active, false);

    const [job] = await sql`select count(*)::int as count from jobs`;
    const [event] = await sql`select count(*)::int as count from chain_events`;
    assert.equal(job.count, 1);
    assert.equal(event.count, 1);

    const [run] = await sql`select status from sync_runs order by id desc limit 1`;
    assert.equal(run.status, "success");
    const [snapshot] = await sql`select count(*)::int as count from economy_snapshots`;
    assert.equal(snapshot.count, 1);

    await syncEconomy(deps(sql));
    const [snapshots] = await sql`select count(*)::int as count from economy_snapshots`;
    assert.equal(snapshots.count, 1);
  });
});

test("a failed snapshot changes nothing and records a failed sync run", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    await sql`
      insert into properties (id, district, x, y, owner_wallet, property_type)
      values (1, 'old', 1, 1, 'player:old.testnet', 'plot')
    `;
    await assert.rejects(
      syncEconomy(
        deps(sql, {
          viewAllBusinesses: async () => {
            throw new Error("provider outage");
          },
        }),
      ),
      /provider outage/,
    );
    const [property] = await sql`select active, owner_wallet from properties where id = 1`;
    assert.equal(property.active, true);
    assert.equal(property.owner_wallet, "player:old.testnet");
    const [run] = await sql`select status, error_message from sync_runs order by id desc limit 1`;
    assert.equal(run.status, "failed");
    assert.match(run.error_message, /provider outage/);
  });
});

test("concurrent full syncs have one winner and one skip", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    const first = connectTestPool(url, schema, 2);
    const second = connectTestPool(url, schema, 2);
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let startedResolve: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      const slow = deps(first, {
        viewAllProperties: async () => {
          startedResolve();
          await gate;
          return [property(10, "gov:council")];
        },
      });
      const fast = deps(second);
      const firstResult = syncEconomy(slow);
      await started;
      const secondResult = syncEconomy(fast);
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      const [a, b] = await Promise.all([firstResult, secondResult]);
      assert.equal(Number(a.skipped) + Number(b.skipped), 1);
    } finally {
      await first.end();
      await second.end();
    }
  });
});

test("full sync skips while a mirror rebuild holds the shared guard", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ sql, schema }) => {
    await migrate(sql);
    const holder = connectTestClient(url, schema);
    try {
      await holder`
        select pg_advisory_lock(
          hashtext(
            current_schema() || ':' ||
            ${`quizcity-rebuild:testnet:quizcity.testnet`}
          )
        )
      `;
      const result = await syncEconomy(deps(sql));
      assert.equal(result.skipped, true);
      const [run] = await sql`
        select status, error_message from sync_runs order by id desc limit 1
      `;
      assert.equal(run.status, "skipped");
      assert.equal(run.error_message, "mirror rebuild is in progress");
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

test("supply math is exact above the safe integer range and reports mismatches", async () => {
  await withTestSchema(async ({ sql }) => {
    await migrate(sql);
    const balance = "90071992547409930";
    const base = deps(sql, {
      viewContract: async <T>(method: string) => {
        if (method === "get_stats") {
          return {
            players: 0,
            properties: 1,
            businesses: 1,
            total_issued: "90071992547409933",
            total_burned: "3",
            tx_count: 1,
          } as T;
        }
        return balance as T;
      },
      viewAllWallets: async () => [{ wallet_id: "gov:council", balance }],
    });
    const result = await syncEconomy(base);
    assert.equal(result.canonicalSupply, "90071992547409930");
    assert.equal(result.mirroredWalletSum, balance);
    assert.equal(result.difference, "0");

    const mismatch = await syncEconomy(
      deps(sql, {
        viewContract: async <T>(method: string) => {
          if (method === "get_stats") {
            return {
              players: 0,
              properties: 1,
              businesses: 1,
              total_issued: "90071992547409933",
              total_burned: "3",
              tx_count: 2,
            } as T;
          }
          return "90071992547409929" as T;
        },
        viewAllWallets: async () => [{ wallet_id: "gov:council", balance: "90071992547409929" }],
      }),
    );
    assert.equal(mismatch.difference, "1");
  });
});
