import test from "node:test";
import assert from "node:assert/strict";
import { createMaps, validateMaps } from "./phase7-map-lib.mjs";
test("map preparation is deterministic and server-linked", () => {
  assert.deepEqual(createMaps(), createMaps());
  assert.doesNotThrow(() => validateMaps(createMaps()));
  for (const map of createMaps()) {
    const ids = map.layers.flatMap((layer) => layer.objects.map((object) => object.id));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(Number.isInteger));
  }
});
test("map validator rejects dimensions, missing layers, duplicate scenes, collision gaps and forged links", () => {
  for (const mutate of [
    (maps) => {
      maps[0].width++;
    },
    (maps) => {
      maps[0].layers.pop();
    },
    (maps) => {
      maps[1] = maps[0];
    },
    (maps) => {
      maps[0].layers.find((item) => item.name === "collision").objects.pop();
    },
    (maps) => {
      maps[0].layers.find((item) => item.name === "interactions").objects[0].targetSceneId = "forged";
    },
  ]) {
    const maps = createMaps();
    mutate(maps);
    assert.throws(() => validateMaps(maps));
  }
});
