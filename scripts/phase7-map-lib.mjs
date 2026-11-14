import { worldScenes, validateWorldScenes } from "../packages/world-data/src/index.ts";

export const layers = [
  "ground",
  "roads",
  "pavement",
  "lower_props",
  "buildings",
  "upper_occlusion",
  "collision",
  "navigation",
  "interactions",
  "spawns",
];
function interactionProperties(scene, zone) {
  const door = scene.doors.find((item) => item.id === zone.id);
  const values = {
    kind: zone.kind,
    serverId: zone.id,
    gridX: zone.x,
    gridY: zone.y,
    radius: zone.radius,
    ...(door ? { targetSceneId: door.targetSceneId, targetSpawnId: door.targetSpawnId } : {}),
  };
  return Object.entries(values).map(([name, value]) => ({
    name,
    type: typeof value === "number" ? "int" : "string",
    value,
  }));
}
export function createMaps() {
  const errors = validateWorldScenes(worldScenes);
  if (errors.length) throw new Error(errors.join("; "));
  return worldScenes.map((scene) => ({
    sceneId: scene.id,
    assetVersion: scene.assetVersion,
    orientation: "isometric",
    renderorder: "right-down",
    tilewidth: 32,
    tileheight: 16,
    width: scene.width,
    height: scene.height,
    infinite: false,
    version: "1.10",
    layers: layers.map((name, index) => ({
      id: index + 1,
      name,
      type: "objectgroup",
      visible: index < 6,
      opacity: 1,
      objects:
        name === "collision"
          ? scene.blocked.map((rect, i) => ({ id: index * 1000 + i + 1, ...rect }))
          : name === "interactions"
            ? scene.interactions.map((zone, i) => ({
                serverId: zone.id,
                ...zone,
                ...(scene.doors.find((door) => door.id === zone.id) ?? {}),
                id: index * 1000 + i + 1,
                properties: interactionProperties(scene, zone),
              }))
            : name === "spawns"
              ? scene.spawns.map((spawn, i) => ({
                  ...spawn,
                  id: index * 1000 + i + 1,
                  serverId: spawn.id,
                  properties: [
                    { name: "serverId", type: "string", value: spawn.id },
                    { name: "kind", type: "string", value: spawn.kind },
                  ],
                }))
              : [],
    })),
  }));
}

export function validateMaps(maps) {
  if (!Array.isArray(maps) || maps.length !== worldScenes.length) throw new Error("Incomplete map registry");
  const seen = new Set();
  for (const map of maps) {
    const scene = worldScenes.find((item) => item.id === map.sceneId);
    if (!scene || seen.has(map.sceneId)) throw new Error("Unknown or duplicate scene");
    seen.add(map.sceneId);
    if (
      map.orientation !== "isometric" ||
      map.tilewidth !== 32 ||
      map.tileheight !== 16 ||
      map.width !== scene.width ||
      map.height !== scene.height ||
      map.assetVersion !== scene.assetVersion
    )
      throw new Error("Map dimensions/version mismatch");
    if (JSON.stringify(map.layers.map((item) => item.name)) !== JSON.stringify(layers))
      throw new Error("Invalid map layers");
    const expected = createMaps().find((item) => item.sceneId === scene.id);
    for (const name of ["collision", "interactions", "spawns"]) {
      if (
        JSON.stringify(map.layers.find((item) => item.name === name)) !==
        JSON.stringify(expected.layers.find((item) => item.name === name))
      ) {
        throw new Error(`Map/server ${name} mismatch in ${scene.id}`);
      }
    }
  }
}
