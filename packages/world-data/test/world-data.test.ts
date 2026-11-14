import assert from "node:assert/strict";
import test from "node:test";
import { findPath, isBlocked, validateWorldScenes, worldScenes, facingForStep } from "../src/index.js";

test("authoritative facing uses screen directions for all eight movement vectors", () => {
  for (const [x, y, facing] of [
    [-1, -1, "north"],
    [1, -1, "east"],
    [1, 1, "south"],
    [-1, 1, "west"],
    [1, 0, "south_east"],
    [0, 1, "south_west"],
    [-1, 0, "north_west"],
    [0, -1, "north_east"],
  ] as const)
    assert.equal(facingForStep(x, y), facing);
});

test("MVP scenes validate with reciprocal doors and in-bounds zones", () => {
  assert.deepEqual(validateWorldScenes(worldScenes), []);
  for (const scene of worldScenes)
    for (const prop of scene.props ?? []) {
      for (let x = prop.x; x < prop.x + prop.width; x++)
        for (let y = prop.y; y < prop.y + prop.height; y++) assert.equal(isBlocked(scene, x, y), true);
    }
});

test("furnished rooms preserve routes between every doorway, player spawn and NPC destination", () => {
  for (const scene of worldScenes.filter((item) => item.id !== "city-district")) {
    const start = scene.spawns.find((point) => point.kind === "player_default")!;
    for (const destination of [...scene.spawns, ...scene.interactions]) {
      const route = findPath(scene, start, destination);
      assert.ok("path" in route, `${scene.id}: ${destination.id} must remain reachable`);
    }
    const cells = new Set<string>();
    for (const prop of scene.props ?? []) {
      for (let x = prop.x; x < prop.x + prop.width; x++)
        for (let y = prop.y; y < prop.y + prop.height; y++) {
          assert.ok(!cells.has(`${x},${y}`), `${scene.id}: furniture footprints overlap`);
          cells.add(`${x},${y}`);
        }
    }
  }
});

test("validator rejects missing reciprocal doors and blocked spawns", () => {
  const broken = structuredClone(worldScenes);
  broken[0].doors = broken[0].doors.filter((door) => door.id !== "library-door-exterior");
  assert.ok(validateWorldScenes(broken).some((error) => /reciprocal|targets missing/.test(error)));

  const blocked = structuredClone(worldScenes);
  blocked[1].spawns[0].x = 4;
  blocked[1].spawns[0].y = 4;
  assert.ok(validateWorldScenes([{ ...blocked[1] }]).some((error) => /spawn is blocked/.test(error)));
  assert.equal(isBlocked(blocked[1], 4, 4), true);
});

test("validator rejects duplicate zones, blocked doors, and fractional radii", () => {
  const duplicate = structuredClone(worldScenes);
  duplicate[0].interactions.push({ ...duplicate[0].interactions[0] });
  assert.ok(validateWorldScenes(duplicate).some((error) => /duplicate interaction/.test(error)));

  const invalidDoor = structuredClone(worldScenes);
  invalidDoor[1].doors[0].x = 4;
  invalidDoor[1].doors[0].y = 4;
  invalidDoor[1].doors[0].radius = 1.5;
  const errors = validateWorldScenes(invalidDoor);
  assert.ok(errors.some((error) => /door is blocked/.test(error)));
  assert.ok(errors.some((error) => /invalid door radius/.test(error)));
});

test("A* is deterministic, handles same tile, blocked targets, and boundaries", () => {
  const scene = worldScenes[0];
  assert.deepEqual(findPath(scene, { x: 3, y: 3 }, { x: 3, y: 3 }), { path: [{ x: 3, y: 3 }] });
  assert.deepEqual(findPath(scene, { x: 3, y: 3 }, { x: 30, y: 20 }), { error: "BLOCKED" });
  assert.deepEqual(findPath(scene, { x: 3, y: 3 }, { x: -1, y: 3 }), { error: "BLOCKED" });

  const first = findPath(scene, { x: 3, y: 3 }, { x: 10, y: 10 });
  const second = findPath(scene, { x: 3, y: 3 }, { x: 10, y: 10 });
  assert.deepEqual(first, second);
  assert.ok("path" in first);
  assert.deepEqual(first.path[0], { x: 3, y: 3 });
  assert.deepEqual(first.path[first.path.length - 1], { x: 10, y: 10 });
});

test("A* reports no path across a sealed wall", () => {
  const sealed = {
    ...worldScenes[1],
    blocked: [...worldScenes[1].blocked, { x: 0, y: 8, width: 24, height: 1 }],
    spawns: [
      { id: "a", kind: "player_default" as const, x: 3, y: 3 },
      { id: "b", kind: "player_default" as const, x: 3, y: 12 },
    ],
    doors: [],
    interactions: [],
  };
  assert.deepEqual(findPath(sealed, { x: 3, y: 3 }, { x: 3, y: 12 }), { error: "NO_PATH" });
});

test("diagonal paths stay straight and never cut a blocked corner", () => {
  const scene = { ...worldScenes[0], width: 12, height: 12, blocked: [] };
  for (const [dx, dy] of [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const result = findPath(scene, { x: 5, y: 5 }, { x: 5 + dx * 3, y: 5 + dy * 3 });
    assert.deepEqual(result, {
      path: Array.from({ length: 4 }, (_, i) => ({ x: 5 + dx * i, y: 5 + dy * i })),
    });
  }
  for (const blocked of [[{ x: 6, y: 5, width: 1, height: 1 }], [{ x: 5, y: 6, width: 1, height: 1 }]]) {
    const result = findPath({ ...scene, blocked }, { x: 5, y: 5 }, { x: 6, y: 6 });
    assert.ok("path" in result);
    assert.ok(result.path.length > 2);
    for (let i = 1; i < result.path.length; i++) {
      const a: { x: number; y: number } = result.path[i - 1];
      const b: { x: number; y: number } = result.path[i];
      if (a.x !== b.x && a.y !== b.y) {
        assert.equal(isBlocked({ ...scene, blocked }, b.x, a.y), false);
        assert.equal(isBlocked({ ...scene, blocked }, a.x, b.y), false);
      }
    }
  }
});

test("quiz centre keeps just two side desks and a five-tile-wide clear approach to Max", () => {
  const scene = worldScenes.find((s) => s.id === "quiz-centre-interior")!;
  assert.equal(scene.assetVersion, "5");
  assert.equal(scene.props!.filter((p) => p.kind === "desk").length, 2);
  const max = scene.spawns.find((s) => s.id === "yaw-quiz-desk")!;
  assert.deepEqual({ x: max.x, y: max.y }, { x: 10, y: 4 });
  for (let x = 8; x <= 12; x++)
    for (let y = 4; y <= 14; y++) assert.equal(isBlocked(scene, x, y), false, `Aisle blocked at ${x},${y}`);
  const start = scene.spawns.find((s) => s.id === "quiz-spawn")!;
  const route = findPath(scene, start, max);
  assert.ok("path" in route);
  assert.deepEqual(
    route.path.map(({ x, y }) => ({ x, y })),
    Array.from({ length: 11 }, (_, i) => ({ x: 10, y: 14 - i })),
  );
});
