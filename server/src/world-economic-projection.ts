import { TxHash } from "@quiz-city/protocol";
import { Value } from "@sinclair/typebox/value";
import type { ValidatedEvent } from "./event-validation.js";
import type { AppendWorldEvent } from "./world-events.js";

/**
 * Maps already verified chain facts to presentation-safe world events. This never
 * changes economic state; it only describes confirmed facts for scene clients.
 */
export function projectEconomicWorldEvents(event: ValidatedEvent, sceneId: string): AppendWorldEvent[] {
  const data = event.data[0];
  if (
    typeof event.receiptId !== "string" ||
    !Number.isInteger(event.eventIndex) ||
    typeof event.chainTimestamp !== "string"
  ) {
    return [];
  }
  const key = (suffix: string) => `chain:${event.receiptId}:${event.eventIndex}:${suffix}`;
  const streamId = `scene:${sceneId}`;
  const base = { streamId, sceneId, cityTime: event.chainTimestamp };

  switch (event.event) {
    case "job_reward": {
      const reference = typeof data.reference === "string" ? data.reference : "";
      if (
        !reference.startsWith("job:") ||
        typeof event.txHash !== "string" ||
        !Value.Check(TxHash, event.txHash)
      ) {
        return [];
      }
      const jobId = reference.slice(4);
      return [
        {
          ...base,
          type: "job.presentation_changed",
          entity: { entityType: "job", entityId: jobId },
          payload: { jobId, status: "paid", txHash: event.txHash ?? null },
          idempotencyKey: key("job"),
        },
      ];
    }
    case "service_paid": {
      const businessId = String(data.business_id ?? "");
      if (!businessId) return [];
      const amount = String(data.amount ?? "0");
      return [
        {
          ...base,
          type: "purchase.presentation_changed",
          entity: { entityType: "business", entityId: businessId },
          payload: { businessId, amount, status: "confirmed" },
          idempotencyKey: key("purchase"),
        },
      ];
    }
    case "property_transferred": {
      const id = String(data.id ?? "");
      if (!id) return [];
      return [
        {
          ...base,
          type: "property.presentation_changed",
          entity: { entityType: "property", entityId: id },
          payload: {
            propertyId: id,
            forSale: false,
            price: "0",
          },
          idempotencyKey: key("property"),
        },
      ];
    }
    case "property_created":
    case "property_listed": {
      const id = String(data.id ?? "");
      if (!id) return [];
      const price = String(data.listing_price ?? data.price ?? "0");
      return [
        {
          ...base,
          type: "property.presentation_changed",
          entity: { entityType: "property", entityId: id },
          payload: { propertyId: id, forSale: Boolean(data.for_sale ?? true), price },
          idempotencyKey: key("property-listing"),
        },
      ];
    }
    case "property_listing_cancelled": {
      const id = String(data.id ?? "");
      if (!id) return [];
      return [
        {
          ...base,
          type: "property.presentation_changed",
          entity: { entityType: "property", entityId: id },
          payload: { propertyId: id, forSale: false, price: "0" },
          idempotencyKey: key("property-listing"),
        },
      ];
    }
    case "business_created": {
      const businessId = String(data.id ?? "");
      if (!businessId) return [];
      return [
        {
          ...base,
          type: "business.state_changed",
          entity: { entityType: "business", entityId: businessId },
          payload: {
            businessId,
            status: "open",
            revenueTotal: "0",
            name: String(data.name),
            propertyId: String(data.property_id),
          },
          idempotencyKey: key("business"),
        },
      ];
    }
    // The current business event describes operating state, not ownership. A
    // business transfer therefore waits for a dedicated presentation schema.
    case "business_transferred":
      return [];
    default:
      return [];
  }
}
