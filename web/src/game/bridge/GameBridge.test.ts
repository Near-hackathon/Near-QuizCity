import { describe, expect, it, vi } from "vitest";
import { createGameBridge } from "./GameBridge";

describe("GameBridge", () => {
  it("delivers both channels and can unsubscribe twice", () => {
    const bridge = createGameBridge();
    const toGame = vi.fn();
    const toReact = vi.fn();
    const offGame = bridge.onReact(toGame);
    const offReact = bridge.subscribe(toReact);
    bridge.send({ type: "dispose" });
    bridge.emit({ type: "gameReady" });
    expect(toGame).toHaveBeenCalledWith({ type: "dispose" });
    expect(toReact).toHaveBeenCalledWith({ type: "gameReady" });
    offGame();
    offGame();
    offReact();
    offReact();
    bridge.send({ type: "dispose" });
    bridge.emit({ type: "gameReady" });
    expect(toGame).toHaveBeenCalledTimes(1);
    expect(toReact).toHaveBeenCalledTimes(1);
  });

  it("disposes idempotently and makes later subscriptions no-op", () => {
    const bridge = createGameBridge();
    const listener = vi.fn();
    bridge.dispose();
    bridge.dispose();
    const off = bridge.subscribe(listener);
    off();
    bridge.emit({ type: "gameReady" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("retains readiness and settings across delayed engine/react subscriptions", () => {
    const bridge = createGameBridge();
    bridge.emit({ type: "gameReady" });
    expect(bridge.isReady()).toBe(true);
    bridge.send({ type: "transportStatus", status: "resyncing" });
    bridge.send({ type: "settingsChanged", settings: { zoom: 3, reducedMotion: true } });
    bridge.send({ type: "settingsChanged", settings: { hidden: false } });
    const listener = vi.fn();
    bridge.onReact(listener);
    expect(listener).toHaveBeenCalledWith({ type: "transportStatus", status: "resyncing" });
    expect(listener).toHaveBeenCalledWith({
      type: "settingsChanged",
      settings: { zoom: 3, reducedMotion: true, hidden: false },
    });
    bridge.dispose();
    expect(bridge.isReady()).toBe(false);
  });
});
