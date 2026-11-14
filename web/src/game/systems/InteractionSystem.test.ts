import { describe, expect, it } from "vitest";
import { findInteractionCandidate } from "./InteractionSystem";

describe("InteractionSystem", () => {
  it("returns null outside radius and nearest candidate inside it", () => {
    const zones = [
      { id: "far", kind: "npc", x: 4, y: 0, radius: 5 },
      { id: "near", kind: "door", x: 1, y: 0, radius: 2 },
    ];
    expect(findInteractionCandidate(20, 20, zones)).toBeNull();
    expect(findInteractionCandidate(0, 0, zones)?.id).toBe("near");
  });

  it("includes an exact radius boundary and preserves deterministic ties", () => {
    const zones = [
      { id: "first", kind: "building", x: 1, y: 0, radius: 1 },
      { id: "second", kind: "building", x: -1, y: 0, radius: 1 },
    ];
    expect(findInteractionCandidate(0, 0, zones)?.id).toBe("first");
  });
});
