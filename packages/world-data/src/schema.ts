export type BlockedRect = { x: number; y: number; width: number; height: number };
export type WorldPoint = { x: number; y: number };
export type WorldProp = WorldPoint & {
  id: string;
  kind:
    | "tree"
    | "lamp"
    | "bench"
    | "bookshelf"
    | "armchair"
    | "sofa"
    | "desk"
    | "chair"
    | "bed"
    | "counter"
    | "plant"
    | "fridge"
    | "stove";
  width: number;
  height: number;
};
export type WorldDoor = {
  id: string;
  x: number;
  y: number;
  radius: number;
  targetSceneId: string;
  targetSpawnId: string;
};
export type WorldInteraction = {
  id: string;
  kind: "npc" | "building" | "door" | "business" | "quiz";
  x: number;
  y: number;
  radius: number;
};
export type WorldSpawn = {
  id: string;
  kind: "player_default" | "door" | "npc_waypoint";
  x: number;
  y: number;
};
export type WorldScene = {
  id: string;
  assetVersion: string;
  width: number;
  height: number;
  tileSize: number;
  blocked: BlockedRect[];
  props?: WorldProp[];
  doors: WorldDoor[];
  interactions: WorldInteraction[];
  spawns: WorldSpawn[];
};

const ID = /^[a-z0-9_-]{1,64}$/;

export function validateWorldScenes(scenes: WorldScene[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  for (const scene of scenes) {
    if (!ID.test(scene.id)) errors.push(`invalid scene id ${scene.id}`);
    if (ids.has(scene.id)) errors.push(`duplicate scene id ${scene.id}`);
    ids.add(scene.id);
    if (!Number.isInteger(scene.width) || scene.width <= 0) errors.push(`${scene.id}: invalid width`);
    if (!Number.isInteger(scene.height) || scene.height <= 0) errors.push(`${scene.id}: invalid height`);
    if (!Number.isInteger(scene.tileSize) || scene.tileSize <= 0)
      errors.push(`${scene.id}: invalid tile size`);
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(scene.assetVersion)) {
      errors.push(`${scene.id}: invalid asset version`);
    }
    const inBounds = (p: WorldPoint) =>
      Number.isInteger(p.x) &&
      Number.isInteger(p.y) &&
      p.x >= 0 &&
      p.y >= 0 &&
      p.x < scene.width &&
      p.y < scene.height;
    for (const rect of scene.blocked) {
      if (
        !Number.isInteger(rect.x) ||
        !Number.isInteger(rect.y) ||
        !Number.isInteger(rect.width) ||
        !Number.isInteger(rect.height) ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.x + rect.width > scene.width ||
        rect.y + rect.height > scene.height
      ) {
        errors.push(`${scene.id}: invalid blocked rect`);
      }
    }
    const spawnIds = new Set<string>();
    for (const spawn of scene.spawns) {
      if (!ID.test(spawn.id)) errors.push(`${scene.id}: invalid spawn id ${spawn.id}`);
      if (spawnIds.has(spawn.id)) errors.push(`${scene.id}: duplicate spawn ${spawn.id}`);
      spawnIds.add(spawn.id);
      if (!inBounds(spawn)) errors.push(`${scene.id}: spawn out of bounds ${spawn.id}`);
      else if (isBlocked(scene, spawn.x, spawn.y)) errors.push(`${scene.id}: spawn is blocked ${spawn.id}`);
    }
    const doorIds = new Set<string>();
    for (const door of scene.doors) {
      if (!ID.test(door.id)) errors.push(`${scene.id}: invalid door id ${door.id}`);
      if (doorIds.has(door.id)) errors.push(`${scene.id}: duplicate door ${door.id}`);
      doorIds.add(door.id);
      if (!inBounds(door)) errors.push(`${scene.id}: door out of bounds ${door.id}`);
      else if (isBlocked(scene, door.x, door.y)) errors.push(`${scene.id}: door is blocked ${door.id}`);
      if (!Number.isInteger(door.radius) || door.radius < 0 || door.radius > 8) {
        errors.push(`${scene.id}: invalid door radius ${door.id}`);
      }
    }
    const interactionIds = new Set<string>();
    for (const interaction of scene.interactions) {
      if (!ID.test(interaction.id)) errors.push(`${scene.id}: invalid interaction id ${interaction.id}`);
      if (interactionIds.has(interaction.id)) {
        errors.push(`${scene.id}: duplicate interaction ${interaction.id}`);
      }
      interactionIds.add(interaction.id);
      if (!inBounds(interaction)) errors.push(`${scene.id}: interaction out of bounds ${interaction.id}`);
      if (!Number.isInteger(interaction.radius) || interaction.radius < 0 || interaction.radius > 8) {
        errors.push(`${scene.id}: invalid interaction radius ${interaction.id}`);
      }
    }
  }
  for (const scene of scenes) {
    for (const door of scene.doors) {
      const target = byId.get(door.targetSceneId);
      if (!target) {
        errors.push(`${scene.id}: door ${door.id} targets missing scene ${door.targetSceneId}`);
        continue;
      }
      const spawn = target.spawns.find((candidate) => candidate.id === door.targetSpawnId);
      if (!spawn) errors.push(`${scene.id}: door ${door.id} targets missing spawn ${door.targetSpawnId}`);
      const reciprocal = target.doors.some(
        (candidate) => candidate.targetSceneId === scene.id && candidate.targetSpawnId === door.id,
      );
      if (!reciprocal) errors.push(`${scene.id}: door ${door.id} has no reciprocal door in ${target.id}`);
    }
  }
  return errors;
}

export function isBlocked(scene: WorldScene, x: number, y: number): boolean {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= scene.width ||
    y >= scene.height
  ) {
    return true;
  }
  return scene.blocked.some(
    (rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height,
  );
}
