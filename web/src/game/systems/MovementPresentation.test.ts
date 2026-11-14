import { expect, it } from "vitest";
import { advanceVisualPosition } from "./MovementPresentation";

it("covers one diagonal tile in the server step time at different frame rates", () => {
  for (const frames of [4, 8, 15, 30, 60]) {
    let point = { x: 32, y: 24 };
    for (let i = 0; i < frames; i++)
      point = advanceVisualPosition(point, { x: 33, y: 25 }, 250 / frames, 250);
    expect(point.x).toBeCloseTo(33, 8);
    expect(point.y).toBeCloseTo(25, 8);
  }
});
it("holds without elapsed time and snaps large authoritative corrections", () => {
  expect(advanceVisualPosition({ x: 0, y: 0 }, { x: 1, y: 1 }, 0, 250)).toEqual({ x: 0, y: 0 });
  expect(advanceVisualPosition({ x: 0, y: 0 }, { x: 10, y: 10 }, 16, 250)).toEqual({ x: 10, y: 10 });
});
