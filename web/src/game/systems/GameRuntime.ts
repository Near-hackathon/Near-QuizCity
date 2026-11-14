import type { GameBridge } from "../bridge/GameBridge";
import { emptyWorldViewModel, type GameSettings, type WorldViewModel } from "../types/game";
import { applyBootstrap, applyWorldEvent } from "./WorldEventSystem";
import { canSampleInput } from "./InputSystem";
import { worldScenes, findPath, isVenueOpen, residentProfile } from "@quiz-city/world-data";
import { findInteractionCandidate } from "./InteractionSystem";
import { entranceMarker } from "../assets/visual-slice";

const supported = new Set([
  "city-district",
  "library-interior",
  "university-interior",
  "quiz-centre-interior",
  "cafe-interior",
  "apartment-interior",
]);

export class GameRuntime {
  model = emptyWorldViewModel();
  settings: GameSettings = {
    reducedMotion: false,
    hidden: false,
    online: false,
    uiModalOpen: false,
    transitioning: false,
  };
  private connected = false;
  private disposed = false;
  private readonly listeners = new Set<(model: WorldViewModel) => void>();
  private readonly unsubscribe: () => void;
  private command = 0;
  private lastMove = -Infinity;
  private pendingMove: string | null = null;
  private predictedPath: { x: number; y: number }[] = [];
  private moveDeadline = 0;
  movementStepMs = 250;
  private interaction: { requestId: string; targetId: string; kind: string; deadline: number } | null = null;
  private candidateId: string | null = null;
  private candidateAvailable: boolean | null = null;
  private clock = { server: 0, client: 0 };
  corrections = 0;
  generation = 0;
  predicted: { x: number; y: number } | null = null;
  private doorApproach: { id: string; x: number; y: number; deadline: number } | null = null;

  constructor(private readonly bridge: GameBridge) {
    this.unsubscribe = bridge.onReact((message) => {
      if (message.type === "activateInteraction") this.interact(performance.now());
      if (message.type === "dispose") {
        this.dispose();
        return;
      }
      if (message.type === "settingsChanged") this.settings = { ...this.settings, ...message.settings };
      if (message.type === "transportStatus") {
        this.connected = message.status === "online";
        if (!this.connected) this.clearCommands();
      }
      if (message.type === "commandResult") {
        if (message.requestId === this.pendingMove && !message.accepted) {
          this.doorApproach = null;
          this.predicted = null;
          this.pendingMove = null;
          this.predictedPath = [];
          this.corrections++;
        }
        if (message.requestId === this.interaction?.requestId) {
          const interaction = this.interaction;
          if (!message.accepted || interaction.kind !== "door") {
            this.interaction = null;
            this.bridge.emit({ type: "transitionStatus", pending: false });
            if (message.accepted)
              this.bridge.emit({
                type: "interactionCompleted",
                targetId: interaction.targetId,
                kind: interaction.kind,
              });
          }
        }
      }
      if (message.type === "bootstrap") {
        const scene = message.bootstrap.scene;
        if (
          !supported.has(scene.id) ||
          worldScenes.find((item) => item.id === scene.id)?.assetVersion !== scene.assetVersion
        ) {
          this.connected = false;
          this.bridge.emit({
            type: "fatalError",
            message: "This city scene or asset version is unavailable.",
          });
          return;
        }
        this.generation++;
        this.clock = { server: Date.parse(message.bootstrap.serverTime), client: performance.now() };
        this.movementStepMs = message.bootstrap.movement
          ? message.bootstrap.movement.stepMs / message.bootstrap.movement.tilesPerTick
          : 250;
        this.model = applyBootstrap(message.bootstrap);
        this.clearCommands();
        this.notify();
      } else if (message.type === "worldEvent") {
        const next = applyWorldEvent(this.model, message.event, this.model.player?.accountId);
        if (next !== this.model) {
          this.model = next;
          if (
            message.event.type === "player.checkpoint" &&
            message.event.payload.accountId === next.player?.accountId
          ) {
            const checkpoint = message.event.payload;
            const index = this.predictedPath.findIndex(
              (point) => point.x === checkpoint.x && point.y === checkpoint.y,
            );
            if (index >= 0) this.predictedPath.splice(0, index + 1);
            else this.predictedPath = [];
            // Keep the next collision-checked tile as presentation prediction.
            // Only a final checkpoint releases the command, never an ACK.
            this.predicted = this.predictedPath[0] ?? null;
            if (!this.predicted) this.pendingMove = null;
          }
          if (next.sceneTransitioning) this.clearCommands();
          this.notify();
        }
      }
    });
  }

  canInput() {
    return (
      !this.disposed &&
      this.connected &&
      !!this.model.player &&
      !this.model.sceneTransitioning &&
      !this.interaction &&
      canSampleInput(this.settings)
    );
  }

  move(x: number, y: number, now: number, direct = false) {
    this.doorApproach = null;
    const player = this.model.player;
    const scene = worldScenes.find((item) => item.id === this.model.scene?.id);
    if (!player || !scene || !this.canInput() || now - this.lastMove < 100 || this.pendingMove) return false;
    const route = findPath(scene, player, { x, y });
    if ("error" in route || route.path.length < 2) return false;
    // Keyboard input is one direct step. It must stop at a corner rather than
    // letting click-to-walk pathfinding steer the player around an obstacle.
    if (direct && route.path.length !== 2) return false;
    this.lastMove = now;
    this.predictedPath = route.path.slice(1);
    this.predicted = this.predictedPath[0];
    this.moveDeadline = now + Math.max(10_000, this.predictedPath.length * this.movementStepMs + 5000);
    const requestId = `move-${++this.command}`;
    this.pendingMove = requestId;
    this.bridge.emit({ type: "moveIntent", requestId, x, y });
    return true;
  }

  candidate() {
    const player = this.model.player;
    if (!player || !this.canInput()) return null;
    return findInteractionCandidate(player.x, player.y, [
      ...this.model.interactionZones.filter((zone) => zone.kind !== "quiz" && zone.kind !== "npc"),
      ...[...this.model.npcs.values()].map((npc) => ({
        id: npc.npcId,
        kind: "npc",
        x: npc.x,
        y: npc.y,
        radius: 2,
      })),
    ]);
  }

  tick(now: number) {
    if (this.interaction && now > this.interaction.deadline) {
      this.interaction = null;
      this.bridge.emit({ type: "transitionStatus", pending: false });
    }
    if (this.pendingMove && now > this.moveDeadline) {
      this.doorApproach = null;
      this.pendingMove = null;
      this.predicted = null;
      this.predictedPath = [];
    }
    if (this.doorApproach && now > this.doorApproach.deadline) this.doorApproach = null;
    if (
      this.doorApproach &&
      this.canInput() &&
      this.model.player?.x === this.doorApproach.x &&
      this.model.player.y === this.doorApproach.y
    ) {
      const id = this.doorApproach.id;
      this.doorApproach = null;
      this.interact(now, id);
    }
    const candidate = this.candidate();
    const building = this.buildingForTarget(candidate?.id);
    const available = this.isBuildingOpen(building, now);
    if ((candidate?.id ?? null) !== this.candidateId || available !== this.candidateAvailable) {
      this.candidateId = candidate?.id ?? null;
      this.candidateAvailable = available;
      const hours = building?.openingHours;
      const name =
        building?.displayName ??
        (candidate && residentProfile(candidate.id)?.name) ??
        candidate?.id.replace(/[-_]/g, " ");
      this.bridge.emit({
        type: "interactionCandidateChanged",
        targetId: this.candidateId,
        kind: candidate?.kind,
        label: !available && hours ? `${name} · ${hours.open}–${hours.close} (Accra)` : name,
        available,
      });
    }
  }

  enterDoor(id: string, now: number) {
    if (!this.canInput()) return false;
    const door = worldScenes
      .find((scene) => scene.id === this.model.scene?.id)
      ?.doors.find((item) => item.id === id);
    if (!door || !this.isBuildingOpen(this.buildingForTarget(id), now)) return false;
    const point = entranceMarker(door);
    if (this.model.player?.x === point.x && this.model.player.y === point.y) return this.interact(now, id);
    if (!this.move(point.x, point.y, now)) return false;
    this.doorApproach = { id, ...point, deadline: this.moveDeadline };
    return true;
  }

  interact(now: number, targetId?: string) {
    if (!this.canInput()) return false;
    const target = targetId
      ? findInteractionCandidate(
          this.model.player!.x,
          this.model.player!.y,
          this.model.interactionZones.filter((zone) => zone.kind === "door" && zone.id === targetId),
        )
      : this.candidate();
    if (!target || !["door", "building", "npc", "business"].includes(target.kind)) return false;
    if (!this.isBuildingOpen(this.buildingForTarget(target.id), now)) return false;
    const requestId = `interaction-${++this.command}`;
    this.interaction = { requestId, targetId: target.id, kind: target.kind, deadline: now + 10_000 };
    if (target.kind === "door") this.bridge.emit({ type: "transitionStatus", pending: true });
    this.bridge.emit({
      type: "interactIntent",
      requestId,
      targetId: target.id,
      targetType: target.kind as "door" | "building" | "npc" | "business",
    });
    return true;
  }

  private clearCommands() {
    this.doorApproach = null;
    this.candidateId = null;
    this.candidateAvailable = null;
    this.bridge.emit({ type: "transitionStatus", pending: false });
    this.pendingMove = null;
    this.predictedPath = [];
    this.predicted = null;
    this.interaction = null;
  }

  private buildingForTarget(id?: string) {
    if (!id) return undefined;
    return (
      this.model.buildings.get(id ?? "") ??
      [...this.model.buildings.values()].find((building) => building.doorId === id)
    );
  }

  private isBuildingOpen(building: ReturnType<GameRuntime["buildingForTarget"]>, now: number) {
    if (!building) return true;
    if (building.status === "closed") return false;
    if (building.openingHours)
      return isVenueOpen(building.openingHours, new Date(this.clock.server + now - this.clock.client));
    return building.isOpen !== false;
  }

  subscribe(listener: (model: WorldViewModel) => void) {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.model);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) listener(this.model);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.listeners.clear();
    this.model = emptyWorldViewModel();
  }
}
