import assert from "node:assert/strict";
import test from "node:test";
import { projectEconomicWorldEvents } from "../src/world-economic-projection.js";
import type { ValidatedEvent } from "../src/event-validation.js";

function event(name: string, data: Record<string, unknown>, txHash = "1".repeat(43)): ValidatedEvent {
  return {
    standard: "quizcity",
    version: "1.0.0",
    event: name,
    data: [data],
    receiptId: "receipt-1",
    eventIndex: 0,
    txHash,
    blockHeight: "10",
    blockHash: "block-10",
    chainTimestamp: "2026-11-13T00:00:00.000Z",
    payload: {},
  };
}

test("confirmed job rewards project one presentation event with a chain idempotency key", () => {
  const drafts = projectEconomicWorldEvents(
    event("job_reward", { reference: "job:job-1", amount: "100" }),
    "city-district",
  );
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].type, "job.presentation_changed");
  assert.equal(drafts[0].streamId, "scene:city-district");
  assert.deepEqual(drafts[0].payload, { jobId: "job-1", status: "paid", txHash: "1".repeat(43) });
  assert.equal(drafts[0].idempotencyKey, "chain:receipt-1:0:job");
});

test("service payments project confirmation without inventing a revenue total", () => {
  const drafts = projectEconomicWorldEvents(
    event("service_paid", { business_id: 1, amount: "20" }),
    "city-district",
  );
  assert.deepEqual(
    drafts.map((draft) => draft.type),
    ["purchase.presentation_changed"],
  );
  assert.deepEqual(drafts[0].payload, { businessId: "1", amount: "20", status: "confirmed" });
});

test("property and business transfers project presentation changes", () => {
  const property = projectEconomicWorldEvents(
    event("property_transferred", { id: 1, new_owner: "player:alice.testnet" }),
    "city-district",
  );
  assert.equal(property[0].type, "property.presentation_changed");
  assert.deepEqual(property[0].payload, { propertyId: "1", forSale: false, price: "0" });

  const business = projectEconomicWorldEvents(event("business_transferred", { id: 1 }), "city-district");
  assert.deepEqual(business, []);
});

test("unrelated chain facts do not create world events", () => {
  assert.deepEqual(
    projectEconomicWorldEvents(event("player_registered", { account: "alice" }), "city-district"),
    [],
  );
  assert.deepEqual(
    projectEconomicWorldEvents(event("job_reward", { reference: "other" }), "city-district"),
    [],
  );
  assert.deepEqual(
    projectEconomicWorldEvents(event("job_reward", { reference: "job:1" }, "invalid"), "city-district"),
    [],
  );
});
