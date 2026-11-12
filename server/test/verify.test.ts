import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_STANDARD, EVENT_VERSION } from "../src/event-ledger.js";
import { testEnv } from "./fixtures.js";

Object.assign(process.env, testEnv);
const { enrichBlockMetadata, extractEvents, requireExpectedEvent, verifyTransactionAction } =
  await import("../src/verify.js");

function canonical(overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}) {
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
        reference: "job:1",
        entity_id: "player:alice.testnet",
        ...dataOverrides,
      },
    ],
    ...overrides,
  };
}

function outcomeWithAction(
  method: string,
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    transaction: {
      signer_id: "alice.testnet",
      receiver_id: "quizcity.testnet",
      actions: [
        {
          FunctionCall: {
            method_name: method,
            args: Buffer.from(JSON.stringify(args)).toString("base64"),
            gas: 30_000_000_000_000,
            deposit: "0",
          },
        },
      ],
      ...overrides,
    },
  };
}

const expectation = {
  signerId: "alice.testnet",
  method: "buy_property",
  args: { property_id: 3 },
};

test("accepts the exact expected function call", () => {
  assert.doesNotThrow(() =>
    verifyTransactionAction(outcomeWithAction("buy_property", { property_id: 3 }), expectation),
  );
});

test("rejects wrong signer, receiver, method, arguments, deposit, and gas", () => {
  assert.throws(
    () =>
      verifyTransactionAction(
        outcomeWithAction("buy_property", { property_id: 3 }, { signer_id: "bob.testnet" }),
        expectation,
      ),
    /signer/,
  );
  assert.throws(
    () =>
      verifyTransactionAction(
        outcomeWithAction("buy_property", { property_id: 3 }, { receiver_id: "other.testnet" }),
        expectation,
      ),
    /receiver/,
  );
  assert.throws(
    () => verifyTransactionAction(outcomeWithAction("pay_service", { property_id: 3 }), expectation),
    /called pay_service/,
  );
  assert.throws(
    () => verifyTransactionAction(outcomeWithAction("buy_property", { property_id: 4 }), expectation),
    /arguments/,
  );
  const withDeposit = outcomeWithAction("buy_property", { property_id: 3 });
  withDeposit.transaction.actions[0].FunctionCall.deposit = "1";
  assert.throws(() => verifyTransactionAction(withDeposit, expectation), /deposit/);
  const withGas = outcomeWithAction("buy_property", { property_id: 3 });
  withGas.transaction.actions[0].FunctionCall.gas = 999_999_999_999_999;
  assert.throws(() => verifyTransactionAction(withGas, expectation), /gas/);
  assert.throws(
    () =>
      verifyTransactionAction(
        {
          transaction: { ...outcomeWithAction("buy_property", { property_id: 3 }).transaction, actions: [] },
        },
        expectation,
      ),
    /exactly one action/,
  );
});

test("extracts only trusted receipts and attaches identity", () => {
  const event = canonical();
  const outcome = {
    transaction_outcome: { id: "tx-hash" },
    receipts_outcome: [
      {
        id: "receipt-1",
        block_hash: "block-1",
        outcome: {
          executor_id: "quizcity.testnet",
          logs: [`EVENT_JSON:${JSON.stringify(event)}`],
        },
      },
      {
        id: "receipt-2",
        block_hash: "block-2",
        outcome: { executor_id: "other.testnet", logs: [`EVENT_JSON:${JSON.stringify(event)}`] },
      },
      {
        id: "receipt-3",
        block_hash: "block-3",
        outcome: { logs: [`EVENT_JSON:${JSON.stringify(event)}`] },
      },
    ],
  };
  const events = extractEvents(outcome);
  assert.equal(events.length, 1);
  assert.equal(events[0].receiptId, "receipt-1");
  assert.equal(events[0].eventIndex, 0);
  assert.equal(events[0].txHash, "tx-hash");
  assert.equal(events[0].blockHash, "block-1");
});

test("rejects malformed trusted logs instead of silently skipping them", () => {
  const base = {
    transaction_outcome: { id: "tx-hash" },
    receipts_outcome: [
      {
        id: "receipt-1",
        block_hash: "block-1",
        outcome: { executor_id: "quizcity.testnet", logs: ["EVENT_JSON:{not json"] },
      },
    ],
  };
  assert.throws(() => extractEvents(base), /malformed EVENT_JSON/);

  const twoData = canonical();
  twoData.data.push({ ...twoData.data[0], seq: 2 });
  assert.throws(
    () =>
      extractEvents({
        transaction_outcome: { id: "tx-hash" },
        receipts_outcome: [
          {
            id: "receipt-1",
            block_hash: "block-1",
            outcome: { executor_id: "quizcity.testnet", logs: [`EVENT_JSON:${JSON.stringify(twoData)}`] },
          },
        ],
      }),
    /exactly one data object/,
  );

  assert.throws(
    () =>
      extractEvents({
        transaction_outcome: { id: "tx-hash" },
        receipts_outcome: [{ block_hash: "block-1", outcome: { executor_id: "quizcity.testnet", logs: [] } }],
      }),
    /missing an id/,
  );
});

test("enriches block metadata once per block hash", async () => {
  const events = extractEvents({
    transaction_outcome: { id: "tx-hash" },
    receipts_outcome: [
      {
        id: "receipt-1",
        block_hash: "block-1",
        outcome: {
          executor_id: "quizcity.testnet",
          logs: [`EVENT_JSON:${JSON.stringify(canonical())}`],
        },
      },
      {
        id: "receipt-2",
        block_hash: "block-1",
        outcome: {
          executor_id: "quizcity.testnet",
          logs: [`EVENT_JSON:${JSON.stringify(canonical({}, { seq: 2 }))}`],
        },
      },
    ],
  });
  let lookups = 0;
  const enriched = await enrichBlockMetadata(events, async (hash) => {
    lookups += 1;
    return { height: hash === "block-1" ? 42 : 43, timestamp: "2026-11-12T00:00:00.000Z" };
  });
  assert.equal(lookups, 1);
  assert.equal(enriched[0].blockHeight, 42);
  assert.equal(enriched[0].chainTimestamp, "2026-11-12T00:00:00.000Z");
});

test("missing or invalid block metadata fails instead of inventing values", async () => {
  const events = extractEvents({
    transaction_outcome: { id: "tx-hash" },
    receipts_outcome: [
      {
        id: "receipt-1",
        block_hash: "block-1",
        outcome: {
          executor_id: "quizcity.testnet",
          logs: [`EVENT_JSON:${JSON.stringify(canonical())}`],
        },
      },
    ],
  });
  await assert.rejects(
    enrichBlockMetadata(events, async () => {
      throw new Error("block unavailable");
    }),
    /block unavailable/,
  );
  await assert.rejects(
    enrichBlockMetadata(events, async () => ({ height: -1, timestamp: "not-a-date" })),
    /invalid block metadata/,
  );
});

test("expected event lookup matches name and entity", async () => {
  const events = extractEvents({
    transaction_outcome: { id: "tx-hash" },
    receipts_outcome: [
      {
        id: "receipt-1",
        block_hash: "block-1",
        outcome: {
          executor_id: "quizcity.testnet",
          logs: [`EVENT_JSON:${JSON.stringify(canonical())}`],
        },
      },
    ],
  });
  assert.doesNotThrow(() =>
    requireExpectedEvent(events, { name: "job_reward", entityId: "player:alice.testnet" }),
  );
  assert.throws(() => requireExpectedEvent(events, { name: "reward_issued" }), /expected reward_issued/);
});

test("expected economic event binds wallets, amount, and reference", () => {
  const events = extractEvents({
    transaction_outcome: { id: "tx-hash" },
    receipts_outcome: [
      {
        id: "receipt-1",
        block_hash: "block-1",
        outcome: {
          executor_id: "quizcity.testnet",
          logs: [`EVENT_JSON:${JSON.stringify(canonical())}`],
        },
      },
    ],
  });
  const expected = {
    name: "job_reward",
    entityId: "player:alice.testnet",
    walletFrom: "npc:professor-kofi",
    walletTo: "player:alice.testnet",
    amount: "100",
    reference: "job:1",
  } as const;
  assert.doesNotThrow(() => requireExpectedEvent(events, expected));
  assert.throws(() => requireExpectedEvent(events, { ...expected, walletFrom: "npc:other" }), /expected/);
  assert.throws(() => requireExpectedEvent(events, { ...expected, amount: "101" }), /expected/);
  assert.throws(() => requireExpectedEvent(events, { ...expected, reference: "job:other" }), /expected/);
});
