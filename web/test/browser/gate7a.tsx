import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GameHost } from "../../src/game/GameHost";
import type { GameBridge } from "../../src/game/bridge/GameBridge";
import { worldBootstrap } from "../../src/test/world-fixtures";
import { worldScenes } from "@quiz-city/world-data";
import { createWorldTransport } from "../../src/state/world-transport";

const errors: string[] = [];
const trace: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", () => errors.push("Unhandled promise rejection"));
let bridge: GameBridge;
let rendered = "";
const apiBase = new URLSearchParams(location.search).get("apiBase");
let transport = apiBase ? createWorldTransport({ apiBase }) : null;
let transportOffs: (() => void)[] = [];
let bootstrapCount = 0;
let replacingTransport = false;
let interactionCompleted = "";
let checkpoint = false;
let online = false;
const checkpoints: { time: number; x: number; y: number }[] = [];
const observedCircles = new WeakSet<object>();
function bindTransport(next: NonNullable<typeof transport>) {
  transportOffs.forEach((off) => off());
  transportOffs = [
    next.onStatus((status) => {
      online = status === "online";
      bridge?.send({ type: "transportStatus", status });
    }),
    next.onMessage((message) => {
      if (message.type === "world.bootstrap") {
        bootstrapCount++;
        bridge.send({ type: "bootstrap", bootstrap: message });
      }
    }),
    next.onEvent((event) => {
      if (event.type === "player.checkpoint" && event.payload.accountId === "alice.testnet")
        checkpoints.push({ time: performance.now(), x: event.payload.x, y: event.payload.y });
      if (event.type === "player.checkpoint" && event.payload.x === 20 && event.payload.y === 10)
        checkpoint = true;
      bridge.send({ type: "worldEvent", event });
    }),
  ];
}
if (transport) bindTransport(transport);
const attach = (next: GameBridge) => {
  bridge = next;
  next.subscribe((message) => {
    trace.push(message.type === "moveIntent" ? `moveIntent:${message.x},${message.y}` : message.type);
    if (message.type === "fatalError" && message.message !== "intentional retry test")
      errors.push(message.message);
    if (message.type === "gameReady") {
      if (transport) {
        transport.connect("city-district", null);
        return;
      }
      next.send({ type: "bootstrap", bootstrap: worldBootstrap() });
      next.send({ type: "transportStatus", status: "online" });
    }
    if (message.type === "sceneRendered") rendered = message.sceneId;
    if (message.type === "interactionCompleted") interactionCompleted = message.targetId;
    if (transport && (message.type === "moveIntent" || message.type === "interactIntent")) {
      const command =
        message.type === "moveIntent"
          ? transport.sendMove(message.x, message.y)
          : transport.sendInteract(message.targetType, message.targetId);
      void command.then(
        () => next.send({ type: "commandResult", requestId: message.requestId, accepted: true }),
        () => {
          next.send({ type: "commandResult", requestId: message.requestId, accepted: false });
          if (!replacingTransport) errors.push("World command rejected");
        },
      );
    }
  });
};

async function until(check: () => boolean, label: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (errors.length) throw new Error(errors.join("; "));
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}; events: ${trace.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function run() {
  const { Character } = await import("../../src/game/entities/Character");
  const { WorldScene } = await import("../../src/game/scenes/WorldScene");
  const originalUpdate = WorldScene.prototype.update;
  let lastTestFrame = 0;
  if (transport) {
    // Reproduce a <=30 FPS renderer receiving Phaser's smoothed 60 FPS delta.
    // Only presentation cadence is throttled; the real server clock is unchanged.
    WorldScene.prototype.update = function (time, delta) {
      const now = performance.now();
      if (now - lastTestFrame < 1000 / 30) return;
      lastTestFrame = now;
      originalUpdate.call(this, time, Math.min(delta, 1000 / 60));
      const circle = this.children.getByName("entrance-circle:library-door-exterior") as {
        x: number;
        y: number;
        on(event: string, callback: () => void): unknown;
      } | null;
      const canvas = document.querySelector("canvas");
      if (circle && canvas) {
        if (!observedCircles.has(circle)) {
          observedCircles.add(circle);
          circle.on("pointerdown", () => trace.push("circle-click"));
        }
        const camera = this.cameras.main;
        const position = camera.matrixCombined.transformPoint(circle.x, circle.y);
        const previous = JSON.parse(canvas.dataset.libraryCircle ?? "null") as {
          x: number;
          y: number;
        } | null;
        canvas.dataset.circleStable =
          previous && Math.hypot(previous.x - position.x, previous.y - position.y) < 0.2
            ? String(Number(canvas.dataset.circleStable ?? 0) + 1)
            : "0";
        canvas.dataset.libraryCircle = JSON.stringify(position);
      }
    };
  }
  const originalDraw = Character.prototype.draw;
  let sampleMovement = false;
  const samples: { time: number; x: number; y: number }[] = [];
  Character.prototype.draw = function (...args: Parameters<typeof originalDraw>) {
    originalDraw.apply(this, args);
    if (sampleMovement && this.id === "alice.testnet")
      samples.push({ time: performance.now(), x: this.x, y: this.y });
  };
  // Exercise the actual lazy demo crypto graph in a browser, where Node globals
  // are absent. Unit tests run in Node and cannot catch prebundle compatibility.
  const { registerDemoKey, demoSigner, demoTransaction, clearDemoKeys } =
    await import("../../src/wallet/demo-loader");
  const { KeyPair } = await import("near-api-js");
  const { nep413Digest } = await import("../../src/nep413");
  const key = KeyPair.fromRandom("ed25519");
  await registerDemoKey(true, "browser-smoke.testnet", key.getPublicKey().toString(), key.toString());
  const signer = await demoSigner(true, "browser-smoke.testnet");
  const payload = {
    message: "Local browser signing regression",
    recipient: location.origin,
    nonce: crypto.getRandomValues(new Uint8Array(32)),
  };
  const signed = await signer?.signMessage(payload);
  if (
    !signed ||
    !key.getPublicKey().verify(
      await nep413Digest(payload),
      Uint8Array.from(atob(signed.signature), (value) => value.charCodeAt(0)),
    )
  )
    throw new Error("Browser demo signature verification failed");
  // Exercise transaction signing as well as login. Never broadcast this fixture.
  const realFetch = window.fetch;
  let broadcastReached = false;
  window.fetch = async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    if (request.method.startsWith("broadcast") || request.method === "send_tx") {
      broadcastReached = true;
      throw new Error("Fixture deliberately prevents broadcasting");
    }
    if (request.method === "block")
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { header: { hash: "11111111111111111111111111111111", height: 1 } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    if (request.method !== "query" || request.params.request_type !== "view_access_key")
      throw new Error(`Unexpected fixture RPC method: ${request.method}/${request.params?.request_type}`);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          nonce: 1,
          permission: "FullAccess",
          block_hash: "11111111111111111111111111111111",
          block_height: 1,
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    await demoTransaction(true, "browser-smoke.testnet", {
      receiverId: "quizcity.testnet",
      methodName: "register_player",
      args: { username: "browser" },
    });
  } catch (error) {
    if (!broadcastReached)
      throw new Error(
        `Browser transaction failed before broadcast: ${error instanceof Error ? error.message : "unknown"}`,
        { cause: error },
      );
  } finally {
    window.fetch = realFetch;
  }
  if (!broadcastReached) throw new Error("Browser transaction did not reach the guarded broadcast fixture");
  await clearDemoKeys();
  if (await demoSigner(true, "browser-smoke.testnet"))
    throw new Error("Demo signing key survived logout cleanup");
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <GameHost onBridge={attach} />
    </StrictMode>,
  );
  await until(() => rendered === "city-district", "city bootstrap");
  if (document.querySelectorAll("canvas").length !== 1) throw new Error("Duplicate/missing canvas");
  if (new URLSearchParams(location.search).has("capture")) {
    const params = new URLSearchParams(location.search);
    const sceneId = params.get("scene") ?? (params.has("interior") ? "library-interior" : "city-district");
    const scene = worldScenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error("Unknown capture scene");
    const spawn = scene.spawns.find((item) => item.kind === "player_default")!;
    const capture = worldBootstrap(sceneId);
    capture.player.x = sceneId === "city-district" && !params.has("overview") ? 21 : spawn.x;
    capture.player.y = sceneId === "city-district" && !params.has("overview") ? 14 : spawn.y;
    bridge.send({ type: "settingsChanged", settings: { zoom: params.has("overview") ? 1 : 2 } });
    bridge.send({ type: "bootstrap", bootstrap: capture });
    await until(() => rendered === capture.scene.id, "visual review scene");
    document.getElementById("result")!.textContent = "CAPTURE";
    await until(() => document.getElementById("result")!.textContent === "CONTINUE", "screenshot capture");
    bridge.send({ type: "bootstrap", bootstrap: worldBootstrap() });
    await until(() => rendered === "city-district", "visual review return");
  }
  if (transport) {
    await until(() => online, "socket replay readiness");
    const started = performance.now(),
      baseline = checkpoints.length;
    sampleMovement = true;
    const focusButton = document.createElement("button");
    focusButton.textContent = "Focus recovery probe";
    document.body.append(focusButton);
    focusButton.focus();
    focusButton.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true }));
    await until(() => checkpoints.length >= baseline + 6, "six held-key movement checkpoints");
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyS", bubbles: true }));
    focusButton.remove();
    sampleMovement = false;
    const elapsed = performance.now() - started;
    let lastChange = started + 350,
      longestPause = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1],
        b = samples[i];
      if (b.time < started + 350) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) > 0.0001) lastChange = b.time;
      else longestPause = Math.max(longestPause, b.time - lastChange);
    }
    if (elapsed > 2300 || samples.length < 15 || longestPause > 180)
      throw new Error(
        `Held-key movement stalled: ${Math.round(elapsed)}ms for six steps, ${Math.round(longestPause)}ms stationary; checkpoints=${JSON.stringify(checkpoints.slice(baseline).map((p) => [Math.round(p.time - started), p.x, p.y]))}; samples=${JSON.stringify(samples.filter((_, i) => i % 8 === 0).map((p) => [Math.round(p.time - started), Number(p.x.toFixed(2)), Number(p.y.toFixed(2))]))}`,
      );
    const upBaseline = checkpoints.length;
    sampleMovement = true;
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowUp", bubbles: true }));
    await until(
      () =>
        checkpoints.slice(upBaseline).filter((point, index) => {
          const previous = checkpoints[upBaseline + index - 1];
          return previous && point.x < previous.x && point.y < previous.y;
        }).length >= 6,
      "six straight Up checkpoints",
    );
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowUp", bubbles: true }));
    sampleMovement = false;
    const screenXs = samples.map((point) => (point.x - point.y) * 16);
    const sidewaysDrift = Math.max(...screenXs) - Math.min(...screenXs);
    if (sidewaysDrift > 0.75)
      throw new Error(`Vertical movement zigzagged ${sidewaysDrift.toFixed(2)} pixels sideways`);
    const beforeBootstrap = bootstrapCount;
    replacingTransport = true;
    transport.disconnect();
    transport = createWorldTransport({ apiBase: apiBase! });
    bindTransport(transport);
    transport.connect("city-district", null);
    await until(() => online && bootstrapCount > beforeBootstrap, "fresh transport after navigation");
    replacingTransport = false;
    const afterReentry = checkpoints.length;
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", bubbles: true }));
    await until(() => checkpoints.length > afterReentry, "first move after navigation without ID conflicts");
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", bubbles: true }));
    bridge!.emit({ type: "moveIntent", requestId: "browser-move", x: 20, y: 10 });
    await until(
      () => checkpoint && checkpoints.at(-1)?.x === 20 && checkpoints.at(-1)?.y === 10,
      "real server movement checkpoint",
    );
    const canvas = document.querySelector("canvas")!;
    await until(
      () => !!canvas.dataset.libraryCircle && Number(canvas.dataset.circleStable) >= 3,
      "settled camera and clickable library circle",
    );
    const circle = JSON.parse(canvas.dataset.libraryCircle!) as { x: number; y: number };
    const bounds = canvas.getBoundingClientRect();
    document.getElementById("result")!.textContent = `CLICK:${JSON.stringify({
      x: bounds.left + (circle.x * bounds.width) / canvas.width,
      y: bounds.top + (circle.y * bounds.height) / canvas.height,
    })}`;
    await until(() => document.getElementById("result")!.textContent === "CLICKED", "native browser click");
    await until(
      () => rendered === "library-interior",
      `circle approach and server-authorized library entry (${JSON.stringify(circle)}; ${JSON.stringify(checkpoints.slice(-3))})`,
    );
    bridge!.emit({ type: "moveIntent", requestId: "approach-kofi", x: 6, y: 9 });
    await until(
      () => checkpoints.at(-1)?.x === 6 && checkpoints.at(-1)?.y === 9,
      "approach visible Professor Kofi",
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE", bubbles: true }));
    await until(() => interactionCompleted === "professor-kofi", "confirmed NPC dialogue interaction");
    bridge!.emit({ type: "moveIntent", requestId: "approach-librarian", x: 4, y: 8 });
    await until(() => checkpoints.at(-1)?.x === 4 && checkpoints.at(-1)?.y === 8, "approach librarian Ama");
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE", bubbles: true }));
    await until(() => interactionCompleted === "librarian-ama", "confirmed librarian dialogue interaction");
    bridge!.emit({ type: "moveIntent", requestId: "return-to-library-door", x: 12, y: 16 });
    await until(() => checkpoints.at(-1)?.x === 12 && checkpoints.at(-1)?.y === 16, "reach library exit");
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE", bubbles: true }));
    await until(() => rendered === "city-district", "leave library");
    bridge!.emit({ type: "moveIntent", requestId: "walk-to-apartment", x: 10, y: 36 });
    await until(
      () => checkpoints.at(-1)?.x === 10 && checkpoints.at(-1)?.y === 36,
      "reach apartment entrance",
      20000,
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE", bubbles: true }));
    await until(() => rendered === "apartment-interior", "enter apartment");
    transport.disconnect();
    root.unmount();
    Character.prototype.draw = originalDraw;
    WorldScene.prototype.update = originalUpdate;
    await until(() => document.querySelectorAll("canvas").length === 0, "stack canvas cleanup");
    return `PASS: <=30 FPS smoothed-clock regression, six steps ${Math.round(elapsed)}ms, pause ${Math.round(longestPause)}ms, drift ${sidewaysDrift.toFixed(2)}px, focus, fresh transport, library/NPC, apartment entrance, teardown`;
  }
  for (let round = 0; round < 2; round++) {
    for (const scene of worldScenes.filter((item) => item.id !== "city-district")) {
      const bootstrap = worldBootstrap(scene.id);
      const spawn = scene.spawns[0];
      bootstrap.scene.width = scene.width;
      bootstrap.scene.height = scene.height;
      bootstrap.player.x = spawn.x;
      bootstrap.player.y = spawn.y;
      bridge!.send({ type: "bootstrap", bootstrap });
      await until(() => rendered === scene.id, `${scene.id} bootstrap`);
      bridge!.send({ type: "bootstrap", bootstrap: worldBootstrap() });
      await until(() => rendered === "city-district", "return bootstrap");
      if (document.querySelectorAll("canvas").length !== 1) throw new Error("Canvas leaked across scenes");
    }
  }
  rendered = "";
  bridge!.emit({ type: "fatalError", message: "intentional retry test" });
  await until(() => !!document.querySelector(".game-error button"), "retry control");
  (document.querySelector(".game-error button") as HTMLButtonElement).click();
  await until(() => rendered === "city-district", "retry bootstrap");
  if (document.querySelectorAll("canvas").length !== 1) throw new Error("Duplicate canvas after retry");
  root.unmount();
  await until(() => document.querySelectorAll("canvas").length === 0, "canvas cleanup");
  if (errors.length) throw new Error(errors.join("; "));
  return "PASS: real Phaser boot, Strict Mode, all six scenes, ten interior round trips, retry, one canvas, teardown";
}

void run().then(
  (message) => {
    document.getElementById("result")!.textContent = message;
  },
  (cause) => {
    document.getElementById("result")!.textContent = `FAIL: ${String(cause)}`;
  },
);
