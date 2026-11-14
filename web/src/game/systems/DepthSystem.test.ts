import { describe, expect, it } from "vitest";
import { depthFor, entityDepth } from "./DepthSystem";

describe("DepthSystem", () => {
  it("is deterministic and applies the optional offset", () => {
    expect(depthFor(12)).toBe(1200);
    expect(depthFor(12, 3)).toBe(1203);
    expect(depthFor(1)).toBeLessThan(depthFor(2));
    expect(entityDepth(12, "alice")).not.toBe(entityDepth(12, "bob"));
    expect(entityDepth(12, "alice")).toBe(entityDepth(12, "alice"));
    expect(entityDepth(12, "alice")).toBeLessThan(entityDepth(13, "bob"));
  });
});
