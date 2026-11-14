import { expect, it, vi } from "vitest";
import { createGameBridge } from "../bridge/GameBridge";
import { GameRuntime } from "./GameRuntime";
import { playerCheckpoint, worldBootstrap } from "../../test/world-fixtures";

it("clicking an entrance walks to its circle, waits for confirmation and enters exactly once", () => {
  const bridge = createGameBridge(),
    runtime = new GameRuntime(bridge),
    messages = vi.fn();
  bridge.subscribe(messages);
  const bootstrap = worldBootstrap();
  bootstrap.player.x = 20;
  bootstrap.player.y = 10;
  bootstrap.interactionZones = [{ id: "library-door-exterior", kind: "door", x: 20, y: 10, radius: 2 }];
  bridge.send({ type: "bootstrap", bootstrap });
  bridge.send({ type: "settingsChanged", settings: { online: true } });
  bridge.send({ type: "transportStatus", status: "online" });
  expect(runtime.enterDoor("library-door-exterior", 1000)).toBe(true);
  expect(messages.mock.calls.flat().filter((item) => item.type === "interactIntent")).toHaveLength(0);
  bridge.send({ type: "commandResult", requestId: "move-1", accepted: true });
  runtime.tick(1100);
  expect(messages.mock.calls.flat().filter((item) => item.type === "interactIntent")).toHaveLength(0);
  const event = playerCheckpoint();
  event.payload = { ...event.payload, x: 22, y: 10 };
  bridge.send({ type: "worldEvent", event });
  runtime.tick(1300);
  runtime.tick(1400);
  expect(messages.mock.calls.flat().filter((item) => item.type === "interactIntent")).toEqual([
    {
      type: "interactIntent",
      requestId: "interaction-2",
      targetId: "library-door-exterior",
      targetType: "door",
    },
  ]);
  runtime.dispose();
});

it("a cancelled entrance walk never triggers entry after later reaching the circle", () => {
  const bridge = createGameBridge(),
    runtime = new GameRuntime(bridge),
    messages = vi.fn();
  bridge.subscribe(messages);
  const bootstrap = worldBootstrap();
  bootstrap.player.x = 20;
  bootstrap.player.y = 10;
  bootstrap.interactionZones = [{ id: "library-door-exterior", kind: "door", x: 20, y: 10, radius: 2 }];
  bridge.send({ type: "bootstrap", bootstrap });
  bridge.send({ type: "settingsChanged", settings: { online: true } });
  bridge.send({ type: "transportStatus", status: "online" });
  expect(runtime.enterDoor("library-door-exterior", 1000)).toBe(true);
  runtime.move(19, 10, 1100, true);
  const event = playerCheckpoint();
  event.payload = { ...event.payload, x: 22, y: 10 };
  bridge.send({ type: "worldEvent", event });
  runtime.tick(1500);
  expect(messages.mock.calls.flat().filter((item) => item.type === "interactIntent")).toHaveLength(0);
  bridge.send({ type: "transportStatus", status: "offline" });
  expect(runtime.enterDoor("library-door-exterior", 2000)).toBe(false);
  runtime.dispose();
});

it("applies a bootstrap, deduplicates checkpoints and gates input on authoritative readiness", () => {
  const bridge = createGameBridge();
  bridge.send({
    type: "settingsChanged",
    settings: { online: true, hidden: false, transitioning: false, uiModalOpen: false, reducedMotion: true },
  });
  const runtime = new GameRuntime(bridge);
  expect(runtime.settings.reducedMotion).toBe(true);
  expect(runtime.canInput()).toBe(false);
  bridge.send({ type: "bootstrap", bootstrap: worldBootstrap() });
  bridge.send({ type: "transportStatus", status: "online" });
  expect(runtime.canInput()).toBe(true);
  const draw = vi.fn();
  runtime.subscribe(draw);
  bridge.send({ type: "worldEvent", event: playerCheckpoint() });
  expect(runtime.model.player?.x).toBe(33);
  bridge.send({ type: "worldEvent", event: playerCheckpoint() });
  expect(draw).toHaveBeenCalledTimes(2);
  bridge.send({ type: "transportStatus", status: "resyncing" });
  expect(runtime.canInput()).toBe(false);
  bridge.send({ type: "dispose" });
  bridge.send({ type: "bootstrap", bootstrap: worldBootstrap() });
  expect(runtime.model.scene).toBeNull();
});

it("rejects unknown scenes/versions and never renders them", () => {
  const bridge = createGameBridge();
  const runtime = new GameRuntime(bridge);
  const observer = vi.fn();
  bridge.subscribe(observer);
  bridge.send({ type: "bootstrap", bootstrap: worldBootstrap("grocery-interior") });
  expect(observer).toHaveBeenCalledWith(expect.objectContaining({ type: "fatalError" }));
  expect(runtime.model.scene).toBeNull();
  bridge.send({
    type: "bootstrap",
    bootstrap: { ...worldBootstrap(), scene: { ...worldBootstrap().scene, assetVersion: "999" } },
  });
  expect(observer).toHaveBeenCalledTimes(2);
  runtime.dispose();
});

it("bounds prediction, rejects collision, waits for checkpoints and handles command rejection", () => {
  const bridge = createGameBridge(),
    runtime = new GameRuntime(bridge),
    sent = vi.fn();
  bridge.subscribe(sent);
  bridge.send({ type: "bootstrap", bootstrap: worldBootstrap() });
  bridge.send({ type: "settingsChanged", settings: { online: true } });
  bridge.send({ type: "transportStatus", status: "online" });
  expect(runtime.move(30, 20, 1000)).toBe(false);
  expect(runtime.move(33, 24, 1000)).toBe(true);
  expect(runtime.model.player?.x).toBe(32);
  expect(runtime.predicted?.x).toBe(33);
  expect(runtime.move(34, 24, 1100)).toBe(false);
  bridge.send({ type: "commandResult", requestId: "move-1", accepted: true });
  expect(runtime.move(34, 24, 1200)).toBe(false);
  bridge.send({ type: "worldEvent", event: playerCheckpoint() });
  expect(runtime.move(34, 24, 1300)).toBe(true);
  bridge.send({ type: "commandResult", requestId: "move-2", accepted: false });
  expect(runtime.predicted).toBeNull();
  expect(runtime.corrections).toBe(1);
  runtime.dispose();
});

it("serializes door interactions and pauses commands while a modal owns focus", () => {
  const bridge = createGameBridge(),
    runtime = new GameRuntime(bridge);
  const bootstrap = worldBootstrap();
  bootstrap.player.x = 20;
  bootstrap.player.y = 10;
  bootstrap.interactionZones = [{ id: "library-door-exterior", kind: "door", x: 20, y: 10, radius: 2 }];
  bridge.send({ type: "bootstrap", bootstrap });
  bridge.send({ type: "settingsChanged", settings: { online: true, uiModalOpen: true } });
  bridge.send({ type: "transportStatus", status: "online" });
  expect(runtime.interact(0)).toBe(false);
  bridge.send({ type: "settingsChanged", settings: { uiModalOpen: false } });
  expect(runtime.interact(0)).toBe(true);
  expect(runtime.interact(100)).toBe(false);
  bridge.send({ type: "commandResult", requestId: "interaction-1", accepted: true });
  expect(runtime.canInput()).toBe(false);
  runtime.tick(11_000);
  expect(runtime.canInput()).toBe(true);
  runtime.dispose();
});

it("shows closed door hours and unlocks the same prompt at opening time", () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const bridge = createGameBridge(),
    runtime = new GameRuntime(bridge),
    events = vi.fn();
  bridge.subscribe(events);
  const bootstrap = worldBootstrap();
  bootstrap.serverTime = "2026-11-13T07:59:59Z";
  bootstrap.player.x = 20;
  bootstrap.player.y = 10;
  bootstrap.interactionZones = [{ id: "library-door-exterior", kind: "door", x: 20, y: 10, radius: 2 }];
  bootstrap.buildings = [
    {
      id: "building-library",
      displayName: "Library",
      buildingType: "library",
      entranceX: 20,
      entranceY: 10,
      entranceFacing: "north",
      status: "active",
      doorId: "library-door-exterior",
      isOpen: false,
      openingHours: { open: "08:00", close: "20:00" },
    },
  ];
  bridge.send({ type: "bootstrap", bootstrap });
  bridge.send({ type: "settingsChanged", settings: { online: true } });
  bridge.send({ type: "transportStatus", status: "online" });
  runtime.tick(0);
  expect(events).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "interactionCandidateChanged",
      available: false,
      label: "Library · 08:00–20:00 (Accra)",
    }),
  );
  expect(runtime.interact(0)).toBe(false);
  expect(runtime.enterDoor("library-door-exterior", 0)).toBe(false);
  runtime.tick(1000);
  expect(events).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "interactionCandidateChanged", available: true }),
  );
  expect(runtime.interact(1000)).toBe(true);
  runtime.dispose();
  clock.mockRestore();
});

it("keyboard movement stops at blocked corners while clicks can route around them", () => {
  const bridge = createGameBridge(),
    runtime = new GameRuntime(bridge);
  const bootstrap = worldBootstrap();
  bootstrap.player.x = 16;
  bootstrap.player.y = 9;
  bridge.send({ type: "bootstrap", bootstrap });
  bridge.send({ type: "settingsChanged", settings: { online: true } });
  bridge.send({ type: "transportStatus", status: "online" });
  expect(runtime.move(17, 10, 1000, true)).toBe(false);
  expect(runtime.model.player).toMatchObject({ x: 16, y: 9 });
  expect(runtime.move(17, 10, 1000)).toBe(true);
  runtime.dispose();
});

it("continues a multi-tile prediction between checkpoints without resending the path", () => {
  const bridge = createGameBridge(),
    runtime = new GameRuntime(bridge),
    sent = vi.fn();
  bridge.subscribe(sent);
  const bootstrap = worldBootstrap();
  bootstrap.movement = { stepMs: 250, tilesPerTick: 1 };
  bridge.send({ type: "bootstrap", bootstrap });
  bridge.send({ type: "settingsChanged", settings: { online: true } });
  bridge.send({ type: "transportStatus", status: "online" });
  expect(runtime.move(35, 24, 1000)).toBe(true);
  bridge.send({ type: "commandResult", requestId: "move-1", accepted: true });
  for (const [sequence, x, nextX] of [
    ["1", 33, 34],
    ["2", 34, 35],
  ] as const) {
    const event = playerCheckpoint(sequence);
    if (event.type !== "player.checkpoint") throw new Error("fixture mismatch");
    event.payload.x = x;
    bridge.send({ type: "worldEvent", event });
    expect(runtime.model.player?.x).toBe(x);
    expect(runtime.predicted).toEqual({ x: nextX, y: 24 });
    expect(runtime.move(36, 24, 2000)).toBe(false);
  }
  const final = playerCheckpoint("3");
  if (final.type !== "player.checkpoint") throw new Error("fixture mismatch");
  final.payload.x = 35;
  bridge.send({ type: "worldEvent", event: final });
  expect(runtime.predicted).toBeNull();
  expect(sent.mock.calls.filter(([message]) => message.type === "moveIntent")).toHaveLength(1);
  expect(runtime.move(36, 24, 2000)).toBe(true);
  runtime.dispose();
});

it("uses server timing and does not expire a legitimately long walk after ten seconds", () => {
  const bridge = createGameBridge(),
    runtime = new GameRuntime(bridge);
  const bootstrap = worldBootstrap();
  bootstrap.movement = { stepMs: 6000, tilesPerTick: 1 };
  bridge.send({ type: "bootstrap", bootstrap });
  bridge.send({ type: "settingsChanged", settings: { online: true } });
  bridge.send({ type: "transportStatus", status: "online" });
  expect(runtime.movementStepMs).toBe(6000);
  expect(runtime.move(35, 24, 0)).toBe(true);
  runtime.tick(11000);
  expect(runtime.predicted).toEqual({ x: 33, y: 24 });
  bridge.send({ type: "transportStatus", status: "offline" });
  expect(runtime.predicted).toBeNull();
  expect(runtime.canInput()).toBe(false);
  runtime.dispose();
});

it("recovers expired movement and rejected interactions without applying economic state", () => {
  const bridge = createGameBridge(),
    runtime = new GameRuntime(bridge),
    events = vi.fn();
  bridge.subscribe(events);
  const bootstrap = worldBootstrap();
  bootstrap.interactionZones = [{ id: "professor-kofi", kind: "npc", x: 32, y: 24, radius: 2 }];
  bootstrap.npcs = [
    {
      npcId: "professor-kofi",
      sceneId: "city-district",
      x: 32,
      y: 24,
      activity: "idle",
      targetX: null,
      targetY: null,
      stateVersion: "1",
    },
  ];
  bridge.send({ type: "bootstrap", bootstrap });
  bridge.send({ type: "settingsChanged", settings: { online: true } });
  bridge.send({ type: "transportStatus", status: "online" });
  runtime.tick(0);
  expect(events).toHaveBeenCalledWith(
    expect.objectContaining({ type: "interactionCandidateChanged", targetId: "professor-kofi" }),
  );
  bridge.send({ type: "activateInteraction" });
  bridge.send({ type: "commandResult", requestId: "interaction-1", accepted: false });
  expect(runtime.canInput()).toBe(true);
  expect(events.mock.calls.some(([event]) => event.type === "interactionCompleted")).toBe(false);
  expect(runtime.move(33, 24, 100)).toBe(true);
  runtime.tick(10_101);
  expect(runtime.predicted).toBeNull();
  expect(runtime.model.player?.x).toBe(32);
  expect(runtime.move(33, 24, 10_102)).toBe(true);
  bridge.send({ type: "bootstrap", bootstrap });
  expect(runtime.generation).toBe(2);
  expect(runtime.predicted).toBeNull();
  runtime.dispose();
});
