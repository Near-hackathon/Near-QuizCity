import { describe, expect, it, vi } from "vitest";
import type { ProtocolEventType } from "@quiz-city/protocol";
import { createFakeTransport, createNoopTransport } from "./transport";

const event: ProtocolEventType = {
  eventId: "event-1",
  sequence: 1,
  serverTime: "2026-11-13T00:00:00.000Z",
  entityId: "job-1",
  entityType: "job",
  type: "job.status_changed",
  payload: { jobId: "job-1", status: "accepted", txHash: null },
};

describe("event transports", () => {
  it("provides a safe no-op boundary", () => {
    const transport = createNoopTransport("offline");
    expect(transport.status()).toBe("offline");
    expect(() => transport.subscribe(vi.fn())()).not.toThrow();
  });

  it("emits deterministically, unsubscribes, and changes status", () => {
    const transport = createFakeTransport();
    const listener = vi.fn();
    const unsubscribe = transport.subscribe(listener);
    transport.emit(event);
    expect(listener).toHaveBeenCalledWith(event);
    transport.setStatus("reconnecting");
    expect(transport.status()).toBe("reconnecting");
    unsubscribe();
    transport.emit(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
