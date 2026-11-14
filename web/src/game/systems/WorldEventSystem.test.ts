import { describe, expect, it } from "vitest";
import type { WorldBootstrapType, WorldEventType } from "@quiz-city/protocol";
import { applyBootstrap, applyWorldEvent } from "./WorldEventSystem";

const stamp = {
  protocolVersion: "1.0.0",
  serverTime: "2026-01-01T00:00:00.000Z",
  cityTime: "2026-01-01T00:00:00.000Z",
};
const bootstrap = (scene = "city-district", sequence = "0"): WorldBootstrapType => ({
  type: "world.bootstrap",
  ...stamp,
  streamId: `scene:${scene}`,
  lastSequence: sequence,
  scene: {
    id: scene,
    name: scene,
    sceneType: "exterior",
    width: 100,
    height: 100,
    assetKey: "city",
    assetVersion: "1",
  },
  player: {
    accountId: "alice.testnet",
    x: 1,
    y: 2,
    facing: "south",
    stateVersion: "1",
    lastClientSequence: "0",
  },
  buildings: [
    {
      id: "b1",
      displayName: "Shop",
      buildingType: "shop",
      entranceX: 1,
      entranceY: 1,
      entranceFacing: "south",
      status: "active",
    },
  ],
  interactionZones: [],
  spawns: [],
  npcs: [
    {
      npcId: "n1",
      sceneId: scene,
      x: 2,
      y: 2,
      activity: "idle",
      targetX: null,
      targetY: null,
      stateVersion: "1",
    },
  ],
  players: [],
  properties: [{ id: "p1", forSale: false, price: "10" }],
  businesses: [{ id: "biz", name: "Cafe", status: "closed" }],
});

function event(
  type: WorldEventType["type"],
  sequence: string,
  payload: unknown,
  entityType: WorldEventType["entity"]["entityType"] = "player",
  sceneId = "city-district",
  entityId = "id",
): WorldEventType {
  return {
    ...stamp,
    eventId: `e${sequence}`,
    streamId: `scene:${sceneId}`,
    sequence,
    sceneId,
    entity: { entityType, entityId },
    type,
    payload,
  } as WorldEventType;
}

describe("WorldEventSystem", () => {
  it("applies activity, position and path facts from the same NPC version without accepting older state", () => {
    let model = applyBootstrap(bootstrap());
    model = applyWorldEvent(
      model,
      event(
        "npc.activity_changed",
        "1",
        { activity: "walking", stateVersion: "2" },
        "npc",
        "city-district",
        "n1",
      ),
    );
    model = applyWorldEvent(
      model,
      event(
        "npc.path_completed",
        "2",
        { sceneId: "city-district", x: 3, y: 2 },
        "npc",
        "city-district",
        "n1",
      ),
    );
    const path = event(
      "npc.path_started",
      "3",
      { sceneId: "city-district", toX: 8, toY: 2, stateVersion: "2" },
      "npc",
      "city-district",
      "n1",
    );
    model = applyWorldEvent(model, path);
    expect(model.npcs.get("n1")).toMatchObject({
      activity: "walking",
      x: 3,
      y: 2,
      targetX: 8,
      targetY: 2,
      stateVersion: "2",
    });
    expect(applyWorldEvent(model, path)).toBe(model);
    model = applyWorldEvent(
      model,
      event(
        "npc.activity_changed",
        "4",
        { activity: "idle", stateVersion: "1" },
        "npc",
        "city-district",
        "n1",
      ),
    );
    expect(model.npcs.get("n1")).toMatchObject({ activity: "walking", stateVersion: "2" });
  });
  it("places arriving NPCs only after a confirmed position and removes departed NPCs", () => {
    let model = applyBootstrap({ ...bootstrap(), npcs: [] });
    model = applyWorldEvent(
      model,
      event(
        "npc.activity_changed",
        "1",
        {
          activity: "research",
          stateVersion: "2",
        },
        "npc",
        "city-district",
        "kofi",
      ),
    );
    expect(model.npcs.size).toBe(0);
    model = applyWorldEvent(
      model,
      event(
        "npc.path_completed",
        "2",
        {
          sceneId: "city-district",
          x: 20,
          y: 10,
        },
        "npc",
        "city-district",
        "kofi",
      ),
    );
    expect(model.npcs.get("kofi")).toMatchObject({ activity: "research", x: 20, y: 10 });
    model = applyWorldEvent(
      model,
      event(
        "npc.entered_building",
        "3",
        {
          buildingId: "building-library",
        },
        "npc",
        "city-district",
        "kofi",
      ),
    );
    expect(model.npcs.size).toBe(0);
  });
  it("replaces bootstrap state instead of retaining old entities", () => {
    const model = applyBootstrap(bootstrap());
    const next = applyBootstrap({
      ...bootstrap("library", "9"),
      buildings: [],
      npcs: [],
      properties: [],
      businesses: [],
    });
    expect(model.buildings.has("b1")).toBe(true);
    expect(next.scene?.id).toBe("library");
    expect(next.buildings.size).toBe(0);
    expect(next.sequence).toBe("9");
  });

  it("applies events once and in sequence order, including large sequences", () => {
    let model = applyBootstrap(bootstrap("city-district", "9007199254740992"));
    const first = event("door.state_changed", "9007199254740993", { doorId: "d1", state: "open" }, "door");
    model = applyWorldEvent(model, first, "alice.testnet");
    expect(model.doors.get("d1")?.state).toBe("open");
    expect(applyWorldEvent(model, first, "alice.testnet")).toBe(model);
    expect(
      applyWorldEvent(
        model,
        event("door.state_changed", "9007199254740992", { doorId: "d1", state: "closed" }, "door"),
        "alice.testnet",
      ),
    ).toBe(model);
  });

  it("ignores wrong scene and stream events", () => {
    const model = applyBootstrap(bootstrap());
    const wrongScene = event("door.state_changed", "1", { doorId: "d1", state: "open" }, "door", "library");
    const wrongStream = { ...wrongScene, sceneId: "city-district" };
    expect(applyWorldEvent(model, wrongScene, "alice.testnet")).toBe(model);
    expect(applyWorldEvent(model, wrongStream, "alice.testnet")).toBe(model);
  });

  it("invalidates local scene state until the authoritative bootstrap arrives", () => {
    const model = applyBootstrap(bootstrap());
    const next = applyWorldEvent(
      model,
      event("player.scene_changed", "1", {
        accountId: "alice.testnet",
        x: 8,
        y: 9,
        facing: "north",
        sceneId: "library",
      }),
      "alice.testnet",
    );
    expect(next.scene).toBeNull();
    expect(next.player).toBeNull();
    expect(next.sequence).toBe("0");
    expect(next.sceneTransitioning).toBe(true);
    expect(next.npcs.size).toBe(0);
    expect(next.buildings.size).toBe(0);
    expect(next.properties.size).toBe(0);
    expect(
      applyWorldEvent(next, event("door.state_changed", "2", { doorId: "d2", state: "open" }, "door")),
    ).toBe(next);
  });

  it("updates checkpoint, door, business, property, and npc state", () => {
    let model = applyBootstrap(bootstrap());
    model = applyWorldEvent(
      model,
      event("player.checkpoint", "1", {
        accountId: "alice.testnet",
        x: 4,
        y: 5,
        facing: "east",
        sceneId: "city-district",
      }),
      "alice.testnet",
    );
    model = applyWorldEvent(
      model,
      event(
        "business.state_changed",
        "2",
        { businessId: "biz", status: "open", revenueTotal: "1" },
        "business",
      ),
      "alice.testnet",
    );
    model = applyWorldEvent(
      model,
      event(
        "property.presentation_changed",
        "3",
        { propertyId: "p1", forSale: true, price: "99" },
        "property",
      ),
      "alice.testnet",
    );
    model = applyWorldEvent(
      model,
      event(
        "npc.activity_changed",
        "4",
        { activity: "working", stateVersion: "2" },
        "npc",
        "city-district",
        "n1",
      ),
      "alice.testnet",
    );
    model = applyWorldEvent(
      model,
      event("door.state_changed", "5", { doorId: "d1", state: "closed" }, "door"),
      "alice.testnet",
    );
    expect(model.player).toMatchObject({ x: 4, y: 5 });
    expect(model.businesses.get("biz")?.status).toBe("open");
    expect(model.properties.get("p1")).toMatchObject({ forSale: true, price: "99" });
    expect(model.npcs.get("n1")?.activity).toBe("working");
    expect(model.doors.get("d1")?.state).toBe("closed");
  });
});

it("updates funded NPC job indicators without changing movement state and ignores replay", () => {
  const model = applyBootstrap(bootstrap());
  model.npcs.set("professor-kofi", {
    npcId: "professor-kofi",
    sceneId: "city-district",
    x: 6,
    y: 8,
    activity: "research",
    targetX: null,
    targetY: null,
    stateVersion: "2",
    hasJob: true,
  });
  const event: WorldEventType = {
    ...stamp,
    type: "job.presentation_changed",
    eventId: "job-accepted",
    streamId: "scene:city-district",
    sequence: "1",
    sceneId: "city-district",
    entity: { entityType: "job", entityId: "job-1" },
    payload: {
      jobId: "job-1",
      status: "accepted",
      txHash: null,
      npcId: "professor-kofi",
      hasOpenJobs: false,
    },
  };
  const next = applyWorldEvent(model, event);
  expect(next.npcs.get("professor-kofi")).toMatchObject({ hasJob: false, x: 6, y: 8, stateVersion: "2" });
  expect(applyWorldEvent(next, event)).toBe(next);
});
