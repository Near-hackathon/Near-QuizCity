import type { WorldBootstrapType, WorldEventType } from "@quiz-city/protocol";
import type { GameSettings } from "../types/game";
import type { WorldStatus } from "../../state/world-transport";

export type ReactToGame =
  | { type: "activateInteraction" }
  | { type: "bootstrap"; bootstrap: WorldBootstrapType }
  | { type: "worldEvent"; event: WorldEventType }
  | { type: "transportStatus"; status: WorldStatus }
  | { type: "commandResult"; requestId: string; accepted: boolean }
  | { type: "settingsChanged"; settings: Partial<GameSettings> }
  | { type: "dispose" };
export type GameToReact =
  | { type: "gameReady" }
  | { type: "transitionStatus"; pending: boolean }
  | { type: "moveIntent"; requestId: string; x: number; y: number }
  | {
      type: "interactIntent";
      requestId: string;
      targetType: "building" | "door" | "npc" | "business";
      targetId: string;
    }
  | {
      type: "interactionCandidateChanged";
      targetId: string | null;
      kind?: string;
      label?: string;
      available?: boolean;
    }
  | { type: "interactionCompleted"; targetId: string; kind: string }
  | { type: "sceneRendered"; sceneId: string }
  | { type: "metrics"; fps: number; entities?: number; corrections?: number }
  | { type: "fatalError"; message: string };
