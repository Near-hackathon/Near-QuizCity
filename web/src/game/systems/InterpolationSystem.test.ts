import { expect, it } from "vitest";
import { InterpolationBuffer } from "./InterpolationSystem";
it("interpolates ordered samples, ignores duplicates, holds and snaps teleports", () => {
  const buffer = new InterpolationBuffer();
  expect(buffer.position(0)).toBeNull();
  buffer.push({ x: 0, y: 0, time: 0, sequence: "1" });
  buffer.push({ x: 1, y: 0, time: 100, sequence: "2" });
  buffer.push({ x: 99, y: 0, time: 120, sequence: "1" });
  expect(buffer.position(150)).toEqual({ x: 0.5, y: 0 });
  expect(buffer.position(1000)).toMatchObject({ x: 1, y: 0 });
  buffer.push({ x: 30, y: 30, time: 1000, sequence: "3" });
  expect(buffer.position(1000)).toMatchObject({ x: 30, y: 30 });
});
