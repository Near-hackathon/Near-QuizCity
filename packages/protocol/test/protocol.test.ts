import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AccountId,
  ConfigResponse,
  EconomyResponse,
  JobResponse,
  JobStatusEvent,
  PROTOCOL_VERSION,
  ProtocolEvent,
  QcAmount,
  TxHash,
  assertNeverEvent,
  assertProtocolCompatible,
  isProtocolCompatible,
  isQcString,
  type ProtocolEventType,
} from "../src/index.js";

test("shared primitives accept valid wire values and reject invalid ones", () => {
  assert.equal(Value.Check(AccountId, "alice.testnet"), true);
  assert.equal(Value.Check(AccountId, "A"), false);
  assert.equal(Value.Check(TxHash, "A".repeat(44)), true);
  assert.equal(Value.Check(TxHash, "0".repeat(44)), false);
  assert.equal(Value.Check(QcAmount, "0"), true);
  assert.equal(Value.Check(QcAmount, "01"), false);
});

test("QC strings stay exact at the u128 boundary", () => {
  assert.equal(isQcString("0"), true);
  assert.equal(isQcString("340282366920938463463374607431768211455"), true);
  assert.equal(isQcString("340282366920938463463374607431768211456"), false);
  for (const invalid of ["", "-1", "+1", "1.0", "1e3", " 1 ", "01", 1, null]) {
    assert.equal(isQcString(invalid), false, String(invalid));
  }
});

test("protocol versions accept the same major and reject mismatches", () => {
  assert.equal(PROTOCOL_VERSION, "1.0.0");
  assert.equal(isProtocolCompatible("1.0.0"), true);
  assert.equal(isProtocolCompatible("1.4.2"), true);
  assert.equal(isProtocolCompatible("2.0.0"), false);
  assert.equal(isProtocolCompatible("1"), false);
  assert.equal(isProtocolCompatible(undefined), false);
  assert.doesNotThrow(() => assertProtocolCompatible("1.2.0"));
  assert.throws(() => assertProtocolCompatible("2.0.0"), /Unsupported protocol version/);
});

test("config exposes the protocol version and economy keeps decimal strings", () => {
  assert.equal(
    Value.Check(ConfigResponse, {
      demoMode: false,
      networkId: "testnet",
      contractId: "quizcity.testnet",
      protocolVersion: "1.0.0",
    }),
    true,
  );
  assert.equal(
    Value.Check(ConfigResponse, {
      demoMode: false,
      networkId: "testnet",
      contractId: "quizcity.testnet",
    }),
    false,
  );
  assert.equal(
    Value.Check(EconomyResponse, {
      circulating_qc: "340282366920938463463374607431768211455",
      mirrored_wallet_sum: "0",
      supply_difference: "0",
      players: 0,
      properties: 0,
      businesses: 0,
      transactions: 0,
    }),
    true,
  );
});

test("event envelopes are versioned and discriminated", () => {
  const event = {
    eventId: "evt-1",
    sequence: 1,
    serverTime: "2026-11-13T00:00:00.000Z",
    entityType: "job",
    entityId: "job:1",
    type: "job.status_changed",
    payload: { jobId: "job-1", status: "paid", txHash: null },
  } as const;
  assert.equal(Value.Check(JobStatusEvent, event), true);
  assert.equal(Value.Check(ProtocolEvent, event), true);
  assert.equal(Value.Check(ProtocolEvent, { ...event, sequence: -1 }), false);
  assert.equal(Value.Check(ProtocolEvent, { ...event, type: "unknown.event" }), false);
});

test("jobs require their player-visible description", () => {
  const job = {
    id: "job-1",
    employer_wallet: "npc:professor-kofi",
    employee_account: null,
    title: "Research",
    description: "Visit the library and summarize the archive.",
    payment: "25",
    status: "open",
    reference: "job:job-1",
    chain_tx: null,
  };
  assert.equal(Value.Check(JobResponse, job), true);
  const { description: _description, ...missingDescription } = job;
  assert.equal(Value.Check(JobResponse, missingDescription), false);
});

test("event handling is exhaustive over the protocol union", () => {
  function label(event: ProtocolEventType): string {
    switch (event.type) {
      case "job.status_changed":
        return event.payload.status;
      case "wallet.balance_changed":
        return event.payload.balance;
      case "quiz.reward_updated":
        return event.payload.rewardState;
      case "economy.snapshot":
        return event.payload.circulatingQc;
      default:
        return assertNeverEvent(event);
    }
  }
  assert.equal(
    label({
      eventId: "e",
      sequence: 0,
      serverTime: "2026-11-13T00:00:00.000Z",
      entityType: "wallet",
      entityId: "player:alice.testnet",
      type: "wallet.balance_changed",
      payload: { walletId: "player:alice.testnet", balance: "25" },
    }),
    "25",
  );
});
