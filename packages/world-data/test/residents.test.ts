import assert from "node:assert/strict";
import test from "node:test";
import {
  residentProfiles,
  residentProfile,
  residentRoutines,
  worldScenes,
  isBlocked,
  findPath,
} from "../src/index.js";

test("starter residents have unique identities and complete, reachable daily routines", () => {
  assert.equal(residentProfiles.length, 6);
  assert.equal(new Set(residentProfiles.map((profile) => profile.id)).size, 6);
  assert.equal(residentProfile("librarian-ama")?.name, "Emma");
  assert.equal(residentProfile("quiz-attendant-yaw")?.action, "quiz");
  assert.equal(residentProfile("unknown-resident"), undefined);
  assert.equal(Object.keys(residentRoutines).length, 5);
  for (const [id, routine] of Object.entries(residentRoutines)) {
    assert.ok(residentProfiles.some((profile) => profile.id === id));
    assert.equal(routine[0].start, 0);
    assert.equal(routine.at(-1)!.end, 1440);
    for (const [index, stop] of routine.entries()) {
      assert.ok(stop.start < stop.end);
      if (index) assert.equal(routine[index - 1].end, stop.start, `${id}: no gaps or overlaps`);
      const scene = worldScenes.find((scene) => scene.id === stop.scene)!;
      const destination = scene.spawns.find((point) => point.id === stop.spawn)!;
      assert.ok(destination);
      assert.notEqual(stop.scene, "apartment-interior", `${id} must not visit the professor's home`);
      for (const waypoint of stop.patrol ?? []) {
        const point = scene.spawns.find((spawn) => spawn.id === waypoint)!;
        assert.ok(point);
        assert.equal(isBlocked(scene, point.x, point.y), false);
        assert.ok("path" in findPath(scene, destination, point));
      }
      assert.equal(isBlocked(scene, destination.x, destination.y), false);
      assert.ok(
        "path" in
          findPath(
            scene,
            scene.spawns.find((point) => point.kind === "player_default")!,
            destination,
          ),
      );
    }
  }
});

test("professor apartment is a single furnished home with reachable entry and study", () => {
  const home = worldScenes.find((scene) => scene.id === "apartment-interior")!;
  assert.equal(home.width, 18);
  assert.equal(home.height, 14);
  assert.equal(home.props!.filter((prop) => prop.kind === "bed").length, 1);
  assert.deepEqual(
    home.spawns.filter((point) => point.kind === "npc_waypoint").map((point) => point.id),
    ["apartment-home"],
  );
  const entrance = home.spawns.find((point) => point.kind === "door")!;
  for (const point of home.spawns) assert.ok("path" in findPath(home, entrance, point));
});
