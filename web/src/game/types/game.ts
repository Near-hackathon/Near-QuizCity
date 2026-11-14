import type { WorldBootstrapType, WorldEventType } from "@quiz-city/protocol";

export const CITY_DISTRICT_SCENE_ID = "city-district";

export type WorldViewModel = {
  scene: WorldBootstrapType["scene"] | null;
  player: WorldBootstrapType["player"] | null;
  players: Map<string, WorldBootstrapType["players"][number]>;
  npcs: Map<string, WorldBootstrapType["npcs"][number]>;
  pendingNpcActivity: Map<string, { activity: string; stateVersion: string }>;
  buildings: Map<string, WorldBootstrapType["buildings"][number]>;
  interactionZones: WorldBootstrapType["interactionZones"];
  spawns: WorldBootstrapType["spawns"];
  doors: Map<string, { state: "open" | "closed" }>;
  businesses: Map<string, WorldBootstrapType["businesses"][number]>;
  properties: Map<string, WorldBootstrapType["properties"][number]>;
  sequence: string;
  sceneTransitioning: boolean;
};

export type GameSettings = {
  reducedMotion: boolean;
  uiModalOpen: boolean;
  online: boolean;
  transitioning: boolean;
  hidden: boolean;
  zoom?: number;
  interactKey?: string;
};
export type Facing = WorldBootstrapType["player"]["facing"];
export type GameEvent = WorldEventType;

export function emptyWorldViewModel(): WorldViewModel {
  return {
    scene: null,
    player: null,
    players: new Map(),
    npcs: new Map(),
    pendingNpcActivity: new Map(),
    buildings: new Map(),
    interactionZones: [],
    spawns: [],
    doors: new Map(),
    businesses: new Map(),
    properties: new Map(),
    sequence: "0",
    sceneTransitioning: false,
  };
}
