import { afterEach, expect, it, vi } from "vitest";
import { loadPreferences } from "./settings";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("honors the operating system until a valid saved preference overrides it", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  expect(loadPreferences().reducedMotion).toBe(true);
  localStorage.setItem(
    "quizcity.game-settings.v1",
    JSON.stringify({ reducedMotion: false, zoom: 3, interactKey: "Space", volume: 40 }),
  );
  expect(loadPreferences()).toEqual({ reducedMotion: false, zoom: 3, interactKey: "Space", volume: 40 });
});
it("recovers from malformed or unavailable storage and validates each stored control", () => {
  localStorage.setItem("quizcity.game-settings.v1", "broken");
  expect(loadPreferences().zoom).toBe(2);
  localStorage.setItem(
    "quizcity.game-settings.v1",
    JSON.stringify({ reducedMotion: "yes", zoom: 1000, interactKey: "Escape", volume: "loud" }),
  );
  expect(loadPreferences()).toMatchObject({ zoom: 2, interactKey: "KeyE", volume: 0 });
  for (const [volume, expected] of [
    [-1, 0],
    [101, 100],
  ]) {
    localStorage.setItem("quizcity.game-settings.v1", JSON.stringify({ volume }));
    expect(loadPreferences().volume).toBe(expected);
  }
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  expect(loadPreferences().zoom).toBe(2);
});
