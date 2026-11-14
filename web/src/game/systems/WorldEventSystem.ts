import type { WorldBootstrapType, WorldEventType } from "@quiz-city/protocol";
import { emptyWorldViewModel, type WorldViewModel } from "../types/game";
type PlayerPayload = {
  accountId: string;
  x: number;
  y: number;
  facing: NonNullable<WorldViewModel["player"]>["facing"];
  sceneId: string;
};

export function applyBootstrap(bootstrap: WorldBootstrapType): WorldViewModel {
  const model = emptyWorldViewModel();
  model.scene = bootstrap.scene;
  model.player = bootstrap.player;
  model.interactionZones = bootstrap.interactionZones;
  model.spawns = bootstrap.spawns;
  model.sequence = bootstrap.lastSequence;
  model.sceneTransitioning = false;
  for (const x of bootstrap.players) model.players.set(x.accountId, x);
  for (const x of bootstrap.npcs) model.npcs.set(x.npcId, x);
  for (const x of bootstrap.buildings) model.buildings.set(x.id, x);
  for (const x of bootstrap.businesses) model.businesses.set(x.id, x);
  for (const x of bootstrap.properties) model.properties.set(x.id, x);
  return model;
}

export function applyWorldEvent(
  model: WorldViewModel,
  event: WorldEventType,
  accountId?: string,
): WorldViewModel {
  if (!model.scene || model.sceneTransitioning) return model;
  if (model.scene && (event.sceneId !== model.scene.id || event.streamId !== `scene:${model.scene.id}`))
    return model;
  if (BigInt(event.sequence) <= BigInt(model.sequence)) return model;
  const next = {
    ...model,
    players: new Map(model.players),
    npcs: new Map(model.npcs),
    pendingNpcActivity: new Map(model.pendingNpcActivity),
    buildings: new Map(model.buildings),
    doors: new Map(model.doors),
    businesses: new Map(model.businesses),
    properties: new Map(model.properties),
  };
  if (
    event.type === "job.presentation_changed" &&
    event.payload.npcId &&
    event.payload.hasOpenJobs !== undefined
  ) {
    const npc = next.npcs.get(event.payload.npcId);
    if (npc) next.npcs.set(event.payload.npcId, { ...npc, hasJob: event.payload.hasOpenJobs });
  }
  const npcVersion =
    next.npcs.get(event.entity.entityId)?.stateVersion ??
    next.pendingNpcActivity.get(event.entity.entityId)?.stateVersion;
  if (
    event.entity.entityType === "npc" &&
    (event.type === "npc.activity_changed" || event.type === "npc.path_started") &&
    (!npcVersion || BigInt(event.payload.stateVersion) >= BigInt(npcVersion))
  ) {
    const npc = next.npcs.get(event.entity.entityId);
    if (!npc && event.type === "npc.activity_changed") {
      next.pendingNpcActivity.set(event.entity.entityId, event.payload);
    }
    if (npc)
      next.npcs.set(event.entity.entityId, {
        ...npc,
        ...(event.type === "npc.activity_changed"
          ? { activity: event.payload.activity }
          : { targetX: event.payload.toX, targetY: event.payload.toY, sceneId: event.payload.sceneId }),
        stateVersion: event.payload.stateVersion,
      });
  } else if (event.entity.entityType === "npc" && event.type === "npc.path_completed") {
    const npc = next.npcs.get(event.entity.entityId) ?? {
      npcId: event.entity.entityId,
      sceneId: event.sceneId,
      activity: "idle",
      stateVersion: "0",
      ...next.pendingNpcActivity.get(event.entity.entityId),
    };
    next.npcs.set(event.entity.entityId, {
      ...npc,
      x: event.payload.x,
      y: event.payload.y,
      targetX: null,
      targetY: null,
    });
    next.pendingNpcActivity.delete(event.entity.entityId);
  } else if (event.type === "npc.entered_building" || event.type === "npc.exited_building") {
    next.npcs.delete(event.entity.entityId);
    next.pendingNpcActivity.delete(event.entity.entityId);
  } else if (event.type === "door.state_changed")
    next.doors.set(event.payload.doorId, { state: event.payload.state });
  else if (event.type === "business.state_changed") {
    const b = next.businesses.get(event.payload.businessId);
    if (b || event.payload.name)
      next.businesses.set(event.payload.businessId, {
        ...(b ?? { id: event.payload.businessId, name: event.payload.name! }),
        status: event.payload.status,
        ...(event.payload.name ? { name: event.payload.name } : {}),
        ...(event.payload.propertyId ? { propertyId: event.payload.propertyId } : {}),
        ...(event.payload.stockAvailable !== undefined
          ? { stockAvailable: event.payload.stockAvailable }
          : {}),
      });
  } else if (event.type === "property.presentation_changed") {
    const p = next.properties.get(event.payload.propertyId);
    if (p)
      next.properties.set(p.id, {
        ...p,
        forSale: event.payload.forSale,
        price: event.payload.price,
        ...(event.payload.condition !== undefined ? { condition: event.payload.condition } : {}),
        ...(event.payload.utilitiesActive !== undefined
          ? { utilitiesActive: event.payload.utilitiesActive }
          : {}),
      });
  } else if (event.entity.entityType === "player" && event.type === "player.scene_changed") {
    const p = event.payload as PlayerPayload;
    if (p.accountId === accountId) {
      next.scene = null;
      next.player = null;
      next.sequence = "0";
      next.sceneTransitioning = true;
      next.players.clear();
      next.npcs.clear();
      next.pendingNpcActivity.clear();
      next.buildings.clear();
      next.doors.clear();
      next.businesses.clear();
      next.properties.clear();
      next.interactionZones = [];
      next.spawns = [];
      return next;
    }
  } else if (
    event.entity.entityType === "player" &&
    (event.type === "player.joined" || event.type === "player.checkpoint")
  ) {
    const p = event.payload as PlayerPayload;
    const player = {
      ...next.players.get(p.accountId),
      accountId: p.accountId,
      x: p.x,
      y: p.y,
      facing: p.facing,
      stateVersion: next.players.get(p.accountId)?.stateVersion ?? next.player?.stateVersion ?? "0",
      lastClientSequence: next.player?.lastClientSequence ?? "0",
    };
    next.players.set(p.accountId, player);
    if (p.accountId === accountId) next.player = { ...next.player, ...player };
  } else if (event.entity.entityType === "player" && event.type === "player.left") {
    const p = event.payload as PlayerPayload;
    next.players.delete(p.accountId);
  }
  next.sequence = event.sequence;
  return next;
}
