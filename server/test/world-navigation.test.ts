import assert from "node:assert/strict";
import test from "node:test";
import { advancePath, planMove, sceneById, validateInteraction } from "../src/world-navigation.js";
import { npcTravelDoor } from "../src/npc-travel.js";

test("NPC travel uses connected doors between interiors and rejects unavailable routes", () => {
  assert.equal(npcTravelDoor("apartment-interior", "library-interior").id, "apartment-spawn");
  assert.equal(npcTravelDoor("city-district", "quiz-centre-interior").id, "quiz-door-exterior");
  assert.equal(npcTravelDoor("library-interior", "cafe-interior").id, "library-spawn");
  assert.throws(() => npcTravelDoor("missing", "city-district"), /unavailable/);
  assert.throws(() => npcTravelDoor("library-interior", "missing"), /no connected/);
});

test("movement plans from authoritative position and rejects blocked destinations", () => {
  const plan = planMove("city-district", { x: 3, y: 3 }, { x: 10, y: 10 });
  assert.ok(plan.path.length > 1);
  assert.deepEqual(plan.path[0], { x: 3, y: 3 });
  assert.throws(() => planMove("city-district", { x: 3, y: 3 }, { x: 30, y: 20 }), /blocked/);
  assert.throws(() => planMove("missing", { x: 0, y: 0 }, { x: 1, y: 1 }), /scene not found/);
});

test("server ticks advance only a bounded number of tiles", () => {
  const path = [
    { x: 1, y: 1 },
    { x: 1, y: 2 },
    { x: 1, y: 3 },
    { x: 1, y: 4 },
  ];
  assert.deepEqual(advancePath(path, 2), {
    position: { x: 1, y: 3 },
    remaining: [{ x: 1, y: 4 }],
  });
  assert.deepEqual(advancePath(path, 1), {
    position: { x: 1, y: 2 },
    remaining: [
      { x: 1, y: 3 },
      { x: 1, y: 4 },
    ],
  });
  assert.deepEqual(advancePath(path, 99), { position: { x: 1, y: 4 }, remaining: [] });
  assert.throws(() => advancePath(path, 0), /positive integer/);
});

test("interactions enforce scene proximity and target existence", () => {
  assert.equal(
    validateInteraction("city-district", { x: 20, y: 10 }, "library-door-exterior", "door").reason,
    "OK",
  );
  assert.equal(
    validateInteraction("city-district", { x: 1, y: 1 }, "library-door-exterior", "door").reason,
    "OUT_OF_RANGE",
  );
  assert.equal(
    validateInteraction("city-district", { x: 20, y: 10 }, "missing", "door").reason,
    "TARGET_NOT_FOUND",
  );
  assert.equal(
    validateInteraction("city-district", { x: 20, y: 10 }, "library-door-exterior", "npc").reason,
    "TARGET_NOT_FOUND",
  );
});

test("scene data is versioned and available to the server", () => {
  assert.equal(sceneById("library-interior").assetVersion, "4");
});
