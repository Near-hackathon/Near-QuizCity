import assert from "node:assert/strict";
import test, { after } from "node:test";
import { api, startStack } from "./harness.js";

const stack = await startStack();
after(async () => {
  await stack.stop();
});

test("local attack cases are rejected without state changes", async () => {
  const { alice, db } = stack;
  const auth = await stack.login(alice);

  const anonymous = await api(stack, "/v1/players/claim", { body: { txHash: "x".repeat(44) } });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.code, "UNAUTHORIZED");

  const noCsrf = await api(stack, "/v1/players/claim", {
    body: { txHash: "x".repeat(44) },
    cookie: auth.cookie,
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error.code, "FORBIDDEN");

  const playerSync = await api(stack, "/v1/sync", {
    body: {},
    cookie: auth.cookie,
    csrf: auth.csrf,
  });
  assert.equal(playerSync.status, 403);
  assert.equal(playerSync.body.error.code, "FORBIDDEN");

  const identityOverride = await api(stack, "/v1/players/claim", {
    body: { txHash: "x".repeat(44), accountId: "bob.test.near" },
    cookie: auth.cookie,
    csrf: auth.csrf,
  });
  assert.equal(identityOverride.status, 400);
  assert.equal(identityOverride.body.error.code, "VALIDATION_ERROR");

  // A real registration transaction cannot be replayed as a claim.
  const registerTx = await stack.contractCall(alice, "register_player", { username: "alice" });
  const registered = await api(stack, "/v1/players/register", {
    body: { username: "alice", txHash: registerTx },
    cookie: auth.cookie,
    csrf: auth.csrf,
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  const claimReuse = await api(stack, "/v1/players/claim", {
    body: { txHash: registerTx },
    cookie: auth.cookie,
    csrf: auth.csrf,
  });
  assert.equal(claimReuse.status, 422, JSON.stringify(claimReuse.body));
  assert.equal(claimReuse.body.error.code, "TX_MISMATCH");
  const [starter] = await db`
    select count(*)::int as count from transactions where event_name = 'starter_allowance'
  `;
  assert.equal(starter.count, 0);

  let restrictedFailure: unknown = null;
  try {
    await stack.restrictedFunctionCall("create_wallet", {
      wallet: "gov:intruder",
      initial_balance: "1",
    });
  } catch (error) {
    restrictedFailure = error;
  }
  assert.ok(restrictedFailure, "restricted operator key must not call create_wallet");

  const fakeProof = await api(stack, "/v1/players/claim", {
    body: { txHash: "x".repeat(44) },
    cookie: auth.cookie,
    csrf: auth.csrf,
  });
  assert.ok(fakeProof.status >= 400, JSON.stringify({ status: fakeProof.status, body: fakeProof.body }));
  const [count] = await db`
    select count(*)::int as count from transactions where event_name = 'starter_allowance'
  `;
  assert.equal(count.count, 0);
});
