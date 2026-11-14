import { act, StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GameHost } from "./GameHost";
import type { GameBridge } from "./bridge/GameBridge";

function game(destroy = vi.fn()) {
  return { destroy } as never;
}

describe("GameHost", () => {
  it("focus changes preserve the modal state owned by the phone", async () => {
    let bridge!: GameBridge;
    render(
      <GameHost
        createGameFn={(_parent, b) => {
          bridge = b;
          return game();
        }}
      />,
    );
    await waitFor(() => expect(bridge).toBeDefined());
    act(() => {
      bridge.send({ type: "settingsChanged", settings: { uiModalOpen: true } });
      document.dispatchEvent(new FocusEvent("focusin"));
    });
    const retained = vi.fn();
    bridge.onReact(retained);
    expect(retained).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "settingsChanged",
        settings: expect.objectContaining({ uiModalOpen: true }),
      }),
    );
    act(() => {
      bridge.send({ type: "settingsChanged", settings: { uiModalOpen: false } });
      document.dispatchEvent(new FocusEvent("focusout"));
    });
    const closed = vi.fn();
    bridge.onReact(closed);
    expect(closed).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "settingsChanged",
        settings: expect.objectContaining({ uiModalOpen: false }),
      }),
    );
  });
  it("keeps the loading screen visible until the scene renders", async () => {
    let bridge!: GameBridge;
    render(
      <GameHost
        createGameFn={(_parent, b) => {
          bridge = b;
          return game();
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Preparing city assets");
    await waitFor(() => expect(bridge).toBeDefined());
    act(() => bridge.emit({ type: "gameReady" }));
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to the city");
    act(() => bridge.emit({ type: "sceneRendered", sceneId: "city-district" }));
    expect(screen.queryByRole("region", { name: "Loading Quiz City" })).not.toBeInTheDocument();
  });
  it("allocates one live game under StrictMode and destroys it on unmount", async () => {
    const destroy = vi.fn();
    const factory = vi.fn(() => game(destroy));
    const view = render(
      <StrictMode>
        <GameHost createGameFn={factory} />
      </StrictMode>,
    );
    await waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    expect(destroy).not.toHaveBeenCalled();
    view.unmount();
    expect(destroy).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("disposes before detaching and destroys with removeCanvas=true", async () => {
    const order: string[] = [];
    let bridge!: GameBridge;
    const instance = {
      destroy: (remove: boolean) => {
        order.push(`destroy:${remove}`);
      },
    } as never;
    const factory = vi.fn().mockImplementation((_parent: HTMLElement, b: GameBridge) => {
      bridge = b;
      b.onReact((message) => {
        if (message.type === "dispose") order.push("dispose");
      });
      return instance;
    });
    const view = render(<GameHost createGameFn={factory} />);
    await waitFor(() => expect(factory).toHaveBeenCalled());
    view.unmount();
    expect(order).toEqual(["dispose", "destroy:true"]);
    bridge.emit({ type: "fatalError", message: "late" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not retain an async factory result after cleanup", async () => {
    let resolve!: (value: never) => void;
    const factory = vi.fn(
      () =>
        new Promise<never>((r) => {
          resolve = r;
        }),
    );
    const destroy = vi.fn();
    const view = render(<GameHost createGameFn={factory} />);
    await waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    view.unmount();
    resolve(game(destroy));
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledWith(true);
  });

  it("shows factory errors and fatal errors, then retries with a new host", async () => {
    const first = vi.fn().mockRejectedValueOnce(new Error("factory broke"));
    const second = vi.fn().mockImplementation((_parent: HTMLElement, bridge: GameBridge) => {
      bridge.emit({ type: "fatalError", message: "fatal" });
      return game();
    });
    const factory = vi.fn().mockImplementationOnce(first).mockImplementationOnce(second);
    render(<GameHost createGameFn={factory} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveFocus();
  });

  it("waits for asynchronous engine destruction before constructing a replacement", async () => {
    let release!: () => void;
    const destroyed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bridge!: GameBridge;
    const destroy = vi.fn(() => destroyed);
    const factory = vi.fn((_parent: HTMLElement, next: GameBridge) => {
      bridge = next;
      return { destroy };
    });
    render(<GameHost createGameFn={factory} />);
    await waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    act(() => bridge.emit({ type: "fatalError", message: "retry test" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
  });
});
