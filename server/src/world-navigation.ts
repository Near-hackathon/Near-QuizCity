import {
  findPath,
  isBlocked,
  validateWorldScenes,
  worldScenes,
  type WorldScene,
} from "@quiz-city/world-data";
import { AppError } from "./errors.js";

const scenes = new Map(worldScenes.map((scene) => [scene.id, scene]));
const validation = [
  ...validateWorldScenes(worldScenes),
  ...worldScenes
    .filter((scene) => !/^(0|[1-9]\d{0,18})$/.test(scene.assetVersion))
    .map((scene) => `${scene.id}: asset version must fit the persisted numeric scene version`),
];
if (validation.length > 0) {
  throw new Error(`invalid world data: ${validation.join("; ")}`);
}

export function sceneById(sceneId: string): WorldScene {
  const scene = scenes.get(sceneId);
  if (!scene) throw new AppError("NOT_FOUND", "scene not found", 404);
  return scene;
}

export type PlannedMove = { path: { x: number; y: number }[] };

/** Movement commands carry a destination tile only; pathing starts from the authoritative position. */
export function planMove(
  sceneId: string,
  start: { x: number; y: number },
  destination: { x: number; y: number },
): PlannedMove {
  const scene = sceneById(sceneId);
  if (!Number.isInteger(start.x) || !Number.isInteger(start.y) || isBlocked(scene, start.x, start.y)) {
    throw new AppError("CONFLICT", "authoritative position is invalid", 409);
  }
  const result = findPath(scene, start, destination);
  if ("error" in result) {
    throw new AppError(
      "VALIDATION_ERROR",
      result.error === "BLOCKED" ? "destination is blocked" : "no path to destination",
      400,
    );
  }
  return { path: result.path };
}

/** Advance at most `tiles` steps per server tick. */
export function advancePath(
  path: { x: number; y: number }[],
  tiles: number,
): { position: { x: number; y: number }; remaining: { x: number; y: number }[] } {
  if (!Number.isInteger(tiles) || tiles < 1) throw new Error("tiles must be a positive integer");
  if (path.length === 0) throw new Error("path is empty");
  // A planned path includes the authoritative starting tile at index zero, so
  // advancing one tile selects index one when a next tile exists.
  const index = Math.min(path.length - 1, tiles);
  return { position: path[index], remaining: path.slice(index + 1) };
}

export type InteractionReason = "OK" | "TARGET_NOT_FOUND" | "OUT_OF_RANGE" | "TARGET_CLOSED";

export function validateInteraction(
  sceneId: string,
  player: { x: number; y: number },
  targetId: string,
  targetType: "building" | "door" | "npc" | "business",
): { reason: InteractionReason; target?: { id: string; x: number; y: number; radius: number } } {
  const scene = sceneById(sceneId);
  const target = scene.interactions.find(
    (candidate) =>
      candidate.id === targetId &&
      (candidate.kind === targetType ||
        (targetType === "door" && candidate.kind === "door") ||
        (targetType === "business" && candidate.kind === "business")),
  );
  if (!target) return { reason: "TARGET_NOT_FOUND" };
  const distance = Math.max(Math.abs(player.x - target.x), Math.abs(player.y - target.y));
  if (distance > target.radius) return { reason: "OUT_OF_RANGE" };
  return { reason: "OK", target };
}
