import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_STANDARD, EVENT_VERSION, type ChainEvent } from "../src/event-ledger.js";
import { U128_MAX, validateEvent, validateEventData } from "../src/event-validation.js";

function event(eventName: string, data: Record<string, unknown> = {}): ChainEvent {
  return {
    standard: EVENT_STANDARD,
    version: EVENT_VERSION,
    event: eventName,
    data: [
      {
        seq: 1,
        wallet_from: "npc:professor-kofi",
        wallet_to: "player:alice.testnet",
        amount: "100",
        reference: "job:1",
        entity_id: "player:alice.testnet",
        ...(eventName === "property_created"
          ? { kind: "plot", district: "knowledge", x: 1, y: 1 }
          : eventName === "business_created"
            ? { name: "Cafe" }
            : {}),
        ...data,
      },
    ],
  };
}

test("accepts a valid transfer event", () => {
  const validated = validateEvent(event("job_reward"));
  assert.equal(validated.data.length, 1);
  assert.equal(validated.data[0].amount, "100");
});

test("rejects malformed envelopes and multiple data objects", () => {
  assert.throws(() => validateEvent({ ...event("job_reward"), standard: "nep297" }), /standard/);
  assert.throws(() => validateEvent({ ...event("job_reward"), version: "2.0.0" }), /version/);
  assert.throws(
    () => validateEvent({ ...event("job_reward"), data: [event("job_reward").data[0], {}] }),
    /exactly one data object/,
  );
  assert.throws(() => validateEvent(event("unknown_event")), /unsupported event name/);
});

test("rejects non-string wallets instead of coercing them to null", () => {
  assert.throws(
    () =>
      validateEventData("job_reward", {
        seq: 1,
        wallet_from: 7,
        wallet_to: "player:alice.testnet",
        amount: "1",
        reference: "job:1",
        entity_id: "player:alice.testnet",
      }),
    /wallet_from must be a string or null/,
  );

  assert.throws(
    () =>
      validateEventData("job_reward", {
        seq: 1,
        wallet_to: "player:alice.testnet",
        amount: "1",
        reference: "job:1",
        entity_id: "player:alice.testnet",
      }),
    /wallet_from is required/,
  );
});

test("enforces the U128 boundary with BigInt", () => {
  assert.doesNotThrow(() => validateEvent(event("job_reward", { amount: U128_MAX.toString() })));
  assert.throws(
    () => validateEvent(event("job_reward", { amount: (U128_MAX + 1n).toString() })),
    /exceeds u128 maximum/,
  );
  for (const amount of ["-1", "1.5", "1e3", "", "abc", "9999999999999999999999999999999999999999"]) {
    assert.throws(() => validateEvent(event("job_reward", { amount })), /amount/);
  }
});

test("enforces mint, burn, transfer, and registry direction", () => {
  assert.throws(
    () =>
      validateEvent(event("reward_issued", { wallet_from: "npc:kofi", entity_id: "player:alice.testnet" })),
    /mint must have wallet_from = null/,
  );
  assert.throws(
    () =>
      validateEvent(
        event("permit_burn", { wallet_to: "player:alice.testnet", entity_id: "business:1", business_id: 1 }),
      ),
    /burn must have wallet_to = null/,
  );
  assert.throws(
    () =>
      validateEvent(
        event("property_created", {
          wallet_from: "player:alice.testnet",
          wallet_to: null,
          amount: "0",
          entity_id: "property:1",
          id: 1,
          owner_wallet: "player:alice.testnet",
          listing_price: "0",
          for_sale: false,
        }),
      ),
    /registry event must have null wallets/,
  );
  assert.throws(
    () => validateEvent(event("job_reward", { wallet_from: null, wallet_to: null })),
    /transfer requires both wallets/,
  );
});

test("enforces event-specific ownership and entity fields", () => {
  assert.throws(
    () =>
      validateEvent(
        event("property_transferred", {
          wallet_from: "player:buyer.testnet",
          wallet_to: "player:seller.testnet",
          entity_id: "property:1",
          id: 1,
          previous_owner: "player:other.testnet",
          new_owner: "player:buyer.testnet",
          transfer_count: 1,
        }),
      ),
    /wallet_to must be the seller/,
  );
  assert.throws(
    () =>
      validateEvent(
        event("business_created", {
          wallet_from: null,
          wallet_to: null,
          amount: "0",
          entity_id: "business:2",
          id: 1,
          owner: "alice.testnet",
          owner_wallet: "player:alice.testnet",
          property_id: 1,
          treasury: "biz:1",
          permit_fee: "100",
        }),
      ),
    /entity_id must be business:1/,
  );
  assert.throws(
    () => validateEvent(event("job_reward", { entity_id: "player:someone-else.testnet" })),
    /entity_id must be player:alice.testnet/,
  );
});

test("registry events require zero movement", () => {
  assert.throws(
    () =>
      validateEvent(
        event("property_created", {
          wallet_from: null,
          wallet_to: null,
          amount: "1",
          entity_id: "property:1",
          id: 1,
          owner_wallet: "player:alice.testnet",
          listing_price: "0",
          for_sale: false,
        }),
      ),
    /registry event amount must be zero/,
  );
});

test("wallet_created relationships are enforced", () => {
  const funded = event("wallet_created", {
    wallet_from: null,
    wallet_to: "npc:professor-kofi",
    amount: "1000",
    reference: "wallet:npc:professor-kofi",
    entity_id: "npc:professor-kofi",
    owner_wallet: "npc:professor-kofi",
    funded: true,
  });
  assert.doesNotThrow(() => validateEvent(funded));

  assert.throws(
    () =>
      validateEvent(
        event("wallet_created", {
          wallet_from: null,
          wallet_to: null,
          amount: "0",
          reference: "wallet:gov:council",
          entity_id: "gov:other",
          owner_wallet: "gov:council",
          funded: false,
        }),
      ),
    /entity_id must equal owner_wallet/,
  );
  assert.throws(
    () =>
      validateEvent(
        event("wallet_created", {
          wallet_from: null,
          wallet_to: "npc:someone-else",
          amount: "1000",
          reference: "wallet:npc:professor-kofi",
          entity_id: "npc:professor-kofi",
          owner_wallet: "npc:professor-kofi",
          funded: true,
        }),
      ),
    /wallet_to must equal owner_wallet/,
  );
});

test("player_registered and starter allowance relationships are enforced", () => {
  assert.doesNotThrow(() =>
    validateEvent(
      event("player_registered", {
        wallet_from: null,
        wallet_to: null,
        amount: "0",
        reference: "player:alice.testnet",
        entity_id: "player:alice.testnet",
        account: "alice.testnet",
        username: "alice",
        owner_wallet: "player:alice.testnet",
      }),
    ),
  );
  assert.throws(
    () =>
      validateEvent(
        event("player_registered", {
          wallet_from: null,
          wallet_to: null,
          amount: "0",
          reference: "player:alice.testnet",
          entity_id: "player:alice.testnet",
          account: "alice.testnet",
          username: "alice",
          owner_wallet: "player:someone-else.testnet",
        }),
      ),
    /owner_wallet must be player:alice.testnet/,
  );

  assert.doesNotThrow(() =>
    validateEvent(
      event("starter_allowance", {
        wallet_from: null,
        wallet_to: "player:alice.testnet",
        amount: "500",
        reference: "starter:alice.testnet",
        entity_id: "player:alice.testnet",
        account: "alice.testnet",
      }),
    ),
  );
  assert.throws(
    () =>
      validateEvent(
        event("starter_allowance", {
          wallet_from: null,
          wallet_to: "player:someone-else.testnet",
          amount: "500",
          reference: "starter:alice.testnet",
          entity_id: "player:alice.testnet",
          account: "alice.testnet",
        }),
      ),
    /wallet_to must be player:alice.testnet/,
  );
});

test("business creation and transfer wallet relationships are enforced", () => {
  const created = event("business_created", {
    wallet_from: null,
    wallet_to: null,
    amount: "0",
    reference: "business:1:create",
    entity_id: "business:1",
    id: 1,
    owner: "alice.testnet",
    owner_wallet: "player:alice.testnet",
    property_id: 3,
    treasury: "biz:1",
    permit_fee: "100",
  });
  assert.doesNotThrow(() => validateEvent(created));
  assert.throws(
    () =>
      validateEvent(
        event("business_created", {
          wallet_from: null,
          wallet_to: null,
          amount: "0",
          reference: "business:1:create",
          entity_id: "business:1",
          id: 1,
          owner: "alice.testnet",
          owner_wallet: "player:bob.testnet",
          property_id: 3,
          treasury: "biz:1",
          permit_fee: "100",
        }),
      ),
    /owner_wallet must be player:alice.testnet/,
  );
  assert.throws(
    () =>
      validateEvent(
        event("business_created", {
          wallet_from: null,
          wallet_to: null,
          amount: "0",
          reference: "business:1:create",
          entity_id: "business:1",
          id: 1,
          owner: "alice.testnet",
          owner_wallet: "player:alice.testnet",
          property_id: 3,
          treasury: "biz:2",
          permit_fee: "100",
        }),
      ),
    /treasury must be biz:1/,
  );

  const transferred = event("business_transferred", {
    wallet_from: null,
    wallet_to: null,
    amount: "0",
    reference: "business:1:transfer",
    entity_id: "business:1",
    id: 1,
    previous_owner: "alice.testnet",
    new_owner: "bob.testnet",
    previous_owner_wallet: "player:alice.testnet",
    new_owner_wallet: "player:bob.testnet",
  });
  assert.doesNotThrow(() => validateEvent(transferred));
  assert.throws(
    () =>
      validateEvent(
        event("business_transferred", {
          wallet_from: null,
          wallet_to: null,
          amount: "0",
          reference: "business:1:transfer",
          entity_id: "business:1",
          id: 1,
          previous_owner: "alice.testnet",
          new_owner: "bob.testnet",
          previous_owner_wallet: "player:someone-else.testnet",
          new_owner_wallet: "player:bob.testnet",
        }),
      ),
    /previous_owner_wallet must be player:alice.testnet/,
  );
  assert.throws(
    () =>
      validateEvent(
        event("business_transferred", {
          wallet_from: null,
          wallet_to: null,
          amount: "0",
          reference: "business:1:transfer",
          entity_id: "business:1",
          id: 1,
          previous_owner: "alice.testnet",
          new_owner: "bob.testnet",
          previous_owner_wallet: "player:alice.testnet",
          new_owner_wallet: "player:someone-else.testnet",
        }),
      ),
    /new_owner_wallet must be player:bob.testnet/,
  );
});
