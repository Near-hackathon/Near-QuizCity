import { describe, expect, it } from "vitest";
import { canSampleInput, inputDirection } from "./InputSystem";

describe("InputSystem helpers", () => {
  it("gates sampling while hidden, offline, modal, or transitioning", () => {
    const base = { hidden: false, online: true, uiModalOpen: false, transitioning: false };
    expect(canSampleInput(base)).toBe(true);
    expect(canSampleInput({ ...base, hidden: true })).toBe(false);
    expect(canSampleInput({ ...base, online: false })).toBe(false);
    expect(canSampleInput({ ...base, uiModalOpen: true })).toBe(false);
    expect(canSampleInput({ ...base, transitioning: true })).toBe(false);
  });

  it("normalizes direction and handles zero input", () => {
    expect(inputDirection(3, 4)).toEqual({ x: 0.6, y: 0.8 });
    expect(inputDirection(0, 0)).toEqual({ x: 0, y: 0 });
  });
});
