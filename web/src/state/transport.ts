import type { ProtocolEventType } from "@quiz-city/protocol";
import type { QueryStatus } from "./entities";

export type EventTransport = {
  subscribe(onEvent: (event: ProtocolEventType) => void): () => void;
  status(): QueryStatus;
};

export type FakeEventTransport = EventTransport & {
  emit(event: ProtocolEventType): void;
  setStatus(status: QueryStatus): void;
};

/** Phase 5 placeholder; Phase 6 supplies the websocket adapter. */
export function createNoopTransport(status: QueryStatus = "online"): EventTransport {
  return {
    subscribe: () => () => {},
    status: () => status,
  };
}

/** Deterministic transport used by route integration tests before Phase 6 adds websockets. */
export function createFakeTransport(initialStatus: QueryStatus = "online"): FakeEventTransport {
  let currentStatus = initialStatus;
  const listeners = new Set<(event: ProtocolEventType) => void>();
  return {
    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
    status: () => currentStatus,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    setStatus(status) {
      currentStatus = status;
    },
  };
}
