import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { api, startStack } from "./harness.js";
const stack = await startStack({ city: true });
after(() => stack.stop());
const { seedWorld } = await import("../../db/seeds/world.js");
const { syncEconomy } = await import("../../src/sync.js");
const { tickQuizMatches } = await import("../../src/quiz-match-worker.js");
const { submitCityPayment } = await import("../../src/operator.js");
const { confirmCityOperation } = await import("../../src/city-economy-routes.js");
const { projectCityOperation } = await import("../../src/city-economy.js");
const { verifyExpectedFunctionCall } = await import("../../src/verify.js");

test(
  "two real wallets escrow QC, share a NEAR quiz, settle the winner pot after its 2% deduction and fees, and refund a tied round without issuance",
  { timeout: 300000 },
  async () => {
    const { alice, bob, operator, db } = stack;
    const aa = await stack.login(alice),
      ba = await stack.login(bob);
    async function request(path: string, body: Record<string, unknown> | undefined, auth = aa) {
      const r = await api(stack, path, { ...(body ? { body } : {}), cookie: auth.cookie, csrf: auth.csrf });
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
      return r.body as any;
    }
    for (const [account, auth] of [
      [alice, aa],
      [bob, ba],
    ] as const) {
      let txHash = await stack.contractCall(account, "register_player", {
        username: account === alice ? "alice" : "bob",
      });
      await request("/v1/players/register", { username: account === alice ? "alice" : "bob", txHash }, auth);
      txHash = await stack.contractCall(account, "claim_starter");
      await request("/v1/players/claim", { txHash }, auth);
    }
    for (const wallet of ["gov:quiz-centre", "gov:network-fees"])
      await stack.contractCall(operator, "create_wallet", { wallet, initial_balance: "0" });
    await seedWorld(db);
    // Sandbox fast-forward skips timestamps, not receipt finality. A harmless view
    // transaction seals the preceding wallet-creation receipt before final RPC views.
    await stack.readContract("get_stats");
    await stack.readContract("get_wallet_count");
    await syncEconomy();
    assert.equal(
      (
        await db`select wallet_id from wallets where active and wallet_id in ('gov:quiz-centre','gov:network-fees')`
      ).length,
      2,
      JSON.stringify(await db`select wallet_id,active from wallets`),
    );
    for (const account of [alice, bob])
      await db`insert into player_presence(session_id,player_account,scene_id,x,y,facing) values(${account.accountId},${account.accountId},'quiz-centre-interior',12,12,'south')`;
    const initial = await stack.readContract<any>("get_stats");
    let now = new Date();
    const deps = {
      operator: operator.accountId,
      now: () => now,
      submit: submitCityPayment,
      confirm: (actor: string, id: string, hash: string) => confirmCityOperation(db, actor, id, hash),
    };
    async function runRoom(tie: boolean) {
      await db`update player_presence set heartbeat_at=now()`;
      const room = (
        await request(tie ? "/v1/quiz-matches" : "/v1/quiz-matches/search", {
          requestId: randomUUID(),
          stake: "100",
        })
      ).match;
      if (!tie) {
        assert.equal(room.visibility, "public");
        assert.equal(room.participants.length, 1);
        const listing = await request("/v1/quiz-matches/public?stake=100", undefined, ba);
        assert.equal(listing.rooms[0].id, room.id);
        assert.equal("code" in listing.rooms[0], false);
        assert.equal(await stack.readContract("get_balance", { wallet: `player:${alice.accountId}` }), "500");
      }
      const joined = (
        await request(
          tie ? "/v1/quiz-matches/join" : "/v1/quiz-matches/search",
          { requestId: randomUUID(), ...(tie ? { code: room.code } : { stake: "100" }) },
          ba,
        )
      ).match;
      assert.equal(joined.id, room.id);
      assert.equal(room.questions.length, 0);
      assert.equal(joined.totalDue, "100");
      assert.equal(joined.operation.actor_account, bob.accountId);
      for (const [account, auth, match] of [
        [alice, aa, room],
        [bob, ba, joined],
      ] as const) {
        const txHash = await stack.contractCall(account, match.operation.method, match.operation.args);
        const funded = (await request(`/v1/quiz-matches/${room.id}/confirm`, { txHash }, auth)).match;
        assert.ok(funded.participants.find((p: any) => p.accountId === account.accountId).funded);
        const count = (await db`select count(*)::int as n from transactions`)[0].n;
        await request(`/v1/quiz-matches/${room.id}/confirm`, { txHash }, auth);
        assert.equal((await db`select count(*)::int as n from transactions`)[0].n, count);
        assert.equal(
          (await stack.readContract<any>("get_escrow", { id: match.operation.args.id })).remaining,
          "100",
        );
        // Neither player may refund or redirect the pool using their own full-access key.
        const forbidden = await account.callRaw(stack.contractId, "settle_escrow", {
          id: match.operation.args.id,
          recipient_wallet: `player:${account.accountId}`,
          amount: "100",
          refund: true,
          reference: `settle:${match.operation.args.id}:steal`,
        });
        assert.equal(forbidden.succeeded, false);
      }
      const [stored] = await db`select * from quiz_matches where id=${room.id}`;
      now = new Date(stored.starts_at.getTime() + 10);
      await tickQuizMatches(db, deps);
      // HTTP uses its real clock. Move only this disposable room's timing to the current instant;
      // no wall-clock sleeps are needed to test real contract/RPC/HTTP boundaries.
      await db`update quiz_matches set starts_at=now()-interval '1 second',ends_at=now()+interval '120 seconds' where id=${room.id}`;
      const game = (await request(`/v1/quiz-matches/${room.id}`, undefined)).match;
      assert.equal(game.state, "playing");
      assert.equal(game.questions.length, 5);
      assert.equal("correct" in game.questions[0], false);
      assert.equal(game.review.length, 0);
      const answer = (wrong: boolean) =>
        Object.fromEntries(
          stored.questions.map((q: any) => [q.id, wrong ? (q.correct + 1) % q.options.length : q.correct]),
        );
      await request(`/v1/quiz-matches/${room.id}/submit`, { answers: answer(false) });
      const hidden = (await request(`/v1/quiz-matches/${room.id}`, undefined, ba)).match;
      assert.equal(hidden.participants[0].score, null);
      assert.equal(hidden.review.length, 0);
      await request(`/v1/quiz-matches/${room.id}/submit`, { answers: answer(!tie) }, ba);
      now = new Date(now.getTime() + 3000);
      await tickQuizMatches(db, deps);
      now = new Date(now.getTime() + 3000);
      await tickQuizMatches(db, deps);
      const result = (await request(`/v1/quiz-matches/${room.id}`, undefined)).match;
      assert.equal(result.state, tie ? "refunded" : "completed");
      assert.equal(result.outcome, tie ? "tie" : "win");
      assert.equal(result.winnerAccount, tie ? null : alice.accountId);
      const transfers =
        await db`select o.* from city_operations o join quiz_match_transfers t on t.operation_id=o.id where t.match_id=${room.id}`;
      assert.equal(transfers.length, tie ? 2 : 4);
      const before = (await db`select count(*)::int as n from transactions`)[0].n;
      for (const op of transfers) {
        assert.equal(op.status, "confirmed");
        assert.ok(op.tx_hash);
        const proof = await verifyExpectedFunctionCall(op.tx_hash, {
          signerId: operator.accountId,
          method: op.method,
          args: op.args,
          events: op.expected_events,
        } as any);
        await db.begin(async (tx) => {
          for (const event of proof.events) await projectCityOperation(tx, event);
        });
        const [ledger] = await db`select * from transactions where reference=${op.reference}`;
        assert.equal(ledger.wallet_from, `gov:escrow.${op.args.id}`);
        assert.equal(ledger.wallet_to, op.args.recipient_wallet);
        assert.equal(ledger.amount, op.args.amount);
        assert.ok(ledger.receipt_id);
        assert.equal(ledger.event_index, 0);
      }
      assert.equal((await db`select count(*)::int as n from transactions`)[0].n, before);
      for (const match of [room, joined])
        assert.equal(
          (await stack.readContract<any>("get_escrow", { id: match.operation.args.id })).remaining,
          "0",
        );
    }
    await runRoom(false);
    assert.equal(await stack.readContract("get_balance", { wallet: `player:${alice.accountId}` }), "596");
    assert.equal(await stack.readContract("get_balance", { wallet: `player:${bob.accountId}` }), "400");
    assert.equal(await stack.readContract("get_balance", { wallet: "gov:quiz-centre" }), "4");
    assert.equal(await stack.readContract("get_balance", { wallet: "gov:network-fees" }), "0");
    await runRoom(true);
    assert.equal(await stack.readContract("get_balance", { wallet: `player:${alice.accountId}` }), "596");
    assert.equal(await stack.readContract("get_balance", { wallet: `player:${bob.accountId}` }), "400");
    assert.equal(await stack.readContract("get_balance", { wallet: "gov:quiz-centre" }), "4");
    assert.equal(await stack.readContract("get_balance", { wallet: "gov:network-fees" }), "0");
    const final = await stack.readContract<any>("get_stats");
    assert.equal(final.total_issued, initial.total_issued);
    assert.equal(final.total_burned, initial.total_burned);
    await syncEconomy();
    const [mirror] = await db`select sum(balance)::text as total from wallets where active=true`;
    assert.equal(BigInt(mirror.total), BigInt(final.total_issued) - BigInt(final.total_burned));
  },
);
