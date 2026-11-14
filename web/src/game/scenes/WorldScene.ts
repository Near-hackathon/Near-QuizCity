import { isBrowserAccount } from "@quiz-city/protocol";
import Phaser from "phaser";
import {
  worldScenes,
  isBlocked,
  findPath,
  residentProfile,
  type WorldScene as SceneData,
} from "@quiz-city/world-data";
import type { GameBridge } from "../bridge/GameBridge";
import type { GameRuntime } from "../systems/GameRuntime";
import type { WorldViewModel } from "../types/game";
import { toScreen, toGrid, sceneBounds } from "../maps/coordinates";
import { Character } from "../entities/Character";
import { InterpolationBuffer } from "../systems/InterpolationSystem";
import { advanceVisualPosition } from "../systems/MovementPresentation";
import { campusFacade, entranceMarker, knowledgeSheets } from "../assets/visual-slice";
import { interiorStyles } from "../assets/interior-style";

const city = "world/city/Sheets/",
  room = "world/interiors/Sheets/";
const vectors = (points: { x: number; y: number }[]) => points.map((p) => new Phaser.Math.Vector2(p.x, p.y));
type Actor = { character: Character; buffer: InterpolationBuffer };
export class WorldScene extends Phaser.Scene {
  private map!: SceneData;
  private actors = new Map<string, Actor>();
  private local?: Character;
  private previousScene: string | null = null;
  private buildings: {
    shape: Phaser.GameObjects.Graphics | Phaser.GameObjects.Image;
    x: number;
    y: number;
    width: number;
  }[] = [];
  private markers: Phaser.GameObjects.GameObject[] = [];
  private keys = new Set<string>();
  private debug = false;
  private debugText?: Phaser.GameObjects.Text;
  private lastMetrics = 0;
  private generation = -1;
  private lastFrameTime: number | null = null;
  private npcPaths = new Map<
    string,
    { target: string; points: { x: number; y: number }[]; x: number; y: number }
  >();
  constructor(
    key: string,
    private readonly bridge: GameBridge,
    private readonly runtime: GameRuntime,
  ) {
    super(key);
  }
  create() {
    this.lastFrameTime = null;
    this.previousScene = null;
    this.local = undefined;
    this.npcPaths.clear();
    this.actors = new Map();
    this.buildings = [];
    this.markers = [];
    this.keys = new Set();
    this.debugText = this.add
      .text(8, 8, "", { fontSize: "10px", backgroundColor: "#102633", color: "#fff" })
      .setScrollFactor(0)
      .setDepth(100000)
      .setVisible(false);
    const off = this.runtime.subscribe((model) => this.snapshot(model));
    const keydown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, dialog, [role=dialog]")
      )
        return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("button, a") &&
        ["Space", "Enter"].includes(event.code)
      )
        return;
      if (event.code === "F3" && import.meta.env.DEV) {
        event.preventDefault();
        this.debug = !this.debug;
        this.debugText?.setVisible(this.debug);
        return;
      }
      if (!this.runtime.canInput()) return;
      if (
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD"].includes(
          event.code,
        )
      ) {
        event.preventDefault();
        this.keys.add(event.code);
      }
      if (!event.repeat && [this.runtime.settings.interactKey ?? "KeyE", "Enter"].includes(event.code)) {
        event.preventDefault();
        this.runtime.interact(performance.now());
      }
    };
    const keyup = (event: KeyboardEvent) => this.keys.delete(event.code);
    const blur = () => this.keys.clear();
    const pointer = (p: Phaser.Input.Pointer) => {
      if (!this.runtime.canInput() || !p.leftButtonDown()) return;
      const point = this.cameras.main.getWorldPoint(p.x, p.y),
        target = toGrid(point.x, point.y);
      this.runtime.move(target.x, target.y, performance.now());
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    this.input.on("pointerdown", pointer);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
      this.input.off("pointerdown", pointer);
      for (const actor of this.actors.values()) actor.character.destroy();
      this.actors.clear();
      this.keys.clear();
    });
  }
  private snapshot(model: WorldViewModel) {
    if (!model.scene || (this.scene.key === "CityScene") !== (model.scene.id === "city-district")) return;
    if (this.generation !== this.runtime.generation) {
      this.generation = this.runtime.generation;
      for (const actor of this.actors.values()) actor.character.destroy();
      this.actors.clear();
      this.npcPaths.clear();
      this.local = undefined;
    }
    if (this.previousScene !== model.scene.id) {
      if (this.previousScene) {
        this.scene.restart();
        return;
      }
      this.previousScene = model.scene.id;
      this.map = worldScenes.find((item) => item.id === model.scene!.id)!;
      this.drawMap();
      this.bridge.emit({ type: "sceneRendered", sceneId: model.scene.id });
    }
    const entities = [
      ...(model.player
        ? [{ id: model.player.accountId, ...model.player, activity: "idle", npc: false }]
        : []),
      ...[...model.players.values()]
        .filter((p) => p.accountId !== model.player?.accountId)
        .map((p) => ({ id: p.accountId, ...p, activity: "idle", npc: false })),
      ...[...model.npcs.values()]
        .filter((n) => n.sceneId === model.scene?.id)
        .map((n) => ({ id: n.npcId, facing: "south", ...n, npc: true })),
    ];
    const ids = new Set(entities.map((entity) => entity.id));
    for (const [id, actor] of this.actors)
      if (!ids.has(id)) {
        actor.character.destroy();
        this.actors.delete(id);
        this.npcPaths.delete(id);
      }
    for (const entity of entities) {
      let actor = this.actors.get(entity.id);
      const profile = entity.npc ? residentProfile(entity.id) : undefined;
      const name =
        entity.id === model.player?.accountId
          ? "You"
          : profile
            ? `${"hasJob" in entity && entity.hasJob ? "★ " : ""}${profile.name}`
            : "displayName" in entity && entity.displayName
              ? entity.displayName
              : isBrowserAccount(entity.id)
                ? "New neighbour"
                : entity.id.replace(/\.testnet$/, "");
      if (!actor) {
        actor = {
          character: new Character(
            this,
            entity.id,
            profile?.skin ?? (entity.npc ? "woman_jeans" : "man_tee"),
            name,
            entity.id === model.player?.accountId,
          ),
          buffer: new InterpolationBuffer(),
        };
        if (profile) actor.character.sprite.setTint(profile.tint);
        this.actors.set(entity.id, actor);
      }
      actor.buffer.push({ x: entity.x, y: entity.y, time: performance.now(), sequence: model.sequence });
      const npc = model.npcs.get(entity.id);
      if (npc?.targetX !== null && npc?.targetX !== undefined && npc.targetY !== null) {
        const target = `${npc.targetX},${npc.targetY}`;
        if (this.npcPaths.get(entity.id)?.target !== target) {
          const path = findPath(this.map, npc, { x: npc.targetX, y: npc.targetY });
          if ("path" in path)
            this.npcPaths.set(entity.id, { target, points: path.path.slice(1), x: npc.x, y: npc.y });
        }
      } else this.npcPaths.delete(entity.id);
      actor.character.label.setText(name);
      if (entity.id === model.player?.accountId && this.local !== actor.character) {
        this.local = actor.character;
        const point = toScreen(entity.x, entity.y);
        actor.character.x = entity.x;
        actor.character.y = entity.y;
        actor.character.sprite.setPosition(point.x, point.y);
        this.cameras.main.startFollow(actor.character.sprite, true, 0.15, 0.15);
        this.cameras.main.centerOn(point.x, point.y);
      }
    }
    this.markers.forEach((marker) => marker.destroy());
    this.markers = [];
    if (model.scene.id === "city-district")
      [...model.properties.values()].forEach((property) => {
        if (property.x === undefined || property.y === undefined) return;
        const p = toScreen(property.x, property.y);
        const shop = [...model.businesses.values()].find((b) => b.propertyId === property.id);
        const label =
          property.utilitiesActive === false
            ? "UTILITIES PAUSED"
            : (property.condition ?? 100) < 30
              ? "NEEDS REPAIRS"
              : shop
                ? `${shop.name}\n${shop.status === "closed" ? "CLOSED" : shop.stockAvailable !== undefined ? `${shop.stockAvailable} in stock` : "OPEN"}`
                : property.forSale
                  ? `FOR SALE\n${property.price} QC`
                  : "OWNED";
        this.markers.push(
          this.add
            .text(p.x, p.y - 22, label, {
              fontSize: "8px",
              color: "#fff5ca",
              backgroundColor: "#875c37",
              align: "center",
              padding: { x: 4, y: 3 },
            })
            .setDepth(p.y + 0.3)
            .setInteractive({ useHandCursor: true })
            .on(
              "pointerdown",
              (
                _pointer: Phaser.Input.Pointer,
                _x: number,
                _y: number,
                event: Phaser.Types.Input.EventData,
              ) => {
                event.stopPropagation();
                this.bridge.emit({ type: "interactionCompleted", kind: "property", targetId: property.id });
              },
            ),
        );
      });
  }
  private prop(x: number, y: number, sheet: string, frame: string) {
    const p = toScreen(x, y);
    return this.add
      .image(p.x, p.y + 8, sheet, frame)
      .setOrigin(0.5, 1)
      .setDepth(p.y);
  }
  private drawMonitor(x: number, y: number, depth = toScreen(x, y).y + 0.2) {
    const p = toScreen(x, y);
    const monitor = this.add.graphics().setDepth(depth);
    monitor
      .fillStyle(0x243d49)
      .fillPoints(
        vectors([
          { x: p.x - 9, y: p.y - 18 },
          { x: p.x + 7, y: p.y - 22 },
          { x: p.x + 7, y: p.y - 10 },
          { x: p.x - 9, y: p.y - 6 },
        ]),
        true,
      )
      .lineStyle(1, 0xb1d0cc)
      .lineBetween(p.x - 6, p.y - 13, p.x + 4, p.y - 16)
      .fillStyle(0x2f454b)
      .fillRect(p.x - 2, p.y - 8, 3, 6);
  }
  private drawCoffeeMachine(x: number, y: number) {
    const p = toScreen(x, y);
    this.add
      .graphics()
      .setDepth(p.y + 0.3)
      .fillStyle(0x33454a)
      .fillRoundedRect(p.x - 8, p.y - 23, 16, 18, 2)
      .fillStyle(0xe0c183)
      .fillRect(p.x - 5, p.y - 19, 10, 3)
      .fillStyle(0xf3e5c9)
      .fillRect(p.x - 4, p.y - 10, 4, 4)
      .fillStyle(0x96684b)
      .fillRect(p.x - 4, p.y - 11, 4, 1);
  }
  private drawMap() {
    const exterior = this.map.id === "city-district",
      bounds = sceneBounds(this.map.width, this.map.height),
      style = interiorStyles[this.map.id];
    this.cameras.main.setBackgroundColor(exterior ? "#182e3b" : "#26313e");
    this.cameras.main
      .setBounds(bounds.x, bounds.y, bounds.width, bounds.height)
      .setZoom(this.runtime.settings.zoom ?? 2);
    // Static terrain is one graphics object; props/characters retain independent feet depth.
    const ground = this.add.graphics().setDepth(-10000);
    for (let y = 0; y < this.map.height; y++)
      for (let x = 0; x < this.map.width; x++) {
        const p = toScreen(x, y),
          edge = x < 2 || y < 2 || x >= this.map.width - 2 || y >= this.map.height - 2;
        const road = exterior && (Math.abs(y - 26) < 2 || Math.abs(x - 32) < 2);
        const park = exterior && x >= 23 && x <= 38 && y >= 30 && y <= 40;
        const campus = exterior && y >= 10 && y <= 17 && x >= 15 && x <= 55;
        const promenade =
          campus ||
          (y >= 36 && y <= 39) ||
          Math.abs(y - 26) === 2 ||
          Math.abs(x - 32) === 2 ||
          (x >= 18 && x <= 22 && y >= 10 && y <= 28) ||
          (x >= 48 && x <= 52 && y >= 10 && y <= 28) ||
          (x >= 26 && x <= 38 && y >= 16 && y <= 25) ||
          (x >= 6 && x <= 17 && y >= 30 && y <= 40) ||
          (x >= 40 && x <= 50 && y >= 30 && y <= 40);
        const color = exterior
          ? edge || park || (!road && !promenade)
            ? (x + y) % 2
              ? 0x89aa72
              : 0x8eae77
            : road
              ? 0x344552
              : campus
                ? (x + y) % 2
                  ? 0xd0cab5
                  : 0xd4ceba
                : (x + y) % 2
                  ? 0xc9c0a7
                  : 0xcdc4ac
          : (x + y) % 2
            ? style.floor
            : style.floorAlt;
        ground.fillStyle(color).fillPoints(
          vectors([
            { x: p.x, y: p.y - 8 },
            { x: p.x + 16, y: p.y },
            { x: p.x, y: p.y + 8 },
            { x: p.x - 16, y: p.y },
          ]),
          true,
        );
        if (road && !isBlocked(this.map, x, y)) {
          if (
            ((x === 20 || x === 50) && Math.abs(y - 26) <= 1) ||
            ((y === 14 || y === 38) && Math.abs(x - 32) <= 1)
          ) {
            ground
              .fillStyle(0xe7e2cc)
              .fillPoints(
                vectors([
                  toScreen(x - 0.35, y - 0.3),
                  toScreen(x + 0.35, y - 0.3),
                  toScreen(x + 0.35, y + 0.3),
                  toScreen(x - 0.35, y + 0.3),
                ]),
                true,
              );
          }
          if (y === 26 && x % 4 < 2 && Math.abs(x - 32) > 2) {
            const a = toScreen(x - 0.4, y),
              b = toScreen(x + 0.4, y);
            ground.lineStyle(1, 0xe0c687).lineBetween(a.x, a.y, b.x, b.y);
          }
          if (x === 32 && y % 4 < 2 && Math.abs(y - 26) > 2) {
            const a = toScreen(x, y - 0.4),
              b = toScreen(x, y + 0.4);
            ground.lineStyle(1, 0xe0c687).lineBetween(a.x, a.y, b.x, b.y);
          }
        }
        if (campus && !isBlocked(this.map, x, y) && y >= 13 && y <= 15)
          this.prop(x, y, "knowledge-campus", "paving").setDisplaySize(32, 16).setDepth(-9998);
      }
    if (!exterior) {
      const corner = toScreen(-0.5, -0.5);
      const walls = this.add.graphics().setDepth(-9000);
      for (const [end, color] of [
        [toScreen(this.map.width - 0.5, -0.5), style.wall],
        [toScreen(-0.5, this.map.height - 0.5), style.sideWall],
      ] as const) {
        walls
          .fillStyle(color)
          .fillPoints(
            vectors([corner, end, { x: end.x, y: end.y - 42 }, { x: corner.x, y: corner.y - 42 }]),
            true,
          )
          .lineStyle(3, style.trim)
          .lineBetween(corner.x, corner.y, end.x, end.y);
      }
      // Windows follow the rear wall's projection instead of floating screen rectangles.
      for (let x = 4; x < this.map.width - 2; x += 5) {
        const a = toScreen(x, -0.5),
          b = toScreen(x + 2, -0.5);
        walls
          .fillStyle(0x8daeb7)
          .fillPoints(
            vectors([
              { x: a.x, y: a.y - 12 },
              { x: b.x, y: b.y - 12 },
              { x: b.x, y: b.y - 34 },
              { x: a.x, y: a.y - 34 },
            ]),
            true,
          )
          .lineStyle(1, style.trim)
          .lineBetween(a.x, a.y - 12, b.x, b.y - 12);
      }
    }
    const colors = [0x936e61, 0x7393a0, 0xb6a074, 0x9e7b68, 0x708b80, 0xaa8262];
    this.map.blocked
      .filter((rect) => rect.x > 1 && rect.y > 1 && rect.width > 2 && rect.height > 1)
      .forEach((rect, i) => {
        const a = toScreen(rect.x - 0.5, rect.y - 0.5),
          b = toScreen(rect.x + rect.width - 0.5, rect.y - 0.5),
          c = toScreen(rect.x + rect.width - 0.5, rect.y + rect.height - 0.5),
          d = toScreen(rect.x - 0.5, rect.y + rect.height - 0.5);
        const facade = exterior ? campusFacade(rect.x, rect.y) : null;
        if (exterior && rect.x === 28 && rect.y === 18) {
          const garden = this.add.graphics().setDepth(-9997);
          garden
            .fillStyle(0x596d48)
            .fillPoints(vectors([a, b, c, d]), true)
            .lineStyle(3, 0xbaa77e)
            .strokePoints(vectors([a, b, c, d]), true);
          for (const [x, y] of [
            [30, 20],
            [33, 20],
            [30, 22],
            [33, 22],
          ])
            this.prop(x, y, `${city}street_1x`, "tree_round");
          const label = toScreen(32, 23);
          this.add
            .text(label.x, label.y, "RESEARCH GARDEN", {
              fontFamily: "monospace",
              fontSize: "8px",
              color: "#fff0bf",
              backgroundColor: "#3d5948",
              padding: { x: 4, y: 3 },
            })
            .setOrigin(0.5, 1)
            .setDepth(c.y + 1);
          return;
        }
        if (facade) {
          const width = (rect.width + rect.height) * 16;
          const image = this.add
            .image(c.x, c.y + 2, "knowledge-buildings", facade)
            .setOrigin(["library", "university"].includes(facade) ? 0.665 : 0.5, 1)
            .setScale(width / knowledgeSheets[0].frames[facade].w)
            .setDepth(c.y);
          this.buildings.push({ shape: image, x: (d.x + b.x) / 2, y: c.y, width });
          return;
        }
        if (!exterior) {
          // Shelves occupy the existing blocked stack; no decorative obstacle is
          // placed in a walkable cell or in Kofi's approach/door corridor.
          for (let x = rect.x; x < rect.x + rect.width; x += 2) {
            this.prop(
              x,
              rect.y + rect.height - 1,
              "knowledge-furniture",
              this.map.id === "quiz-centre-interior" ? "table" : "books",
            ).setDisplaySize(48, 30);
            if (this.map.id === "quiz-centre-interior") this.drawMonitor(x, rect.y + rect.height - 1);
          }
          return;
        }
        const height = exterior ? 54 : 24,
          shape = this.add.graphics().setDepth(c.y);
        shape
          .fillStyle(colors[i % colors.length])
          .fillPoints(vectors([d, c, { x: c.x, y: c.y - height }, { x: d.x, y: d.y - height }]), true);
        shape
          .fillStyle(exterior ? 0x554d54 : 0x74604a)
          .fillPoints(vectors([b, c, { x: c.x, y: c.y - height }, { x: b.x, y: b.y - height }]), true);
        shape
          .fillStyle(exterior ? 0xd7b58b : 0x8c775b)
          .fillPoints(vectors([a, b, c, d].map((p) => ({ x: p.x, y: p.y - height }))), true);
        shape
          .lineStyle(1, 0x3a3b42, 0.6)
          .strokePoints(vectors([a, b, c, d].map((p) => ({ x: p.x, y: p.y - height }))), true);
        this.buildings.push({ shape, x: c.x, y: c.y, width: (rect.width + rect.height) * 16 });
        for (let n = 1; n < rect.width; n++) {
          const p = toScreen(rect.x + n, rect.y + rect.height - 1);
          shape.fillStyle(0xf8e3a0).fillRect(p.x - 4, p.y - height / 2 - 7, 8, 14);
        }
        if (!exterior) this.prop(rect.x, rect.y, `${room}living_1x`, "bookshelf_sw");
      });
    if (!exterior) {
      if (this.map.id === "apartment-interior") {
        const lounge = [
          [3, 7],
          [8, 7],
          [8, 11],
          [3, 11],
        ].map(([x, y]) => toScreen(x, y));
        ground
          .fillStyle(style.rug)
          .fillPoints(vectors(lounge), true)
          .lineStyle(2, style.accent)
          .strokePoints(vectors(lounge), true);
      }
      const left = Math.floor(this.map.width / 3),
        right = this.map.width - 4;
      const top = Math.floor(this.map.height / 2),
        bottom = this.map.height - 4;
      const carpet = [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
      ].map(([x, y]) => toScreen(x, y));
      if (this.map.id !== "apartment-interior")
        ground
          .fillStyle(style.rug)
          .fillPoints(vectors(carpet), true)
          .lineStyle(2, style.accent)
          .strokePoints(vectors(carpet), true);
      if (["university-interior", "quiz-centre-interior"].includes(this.map.id)) {
        const a = toScreen(9, 0),
          b = toScreen(15, 0);
        this.add
          .graphics()
          .setDepth(-8999)
          .fillStyle(this.map.id === "university-interior" ? 0xe8eddb : 0x425d79)
          .fillPoints(
            vectors([
              { x: a.x, y: a.y - 8 },
              { x: b.x, y: b.y - 8 },
              { x: b.x, y: b.y - 36 },
              { x: a.x, y: a.y - 36 },
            ]),
            true,
          )
          .lineStyle(2, style.trim)
          .strokePoints(
            vectors([
              { x: a.x, y: a.y - 8 },
              { x: b.x, y: b.y - 8 },
              { x: b.x, y: b.y - 36 },
              { x: a.x, y: a.y - 36 },
            ]),
            true,
          );
      }
      const p = toScreen(Math.floor(this.map.width / 2), 1);
      this.add
        .text(p.x, p.y - 30, style.title, {
          fontFamily: "monospace",
          fontSize: "10px",
          color: "#f0d9a7",
          backgroundColor: "#334e4c",
          padding: { x: 8, y: 5 },
        })
        .setOrigin(0.5, 1)
        .setDepth(p.y);
      this.add
        .text(p.x, p.y - 16, style.subtitle, {
          fontFamily: "monospace",
          fontSize: "6px",
          color: "#f0ddb8",
          backgroundColor: "#334e4c",
          padding: { x: 4, y: 2 },
        })
        .setOrigin(0.5, 1)
        .setDepth(p.y);
    }
    for (const door of this.map.doors) {
      const approach = entranceMarker(door);
      const p = toScreen(approach.x, approach.y);
      const circle = this.add
        .ellipse(p.x, p.y + 5, 24, 12, 0xeadba2, 0.12)
        .setStrokeStyle(1, 0xffe5a2, 0.9)
        .setDepth(exterior ? p.y + 32 : p.y - 0.5)
        .setInteractive({ useHandCursor: true });
      circle.setName(`entrance-circle:${door.id}`);
      circle.on("pointerover", () => circle.setFillStyle(0xeadba2, 0.3));
      circle.on("pointerout", () => circle.setFillStyle(0xeadba2, 0.12));
      circle.on(
        "pointerdown",
        (_pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
          event.stopPropagation();
          this.runtime.enterDoor(door.id, performance.now());
        },
      );
      const title = exterior
        ? door.targetSceneId.replace("-interior", "").replace(/-/g, " ").toUpperCase()
        : "EXIT TO CITY";
      this.add
        .text(p.x, exterior ? p.y - 22 : p.y + 15, title, {
          fontFamily: "monospace",
          fontSize: "9px",
          color: "#fff0bf",
          backgroundColor: "#243e48",
          padding: { x: 4, y: 3 },
        })
        .setOrigin(0.5, exterior ? 1 : 0)
        .setDepth(10000);
    }
    const frames = {
      tree: "tree_round",
      lamp: "street_lamp_sw",
      bench: "bench_sw",
      bookshelf: "bookshelf_sw",
      armchair: "armchair_sw",
      sofa: "sofa_sw",
    };
    for (const prop of this.map.props ?? []) {
      const furnitureFrames: Partial<Record<typeof prop.kind, string>> = {
        desk: "table",
        chair: "chair",
        bed: "bed",
        counter: "counter",
        plant: "plant",
        fridge: "fridge",
        stove: "stove",
      };
      const furniture = furnitureFrames[prop.kind];
      if (furniture) {
        if (prop.kind === "counter") {
          for (let offset = 0; offset < prop.width; offset++)
            this.prop(prop.x + offset, prop.y, "knowledge-furniture", "counter").setDisplaySize(32, 30);
          if (this.map.id === "cafe-interior") this.drawCoffeeMachine(prop.x + 1, prop.y);
          continue;
        }
        const width =
          prop.kind === "bed"
            ? 56
            : prop.kind === "desk"
              ? 44
              : prop.kind === "plant"
                ? 22
                : prop.kind === "chair"
                  ? 18
                  : 28;
        const frame = knowledgeSheets[2].frames[furniture as keyof (typeof knowledgeSheets)[2]["frames"]];
        const screen = toScreen(prop.x + (prop.width - 1) / 2, prop.y + (prop.height - 1) / 2);
        this.add
          .image(screen.x, screen.y + 8, "knowledge-furniture", furniture)
          .setOrigin(0.5, 1)
          .setDisplaySize(width, (width * frame.h) / frame.w)
          .setDepth(toScreen(prop.x + prop.width - 1, prop.y + prop.height - 1).y);
        if (prop.kind === "desk" && ["quiz-centre-interior", "university-interior"].includes(this.map.id))
          this.drawMonitor(prop.x + 0.5, prop.y, toScreen(prop.x + prop.width - 1, prop.y).y + 0.2);
        continue;
      }
      if (exterior && prop.kind === "tree")
        this.prop(prop.x, prop.y, "knowledge-campus", "flowerbed")
          .setDisplaySize(32, 32)
          .setDepth(toScreen(prop.x, prop.y).y - 0.1);
      if (exterior && prop.kind === "bench") {
        this.prop(prop.x, prop.y, "knowledge-campus", "bench").setDisplaySize(32, 32);
        continue;
      }
      this.prop(
        prop.x,
        prop.y,
        ["tree", "lamp", "bench"].includes(prop.kind) ? `${city}street_1x` : `${room}living_1x`,
        frames[prop.kind as keyof typeof frames],
      );
    }
    if (exterior) {
      // Border planting uses the already blocked perimeter, leaving footpaths clear.
      for (let x = 5; x < this.map.width - 3; x += 8) {
        this.prop(x, 1, `${city}street_1x`, "tree_round");
        this.prop(x, this.map.height - 1, `${city}street_1x`, "tree_round");
      }
      for (let y = 6; y < this.map.height - 4; y += 8) {
        this.prop(1, y, `${city}street_1x`, "tree_round");
        this.prop(this.map.width - 1, y, `${city}street_1x`, "tree_round");
      }
      const p = toScreen(30, 38);
      this.add
        .text(p.x, p.y, "KNOWLEDGE GARDENS", {
          fontSize: "9px",
          color: "#eff0be",
          backgroundColor: "#456b55",
        })
        .setOrigin(0.5)
        .setDepth(p.y);
    }
  }
  update(_time: number, delta: number) {
    if (!this.map) return;
    const now = performance.now(),
      player = this.runtime.model.player;
    // Phaser may supply a smoothed 16ms delta even when rendering at 30 FPS.
    // Presentation must follow wall time, or it falls behind and then snaps.
    const frameDelta = Math.min(
      100,
      Math.max(0, this.lastFrameTime === null ? delta : now - this.lastFrameTime),
    );
    this.lastFrameTime = now;
    this.runtime.tick(now);
    if (!this.runtime.canInput()) this.keys.clear();
    if (player && this.keys.size) {
      const dx =
        Number(
          this.keys.has("ArrowDown") ||
            this.keys.has("KeyS") ||
            this.keys.has("ArrowRight") ||
            this.keys.has("KeyD"),
        ) -
        Number(
          this.keys.has("ArrowUp") ||
            this.keys.has("KeyW") ||
            this.keys.has("ArrowLeft") ||
            this.keys.has("KeyA"),
        );
      const dy =
        Number(
          this.keys.has("ArrowDown") ||
            this.keys.has("KeyS") ||
            this.keys.has("ArrowLeft") ||
            this.keys.has("KeyA"),
        ) -
        Number(
          this.keys.has("ArrowUp") ||
            this.keys.has("KeyW") ||
            this.keys.has("ArrowRight") ||
            this.keys.has("KeyD"),
        );
      if (dx || dy) this.runtime.move(player.x + Math.sign(dx), player.y + Math.sign(dy), now, true);
    }
    this.cameras.main.setZoom(this.runtime.settings.zoom ?? 2);
    for (const [id, actor] of this.actors) {
      const npc = this.runtime.model.npcs.get(id),
        remote = this.runtime.model.players.get(id);
      let p = actor.buffer.position(now);
      const route = this.npcPaths.get(id);
      if (route) {
        const target = route.points[0];
        if (target) {
          const distance = Math.max(Math.abs(target.x - route.x), Math.abs(target.y - route.y)),
            step = Math.min(1, frameDelta / 1000 / Math.max(0.01, distance));
          route.x += (target.x - route.x) * step;
          route.y += (target.y - route.y) * step;
          if (Math.hypot(target.x - route.x, target.y - route.y) < 0.01) route.points.shift();
        }
        p = { x: route.x, y: route.y };
      }
      if (id === player?.accountId) {
        p = advanceVisualPosition(
          actor.character,
          this.runtime.predicted ?? player,
          frameDelta,
          this.runtime.movementStepMs,
        );
      }
      if (p) {
        const screen = toScreen(p.x, p.y);
        actor.character.draw(
          p.x,
          p.y,
          id === player?.accountId ? player.facing : (remote?.facing ?? "south"),
          npc?.activity ?? "idle",
          this.runtime.settings.reducedMotion,
          this.cameras.main.worldView.contains(screen.x, screen.y),
        );
      }
    }
    if (this.local)
      for (const b of this.buildings) {
        const p = toScreen(this.local.x, this.local.y);
        b.shape.setAlpha(p.y < b.y && p.y > b.y - 100 && Math.abs(p.x - b.x) < b.width / 2 ? 0.5 : 1);
      }
    if (now - this.lastMetrics > 1000) {
      this.lastMetrics = now;
      this.bridge.emit({
        type: "metrics",
        fps: this.game.loop.actualFps,
        entities: this.actors.size,
        corrections: this.runtime.corrections,
      });
      this.debugText?.setText(
        `${this.map.id} | seq ${this.runtime.model.sequence}\n${player?.x},${player?.y} | ${this.actors.size} actors | ${Math.round(this.game.loop.actualFps)} FPS`,
      );
    }
  }
}
