import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Property } from "./api";
import { registerDemoKey } from "./wallet/demo-loader";

const api = vi.hoisted(() => ({
  config: vi.fn(),
  demoAccounts: vi.fn(),
  properties: vi.fn(),
  businesses: vi.fn(),
  jobs: vi.fn(),
  quizzes: vi.fn(),
  wallets: vi.fn(),
  transactions: vi.fn(),
  economy: vi.fn(),
  authMe: vi.fn(),
}));
const chain = vi.hoisted(() => ({
  call: vi.fn(),
  view: vi.fn(),
  loadSession: vi.fn(
    () =>
      null as null | {
        accountId: string;
        publicKey?: string;
        networkId: string;
        walletId: string;
        authenticatedAt: string;
      },
  ),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}));
const auth = vi.hoisted(() => ({ ensureAuth: vi.fn(), logout: vi.fn() }));
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

vi.mock("./api", () => ({ api }));
vi.mock("./chain", () => chain);
vi.mock("./auth", () => auth);
vi.mock("./wallet/demo-loader", () => ({
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
vi.mock("./wallet/WalletProvider", () => ({
  useWallet: () => wallet,
}));

const { App } = await import("./App");
const { StateProvider } = await import("./state/StateProvider");

function renderApp() {
  return render(
    <StateProvider>
      <App />
    </StateProvider>,
  );
}

const property: Property = {
  id: "1",
  district: "knowledge",
  x: 0,
  y: 0,
  owner_wallet: "player:alice.testnet",
  property_type: "venue",
  price: "300",
  for_sale: true,
  transfer_count: "1",
};

beforeEach(() => {
  vi.mocked(registerDemoKey).mockReset();
  Object.values(api).forEach((mock) => mock.mockReset());
  Object.values(chain).forEach((mock) => mock.mockReset());
  Object.values(auth).forEach((mock) => mock.mockReset());
  chain.loadSession.mockReturnValue(null);
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
    circulating_qc: "9007199254740993",
    mirrored_wallet_sum: "9007199254740993",
    supply_difference: "0",
    players: 2,
    properties: 1,
    businesses: 1,
    transactions: 8,
  });
});

describe("App", () => {
  it("shows loading while authenticating and publishes the selected account only after server sign-in", async () => {
    api.config.mockResolvedValue({ demoMode: true, networkId: "testnet", contractId: "quizcity.testnet" });
    api.demoAccounts.mockResolvedValue({
      accounts: [{ accountId: "alice.testnet", publicKey: "unused", secretKey: "unused" }],
    });
    let finish!: (value: { accountId: string; roles: string[]; expiresAt: string }) => void;
    auth.ensureAuth.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderApp();
    await userEvent.setup().click(await screen.findByRole("button", { name: /alice.*alice.testnet/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("Signing you in");
    expect(screen.queryByText("Register as a resident")).not.toBeInTheDocument();
    expect(screen.queryByText("Knowledge / Commercial District")).not.toBeInTheDocument();
    expect(chain.saveSession).not.toHaveBeenCalled();
    await act(async () =>
      finish({ accountId: "alice.testnet", roles: ["player"], expiresAt: "2099-01-01T00:00:00Z" }),
    );
    await waitFor(() =>
      expect(chain.saveSession).toHaveBeenCalledWith(expect.objectContaining({ accountId: "alice.testnet" })),
    );
  });
  it("shows a safe demo key-load failure without saving a session or leaking diagnostics", async () => {
    api.config.mockResolvedValue({ demoMode: true, networkId: "testnet", contractId: "quizcity.testnet" });
    api.demoAccounts.mockResolvedValue({
      accounts: [{ accountId: "alice.testnet", publicKey: "unused", secretKey: "unused" }],
    });
    vi.mocked(registerDemoKey).mockRejectedValueOnce(new Error("internal key-loader details"));
    renderApp();
    await userEvent.setup().click(await screen.findByRole("button", { name: /alice.*alice.testnet/ }));
    expect(
      await screen.findByText("Demo sign-in could not start. Refresh the page and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText("internal key-loader details")).not.toBeInTheDocument();
    expect(chain.saveSession).not.toHaveBeenCalled();
  });
  it("renders the read-only dashboard with exact economy values", async () => {
    const { container } = renderApp();
    expect(await screen.findByText("Knowledge / Commercial District")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("9,007,199,254,740,993")).toBeInTheDocument());
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/ed25519:|csrf|signature/i);
  });

  it("shows a safe API failure notice and recovers on explicit retry", async () => {
    const user = userEvent.setup();
    api.properties.mockRejectedValueOnce(new Error("api unavailable"));
    renderApp();
    expect(await screen.findByText("api unavailable")).toBeInTheDocument();

    api.properties.mockResolvedValue([property]);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("venue")).toBeInTheDocument();
  });

  it("shows an authenticated session transition and auth failure safely", async () => {
    chain.loadSession.mockReturnValue({
      accountId: "alice.testnet",
      publicKey: "ed25519:11111111111111111111111111111111",
      networkId: "testnet",
      walletId: "demo",
      authenticatedAt: "2026-11-13T00:00:00.000Z",
    });
    auth.ensureAuth.mockResolvedValue({
      accountId: "alice.testnet",
      roles: ["player"],
      expiresAt: "2026-11-13T00:00:00.000Z",
    });
    const { container, unmount } = renderApp();
    expect(await screen.findByRole("button", { name: "Switch account" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/ed25519:|signature/i);
    unmount();

    auth.ensureAuth.mockRejectedValueOnce(new Error("wallet rejected"));
    renderApp();
    expect(await screen.findByText("sign-in failed: wallet rejected")).toBeInTheDocument();
  });
});
