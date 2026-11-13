import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  WorldBootstrap,
  WorldClientMessage,
  WorldEvent,
  WorldSequence,
  WorldServerMessage,
  type WorldEventType,
  assertNeverWorldEvent,
} from "../src/index.js";

const common = {
  protocolVersion: "1.0.0",
  eventId: "evt-city-1",
  streamId: "scene:city-district",
  sequence: "1",
  serverTime: "2026-11-13T00:00:00.000Z",
  cityTime: "2026-11-13T00:00:00.000Z",
  sceneId: "city-district",
};
const entity = (entityType: string, entityId: string) => ({ entityType, entityId });
const worldEvents = [
  {
    ...common,
    entity: entity("npc", "kofi"),
    type: "npc.activity_changed",
    payload: { activity: "research", stateVersion: "1" },
  },
  {
    ...common,
    entity: entity("npc", "kofi"),
    type: "npc.path_started",
    payload: { sceneId: "city-district", toX: 2, toY: 3, stateVersion: "2" },
  },
  {
    ...common,
    entity: entity("npc", "kofi"),
    type: "npc.path_completed",
    payload: { sceneId: "city-district", x: 2, y: 3 },
  },
  {
    ...common,
    entity: entity("npc", "kofi"),
    type: "npc.entered_building",
    payload: { buildingId: "library" },
  },
  {
    ...common,
    entity: entity("npc", "kofi"),
    type: "npc.exited_building",
    payload: { buildingId: "library" },
  },
  {
    ...common,
    entity: entity("door", "library-door"),
    type: "door.state_changed",
    payload: { doorId: "library-door", state: "open" },
  },
  {
    ...common,
    entity: entity("business", "1"),
    type: "business.state_changed",
    payload: { businessId: "1", status: "open", revenueTotal: "10" },
  },
  {
    ...common,
    entity: entity("job", "job-1"),
    type: "job.presentation_changed",
    payload: { jobId: "job-1", status: "paid", txHash: "1".repeat(43) },
  },
  {
    ...common,
    entity: entity("business", "1"),
    type: "purchase.presentation_changed",
    payload: { businessId: "1", amount: "5", status: "confirmed" },
  },
  {
    ...common,
    entity: entity("player", "alice.testnet"),
    type: "inventory.presentation_changed",
    payload: { accountId: "alice.testnet", item: "book", delta: "-1" },
  },
  {
    ...common,
    entity: entity("property", "1"),
    type: "property.presentation_changed",
    payload: { propertyId: "1", forSale: true, price: "100" },
  },
  ...["player.joined", "player.checkpoint", "player.left", "player.scene_changed"].map((type) => ({
    ...common,
    entity: entity("player", "alice.testnet"),
    type,
    payload: { accountId: "alice.testnet", x: 1, y: 2, facing: "south", sceneId: "city-district" },
  })),
];

const bootstrap = {
  type: "world.bootstrap",
  protocolVersion: "1.0.0",
  serverTime: "2026-11-13T00:00:00.000Z",
  cityTime: "2026-11-13T00:00:00.000Z",
  streamId: "scene:city-district",
  lastSequence: "9007199254740993",
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

test("world sequences are canonical, bigint-safe PostgreSQL decimal strings", () => {
  for (const value of ["0", "1", "9007199254740993", "999999999999999999"]) {
    assert.equal(Value.Check(WorldSequence, value), true, value);
  }
  for (const value of ["", "01", "-1", "1.5", "9999999999999999999", 1]) {
    assert.equal(Value.Check(WorldSequence, value), false, String(value));
  }
});

test("every durable world event variant validates at runtime", () => {
  for (const event of worldEvents) {
    assert.equal(Value.Check(WorldEvent, event), true, event.type);
  }
  assert.equal(new Set(worldEvents.map((event) => event.type)).size, 15);
});

test("world events reject malformed envelopes, mismatched entities, and unsafe payloads", () => {
  const activity = worldEvents[0];
  const path = worldEvents[1];
  assert.equal(Value.Check(WorldEvent, { ...activity, extra: true }), false);
  assert.equal(Value.Check(WorldEvent, { ...activity, sequence: "01" }), false);
  assert.equal(Value.Check(WorldEvent, { ...activity, serverTime: "not-a-date" }), false);
  assert.equal(Value.Check(WorldEvent, { ...activity, type: "npc.unknown" }), false);
  assert.equal(Value.Check(WorldEvent, { ...activity, entity: entity("player", "kofi") }), false);
  assert.equal(Value.Check(WorldEvent, { ...path, payload: { ...path.payload, toX: 1.5 } }), false);
  assert.equal(Value.Check(WorldEvent, { ...path, payload: { ...path.payload, toX: 10_001 } }), false);
  assert.equal(Value.Check(WorldEvent, { ...activity, eventId: "x".repeat(129) }), false);
});

test("every client command validates and rejects unknown or extra fields", () => {
  const base = { messageId: "m1", clientSequence: "1", sceneId: "city-district" };
  const messages = [
    { ...base, type: "world.subscribe", lastSequence: null },
    { ...base, type: "world.ack", sequence: "1" },
    { ...base, type: "world.move_intent", x: 1, y: 2 },
    { ...base, type: "world.interact", targetType: "npc", targetId: "kofi" },
    { ...base, type: "world.ping" },
  ];
  for (const message of messages) assert.equal(Value.Check(WorldClientMessage, message), true, message.type);
  assert.equal(Value.Check(WorldClientMessage, { ...messages[0], extra: true }), false);
  assert.equal(Value.Check(WorldClientMessage, { ...messages[0], type: "world.unknown" }), false);
  assert.equal(Value.Check(WorldClientMessage, { ...messages[2], x: 1.5 }), false);
  assert.equal(Value.Check(WorldClientMessage, { ...messages[4], messageId: "x".repeat(129) }), false);
});

test("bootstrap and every server message variant validate", () => {
  assert.equal(Value.Check(WorldBootstrap, bootstrap), true);
  const messages = [
    bootstrap,
    { type: "world.event", event: worldEvents[0] },
    {
      type: "world.ready",
      streamId: "scene:city-district",
      sequence: "2",
      lastClientSequence: "3",
    },
    { type: "world.ack", messageId: "m1", sequence: "2" },
    { type: "world.resync_required", reason: "history expired" },
    { type: "world.error", code: "INVALID_MOVE", message: "Blocked", messageId: "m1" },
    { type: "world.pong", messageId: "m1", serverTime: common.serverTime },
  ];
  for (const message of messages) assert.equal(Value.Check(WorldServerMessage, message), true, message.type);
  assert.equal(Value.Check(WorldBootstrap, { ...bootstrap, lastSequence: 1 }), false);
  assert.equal(Value.Check(WorldServerMessage, { type: "world.unknown" }), false);
  assert.equal(Value.Check(WorldServerMessage, { ...messages[5], message: "x".repeat(513) }), false);
});

test("world event handling remains compile-time exhaustive", () => {
  function label(value: WorldEventType): string {
    switch (value.type) {
      case "npc.activity_changed":
        return value.payload.activity;
      case "npc.path_started":
      case "npc.path_completed":
        return value.type;
      case "npc.entered_building":
      case "npc.exited_building":
        return value.payload.buildingId;
      case "door.state_changed":
        return value.payload.state;
      case "business.state_changed":
        return value.payload.status;
      case "job.presentation_changed":
        return value.payload.status;
      case "purchase.presentation_changed":
        return value.payload.status;
      case "inventory.presentation_changed":
        return value.payload.item;
      case "property.presentation_changed":
        return value.payload.propertyId;
      case "player.joined":
      case "player.checkpoint":
      case "player.left":
      case "player.scene_changed":
        return value.payload.accountId;
      default:
        return assertNeverWorldEvent(value);
    }
  }
  assert.equal(label(worldEvents[0] as WorldEventType), "research");
});
