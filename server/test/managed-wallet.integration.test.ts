import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { KeyPair, utils } from "near-api-js";
import { withTestSchema } from "./db-test-utils.js";
import { runMigrations, loadMigrations, postgresMigrationStore } from "../src/migrations.js";
import { makeTestConfig } from "./fixtures.js";
import { createProfile, enterProfile, listProfiles } from "../src/profiles.js";
import { allocateManagedWallet, getManagedWallet, signManagedTransaction } from "../src/managed-wallets.js";
import { processManagedWallet } from "../src/wallet-provisioning.js";
import { openWalletKey, walletContext } from "../src/wallet-vault.js";
import { validateEvent } from "../src/event-validation.js";
import { AppError } from "../src/errors.js";
import type { ManagedWalletChain } from "../src/managed-wallet-chain.js";
import type { AppConfig } from "../src/config.js";
const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));
export function fakeManagedChain() {
  const accounts = new Map<string, string>(),
    players = new Map<string, { username: string; starter_claimed: boolean }>(),
    txs = new Map<string, any>(),
    balances = new Map<string, string>();
  const calls = { create: 0, sign: 0, broadcast: 0, claim: 0 };
  let supported = true,
    unavailable = false,
    afterCreate = false;
  const chain: ManagedWalletChain = {
    async accountKeys(id) {
      if (unavailable) throw new AppError("CHAIN_UNAVAILABLE", "Unavailable", 503);
      return accounts.has(id) ? [{ publicKey: accounts.get(id)!, permission: "FullAccess" }] : null;
    },
    async createAccount(id, pub) {
      calls.create++;
      accounts.set(id, pub);
      if (afterCreate) throw new AppError("FAUCET_UNAVAILABLE", "Lost response", 503);
    },
    async supportsGame() {
      return supported;
    },
    async sign(account, key, method, args, lastNonce) {
      calls.sign++;
      assert.ok(
        KeyPair.fromString(key as never)
          .getPublicKey()
          .toString() === accounts.get(account),
      );
      const nonce = (BigInt(lastNonce) + 1n).toString(),
        hash = utils.serialize.base_encode(
          createHash("sha256")
            .update(account + nonce + JSON.stringify(args))
            .digest(),
        );
      const bytes = Buffer.from(
        JSON.stringify({ account, method, args, nonce, padding: "x".repeat(120) }),
      ).toString("base64");
      txs.set(hash, { account, method, args, bytes, executed: false });
      return { hash, bytes, nonce };
    },
    async broadcast(bytes) {
      calls.broadcast++;
      const tx = [...txs.values()].find((t) => t.bytes === bytes);
      if (!tx || tx.executed) return;
      tx.executed = true;
      if (tx.method === "register_player") {
        players.set(tx.account, { username: tx.args.username, starter_claimed: false });
        balances.set(`player:${tx.account}`, "0");
      }
      if (tx.method === "claim_starter") {
        const p = players.get(tx.account)!;
        if (!p.starter_claimed) {
          p.starter_claimed = true;
          calls.claim++;
          balances.set(`player:${tx.account}`, "500");
        }
      }
    },
    async verify(hash, expected) {
      const tx = txs.get(hash);
      if (!tx?.executed) throw new AppError("TX_PENDING", "Pending", 409);
      assert.equal(tx.account, expected.signerId);
      assert.equal(tx.method, expected.method);
      const events = [];
      if (["register_player", "claim_starter"].includes(tx.method)) {
        const starter = tx.method === "claim_starter";
        events.push(
          validateEvent({
            standard: "quizcity",
            version: "1.0.0",
            event: starter ? "starter_allowance" : "player_registered",
            data: [
              {
                seq: starter ? 2 : 1,
                wallet_from: null,
                wallet_to: starter ? `player:${tx.account}` : null,
                amount: starter ? "500" : "0",
                reference: starter ? `starter:${tx.account}` : `player:${tx.account}`,
                entity_id: `player:${tx.account}`,
                account: tx.account,
                username: players.get(tx.account)!.username,
                owner_wallet: `player:${tx.account}`,
              },
            ],
            receiptId: hash,
            eventIndex: 0,
            txHash: hash,
            blockHeight: "10",
            blockHash: "1".repeat(44),
            chainTimestamp: "2026-11-14T12:00:00Z",
          }),
        );
      }
      return { txHash: hash, events, outcome: {} as never };
    },
    async view<T>(_method, args) {
      return players.get(String(args?.account)) as T;
    },
    async balance(wallet) {
      return balances.get(wallet) ?? "0";
    },
  };
  return {
    chain,
    calls,
    accounts,
    players,
    balances,
    setSupported: (v: boolean) => {
      supported = v;
    },
    setUnavailable: (v: boolean) => {
      unavailable = v;
    },
    setLostCreate: (v: boolean) => {
      afterCreate = v;
    },
  };
}
function config(): AppConfig {
  return makeTestConfig({
    autoTestnetWallets: true,
    testnetWalletEncryptionKey: randomBytes(32).toString("base64"),
  });
}
async function setup(sql: import("postgres").Sql, cfg: AppConfig) {
  await runMigrations(postgresMigrationStore(sql), migrations);
  return createProfile(sql, null, { username: "reader", firstName: "Taylor" }, allocateManagedWallet(cfg));
}
async function due(sql: import("postgres").Sql, id: string) {
  await sql`update managed_wallets set next_attempt_at=now(),lease_until=null where profile_id=${id}`;
}
test("signup allocates one encrypted testnet wallet; durable stages confirm registration, 500 QC and safe browser re-entry", async () => {
  await withTestSchema(async ({ sql }) => {
    const cfg = config(),
      created = await setup(sql, cfg),
      fake = fakeManagedChain(),
      id = created.profile.id;
    const repeated = await createProfile(
      sql,
      created.deviceToken,
      { username: "reader", firstName: "Taylor" },
      allocateManagedWallet(cfg),
    );
    assert.equal(repeated.profile.id, id);
    const wallet = (await getManagedWallet(sql, id))!;
    assert.match(wallet.account_id, /^qc-[0-9a-f]{32}\.testnet$/);
    assert.ok(wallet.encrypted_key && !wallet.encrypted_key.includes("ed25519:"));
    const old = await enterProfile(sql, created.deviceToken, id);
    for (let i = 0; i < 3; i++) await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal((await getManagedWallet(sql, id))!.stage, "ready");
    assert.equal(fake.calls.create, 1);
    assert.equal(fake.calls.claim, 1);
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal(fake.calls.sign, 2);
    const [balance] =
      await sql`select balance::text from wallets where wallet_id=${`player:${wallet.account_id}`}`;
    assert.equal(balance.balance, "500");
    assert.equal((await sql`select count(*)::int as n from transactions`)[0].n, 2);
    assert.equal((await sql`select count(*)::int as n from transaction_consumptions`)[0].n, 2);
    const profile = (await listProfiles(sql, created.deviceToken))[0];
    assert.equal(profile.accountId, wallet.account_id);
    assert.equal(profile.walletKind, "embedded");
    assert.equal(profile.walletLinked, true);
    const { authenticateSession } = await import("../src/auth/service.js");
    assert.equal(await authenticateSession(sql, old.sessionToken, new Date()), null);
    assert.equal((await enterProfile(sql, created.deviceToken, id)).profile.accountId, wallet.account_id);
  });
});
test("a lost faucet response reuses its saved account/key and never allocates another wallet", async () => {
  await withTestSchema(async ({ sql }) => {
    const cfg = config(),
      created = await setup(sql, cfg),
      fake = fakeManagedChain(),
      id = created.profile.id;
    fake.setLostCreate(true);
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal(fake.calls.create, 1);
    assert.equal((await getManagedWallet(sql, id))!.stage, "creating_account");
    await due(sql, id);
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal(fake.calls.create, 1);
    assert.equal((await getManagedWallet(sql, id))!.stage, "registering");
    assert.equal((await sql`select count(*)::int as n from managed_wallets`)[0].n, 1);
  });
});
test("an old game contract blocks QC setup without inventing a balance or losing the newly created account", async () => {
  await withTestSchema(async ({ sql }) => {
    const cfg = config(),
      created = await setup(sql, cfg),
      fake = fakeManagedChain(),
      id = created.profile.id;
    fake.setSupported(false);
    await processManagedWallet(sql, cfg, fake.chain, id);
    await processManagedWallet(sql, cfg, fake.chain, id);
    const w = (await getManagedWallet(sql, id))!;
    assert.equal(w.stage, "registering");
    assert.equal(w.last_error_code, "CONTRACT_UPGRADE_REQUIRED");
    assert.equal(fake.calls.sign, 0);
    assert.equal((await sql`select count(*)::int as n from wallets`)[0].n, 0);
    fake.setSupported(true);
    await due(sql, id);
    await processManagedWallet(sql, cfg, fake.chain, id);
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal(fake.calls.claim, 1);
  });
});
test("starter chain success followed by local failure recovers the same proof without minting again", async () => {
  await withTestSchema(async ({ sql }) => {
    const cfg = config(),
      created = await setup(sql, cfg),
      fake = fakeManagedChain(),
      id = created.profile.id;
    await processManagedWallet(sql, cfg, fake.chain, id);
    await processManagedWallet(sql, cfg, fake.chain, id);
    const balance = fake.chain.balance;
    fake.chain.balance = async () => {
      throw new AppError("CHAIN_UNAVAILABLE", "Lost balance response", 503);
    };
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal(fake.calls.claim, 1);
    assert.equal((await getManagedWallet(sql, id))!.stage, "claiming");
    fake.chain.balance = balance;
    await due(sql, id);
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal(fake.calls.claim, 1);
    assert.equal(fake.calls.sign, 2);
    assert.equal((await getManagedWallet(sql, id))!.stage, "ready");
  });
});
test("signing persists exact bytes before broadcast, binds request IDs and serializes competing wallet actions", async () => {
  await withTestSchema(async ({ sql }) => {
    const cfg = config(),
      created = await setup(sql, cfg),
      fake = fakeManagedChain(),
      id = created.profile.id;
    await processManagedWallet(sql, cfg, fake.chain, id);
    const requestId = randomUUID();
    const tx = await signManagedTransaction(sql, cfg, fake.chain, id, requestId, "buy_property", {
      property_id: 1,
    });
    const replay = await signManagedTransaction(sql, cfg, fake.chain, id, requestId, "buy_property", {
      property_id: 1,
    });
    assert.equal(tx.tx_hash, replay.tx_hash);
    assert.equal(fake.calls.sign, 1);
    await assert.rejects(
      signManagedTransaction(sql, cfg, fake.chain, id, requestId, "buy_property", { property_id: 2 }),
      { code: "CONFLICT" },
    );
    const broadcast = fake.chain.broadcast;
    fake.chain.broadcast = async () => {
      throw new AppError("CHAIN_TIMEOUT", "No response", 504);
    };
    const pending = await signManagedTransaction(
      sql,
      cfg,
      fake.chain,
      id,
      randomUUID(),
      "business_withdraw",
      { business_id: 1, amount: "10" },
    );
    assert.equal(pending.state, "pending");
    await assert.rejects(
      signManagedTransaction(sql, cfg, fake.chain, id, randomUUID(), "buy_property", { property_id: 3 }),
      { code: "WALLET_BUSY" },
    );
    fake.chain.broadcast = broadcast;
    const resumed = await signManagedTransaction(sql, cfg, fake.chain, id, pending.id, "business_withdraw", {
      business_id: 1,
      amount: "10",
    });
    assert.equal(resumed.tx_hash, pending.tx_hash);
    assert.equal(fake.calls.sign, 2);
  });
});
test("quota failure rolls back the profile/device allocation and credentials cannot be transplanted to another account", async () => {
  await withTestSchema(async ({ sql }) => {
    const cfg = { ...config(), testnetWalletDailyLimit: 1 },
      created = await setup(sql, cfg);
    await assert.rejects(
      createProfile(sql, null, { username: "another", firstName: "Alex" }, allocateManagedWallet(cfg)),
      { code: "SIGNUP_LIMIT" },
    );
    assert.equal((await sql`select count(*)::int as n from resident_profiles`)[0].n, 1);
    assert.equal((await sql`select count(*)::int as n from browser_devices`)[0].n, 1);
    const w = (await getManagedWallet(sql, created.profile.id))!;
    assert.throws(() =>
      openWalletKey(
        cfg.testnetWalletEncryptionKey!,
        w.encrypted_key,
        walletContext(randomUUID(), w.account_id),
      ),
    );
  });
});

import { buildPublicApp } from "../src/app.js";
test("wallet HTTP routes require saved-device ownership, CSRF and explicit backup approval; ready accounts stay browser-owned players", async () => {
  await withTestSchema(async ({ sql }) => {
    const cfg = config();
    await runMigrations(postgresMigrationStore(sql), migrations);
    const fake = fakeManagedChain(),
      app = await buildPublicApp(cfg, { database: sql, managedWalletChain: fake.chain });
    const call = (path: string, body: unknown, cookie = "", csrf?: string, origin = cfg.webOrigin) =>
      app.inject({
        method: "POST",
        url: path,
        headers: { origin, cookie, ...(csrf ? { "x-csrf-token": csrf } : {}) },
        payload: body as any,
      });
    try {
      assert.equal((await call("/v1/profiles", { username: "reader", firstName: "Taylor" })).statusCode, 409);
      assert.equal(
        (await call("/v1/profiles/device", {}, "", undefined, "https://attacker.invalid")).statusCode,
        403,
      );
      const device = await call("/v1/profiles/device", {});
      assert.equal(device.statusCode, 200);
      const deviceCookie = device.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const created = await call("/v1/profiles", { username: "reader", firstName: "Taylor" }, deviceCookie);
      assert.equal(created.statusCode, 200, created.body);
      const id = created.json().profile.id,
        csrf = created.json().csrfToken,
        cookie =
          deviceCookie +
          "; " +
          created.cookies
            .filter((c) => c.name === "qc_session")
            .map((c) => `${c.name}=${c.value}`)
            .join("; ");
      const repeated = await call("/v1/profiles", { username: "reader", firstName: "Taylor" }, deviceCookie);
      assert.equal(repeated.json().profile.id, id);
      assert.equal((await app.inject({ method: "GET", url: `/v1/profiles/${id}/wallet` })).statusCode, 404);
      assert.equal(
        (await call(`/v1/profiles/${id}/wallet/backup`, { confirm: true }, cookie)).statusCode,
        403,
      );
      assert.equal(
        (await call(`/v1/profiles/${id}/wallet/backup`, { confirm: false }, cookie, csrf)).statusCode,
        400,
      );
      assert.equal(
        (await call(`/v1/profiles/${id}/wallet/backup`, { confirm: true }, cookie, csrf)).statusCode,
        409,
      );
      await processManagedWallet(sql, cfg, fake.chain, id);
      const backup = await call(`/v1/profiles/${id}/wallet/backup`, { confirm: true }, cookie, csrf);
      assert.equal(backup.statusCode, 200);
      assert.equal(backup.headers["cache-control"], "no-store");
      assert.equal(backup.headers["content-type"], "application/octet-stream");
      const data = JSON.parse(backup.body),
        w = (await getManagedWallet(sql, id))!;
      assert.ok(KeyPair.fromString(data.private_key).getPublicKey().toString() === w.public_key);
      assert.equal(
        (await call(`/v1/profiles/${randomUUID()}/wallet/backup`, { confirm: true }, cookie, csrf))
          .statusCode,
        404,
      );
      await processManagedWallet(sql, cfg, fake.chain, id);
      await processManagedWallet(sql, cfg, fake.chain, id);
      const login = await call("/v1/profiles/enter", { id }, deviceCookie);
      assert.equal(login.statusCode, 200);
      const readyCookie = deviceCookie + "; " + login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        readyCsrf = login.json().csrfToken;
      assert.equal(login.json().profile.accountId, w.account_id);
      const denied = await call(
        "/v1/wallet/transactions",
        { requestId: randomUUID(), method: "credit_reward", args: {} },
        readyCookie,
        readyCsrf,
      );
      assert.equal(denied.statusCode, 400);
      const request = { requestId: randomUUID(), method: "buy_property", args: { property_id: 1 } };
      assert.equal(
        (await call("/v1/wallet/transactions", request, readyCookie, readyCsrf, "https://attacker.invalid"))
          .statusCode,
        403,
      );
      const sent = await call("/v1/wallet/transactions", request, readyCookie, readyCsrf);
      assert.equal(sent.statusCode, 200, sent.body);
      const replay = await call("/v1/wallet/transactions", request, readyCookie, readyCsrf);
      assert.equal(replay.json().txHash, sent.json().txHash);
      const chargeArgs = {
        source_wallet: `player:${w.account_id}`,
        to_wallet: "gov:council",
        amount: "5",
        reference: `upkeep:${randomUUID()}`,
      };
      const quoteId = randomUUID();
      await sql`insert into city_operations(id,actor_account,kind,method,args,expected_events,reference) values(${quoteId},${w.account_id},'charge','pay_charge',${sql.json(chargeArgs)},'[]'::jsonb,${chargeArgs.reference})`;
      const quoted = { requestId: randomUUID(), method: "pay_charge", args: chargeArgs };
      const before = fake.calls.sign;
      assert.equal(
        (
          await call(
            "/v1/wallet/transactions",
            { ...quoted, args: { ...chargeArgs, amount: "6" } },
            readyCookie,
            readyCsrf,
          )
        ).statusCode,
        409,
      );
      assert.equal(fake.calls.sign, before);
      const payment = await call("/v1/wallet/transactions", quoted, readyCookie, readyCsrf);
      assert.equal(payment.statusCode, 200);
      await sql`update city_operations set status='confirmed' where id=${quoteId}`;
      const lostResponseRetry = await call("/v1/wallet/transactions", quoted, readyCookie, readyCsrf);
      assert.equal(lostResponseRetry.statusCode, 200);
      assert.equal(lostResponseRetry.json().txHash, payment.json().txHash);
      assert.equal(
        (
          await call(
            "/v1/wallet/transactions",
            { ...quoted, requestId: randomUUID() },
            readyCookie,
            readyCsrf,
          )
        ).statusCode,
        409,
      );
      assert.equal(
        (await sql`select count(*)::int as n from managed_wallet_audit where action='backup_exported'`)[0].n,
        1,
      );
    } finally {
      await app.close();
    }
  });
});

test("managed wallet migration upgrades existing external residents, is idempotent and rolls back failed forward changes", async () => {
  await withTestSchema(async ({ sql }) => {
    const previous = migrations.filter((m) => m.filename < "0034");
    await runMigrations(postgresMigrationStore(sql), previous);
    const profile = await createProfile(sql, null, { username: "before", firstName: "Alex" });
    await sql`update resident_profiles set wallet_linked=true,account_id='existing.testnet' where id=${profile.profile.id}`;
    await runMigrations(postgresMigrationStore(sql), migrations);
    assert.equal((await sql`select wallet_kind from resident_profiles`)[0].wallet_kind, "external");
    await runMigrations(postgresMigrationStore(sql), migrations);
    assert.equal((await sql`select count(*)::int as n from schema_migrations`)[0].n, migrations.length);
    await assert.rejects(
      runMigrations(postgresMigrationStore(sql), [
        ...migrations,
        {
          filename: "0035_broken.sql",
          checksum: "test",
          sql: "create table rolled_back_wallets(id int); select missing_wallet_column;",
        },
      ]),
    );
    assert.equal((await sql`select to_regclass('rolled_back_wallets') as name`)[0].name, null);
    await assert.rejects(sql`update resident_profiles set wallet_kind='custody'`);
    assert.equal((await sql`select account_id from resident_profiles`)[0].account_id, "existing.testnet");
  });
});
test("two provisioning workers overlap with one sponsor call, and competing signing requests cannot allocate another nonce", async () => {
  const { connectTestClient, testDatabaseUrl } = await import("./db-test-utils.js");
  await withTestSchema(async ({ sql, schema }) => {
    const cfg = config(),
      created = await setup(sql, cfg),
      fake = fakeManagedChain(),
      id = created.profile.id;
    const other = connectTestClient(testDatabaseUrl(), schema);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      barrier = new Promise<void>((r) => (release = r));
    const sponsor = fake.chain.createAccount;
    fake.chain.createAccount = async (...args) => {
      entered();
      await barrier;
      return sponsor(...args);
    };
    const first = processManagedWallet(sql, cfg, fake.chain, id);
    try {
      await started;
      await processManagedWallet(other, cfg, fake.chain, id);
      release();
      await first;
      assert.equal(fake.calls.create, 1);
      let signed!: () => void, resume!: () => void;
      const signing = new Promise<void>((r) => (signed = r)),
        wait = new Promise<void>((r) => (resume = r)),
        sign = fake.chain.sign;
      fake.chain.sign = async (...args) => {
        signed();
        await wait;
        return sign(...args);
      };
      const original = signManagedTransaction(sql, cfg, fake.chain, id, randomUUID(), "buy_property", {
        property_id: 1,
      });
      await signing;
      await assert.rejects(
        signManagedTransaction(other, cfg, fake.chain, id, randomUUID(), "buy_property", { property_id: 2 }),
        { code: "WALLET_BUSY" },
      );
      resume();
      await original;
      assert.equal(fake.calls.sign, 1);
      assert.equal((await sql`select count(*)::int as n from managed_wallet_transactions`)[0].n, 1);
    } finally {
      release();
      await other.end();
    }
  });
});
test("sponsor limits, unknown creation, key mismatches and rejected transactions preserve the saved wallet", async () => {
  const { reconcileManagedTransactions, tickWalletProvisioning } =
    await import("../src/wallet-provisioning.js");
  await withTestSchema(async ({ sql }) => {
    const cfg = config(),
      created = await setup(sql, cfg),
      fake = fakeManagedChain(),
      id = created.profile.id;
    fake.setUnavailable(true);
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal(fake.calls.create, 0);
    fake.setUnavailable(false);
    await due(sql, id);
    fake.chain.createAccount = async () => {};
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal((await getManagedWallet(sql, id))!.stage, "creating_account");
    await due(sql, id);
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal((await getManagedWallet(sql, id))!.faucet_attempts, 1);
    await sql`update managed_wallets set faucet_requested_at=now()-interval '2 minutes',faucet_attempts=3,next_attempt_at=now() where profile_id=${id}`;
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal((await getManagedWallet(sql, id))!.last_error_code, "FAUCET_RATE_LIMITED");
    const w = (await getManagedWallet(sql, id))!;
    fake.accounts.set(w.account_id, KeyPair.fromRandom("ed25519").getPublicKey().toString());
    await due(sql, id);
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal((await getManagedWallet(sql, id))!.last_error_code, "ACCESS_KEY_MISMATCH");
    fake.accounts.set(w.account_id, w.public_key);
    await due(sql, id);
    await tickWalletProvisioning(sql, cfg, fake.chain);
    fake.chain.verify = async () => {
      throw new AppError("TX_FAILED", "Rejected", 409);
    };
    await processManagedWallet(sql, cfg, fake.chain, id);
    assert.equal((await getManagedWallet(sql, id))!.last_error_code, "TX_FAILED");
    assert.equal((await sql`select state from managed_wallet_transactions`)[0].state, "rejected");
    assert.equal((await sql`select count(*)::int as n from wallets`)[0].n, 0);
    await reconcileManagedTransactions(sql, fake.chain);
    await tickWalletProvisioning(sql, { ...cfg, autoTestnetWallets: false }, fake.chain);
  });
});
