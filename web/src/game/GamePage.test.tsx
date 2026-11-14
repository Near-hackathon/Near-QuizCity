import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { GamePage } from "./GamePage";
import type { GameBridge } from "./bridge/GameBridge";
import type { WorldTransport } from "../state/world-transport";
import { StateProvider } from "../state/StateProvider";
import { worldBootstrap as bootstrap, playerCheckpoint as event } from "../test/world-fixtures";
import { clearSession, type Session } from "../chain";
import type { WorldEventType, WorldServerMessageType } from "@quiz-city/protocol";
import type { WorldStatus } from "../state/world-transport";
import { StrictMode } from "react";
import { api } from "../api";
vi.mock("../api", () => ({ api: { authMe: vi.fn() } }));

const authState = vi.hoisted(() => ({
  session: {
    accountId: "alice.testnet",
    networkId: "testnet",
    walletId: "demo",
    authenticatedAt: "2026-01-01T00:00:00.000Z",
  } as Session | null,
}));
const signOutMocks = vi.hoisted(() => ({ logout: vi.fn(), disconnect: vi.fn(), clearDemoKeys: vi.fn() }));
vi.mock("../auth", () => ({ logout: signOutMocks.logout }));
vi.mock("../wallet/WalletProvider", () => ({ useWallet: () => ({ disconnect: signOutMocks.disconnect }) }));
vi.mock("../wallet/demo-loader", () => ({ clearDemoKeys: signOutMocks.clearDemoKeys }));
vi.mock("../chain", () => ({
  loadSession: vi.fn(() => authState.session),
  clearSession: vi.fn(() => {
    authState.session = null;
  }),
}));
vi.mock("../App", () => ({ App: () => <div data-testid="signed-out-app" /> }));
vi.mock("./ui/GameUi", () => ({
  GameUi: ({ onSignOut }: { onSignOut: () => Promise<void> }) => (
    <button onClick={() => void onSignOut()}>Sign out</button>
  ),
}));

function transport(): WorldTransport & {
  emitMessage: (message: WorldServerMessageType) => void;
  emitEvent: (event: WorldEventType) => void;
  emitStatus: (status: WorldStatus) => void;
} {
  const messages = new Set<(message: WorldServerMessageType) => void>();
  const events = new Set<(event: WorldEventType) => void>();
  const statuses = new Set<(status: WorldStatus) => void>();
  return {
    connect: vi.fn(),
    sendMove: vi.fn().mockResolvedValue("m"),
    sendInteract: vi.fn().mockResolvedValue("i"),
    disconnect: vi.fn(),
    lastSequence: vi.fn(() => null),
    onMessage: vi.fn((fn) => {
      messages.add(fn);
      return () => messages.delete(fn);
    }),
    onEvent: vi.fn((fn) => {
      events.add(fn);
      return () => events.delete(fn);
    }),
    onStatus: vi.fn((fn) => {
      statuses.add(fn);
      fn("offline");
      return () => statuses.delete(fn);
    }),
    emitMessage: (message) => messages.forEach((fn) => fn(message)),
    emitEvent: (event) => events.forEach((fn) => fn(event)),
    emitStatus: (status) => statuses.forEach((fn) => fn(status)),
  };
}
function renderPage(t: WorldTransport, path = "/play", fatal = false, strict = false) {
  const received: unknown[] = [];
  let bridgeRef!: GameBridge;
  const factory = vi.fn((_parent: HTMLElement, bridge: GameBridge) => {
    bridgeRef = bridge;
    bridge.onReact((message) => received.push(message));
    // Deliberately synchronous: readiness must survive emission before the parent effect.
    if (fatal) bridge.emit({ type: "fatalError", message: "fatal" });
    else bridge.emit({ type: "gameReady" });
    return { destroy: vi.fn() } as never;
  });
  return {
    view: render(
      <StrictModeWrapper enabled={strict}>
        <StateProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route
                path="/"
                element={
                  <>
                    <div data-testid="signed-out-app" />
                    <LocationProbe />
                  </>
                }
              />
              <Route
                path="*"
                element={
                  <>
                    <GamePage transport={t} createGameFn={factory} />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </StateProvider>
      </StrictModeWrapper>,
    ),
    factory,
    received,
    bridge: () => bridgeRef,
  };
}
function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.pathname}</output>
      <button onClick={() => navigate("/interior/forged")}>Change URL</button>
    </>
  );
}
function StrictModeWrapper({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return enabled ? <StrictMode>{children}</StrictMode> : <>{children}</>;
}

describe("GamePage", () => {
  it("offers an immediate full reconnect while waiting for automatic recovery", async () => {
    const t = transport();
    renderPage(t);
    await waitFor(() => expect(t.connect).toHaveBeenCalledTimes(1));
    act(() => t.emitStatus("reconnecting"));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }));
    expect(t.connect).toHaveBeenLastCalledWith("city-district", null);
    expect(t.connect).toHaveBeenCalledTimes(2);
    act(() => t.emitStatus("online"));
    expect(screen.queryByRole("button", { name: "Reconnect now" })).not.toBeInTheDocument();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.authMe).mockResolvedValue({
      accountId: "alice.testnet",
      roles: ["player"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    authState.session = {
      accountId: "alice.testnet",
      networkId: "testnet",
      walletId: "demo",
      authenticatedAt: "2026-01-01T00:00:00.000Z",
    };
  });

  it("signs out from an interior, disconnects the world and clears local credentials even if wallet disconnect fails", async () => {
    const t = transport();
    const { factory, bridge } = renderPage(t, "/interior/library-interior");
    await waitFor(() => expect(t.connect).toHaveBeenCalledTimes(1));
    await act(async () => t.emitMessage(bootstrap("library-interior")));
    signOutMocks.disconnect.mockRejectedValueOnce(new Error("wallet unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByTestId("signed-out-app");
    expect(signOutMocks.logout).toHaveBeenCalledTimes(1);
    expect(signOutMocks.disconnect).toHaveBeenCalledTimes(1);
    expect(signOutMocks.clearDemoKeys).toHaveBeenCalledTimes(1);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(authState.session).toBeNull();
    expect(t.disconnect).toHaveBeenCalled();
    await waitFor(() => expect(factory.mock.results[0].value.destroy).toHaveBeenCalledTimes(1));
    expect(bridge()?.isReady()).toBe(false);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
  });

  it("waits for gameReady, connects city/interior scenes, and forwards every bootstrap", async () => {
    const t = transport();
    const { view, received } = renderPage(t);
    expect(t.connect).not.toHaveBeenCalled();
    await waitFor(() => expect(t.connect).toHaveBeenCalledWith("city-district", null));
    await act(async () => {
      t.emitMessage(bootstrap());
      t.emitMessage(bootstrap("library"));
    });
    await waitFor(() =>
      expect(received.filter((message: any) => message.type === "bootstrap")).toHaveLength(2),
    );
    view.unmount();

    const interior = transport();
    renderPage(interior, "/interior/library");
    await waitFor(() => expect(interior.connect).toHaveBeenCalledWith("library", null));
  });

  it("navigates exterior bootstraps to the city route", async () => {
    const t = transport();
    renderPage(t, "/interior/old");
    await waitFor(() => expect(t.connect).toHaveBeenCalledWith("old", null));
    await act(async () => t.emitMessage(bootstrap("city-district")));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/play$/));
    expect(t.connect).toHaveBeenCalledTimes(1);
  });

  it("uses an authoritative bootstrap after a scene mismatch without reconnecting the transport", async () => {
    const t = transport();
    renderPage(t, "/interior/old");
    await waitFor(() => expect(t.connect).toHaveBeenCalledWith("old", null));
    await act(async () => t.emitMessage(bootstrap("city-district")));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/play$/));
    expect(t.disconnect).not.toHaveBeenCalled();
    expect(t.connect).toHaveBeenCalledTimes(1);
  });

  it("navigates a local city-district scene change home without reconnecting", async () => {
    const t = transport();
    renderPage(t, "/interior/old");
    await waitFor(() => expect(t.connect).toHaveBeenCalledWith("old", null));
    await act(async () =>
      t.emitEvent({
        ...event(),
        type: "player.scene_changed",
        sceneId: "old",
        streamId: "scene:old",
        sequence: "1",
        entity: { entityType: "player", entityId: "alice.testnet" },
        payload: { accountId: "alice.testnet", sceneId: "city-district", x: 1, y: 1, facing: "south" },
      }),
    );
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/play$/));
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.disconnect).not.toHaveBeenCalled();
  });

  it("does not connect to a malformed interior identifier", async () => {
    const t = transport();
    renderPage(t, "/interior/%5Bbad%5D");
    await waitFor(() => expect(t.connect).toHaveBeenCalledWith("city-district", null));
    expect(t.connect).not.toHaveBeenCalledWith("[bad]", null);
  });

  it("forwards only transport events from onEvent once and renders status", async () => {
    const t = transport();
    const { received } = renderPage(t);
    await waitFor(() => expect(t.connect).toHaveBeenCalled());
    await act(async () => {
      t.emitStatus("online");
    });
    expect(await screen.findByText("World: online")).toBeInTheDocument();
    await act(async () => {
      t.emitEvent(event());
    });
    expect(received.filter((message: any) => message.type === "worldEvent")).toHaveLength(1);
  });

  it("sends intents once and reports rejection while keeping a healthy connection online", async () => {
    const t = transport();
    const { bridge } = renderPage(t);
    await waitFor(() => expect(t.connect).toHaveBeenCalled());
    const move = t.sendMove as ReturnType<typeof vi.fn>;
    const interact = t.sendInteract as ReturnType<typeof vi.fn>;
    move.mockRejectedValueOnce(new Error("offline"));
    await act(async () => t.emitStatus("online"));
    bridge().emit({ type: "moveIntent", requestId: "move-1", x: 1, y: 2 });
    bridge().emit({ type: "interactIntent", requestId: "interact-1", targetType: "npc", targetId: "n1" });
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(interact).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be accepted");
    expect(screen.getByText("World: online")).toBeInTheDocument();
  });

  it("disconnects and removes listeners on unmount", async () => {
    const t = transport();
    const { view } = renderPage(t);
    await waitFor(() => expect(t.connect).toHaveBeenCalled());
    view.unmount();
    expect(t.disconnect).toHaveBeenCalledTimes(1);
    t.emitEvent(event());
    expect(t.onEvent).toHaveBeenCalledTimes(1);
  });

  it("shows fatal errors with a focused retry", async () => {
    const t = transport();
    const { factory } = renderPage(t, "/interior/unknown", true);
    expect(await screen.findByRole("alert")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(t.connect).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("does not create transport or game while signed out, then remounts on session change", async () => {
    authState.session = null;
    const t = transport();
    const { factory } = renderPage(t);
    expect(factory).not.toHaveBeenCalled();
    expect(t.connect).not.toHaveBeenCalled();
    authState.session = {
      accountId: "alice.testnet",
      networkId: "testnet",
      walletId: "demo",
      authenticatedAt: "2026-01-01T00:00:00.000Z",
    };
    await act(async () => {
      window.dispatchEvent(new Event("qc:session-changed"));
    });
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    // A real entry explicitly navigates back to /play after establishing the session.
  });

  it("retains synchronous readiness under StrictMode without duplicate connects", async () => {
    const t = transport();
    const { factory, view } = renderPage(t, "/play", false, true);
    await waitFor(() => expect(t.connect).toHaveBeenCalledTimes(1));
    expect(factory).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(t.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not mount a game for an expired or mismatched server session", async () => {
    vi.mocked(api.authMe).mockResolvedValue({
      accountId: "bob.testnet",
      roles: ["player"],
      expiresAt: "2099-01-01T00:00:00Z",
    });
    const t = transport();
    const { factory } = renderPage(t);
    expect(await screen.findByTestId("signed-out-app")).toBeInTheDocument();
    expect(factory).not.toHaveBeenCalled();
    expect(t.connect).not.toHaveBeenCalled();
  });

  it("normalizes URL-only navigation without remounting or issuing interactions", async () => {
    const t = transport();
    const { factory } = renderPage(t);
    await waitFor(() => expect(t.connect).toHaveBeenCalledTimes(1));
    await act(async () => t.emitMessage(bootstrap()));
    fireEvent.click(screen.getByText("Change URL"));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/play$/));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(t.sendInteract).not.toHaveBeenCalled();
    expect(t.disconnect).not.toHaveBeenCalled();
  });

  it("disconnects the old account and recreates its game after a verified account switch", async () => {
    const t = transport();
    const { factory } = renderPage(t);
    await waitFor(() => expect(t.connect).toHaveBeenCalledTimes(1));
    authState.session = { ...authState.session!, accountId: "bob.testnet" };
    vi.mocked(api.authMe).mockResolvedValue({
      accountId: "bob.testnet",
      roles: ["player"],
      expiresAt: "2099-01-01T00:00:00Z",
    });
    await act(async () => window.dispatchEvent(new Event("qc:session-changed")));
    await waitFor(() => expect(t.connect).toHaveBeenCalledTimes(2));
    expect(t.disconnect).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
