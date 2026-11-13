import assert from "node:assert/strict";
import test from "node:test";
import { findPath, isBlocked, validateWorldScenes, worldScenes } from "../src/index.js";

test("MVP scenes validate with reciprocal doors and in-bounds zones", () => {
  assert.deepEqual(validateWorldScenes(worldScenes), []);
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
