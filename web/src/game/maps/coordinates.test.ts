import { expect, it } from "vitest";
import { toScreen, toGrid, sceneBounds, directionForDelta } from "./coordinates";
it("round-trips tile centres including negative screen offsets", () => {
  for (const [x, y] of [
    [0, 0],
    [63, 47],
    [1, 40],
    [32, 24],
  ]) {
    const point = toScreen(x, y);
    expect(toGrid(point.x, point.y)).toEqual({ x, y });
  }
  expect(sceneBounds(64, 48).width).toBeGreaterThan(64 * 16);
});
it("faces the screen direction of isometric movement", () => {
  for (const [x, y, direction] of [
    [-1, -1, "n"],
    [1, -1, "e"],
    [1, 1, "s"],
    [-1, 1, "w"],
    [1, 0, "se"],
    [0, 1, "sw"],
    [-1, 0, "nw"],
    [0, -1, "ne"],
  ] as const)
    expect(directionForDelta(x, y)).toBe(direction);
  expect(directionForDelta(0, 0)).toBeNull();
  expect(directionForDelta(-1, -1 + Number.EPSILON)).toBe("n");
});
