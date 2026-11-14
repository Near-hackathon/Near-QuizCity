import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withTestSchema } from "./db-test-utils.js";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../src/migrations.js";
import {
  createProfile,
  enterProfile,
  listProfiles,
  completeOnboarding,
  linkProfileWallet,
} from "../src/profiles.js";
import { authenticateSession, hashToken } from "../src/auth/service.js";
import { buildPublicApp } from "../src/app.js";
import { makeTestConfig } from "./fixtures.js";
const migrations = loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url)));

test("browser profiles require their device credential; concurrent duplicate usernames have one winner", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    const first = await createProfile(sql, null, { username: "CityReader", firstName: "Taylor" });
    assert.equal(first.profile.username, "cityreader");
    assert.equal(first.profile.walletLinked, false);
    assert.deepEqual(await listProfiles(sql, null), []);
    assert.deepEqual(await listProfiles(sql, "a-different-device"), []);
    assert.equal((await listProfiles(sql, first.deviceToken))[0].id, first.profile.id);
    await assert.rejects(enterProfile(sql, "wrong-device", first.profile.id), { code: "PROFILE_NOT_FOUND" });
    const login = await enterProfile(sql, first.deviceToken, first.profile.id);
    const session = await authenticateSession(sql, login.sessionToken, new Date());
    assert.equal(session?.accountId, first.profile.accountId);
    assert.deepEqual(session?.roles, ["player"]);
    await sql`insert into account_roles(account_id,role) values (${first.profile.accountId},'admin')`;
    assert.deepEqual((await authenticateSession(sql, login.sessionToken, new Date()))?.roles, ["player"]);
    const [stored] = await sql`select token_hash,csrf_hash from auth_sessions`;
    assert.equal(stored.token_hash, hashToken(login.sessionToken));
    assert.notEqual(stored.csrf_hash, login.csrfToken);
    const results = await Promise.allSettled([
      createProfile(sql, null, { username: "UniqueTown", firstName: "Alex" }),
      createProfile(sql, null, { username: "uniquetown", firstName: "Sam" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const [counts] =
      await sql`select (select count(*)::int from resident_profiles) as profiles,(select count(*)::int from browser_devices) as devices`;
    assert.deepEqual({ ...counts }, { profiles: 2, devices: 2 });
  });
});
test("onboarding persists only passing answers and wallet recovery preserves the profile", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    const first = await createProfile(sql, null, { username: "wanderer", firstName: "Jamie" });
    assert.deepEqual(await completeOnboarding(sql, first.profile.accountId, [2, 0, 1]), {
      complete: false,
      score: 0,
      total: 3,
    });
    assert.equal((await listProfiles(sql, first.deviceToken))[0].onboardingComplete, false);
    assert.equal((await completeOnboarding(sql, first.profile.accountId, [0, 1, 2])).complete, true);
    await assert.rejects(linkProfileWallet(sql, "wrong-device", "alice.testnet", first.profile.id), {
      code: "FORBIDDEN",
    });
    await assert.rejects(
      linkProfileWallet(sql, first.deviceToken, first.profile.accountId, first.profile.id),
      { code: "FORBIDDEN" },
    );
    const linked = await linkProfileWallet(sql, first.deviceToken, "alice.testnet", first.profile.id);
    assert.equal(linked.profile.id, first.profile.id);
    assert.equal(linked.profile.onboardingComplete, true);
    assert.equal(linked.profile.walletLinked, true);
    const recovered = await linkProfileWallet(sql, null, "alice.testnet");
    assert.equal((await listProfiles(sql, recovered.deviceToken))[0].id, first.profile.id);
    assert.equal((await listProfiles(sql, first.deviceToken))[0].id, first.profile.id);
    const [count] = await sql`select count(*)::int as n from resident_profiles`;
    assert.equal(count.n, 1);
  });
});
test("profile HTTP routes reject cross-origin entry, identity theft, guest money commands and missing CSRF", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    const cfg = makeTestConfig();
    const app = await buildPublicApp(cfg, { database: sql });
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/v1/profiles",
        headers: { origin: "https://attacker.invalid" },
        payload: { username: "intruder", firstName: "X" },
      });
      assert.equal(denied.statusCode, 403);
      const created = await app.inject({
        method: "POST",
        url: "/v1/profiles",
        headers: { origin: cfg.webOrigin },
        payload: { username: "reader", firstName: "Taylor" },
      });
      assert.equal(created.statusCode, 200, created.body);
      const cookies = created.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      assert.ok(created.cookies.every((c) => c.httpOnly));
      const result = created.json();
      const stolen = await app.inject({
        method: "POST",
        url: "/v1/profiles/enter",
        headers: { origin: cfg.webOrigin },
        payload: { id: result.profile.id },
      });
      assert.equal(stolen.statusCode, 404);
      const noCsrf = await app.inject({
        method: "POST",
        url: "/v1/profiles/onboarding",
        headers: { cookie: cookies },
        payload: { answers: [0, 1, 2] },
      });
      assert.equal(noCsrf.statusCode, 403);
      const completed = await app.inject({
        method: "POST",
        url: "/v1/profiles/onboarding",
        headers: { cookie: cookies, "x-csrf-token": result.csrfToken },
        payload: { answers: [0, 1, 2] },
      });
      assert.equal(completed.statusCode, 200, completed.body);
      const link = await app.inject({
        method: "POST",
        url: "/v1/profiles/link-wallet",
        headers: { cookie: cookies, "x-csrf-token": result.csrfToken },
        payload: { profileId: result.profile.id },
      });
      assert.equal(link.statusCode, 403);
      const listing = await app.inject({ method: "GET", url: "/v1/profiles", headers: { cookie: cookies } });
      assert.equal(listing.json().profiles[0].onboardingComplete, true);
    } finally {
      await app.close();
    }
  });
});

test("expired device credentials cannot be revived by signup and browser profile limits hold", async () => {
  await withTestSchema(async ({ sql }) => {
    await runMigrations(postgresMigrationStore(sql), migrations);
    const first = await createProfile(sql, null, { username: "old_resident", firstName: "Taylor" });
    await sql`update browser_devices set expires_at=now()-interval '1 hour' where token_hash=${hashToken(first.deviceToken)}`;
    await assert.rejects(enterProfile(sql, first.deviceToken, first.profile.id), {
      code: "PROFILE_NOT_FOUND",
    });
    const next = await createProfile(sql, first.deviceToken, {
      username: "new_resident",
      firstName: "Jamie",
    });
    assert.notEqual(next.deviceToken, first.deviceToken);
    assert.deepEqual(await listProfiles(sql, first.deviceToken), []);
    assert.equal((await listProfiles(sql, next.deviceToken)).length, 1);
    for (let i = 0; i < 7; i++)
      await createProfile(sql, next.deviceToken, { username: `resident_${i}`, firstName: "Sam" });
    await assert.rejects(
      createProfile(sql, next.deviceToken, { username: "one_too_many", firstName: "Alex" }),
      { code: "PROFILE_LIMIT" },
    );
    assert.equal((await listProfiles(sql, next.deviceToken)).length, 8);
  });
});
