import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_STANDARD, EVENT_VERSION, type ChainEvent } from "../src/event-ledger.js";
import { ledgerEntity, ledgerEntryFromEvent, ledgerEntryKey, type LedgerContext } from "../src/ledger.js";
import { testEnv } from "./fixtures.js";

// verify.ts reads runtime configuration at import time.
Object.assign(process.env, testEnv);
const { parseEvents } = await import("../src/verify.js");

const context: LedgerContext = { networkId: "testnet", contractId: "quizcity.testnet" };

function canonical(
  eventOverrides: Record<string, unknown> = {},
  dataOverrides: Record<string, unknown> = {},
): ChainEvent {
  return {
    standard: EVENT_STANDARD,
    version: EVENT_VERSION,
    event: "job_reward",
    data: [
      {
        seq: 7,
        wallet_from: "npc:professor-kofi",
        wallet_to: "player:alice.testnet",
        amount: "100",
        reference: "job:7",
        entity_id: "player:alice.testnet",
        ...dataOverrides,
      },
    ],
    receiptId: "receipt-1",
    eventIndex: 0,
    blockHeight: 1234,
    blockHash: "block-hash",
    txHash: "tx-hash",
    payload: { untouched: true },
    ...eventOverrides,
  };
}

test("ledger entity splits the canonical entity_id", () => {
  assert.deepEqual(ledgerEntity("property:2"), { entityType: "property", entityId: "2" });
  assert.deepEqual(ledgerEntity("player:alice.testnet"), {
    entityType: "player",
    entityId: "alice.testnet",
  });
  assert.deepEqual(ledgerEntity("no-separator"), { entityType: null, entityId: "no-separator" });
  assert.deepEqual(ledgerEntity(null), { entityType: null, entityId: null });
});

test("maps a canonical balance movement with receipt identity and raw payload", () => {
  const entry = ledgerEntryFromEvent(canonical(), context);
  assert.ok(entry);
  assert.equal(entry.networkId, "testnet");
  assert.equal(entry.contractId, "quizcity.testnet");
  assert.equal(entry.txHash, "tx-hash");
  assert.equal(entry.receiptId, "receipt-1");
  assert.equal(entry.eventIndex, 0);
  assert.equal(entry.eventName, "job_reward");
  assert.equal(entry.eventVersion, EVENT_VERSION);
  assert.equal(entry.walletFrom, "npc:professor-kofi");
  assert.equal(entry.walletTo, "player:alice.testnet");
  assert.equal(entry.amount, "100");
  assert.equal(entry.reference, "job:7");
  assert.equal(entry.entityType, "player");
  assert.equal(entry.entityId, "alice.testnet");
  assert.equal(entry.blockHeight, 1234);
  assert.equal(entry.blockHash, "block-hash");
  assert.deepEqual(entry.payload, { untouched: true });
});

test("issuance uses a null source and burn uses a null destination", () => {
  const issued = ledgerEntryFromEvent(
    canonical({}, { wallet_from: null, wallet_to: "player:alice.testnet", amount: "500" }),
    context,
  );
  assert.ok(issued);
  assert.equal(issued.walletFrom, null);
  assert.equal(issued.walletTo, "player:alice.testnet");

  const burned = ledgerEntryFromEvent(
    canonical({}, { wallet_from: "player:alice.testnet", wallet_to: null, amount: "100" }),
    context,
  );
  assert.ok(burned);
  assert.equal(burned.walletFrom, "player:alice.testnet");
  assert.equal(burned.walletTo, null);
});

test("registry events carry amount zero without pretending to move QC", () => {
  const entry = ledgerEntryFromEvent(
    canonical({ event: "property_created" }, { wallet_from: null, wallet_to: null, amount: "0" }),
    context,
  );
  assert.ok(entry);
  assert.equal(entry.amount, "0");
  assert.equal(entry.walletFrom, null);
  assert.equal(entry.walletTo, null);
});

test("rejects non-canonical logs, missing identity, and invalid amounts", () => {
  assert.equal(ledgerEntryFromEvent(canonical({ standard: "nep297" }), context), null);
  assert.equal(ledgerEntryFromEvent(canonical({ version: "0.9" }), context), null);
  assert.throws(
    () => ledgerEntryFromEvent(canonical({ receiptId: undefined }), context),
    /missing receipt\/event identity/,
  );
  assert.throws(
    () => ledgerEntryFromEvent(canonical({}, { amount: "-5" }), context),
    /invalid ledger amount/,
  );
});

test("ledger identity is (network_id, receipt_id, event_index)", () => {
  const first = ledgerEntryFromEvent(canonical(), context)!;
  const second = ledgerEntryFromEvent(canonical({ eventIndex: 1 }), context)!;
  assert.notEqual(ledgerEntryKey(first), ledgerEntryKey(second));
  assert.equal(ledgerEntryKey(first), "testnet:receipt-1:0");
});

test("parseEvents attaches receipt/event identity for every canonical log", () => {
  const first = canonical();
  const second = canonical({}, { seq: 8 });
  const outcome = {
    transaction_outcome: { id: "tx-hash" },
    receipts_outcome: [
      {
        id: "receipt-1",
        block_hash: "block-hash",
        block_height: 1234,
        outcome: {
          executor_id: "quizcity.testnet",
          logs: [
            `EVENT_JSON:${JSON.stringify(first)}`,
            "not an event log",
            `EVENT_JSON:${JSON.stringify(second)}`,
          ],
        },
      },
      {
        id: "receipt-2",
        outcome: {
          executor_id: "another-contract.testnet",
          logs: [`EVENT_JSON:${JSON.stringify(canonical())}`],
        },
      },
    ],
  };

  const events = parseEvents(outcome);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => [event.receiptId, event.eventIndex]),
    [
      ["receipt-1", 0],
      ["receipt-1", 1],
    ],
  );
  assert.equal(events[0].txHash, "tx-hash");
  assert.equal(events[0].blockHeight, 1234);
  assert.equal(events[0].blockHash, "block-hash");

  const entries = events.map((event) => ledgerEntryFromEvent(event, context)!);
  assert.equal(new Set(entries.map(ledgerEntryKey)).size, 2);
});
