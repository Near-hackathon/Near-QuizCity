import { expect, it } from "vitest";
import { findPath, isBlocked, worldScenes } from "@quiz-city/world-data";
import { entranceMarker } from "./visual-slice";

it("every entry circle is reachable and inside the authoritative door radius", () => {
  for (const scene of worldScenes) {
    const spawn = scene.spawns.find((point) => point.kind === "player_default")!;
    for (const door of scene.doors) {
      const circle = entranceMarker(door);
      expect(isBlocked(scene, circle.x, circle.y), door.id).toBe(false);
      expect(Math.max(Math.abs(circle.x - door.x), Math.abs(circle.y - door.y)), door.id).toBeLessThanOrEqual(
        door.radius,
      );
      expect(findPath(scene, spawn, circle), door.id).toHaveProperty("path");
    }
  }
});
