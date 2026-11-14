import { worldScenes, type WorldDoor } from "@quiz-city/world-data";

/** First door in the shortest scene route; within-scene walking remains authoritative A*. */
export function npcTravelDoor(from: string, to: string): WorldDoor {
  const queue: { scene: string; first?: WorldDoor }[] = [{ scene: from }];
  const seen = new Set([from]);
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    const scene = worldScenes.find((scene) => scene.id === item.scene);
    if (!scene) throw new Error("NPC travel scene is unavailable");
    for (const door of scene.doors) {
      const first = item.first ?? door;
      if (door.targetSceneId === to) return first;
      if (!seen.has(door.targetSceneId)) {
        seen.add(door.targetSceneId);
        queue.push({ scene: door.targetSceneId, first });
      }
    }
  }
  throw new Error("NPC destination has no connected door route");
}
