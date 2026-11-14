import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadMigrations, postgresMigrationStore, runMigrations, type Migration } from "../src/migrations.js";
import { connectTestClient, testDatabaseUrl, withTestSchema } from "./db-test-utils.js";
import { seedWorld } from "../db/seeds/world.js";
import { worldScenes } from "@quiz-city/world-data";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
const realMigrations = loadMigrations(migrationsDir);

test("historical furniture migration validates footprints and upgrades occupied rooms without losing identities or balances", async () => {
  const furnitureMigration = realMigrations.find((item) => item.filename === "0026_furnished_interiors.sql")!;
  const values = furnitureMigration.sql
    .split("insert into quizcity_interior_furniture values\n")[1]
    .split(";")[0];
  const rows = [...values.matchAll(/\('([^']+)', (\d+), (\d+), (\d+), (\d+)\)/g)].map((match) => [
    match[1],
    ...match.slice(2).map(Number),
  ]);
  assert.equal(rows.length, 49);
  assert.ok(rows.some((row) => row[0] === "library-interior" && row[1] === 6 && row[2] === 10));
  await withTestSchema(async ({ sql }) => {
    await runMigrations(
      postgresMigrationStore(sql),
      realMigrations.filter((m) => m.filename < "0026"),
    );
    await seedWorld(sql);
    await sql`update scenes set asset_version = 2 where scene_type = 'interior'`;
    await sql`insert into wallets (wallet_id, owner_type, owner_id, balance) values ('player:fixture.testnet','player','fixture.testnet',9007199254740993)`;
    await sql`insert into player_presence (session_id, player_account, scene_id, x, y, facing, path, scene_version)
      values ('trapped','alice.testnet','library-interior',6,10,'south','[{"x":6,"y":11}]'::jsonb,2),
      ('safe','bob.testnet','library-interior',12,12,'south','[]'::jsonb,2),
      ('outside','carol.testnet','city-district',20,10,'south','[]'::jsonb,3)`;
    const before =
      await sql`select session_id, presence_generation::text from player_presence order by session_id`;
    await sql`update npc_runtime set scene_id = 'library-interior', x = 6, y = 10 where npc_id = 'professor-kofi'`;
    const result = await runMigrations(
      postgresMigrationStore(sql),
      realMigrations.filter((m) => m.filename < "0027"),
    );
    assert.deepEqual(
      result.applied.map((item) => item.filename),
      ["0026_furnished_interiors.sql"],
    );
    assert.deepEqual(
      [...(await sql`select session_id, presence_generation::text from player_presence order by session_id`)],
      [...before],
    );
    const presences =
      await sql`select session_id, x, y, path, scene_version::text as version from player_presence order by session_id`;
    assert.deepEqual(
      presences.map(({ session_id, x, y, version }) => ({ session_id, x, y, version })),
      [
        { session_id: "outside", x: 20, y: 10, version: "3" },
        { session_id: "safe", x: 12, y: 12, version: "3" },
        { session_id: "trapped", x: 12, y: 12, version: "3" },
      ],
    );
    assert.deepEqual(presences.find((item) => item.session_id === "trapped")!.path, []);
    const [npc] = await sql`select x,y,target_x,target_y from npc_runtime where npc_id = 'professor-kofi'`;
    assert.deepEqual({ ...npc }, { x: 12, y: 12, target_x: null, target_y: null });
    const [wallet] =
      await sql`select balance::text as balance from wallets where wallet_id = 'player:fixture.testnet'`;
    assert.equal(wallet.balance, "9007199254740993");
    const second = await runMigrations(
      postgresMigrationStore(sql),
      realMigrations.filter((m) => m.filename < "0027"),
    );
    assert.deepEqual(second.applied, []);
  });
});

test("a later migration error rolls back furnished-room relocation and version changes", async () => {
  await withTestSchema(async ({ sql }) => {
    const previous = realMigrations.filter((m) => m.filename < "0026");
    await runMigrations(postgresMigrationStore(sql), previous);
    await seedWorld(sql);
    await sql`update scenes set asset_version = 2 where scene_type = 'interior'`;
    await sql`insert into player_presence (session_id, player_account, scene_id, x, y, facing) values ('rollback','alice.testnet','library-interior',6,10,'south')`;
    const before = await sql`select * from player_presence`;
    const failure: Migration = {
      filename: "0027_fixture_failure.sql",
      checksum: "failure",
      sql: "select 1/0",
    };
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), [
        ...realMigrations.filter((m) => m.filename < "0027"),
        failure,
      ]),
    );
    assert.deepEqual([...(await sql`select * from player_presence`)], [...before]);
    const [scene] = await sql`select asset_version from scenes where id = 'library-interior'`;
    assert.equal(scene.asset_version, "2");
    const registry =
      await sql`select filename from schema_migrations where filename = '0026_furnished_interiors.sql'`;
    assert.equal(registry.length, 0);
  });
});

test("fresh database applies every migration and records exact checksums", async () => {
  await withTestSchema(async ({ sql }) => {
    const first = await runMigrations(postgresMigrationStore(sql), realMigrations);
    assert.deepEqual(
      first.applied.map((migration) => migration.filename),
      realMigrations.map((migration) => migration.filename),
    );

    const registry = await sql<{ filename: string; checksum: string }[]>`
      select filename, checksum from schema_migrations order by filename
    `;
    assert.deepEqual(
      [...registry].map((row) => ({ filename: row.filename, checksum: row.checksum })),
      realMigrations.map((migration) => ({
        filename: migration.filename,
        checksum: migration.checksum,
      })),
    );

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = current_schema()
    `;
    const names = new Set(tables.map((table) => table.table_name));
    for (const name of ["players", "wallets", "transactions", "schema_migrations"]) {
      assert.ok(names.has(name), `${name} should exist`);
    }

    const second = await runMigrations(postgresMigrationStore(sql), realMigrations);
    assert.deepEqual(second.pending, []);
    assert.deepEqual(second.applied, []);
  });
});

test("a pre-migration schema upgrades without losing rows", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), [realMigrations[0]]);

    await sql`insert into players (account_id, username) values (${"alice.testnet"}, ${"alice"})`;
    await sql`
      insert into wallets (wallet_id, owner_type, owner_id, balance)
      values (${"player:alice.testnet"}, ${"player"}, ${"alice.testnet"}, 500)
    `;
    await sql`
      insert into transactions (tx_hash, wallet_from, wallet_to, amount, kind, reference)
      values (${"legacy-tx"}, ${"system:mint"}, ${"player:alice.testnet"}, 500, ${"starter_allowance"}, ${"alice.testnet"})
    `;
    await sql`
      insert into chain_events (receipt_id, tx_hash, event, payload)
      values (${"legacy-receipt"}, ${"legacy-tx"}, ${"starter_allowance"}, ${sql.json({ legacy: true })})
    `;

    const result = await runMigrations(postgresMigrationStore(sql), realMigrations);
    assert.ok(result.applied.length >= 1);

    const [player] = await sql`select account_id from players`;
    assert.equal(player.account_id, "alice.testnet");
    const [wallet] = await sql`select balance from wallets`;
    assert.equal(Number(wallet.balance), 500);
    const [tx] = await sql`select receipt_id, network_id, wallet_from from transactions`;
    assert.match(tx.receipt_id, /^legacy:/);
    assert.equal(tx.network_id, "legacy");
    assert.equal(tx.wallet_from, null);
    const [event] = await sql`select network_id, event_index from chain_events`;
    assert.equal(event.network_id, "legacy");
    assert.equal(event.event_index, 0);
  });
});

test("dead-letter source repair refuses an ambiguous legacy cursor source", async () => {
  await withTestSchema(async ({ sql }) => {
    const repairIndex = realMigrations.findIndex(
      (migration) => migration.filename === "0019_dead_letter_source_repair.sql",
    );
    assert.ok(repairIndex > 0, "source repair migration must exist after the audit migration");
    await runMigrations(postgresMigrationStore(sql), realMigrations.slice(0, repairIndex));
    await sql`
      insert into chain_cursors (
        network_id, contract_id, source, next_cursor, last_finalized_block
      ) values
        ('testnet', 'quizcity.testnet', 'source-a', '10', 9),
        ('testnet', 'quizcity.testnet', 'source-b', '10', 9)
    `;
    await sql`
      insert into chain_event_failures (
        network_id, contract_id, source, receipt_id, event_index,
        block_height, error_code, error_message
      ) values (
        'testnet', 'quizcity.testnet', 'source-a', 'receipt', 0,
        '10', 'DEAD_LETTER', 'legacy failure'
      )
    `;

    await runMigrations(postgresMigrationStore(sql), realMigrations);
    const [failure] = await sql`select source from chain_event_failures where receipt_id = 'receipt'`;
    assert.equal(failure.source, null);
  });
});

test("checksum drift is rejected before any new migration runs", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), [realMigrations[0]]);
    const changed: Migration = { ...realMigrations[0], checksum: "0".repeat(64) };
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), [changed, ...realMigrations.slice(1)]),
      /checksum changed/,
    );
    const columns = await sql`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = ${"transactions"}
    `;
    assert.equal(
      columns.some((column) => column.column_name === "network_id"),
      false,
    );
  });
});

test("missing and out-of-order applied histories are rejected", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), realMigrations);
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), realMigrations.slice(0, -1)),
      /applied history contains/,
    );
  });

  await withTestSchema(async ({ sql }) => {
    await sql`
      create table schema_migrations (
        filename text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `;
    const last = realMigrations[realMigrations.length - 1];
    await sql`
      insert into schema_migrations (filename, checksum) values (${last.filename}, ${last.checksum})
    `;
    await assert.rejects(runMigrations(postgresMigrationStore(sql), realMigrations), /not an ordered prefix/);
  });
});

test("concurrent runners serialize and apply each migration once", async () => {
  const url = testDatabaseUrl();
  await withTestSchema(async ({ schema }) => {
    const migrations: Migration[] = [
      {
        filename: "0001_concurrency.sql",
        checksum: "a",
        sql: "create table concurrency_probe (id integer); select pg_sleep(0.3);",
      },
      {
        filename: "0002_concurrency.sql",
        checksum: "b",
        sql: "create table concurrency_probe_two (id integer);",
      },
    ];
    const first = connectTestClient(url, schema);
    const second = connectTestClient(url, schema);
    try {
      const [resultA, resultB] = await Promise.all([
        runMigrations(postgresMigrationStore(first), migrations),
        runMigrations(postgresMigrationStore(second), migrations),
      ]);
      assert.equal(resultA.applied.length + resultB.applied.length, 2);
      const [registry] = await first<{ count: number }[]>`
        select count(*)::int as count from schema_migrations
      `;
      assert.equal(registry.count, 2);
    } finally {
      await first.end();
      await second.end();
    }
  });
});

test("a failing later migration rolls back the whole run", async () => {
  await withTestSchema(async ({ sql }) => {
    const migrations: Migration[] = [
      {
        filename: "0001_rollback.sql",
        checksum: "a",
        sql: "create table rollback_probe (id integer);",
      },
      {
        filename: "0002_rollback.sql",
        checksum: "b",
        sql: "create table broken (",
      },
    ];
    await assert.rejects(runMigrations(postgresMigrationStore(sql), migrations));
    const [probe] = await sql`select to_regclass('rollback_probe') as relation`;
    assert.equal(probe.relation, null);
    const [registryTable] = await sql`select to_regclass('schema_migrations') as relation`;
    if (registryTable.relation !== null) {
      const [registry] = await sql`select count(*)::int as count from schema_migrations`;
      assert.equal(registry.count, 0);
    }
  });
});

test("historical residential suite upgrade preserves safe positions and money and is idempotent", async () => {
  const migration = realMigrations.find((m) => m.filename === "0028_residential_suites.sql")!;
  const payload = JSON.parse(migration.sql.split("jsonb_to_recordset('")[1].split("'::jsonb)")[0]);
  assert.equal(payload.length, 6);
  assert.equal(payload.find((s: { id: string }) => s.id === "apartment-interior").width, 30);
  assert.ok(payload.every((s: { version: string }) => s.version === "4"));
  await withTestSchema(async ({ sql }) => {
    await runMigrations(
      postgresMigrationStore(sql),
      realMigrations.filter((m) => m.filename < "0028"),
    );
    await seedWorld(sql);
    await sql`insert into wallets(wallet_id,owner_type,owner_id,balance) values ('player:fixture.testnet','player','fixture.testnet',9007199254740993)`;
    await sql`insert into player_presence(session_id,player_account,scene_id,x,y,facing) values ('safe','alice.testnet','city-district',20,11,'north'),('trapped','bob.testnet','apartment-interior',2,2,'south')`;
    await runMigrations(
      postgresMigrationStore(sql),
      realMigrations.filter((m) => m.filename < "0029"),
    );
    const rows =
      await sql`select session_id,x,y,scene_version::text as v from player_presence order by session_id`;
    assert.deepEqual(
      [...rows],
      [
        { session_id: "safe", x: 20, y: 11, v: "4" },
        { session_id: "trapped", x: 15, y: 19, v: "4" },
      ],
    );
    assert.equal(
      (await sql`select balance::text as b from wallets where wallet_id='player:fixture.testnet'`)[0].b,
      "9007199254740993",
    );
    assert.equal(
      (
        await runMigrations(
          postgresMigrationStore(sql),
          realMigrations.filter((m) => m.filename < "0029"),
        )
      ).applied.length,
      0,
    );
  });
});

const professorHomeMigration = realMigrations.find((m) => m.filename === "0032_professor_home.sql")!;
async function previousProfessorHome(sql: Parameters<typeof seedWorld>[0]) {
  await runMigrations(
    postgresMigrationStore(sql),
    realMigrations.filter((m) => m.filename < "0032"),
  );
  await seedWorld(sql);
  await sql`update scenes set width=30,height=24,asset_version=4,name='City Residences' where id='apartment-interior'`;
  await sql`update buildings set display_name='City Residences',operating_hours='{}'::jsonb where id='building-apartment'`;
  await sql`update spawn_points set x=15,y=22 where id='apartment-spawn'`;
  await sql`update spawn_points set x=15,y=19 where id='apartment-default'`;
  for (const [npc, id] of [
    ["librarian-ama", "ama-home"],
    ["quiz-attendant-yaw", "yaw-home"],
    ["barista-esi", "esi-home"],
    ["resident-kojo", "kojo-home"],
    ["student-abena", "abena-home"],
  ]) {
    await sql`insert into spawn_points(id,scene_id,kind,x,y) values (${id},'apartment-interior','npc_waypoint',23,14)`;
    await sql`update npc_schedules set destination_scene_id='apartment-interior',destination_building_id='building-apartment',destination_spawn_id=${id},activity='home',parameters='{}'::jsonb where npc_id=${npc} and sequence=0`;
  }
  await sql`update npc_runtime set scene_id='apartment-interior',x=23,y=14`;
  await sql`insert into wallets(wallet_id,owner_type,owner_id,balance) values ('player:fixture.testnet','player','fixture.testnet',9007199254740993)`;
  await sql`insert into player_presence(session_id,player_account,scene_id,x,y,facing,scene_version) values ('safe','alice.testnet','apartment-interior',9,9,'north',4),('outside-room','bob.testnet','apartment-interior',28,22,'south',4),('blocked','carol.testnet','apartment-interior',2,2,'south',4),('outside','dan.testnet','city-district',20,11,'east',4)`;
}

test("professor-only home migration matches shared maps and upgrades old suites without losing progress", async () => {
  const payload = JSON.parse(
    professorHomeMigration.sql.split("jsonb_to_recordset('")[1].split("'::jsonb)")[0],
  );
  assert.deepEqual(
    payload,
    worldScenes
      .filter((s) => ["city-district", "apartment-interior"].includes(s.id))
      .map((s) => ({
        id: s.id,
        width: s.width,
        height: s.height,
        version: "5",
        blocked: s.blocked,
        spawns: s.spawns.filter((p) => p.id !== "market-queue"),
      })),
  );
  await withTestSchema(async ({ sql }) => {
    await previousProfessorHome(sql);
    const identities =
      await sql`select session_id,player_account,presence_generation::text from player_presence order by session_id`;
    await runMigrations(
      postgresMigrationStore(sql),
      realMigrations.filter((m) => m.filename < "0033"),
    );
    assert.deepEqual(
      [
        ...(await sql`select session_id,player_account,presence_generation::text from player_presence order by session_id`),
      ],
      [...identities],
    );
    const rooms =
      await sql`select session_id,x,y,scene_version::text as v from player_presence order by session_id`;
    assert.deepEqual(
      [...rooms],
      [
        { session_id: "blocked", x: 9, y: 9, v: "5" },
        { session_id: "outside", x: 20, y: 11, v: "5" },
        { session_id: "outside-room", x: 9, y: 9, v: "5" },
        { session_id: "safe", x: 9, y: 9, v: "5" },
      ],
    );
    assert.deepEqual(
      [...(await sql`select npc_id from npc_runtime where scene_id='apartment-interior'`)],
      [{ npc_id: "professor-kofi" }],
    );
    assert.equal(
      (
        await sql`select count(*)::int as n from npc_schedules where npc_id<>'professor-kofi' and destination_scene_id='apartment-interior'`
      )[0].n,
      0,
    );
    assert.equal(
      (
        await sql`select count(*)::int as n from spawn_points where scene_id='apartment-interior' and kind='npc_waypoint' and active=true`
      )[0].n,
      1,
    );
    assert.equal(
      (await sql`select balance::text as balance from wallets where wallet_id='player:fixture.testnet'`)[0]
        .balance,
      "9007199254740993",
    );
    assert.deepEqual(
      (await sql`select operating_hours from buildings where id='building-apartment'`)[0].operating_hours,
      {},
    );
    assert.equal(
      (
        await runMigrations(
          postgresMigrationStore(sql),
          realMigrations.filter((m) => m.filename < "0033"),
        )
      ).applied.length,
      0,
    );
  });
});

test("professor home upgrade rolls back all affected world state when a later migration fails", async () => {
  await withTestSchema(async ({ sql }) => {
    await previousProfessorHome(sql);
    const tables = [
      "scenes",
      "buildings",
      "spawn_points",
      "npc_schedules",
      "npc_runtime",
      "player_presence",
      "wallets",
      "schema_migrations",
    ];
    const snapshots = async () =>
      Promise.all(
        tables.map((table) =>
          sql.unsafe(`select row_to_json(t)::text as row from ${table} t order by row_to_json(t)::text`),
        ),
      );
    const before = await snapshots();
    const failure = { filename: "9999_failure.sql", checksum: "failure", sql: "select 1/0;" };
    await assert.rejects(runMigrations(postgresMigrationStore(sql), [...realMigrations, failure]));
    const after = await snapshots();
    for (let i = 0; i < tables.length; i++) assert.deepEqual([...after[i]], [...before[i]], tables[i]);
  });
});

test("quiz-centre layout upgrade preserves Max, venue hours and wallets while safely updating occupied paths", async () => {
  await withTestSchema(async ({ sql }) => {
    const previous = realMigrations.filter((m) => m.filename < "0038"),
      latest = realMigrations.filter((m) => m.filename < "0039");
    await runMigrations(postgresMigrationStore(sql), previous);
    await seedWorld(sql);
    await sql`update scenes set asset_version=4 where id='quiz-centre-interior'`;
    await sql`update buildings set operating_hours='{}'::jsonb`;
    await sql`insert into wallets(wallet_id,owner_type,owner_id,balance) values('player:layout.testnet','player','layout.testnet',9007199254740993)`;
    await sql`insert into player_presence(session_id,player_account,scene_id,x,y,facing,path,scene_version,state_version) values ('quiz-trapped','alice.testnet','quiz-centre-interior',4,8,'south','[{"x":4,"y":9}]',4,2),('quiz-clear','bob.testnet','quiz-centre-interior',10,11,'north','[{"x":10,"y":10}]',4,7),('quiz-outside','carol.testnet','city-district',32,24,'south','[]',6,3)`;
    await sql`update npc_runtime set scene_id='quiz-centre-interior',x=10,y=4,target_x=3,target_y=7,state='{"path":[{"x":3,"y":7}]}'::jsonb where npc_id='quiz-attendant-yaw'`;
    const hours = await sql`select id,operating_hours from buildings order by id`,
      wallets = await sql`select * from wallets order by wallet_id`,
      outside = await sql`select * from player_presence where session_id='quiz-outside'`,
      identities =
        await sql`select session_id,presence_generation::text from player_presence order by session_id`;
    const result = await runMigrations(postgresMigrationStore(sql), latest);
    assert.deepEqual(
      result.applied.map((m) => m.filename),
      ["0038_quiz_centre_walkway.sql"],
    );
    const rows =
      await sql`select session_id,x,y,path,scene_version::text,state_version from player_presence where scene_id='quiz-centre-interior' order by session_id`;
    assert.deepEqual(
      rows.map((r) => ({
        id: r.session_id,
        x: r.x,
        y: r.y,
        version: r.scene_version,
        state: r.state_version,
      })),
      [
        { id: "quiz-clear", x: 10, y: 11, version: "5", state: "8" },
        { id: "quiz-trapped", x: 10, y: 11, version: "5", state: "3" },
      ],
    );
    assert.ok(rows.every((r) => r.path.length === 0));
    assert.deepEqual(
      [...(await sql`select * from player_presence where session_id='quiz-outside'`)],
      [...outside],
    );
    assert.deepEqual(
      [...(await sql`select session_id,presence_generation::text from player_presence order by session_id`)],
      [...identities],
    );
    const [max] =
      await sql`select x,y,target_x,target_y,state from npc_runtime where npc_id='quiz-attendant-yaw'`;
    assert.deepEqual({ ...max }, { x: 10, y: 4, target_x: null, target_y: null, state: {} });
    assert.deepEqual([...(await sql`select id,operating_hours from buildings order by id`)], [...hours]);
    assert.deepEqual([...(await sql`select * from wallets order by wallet_id`)], [...wallets]);
    assert.equal((await runMigrations(postgresMigrationStore(sql), latest)).applied.length, 0);
    assert.deepEqual(
      [
        ...(await sql`select session_id,x,y,path,scene_version::text,state_version from player_presence where scene_id='quiz-centre-interior' order by session_id`),
      ],
      [...rows],
    );
  });
});
test("quiz-centre relocation rolls back completely if a subsequent migration fails", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(
      postgresMigrationStore(sql),
      realMigrations.filter((m) => m.filename < "0038"),
    );
    await seedWorld(sql);
    await sql`update scenes set asset_version=4 where id='quiz-centre-interior'`;
    await sql`insert into player_presence(session_id,player_account,scene_id,x,y,facing,path,scene_version) values('quiz-rollback','alice.testnet','quiz-centre-interior',4,8,'south','[{"x":4,"y":9}]',4)`;
    const before = await sql`select * from player_presence where session_id='quiz-rollback'`;
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), [
        ...realMigrations.filter((m) => m.filename < "0039"),
        { filename: "0039_fixture_failure.sql", checksum: "failure", sql: "select 1/0" },
      ]),
      /division by zero/,
    );
    assert.deepEqual(
      [...(await sql`select * from player_presence where session_id='quiz-rollback'`)],
      [...before],
    );
    assert.equal(
      (await sql`select asset_version::text as version from scenes where id='quiz-centre-interior'`)[0]
        .version,
      "4",
    );
    assert.equal(
      (
        await sql`select count(*)::int as n from schema_migrations where filename='0038_quiz_centre_walkway.sql'`
      )[0].n,
      0,
    );
  });
});
