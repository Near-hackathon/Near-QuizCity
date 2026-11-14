import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorldTransport } from "../world-transport";

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(value: string) {
    this.sent.push(value);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const bootstrap = {
  type: "world.bootstrap",
  protocolVersion: "1.0.0",
  serverTime: "2026-11-13T00:00:00.000Z",
  cityTime: "2026-11-13T00:00:00.000Z",
  streamId: "scene:city-district",
  lastSequence: "5",
  scene: {
    id: "city-district",
    name: "City",
    sceneType: "exterior",
    width: 64,
    height: 48,
    assetKey: "maps/city",
    assetVersion: "1",
  },
  player: {
    accountId: "alice.testnet",
    x: 1,
    y: 2,
    facing: "south",
    stateVersion: "0",
    lastClientSequence: "0",
  },
  buildings: [],
  interactionZones: [],
  spawns: [],
  npcs: [],
  players: [],
  properties: [],
  businesses: [],
};

let sockets: FakeSocket[] = [];
const factory = (url: string) => {
  lastUrl = url;
  const socket = new FakeSocket();
  sockets.push(socket);
  return socket as unknown as WebSocket;
};
let lastUrl = "";

beforeEach(() => {
  sockets = [];
  lastUrl = "";
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("world transport", () => {
  it("accepts a matching resume barrier and rejects a mismatched ready stream", () => {
    const transport = createWorldTransport({ apiBase: "http://localhost:8787", socketFactory: factory });
    const statuses: string[] = [];
    transport.onStatus((status) => statuses.push(status));
    transport.connect("city-district", "5");
    sockets[0].open();
    sockets[0].deliver({
      type: "world.ready",
      streamId: "scene:city-district",
      sequence: "5",
      lastClientSequence: "0",
    });
    expect(statuses.at(-1)).toBe("online");
    sockets[0].deliver({
      type: "world.ready",
      streamId: "scene:library-interior",
      sequence: "5",
      lastClientSequence: "0",
    });
    expect(sockets[0].closed?.reason).toBe("invalid ready barrier");
    transport.disconnect();
  });
  it("does not reuse durable command IDs when a transport is recreated after navigation", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const transport = createWorldTransport({ apiBase: "http://localhost:8787", socketFactory: factory });
      transport.connect("city-district", null);
      const socket = sockets.at(-1)!;
      socket.open();
      socket.deliver(bootstrap);
      socket.deliver({
        type: "world.ready",
        streamId: bootstrap.streamId,
        sequence: "5",
        lastClientSequence: "20",
      });
      const move = transport.sendMove(33, 24);
      const message = JSON.parse(socket.sent.at(-1)!);
      ids.push(message.messageId);
      expect(message.clientSequence).toBe("21");
      socket.deliver({ type: "world.ack", messageId: message.messageId, sequence: "5" });
      await move;
      transport.disconnect();
    }
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("derives the websocket URL, subscribes on open, and applies bootstrap", () => {
    const transport = createWorldTransport({ apiBase: "https://api.example.com", socketFactory: factory });
    const statuses: string[] = [];
    transport.onStatus((status) => statuses.push(status));
    transport.connect("city-district", null);
    expect(lastUrl).toBe("wss://api.example.com/v1/world/ws");

    sockets[0].open();
    const subscribe = JSON.parse(sockets[0].sent[0]);
    expect(subscribe).toMatchObject({
      type: "world.subscribe",
      sceneId: "city-district",
      lastSequence: null,
      clientSequence: "1",
    });
    sockets[0].deliver(bootstrap);
    expect(transport.lastSequence()).toBe("5");
    expect(statuses).toContain("connecting");
    expect(statuses).not.toContain("online");
    sockets[0].deliver({
      type: "world.ready",
      streamId: bootstrap.streamId,
      sequence: "5",
      lastClientSequence: "0",
    });
    expect(statuses).toContain("online");
    transport.disconnect();
  });

  it("validates incoming messages and ignores duplicate/older events", () => {
    const transport = createWorldTransport({ apiBase: "http://localhost:8787", socketFactory: factory });
    const events: string[] = [];
    transport.onEvent((event) => events.push(event.sequence));
    transport.connect("city-district", null);
    sockets[0].open();
    sockets[0].deliver(bootstrap);
    const event = {
      type: "world.event",
      event: {
        protocolVersion: "1.0.0",
        eventId: "evt-1",
        streamId: "scene:city-district",
        sequence: "6",
        serverTime: "2026-11-13T00:00:00.000Z",
        cityTime: "2026-11-13T00:00:00.000Z",
        sceneId: "city-district",
        entity: { entityType: "player", entityId: "alice.testnet" },
        type: "player.checkpoint",
        payload: { accountId: "alice.testnet", x: 1, y: 1, facing: "south", sceneId: "city-district" },
      },
    };
    sockets[0].deliver(event);
    sockets[0].deliver(event);
    expect(events).toEqual(["6"]);

    // A malformed message closes the socket without entering application state.
    sockets[0].deliver({ type: "world.event", event: { type: "nope" } });
    expect(sockets[0].closed?.code).toBe(1003);
    transport.disconnect();
  });

  it("resolves intent acknowledgements and rejects errors/timeouts", async () => {
    const transport = createWorldTransport({ apiBase: "http://localhost:8787", socketFactory: factory });
    transport.connect("city-district", null);
    sockets[0].open();
    sockets[0].deliver(bootstrap);

    const pending = transport.sendMove(2, 3);
    const sent = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]);
    sockets[0].deliver({ type: "world.ack", messageId: sent.messageId, sequence: "5" });
    await expect(pending).resolves.toBe(sent.messageId);

    const failing = transport.sendInteract("building", "building-library");
    const interact = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]);
    sockets[0].deliver({
      type: "world.error",
      code: "NOT_IMPLEMENTED",
      message: "nope",
      messageId: interact.messageId,
    });
    await expect(failing).rejects.toThrow("NOT_IMPLEMENTED");
    transport.disconnect();
  });

  it("adopts a destination bootstrap after an authoritative door transition", async () => {
    const transport = createWorldTransport({ apiBase: "http://localhost:8787", socketFactory: factory });
    transport.connect("city-district", null);
    sockets[0].open();
    sockets[0].deliver(bootstrap);

    const transition = transport.sendInteract("door", "library-door-exterior");
    const interact = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]);
    sockets[0].deliver({
      ...bootstrap,
      streamId: "scene:library-interior",
      scene: { ...bootstrap.scene, id: "library-interior", name: "Library", sceneType: "interior" },
      player: { ...bootstrap.player, x: 12, y: 16, facing: "north" },
    });
    sockets[0].deliver({ type: "world.ack", messageId: interact.messageId, sequence: "5" });
    await expect(transition).resolves.toBe(interact.messageId);

    const move = transport.sendMove(12, 12);
    const sentMove = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]);
    expect(sentMove.sceneId).toBe("library-interior");
    sockets[0].deliver({ type: "world.ack", messageId: sentMove.messageId, sequence: "5" });
    await expect(move).resolves.toBe(sentMove.messageId);
    transport.disconnect();
  });

  it("reconnects with backoff and stops on disconnect", () => {
    const transport = createWorldTransport({
      apiBase: "http://localhost:8787",
      socketFactory: factory,
      random: () => 0,
    });
    transport.connect("city-district", null);
    sockets[0].open();
    sockets[0].deliver(bootstrap);
    sockets[0].close(1006, "network");
    vi.advanceTimersByTime(1_000);
    expect(sockets.length).toBe(2);
    sockets[1].open();
    const subscribe = JSON.parse(sockets[1].sent[0]);
    expect(subscribe.lastSequence).toBe("5");

    transport.disconnect();
    vi.advanceTimersByTime(30_000);
    expect(sockets.length).toBe(2);
  });

  it("resyncs on sequence gaps and does not reconnect terminal policy failures", () => {
    const transport = createWorldTransport({
      apiBase: "http://localhost:8787",
      socketFactory: factory,
      random: () => 0,
    });
    transport.connect("city-district", null);
    sockets[0].open();
    sockets[0].deliver(bootstrap);
    sockets[0].deliver({
      type: "world.event",
      event: {
        protocolVersion: "1.0.0",
        eventId: "evt-7",
        streamId: "scene:city-district",
        sequence: "7",
        serverTime: "2026-11-13T00:00:00.000Z",
        cityTime: "2026-11-13T00:00:00.000Z",
        sceneId: "city-district",
        entity: { entityType: "player", entityId: "alice.testnet" },
        type: "player.checkpoint",
        payload: { accountId: "alice.testnet", x: 1, y: 1, facing: "south", sceneId: "city-district" },
      },
    });
    expect(sockets[0].closed).toEqual({ code: 1012, reason: "sequence gap" });
    vi.advanceTimersByTime(1_000);
    expect(sockets.length).toBe(2);

    sockets[1].close(1008, "authentication required");
    vi.advanceTimersByTime(30_000);
    expect(sockets.length).toBe(2);
  });
});
