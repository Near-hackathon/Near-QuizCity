import { render, screen, waitFor } from "@testing-library/react";
import { RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRouter } from "./router";
import { StateProvider } from "../state/StateProvider";

const api = vi.hoisted(() => ({
  profiles: vi.fn(),
  config: vi.fn(),
  authMe: vi.fn(),
  properties: vi.fn(),
  businesses: vi.fn(),
  jobs: vi.fn(),
  quizzes: vi.fn(),
  wallets: vi.fn(),
  transactions: vi.fn(),
  economy: vi.fn(),
}));
const chain = vi.hoisted(() => ({
  loadSession: vi.fn(),
  view: vi.fn(),
  clearSession: vi.fn(),
  saveSession: vi.fn(),
}));
const auth = vi.hoisted(() => ({ ensureAuth: vi.fn(), logout: vi.fn() }));
const gameHost = vi.hoisted(() => vi.fn(() => <div data-testid="game-host" />));

vi.mock("../api", () => ({ api }));
vi.mock("../chain", () => chain);
vi.mock("../auth", () => auth);
vi.mock("../wallet/demo-loader", () => ({
  demoSigner: async () => ({
    accountId: "alice.testnet",
    signMessage: async () => ({
      accountId: "alice.testnet",
      publicKey: "ed25519:11111111111111111111111111111111",
      signature: "signature",
    }),
  }),
  registerDemoKey: vi.fn(),
  demoTransaction: vi.fn(),
}));
const wallet = vi.hoisted(() => ({
  account: null,
  connector: null,
  connecting: false,
  error: null,
  connect: vi.fn(),
  restore: vi.fn(),
  disconnect: vi.fn(),
  signer: vi.fn(),
  sendTransaction: vi.fn(),
}));
vi.mock("../wallet/WalletProvider", () => ({ useWallet: () => wallet }));
vi.mock("../game/GameHost", () => ({ GameHost: gameHost }));

const session = {
  accountId: "alice.testnet",
  networkId: "testnet",
  walletId: "demo",
  authenticatedAt: "2026-11-13T00:00:00.000Z",
};

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  Object.values(chain).forEach((mock) => mock.mockReset());
  Object.values(auth).forEach((mock) => mock.mockReset());
  chain.loadSession.mockReturnValue(null);
  chain.view.mockResolvedValue(null);
  api.profiles.mockResolvedValue({ profiles: [] });
  api.config.mockResolvedValue({
    demoMode: false,
    networkId: "testnet",
    contractId: "quizcity.testnet",
    protocolVersion: "1.0.0",
  });
  api.properties.mockResolvedValue([]);
  api.businesses.mockResolvedValue([]);
  api.jobs.mockResolvedValue([]);
  api.quizzes.mockResolvedValue([]);
  api.wallets.mockResolvedValue([]);
  api.transactions.mockResolvedValue([]);
  api.economy.mockResolvedValue({
    circulating_qc: "0",
    mirrored_wallet_sum: "0",
    supply_difference: "0",
    players: 0,
    properties: 0,
    businesses: 0,
    transactions: 0,
  });
  api.authMe.mockResolvedValue({
    accountId: "alice.testnet",
    roles: ["player"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  auth.ensureAuth.mockResolvedValue({
    accountId: "alice.testnet",
    roles: ["player"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
});

async function renderRoute(path: string) {
  const router = createTestRouter([path]);
  render(
    <StateProvider>
      <RouterProvider router={router} />
    </StateProvider>,
  );
  return router;
}

describe("application router", () => {
  it("renders the landing page at / without fetching game or admin data", async () => {
    await renderRoute("/");
    expect(await screen.findByText("Your story.")).toBeInTheDocument();
    expect(api.properties).not.toHaveBeenCalled();
    expect(api.wallets).not.toHaveBeenCalled();
    expect(api.transactions).not.toHaveBeenCalled();
  });

  it("redirects manage to the city when signed out", async () => {
    const router = await renderRoute("/manage");
    expect(await screen.findByText("Your story.")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("loads manage and admin only with the required session and role", async () => {
    chain.loadSession.mockReturnValue(session);
    const router = await renderRoute("/manage");
    expect(await screen.findByText("QC balance")).toBeInTheDocument();
    expect(api.jobs).toHaveBeenCalled();
    router.dispose();
  });

  it("does not mount a game host for manage or admin", async () => {
    chain.loadSession.mockReturnValue(session);
    gameHost.mockClear();
    const manage = await renderRoute("/manage");
    expect(await screen.findByText("QC balance")).toBeInTheDocument();
    expect(screen.queryByTestId("game-host")).not.toBeInTheDocument();
    expect(gameHost).not.toHaveBeenCalled();
    manage.dispose();

    const admin = await renderRoute("/admin");
    expect(await screen.findByText("Not authorized")).toBeInTheDocument();
    expect(gameHost).not.toHaveBeenCalled();
    admin.dispose();
  });

  it("denies admin to players and allows operators", async () => {
    chain.loadSession.mockReturnValue(session);
    const denied = await renderRoute("/admin");
    expect(await screen.findByText("Not authorized")).toBeInTheDocument();
    denied.dispose();

    api.authMe.mockResolvedValue({
      accountId: "alice.testnet",
      roles: ["player", "operator"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await renderRoute("/admin");
    expect(await screen.findByText("Ledger")).toBeInTheDocument();
    expect(api.transactions).toHaveBeenCalled();
  });

  it("renders valid interiors, rejects invalid identifiers, and shows not-found", async () => {
    chain.loadSession.mockReturnValue(session);
    const valid = await renderRoute("/interior/library");
    expect(await screen.findByText("Interior: library")).toBeInTheDocument();
    valid.dispose();

    const invalid = await renderRoute("/interior/BAD%20ID");
    expect(await screen.findByText("Invalid interior")).toBeInTheDocument();
    invalid.dispose();

    await renderRoute("/does-not-exist");
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });
});
