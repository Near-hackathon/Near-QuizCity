import assert from "node:assert/strict";
import test from "node:test";
import {
  legacyPropertySaleReceipt,
  propertySaleFromReceipts,
  propertySaleReceipt,
  ReceiptError,
  servicePaymentReceipt,
  type ChainEvent,
} from "../src/event-ledger.js";

const sale = (overrides: Record<string, unknown> = {}): ChainEvent => ({
  standard: "quizcity",
  version: "1.0.0",
  event: "property_transferred",
  data: [
    {
      seq: 6,
      wallet_from: "player:buyer.testnet",
      wallet_to: "player:seller.testnet",
      amount: "300",
      reference: "property:2:1",
      entity_id: "property:2",
      previous_owner: "player:seller.testnet",
      new_owner: "player:buyer.testnet",
      transfer_count: 1,
      ...overrides,
    },
  ],
});

test("property sale receipt keeps buyer to seller direction", () => {
  const receipt = propertySaleReceipt([sale()], "player:buyer.testnet", 2, 1);
  assert.deepEqual(receipt, { seller: "player:seller.testnet", price: 300 });
});

test("property sale receipt rejects the old reversed direction", () => {
  assert.throws(
    () =>
      propertySaleReceipt(
        [
          sale({
            wallet_from: "player:seller.testnet",
            wallet_to: "player:buyer.testnet",
          }),
        ],
        "player:buyer.testnet",
        2,
        1,
      ),
    ReceiptError,
  );
});

test("property sale receipt rejects a mismatched entity or transfer count", () => {
  assert.throws(
    () => propertySaleReceipt([sale({ entity_id: "property:3" })], "player:buyer.testnet", 2, 1),
    /does not match/,
  );
  assert.throws(() => propertySaleReceipt([sale()], "player:buyer.testnet", 2, 2), /does not match/);
});

test("property sale receipt returns null when no canonical event exists", () => {
  assert.equal(propertySaleReceipt([], "player:buyer.testnet", 2, 1), null);
});

const legacy = (overrides: Record<string, unknown> = {}): ChainEvent => ({
  event: "transfer",
  data: [
    {
      from: "player:buyer.testnet",
      to: "player:seller.testnet",
      amount: "300",
      kind: "property_sale",
      tx: 4,
      ...overrides,
    },
  ],
});

test("legacy property sale reads the seller from `to`", () => {
  assert.deepEqual(legacyPropertySaleReceipt([legacy()], "player:buyer.testnet"), {
    seller: "player:seller.testnet",
    price: 300,
  });
});

test("legacy property sale rejects the old reversed matcher shape", () => {
  assert.throws(
    () =>
      legacyPropertySaleReceipt(
        [legacy({ from: "player:seller.testnet", to: "player:buyer.testnet" })],
        "player:buyer.testnet",
      ),
    /buyer does not match/,
  );
});

test("legacy property sale rejects multiple matching sales", () => {
  const events: ChainEvent[] = [legacy(), legacy({ tx: 5 })];
  assert.throws(() => legacyPropertySaleReceipt(events, "player:buyer.testnet"), /ambiguous/);
});

test("legacy property sale rejects invalid parties", () => {
  for (const override of [{ to: "" }, { to: "player:buyer.testnet" }, { to: 7 }]) {
    assert.throws(() => legacyPropertySaleReceipt([legacy(override)], "player:buyer.testnet"), ReceiptError);
  }
});

test("legacy property sale rejects invalid amounts", () => {
  for (const amount of ["0", "-5", "abc", "9007199254740992"]) {
    assert.throws(
      () => legacyPropertySaleReceipt([legacy({ amount })], "player:buyer.testnet"),
      ReceiptError,
    );
  }
});

test("legacy property sale returns null when no sale exists", () => {
  assert.equal(legacyPropertySaleReceipt([], "player:buyer.testnet"), null);
  const other: ChainEvent = {
    event: "transfer",
    data: [{ kind: "service", from: "a", to: "b", amount: "1" }],
  };
  assert.equal(legacyPropertySaleReceipt([other], "player:buyer.testnet"), null);
});

test("canonical receipt takes priority when legacy logs are also present", () => {
  const events = [legacy({ to: "player:legacy-seller.testnet" }), sale()];
  assert.deepEqual(legacyPropertySaleReceipt(events, "player:buyer.testnet"), {
    seller: "player:legacy-seller.testnet",
    price: 300,
  });
  assert.deepEqual(propertySaleFromReceipts(events, "player:buyer.testnet", 2, 1), {
    seller: "player:seller.testnet",
    price: 300,
  });
});

test("service payment receipt keeps customer to business direction", () => {
  const events: ChainEvent[] = [
    {
      standard: "quizcity",
      version: "1.0.0",
      event: "service_paid",
      data: [
        {
          seq: 9,
          wallet_from: "player:bob.testnet",
          wallet_to: "biz:1",
          amount: "20",
          reference: "service:1:8",
          entity_id: "business:1",
        },
      ],
    },
  ];
  assert.deepEqual(servicePaymentReceipt(events, "player:bob.testnet", "biz:1", 1), { amount: 20 });
  assert.throws(() => servicePaymentReceipt(events, "player:alice.testnet", "biz:1", 1), ReceiptError);
});
