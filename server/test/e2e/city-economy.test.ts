import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { api, startStack } from "./harness.js";
const stack = await startStack({ city: true });
after(() => stack.stop());
const { seedWorld } = await import("../../db/seeds/world.js");
const { tickNpcShopping, reserveNpcShopping } = await import("../../src/npc-shopping.js");
const { tickNpcSimulation } = await import("../../src/world-simulation.js");
const { syncEconomy } = await import("../../src/sync.js");

test(
  "city economy uses real reserved funds, receipts, stock and funded prizes without new issuance",
  { timeout: 300000 },
  async () => {
    const { alice, bob, operator, db } = stack;
    const aliceAuth = await stack.login(alice),
      bobAuth = await stack.login(bob),
      operatorAuth = await stack.login(operator);
    await db`insert into account_roles(account_id,role) values (${operator.accountId},'operator') on conflict do nothing`;
    const request = async (path: string, body: Record<string, unknown> | undefined, auth = aliceAuth) => {
      const response = await api(stack, path, {
        ...(body ? { body } : {}),
        cookie: auth.cookie,
        csrf: auth.csrf,
      });
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.body)}`);
      return response.body as any;
    };
    for (const [account, auth] of [
      [alice, aliceAuth],
      [bob, bobAuth],
    ] as const) {
      let hash = await stack.contractCall(account, "register_player", {
        username: account === alice ? "alice" : "bob",
      });
      await request(
        "/v1/players/register",
        { username: account === alice ? "alice" : "bob", txHash: hash },
        auth,
      );
      hash = await stack.contractCall(account, "claim_starter");
      await request("/v1/players/claim", { txHash: hash }, auth);
    }
    await seedWorld(db);
    await syncEconomy();
    let hash = await stack.contractCall(alice, "buy_property", { property_id: 1 });
    await request("/v1/properties/1/buy", { txHash: hash });
    hash = await stack.contractCall(alice, "create_business", { property_id: 1, name: "City Market" });
    await request("/v1/businesses", { propertyId: 1, name: "City Market", txHash: hash });
    const item = await request("/v1/businesses/1/catalogue", {
      sku: "guide",
      name: "City guide",
      unitPrice: "20",
      quantity: 10,
    });
    let order = (await request("/v1/orders", { itemId: item.id, quantity: 5 }, bobAuth)).order;
    hash = await stack.contractCall(bob, "pay_order", {
      business_id: 1,
      amount: order.total,
      reference: order.reference,
    });
    await request(`/v1/orders/${order.id}/confirm`, { txHash: hash }, bobAuth);
    const operation = async (input: Record<string, unknown>, who = alice, auth = aliceAuth) => {
      const op = (await request("/v1/city/commands", { requestId: randomUUID(), ...input }, auth)).operation;
      const tx = await stack.contractCall(who, op.method, op.args);
      const result = await request(`/v1/city/operations/${op.id}/confirm`, { txHash: tx }, auth);
      assert.equal(result.operation.status, "confirmed");
      const before = (await db`select count(*)::int as n from transactions`)[0].n;
      await request(`/v1/city/operations/${op.id}/confirm`, { txHash: tx }, auth);
      assert.equal((await db`select count(*)::int as n from transactions`)[0].n, before);
      return result.operation;
    };
    await operation({ action: "supplier", targetId: item.id, quantity: 5 });
    assert.equal((await db`select on_hand from business_items where id=${item.id}`)[0].on_hand, 10);
    const jobFund = await operation({
      action: "job",
      targetId: "1",
      amount: "30",
      title: "Prepare a city report",
      description: "Write a sourced report comparing the city library and market.",
      days: 7,
    });
    const [job] = await db`select * from funded_jobs where operation_id=${jobFund.id}`;
    await request(`/v1/jobs/${job.job_id}/accept`, {}, bobAuth);
    await request(
      `/v1/jobs/${job.job_id}/submit`,
      {
        deliverable:
          "The city library provides reference material, while the market supplies books for residents.",
      },
      bobAuth,
    );
    await request(`/v1/city/jobs/${job.job_id}/review`, {
      decision: "approve",
      note: "The referenced report satisfies the agreed deliverable.",
    });
    await request(`/v1/jobs/${job.job_id}/complete`, {}, bobAuth);
    assert.equal((await stack.readContract<any>("get_escrow", { id: job.escrow_id })).remaining, "0");
    const draft = await request("/v1/city/quizzes/drafts", {
      businessId: "1",
      title: "City knowledge check",
      questions: [
        {
          question: "What protects control of a wallet?",
          options: ["Private keys", "Public usernames"],
          correct: 0,
          source: "https://near.org/",
        },
      ],
      passScore: 1,
      entryFee: "5",
      reward: "25",
      capacity: 3,
      opensAt: new Date(Date.now() - 60000).toISOString(),
      closesAt: new Date(Date.now() + 3600000).toISOString(),
    });
    await request(`/v1/city/quizzes/drafts/${draft.id}/review`, {
      decision: "submit",
      note: "Question and source are ready for independent review.",
    });
    await request(
      `/v1/city/quizzes/drafts/${draft.id}/review`,
      { decision: "approve", note: "The source and answer key have been independently verified." },
      operatorAuth,
    );
    const prizeFund = await operation({ action: "quiz-fund", targetId: draft.id, amount: "50" });
    const quizId = `venue-${draft.id}`;
    await operation({ action: "sponsor", targetId: quizId, amount: "10" }, bob, bobAuth);
    await operation({ action: "admission", targetId: quizId }, bob, bobAuth);
    const attempt = await request(`/v1/quizzes/${quizId}/start`, {}, bobAuth);
    const before = await stack.readContract<any>("get_stats");
    const scored = await request(
      `/v1/quizzes/${quizId}/submit`,
      { attemptId: attempt.attemptId, answers: { [attempt.questions[0].id]: 0 } },
      bobAuth,
    );
    assert.equal(scored.reward, "25");
    const stats = await stack.readContract<any>("get_stats");
    assert.equal(stats.total_issued, before.total_issued, "funded prizes never mint");
    assert.equal((await stack.readContract<any>("get_escrow", { id: prizeFund.id })).remaining, "35");
    // A restricted payout key signs the real NPC purchase after actual travel and queueing.
    await db`update npc_runtime set scene_id='city-district',x=32,y=24,activity='garden_walk' where npc_id='professor-kofi'`;
    const now = new Date();
    await db`insert into business_settings(business_id,open_minute,close_minute) values (1,0,1440)`;
    await reserveNpcShopping(db, now);
    await tickNpcSimulation(db, { now, timeZone: "Africa/Accra", tilesPerTick: 2, catchupAfterMs: 1000 });
    await tickNpcShopping(db, now);
    await tickNpcShopping(db, new Date(now.getTime() + 4000));
    assert.equal(
      (await db`select status from npc_shop_visits where npc_id='professor-kofi'`)[0].status,
      "paid",
    );
    await operation({ action: "tax", targetId: "1" });
    // An unpaid cancellation permanently invalidates a previously prepared payment.
    order = (await request("/v1/orders", { itemId: item.id, quantity: 1 }, bobAuth)).order;
    await operation({ action: "cancel-order", targetId: order.id }, bob, bobAuth);
    assert.equal((await db`select status from business_orders where id=${order.id}`)[0].status, "cancelled");
    order = (await request("/v1/orders", { itemId: item.id, quantity: 1 }, bobAuth)).order;
    hash = await stack.contractCall(bob, "pay_order", {
      business_id: 1,
      amount: order.total,
      reference: order.reference,
    });
    await request(`/v1/orders/${order.id}/confirm`, { txHash: hash }, bobAuth);
    await operation({ action: "refund", targetId: order.id });
    assert.equal((await db`select status from business_orders where id=${order.id}`)[0].status, "refunded");
    const finalStats = await stack.readContract<any>("get_stats");
    const [sum] = await db`select sum(balance)::text as amount from wallets where active=true`;
    assert.equal(BigInt(sum.amount), BigInt(finalStats.total_issued) - BigInt(finalStats.total_burned));
    assert.equal((await db`select on_hand from business_items where id=${item.id}`)[0].on_hand, 9);
    assert.equal(
      (await db`select revenue_total::text as revenue from businesses where id=1`)[0].revenue,
      "145",
    );
    assert.equal(finalStats.total_issued, "11000");
    assert.equal(finalStats.total_burned, "100");
  },
);
