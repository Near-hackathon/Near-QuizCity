import type { WorldBootstrapType, WorldEventType } from "@quiz-city/protocol";
import { worldScenes } from "@quiz-city/world-data";

export function worldBootstrap(sceneId = "city-district"): WorldBootstrapType {
  return {
    type: "world.bootstrap",
    protocolVersion: "1.0.0",
    serverTime: "2026-11-13T10:00:00.000Z",
    cityTime: "2026-11-13T10:00:00.000Z",
    streamId: `scene:${sceneId}`,
    lastSequence: "0",
    scene: {
      id: sceneId,
      name: sceneId,
      sceneType: sceneId === "city-district" ? "exterior" : "interior",
      width: 64,
      height: 48,
      assetKey: `maps/${sceneId}`,
      assetVersion: worldScenes.find((scene) => scene.id === sceneId)?.assetVersion ?? "1",
    },
    player: {
      accountId: "alice.testnet",
      x: 32,
      y: 24,
      facing: "south",
      stateVersion: "1",
      lastClientSequence: "0",
    },
    buildings: [],
    interactionZones: [],
    spawns: [],
    npcs: [],
    players: [],
    properties: [],
    businesses: [],
  };
}

export function playerCheckpoint(sequence = "1"): WorldEventType {
  return {
    type: "player.checkpoint",
    protocolVersion: "1.0.0",
    eventId: `checkpoint-${sequence}`,
    streamId: "scene:city-district",
    sequence,
    serverTime: "2026-11-13T10:00:00.000Z",
    cityTime: "2026-11-13T10:00:00.000Z",
    sceneId: "city-district",
    entity: { entityType: "player", entityId: "alice.testnet" },
    payload: { accountId: "alice.testnet", x: 33, y: 24, facing: "east", sceneId: "city-district" },
  };
}
