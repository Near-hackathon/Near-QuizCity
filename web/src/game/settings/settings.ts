export type Preferences = { reducedMotion: boolean; zoom: number; interactKey: string; volume: number };
export function loadPreferences(): Preferences {
  const defaults = {
    reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    zoom: 2,
    interactKey: "KeyE",
    volume: 0,
  };
  try {
    const data = JSON.parse(localStorage.getItem("quizcity.game-settings.v1") ?? "null");
    if (!data) return defaults;
    return {
      reducedMotion: typeof data.reducedMotion === "boolean" ? data.reducedMotion : defaults.reducedMotion,
      zoom: [1, 2, 3].includes(data.zoom) ? data.zoom : 2,
      interactKey: ["KeyE", "Space"].includes(data.interactKey) ? data.interactKey : "KeyE",
      volume: typeof data.volume === "number" ? Math.max(0, Math.min(100, data.volume)) : 0,
    };
  } catch {
    return defaults;
  }
}
