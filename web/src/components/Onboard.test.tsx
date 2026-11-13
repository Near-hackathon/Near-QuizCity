import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "../test/axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainPlayer, Session } from "../chain";

const api = {
  config: vi.fn(),
  demoAccounts: vi.fn(),
  register: vi.fn(),
  claim: vi.fn(),
};
const call = vi.fn();

vi.mock("../api", () => ({ api }));
vi.mock("../chain", () => ({ call }));

const { Onboard } = await import("./Onboard");

const session: Session = {
  accountId: "alice.testnet",
  publicKey: "ed25519:11111111111111111111111111111111",
  secretKey: "ed25519:22222222222222222222222222222222",
};

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  call.mockReset();
  api.config.mockResolvedValue({ demoMode: false, networkId: "testnet", contractId: "quizcity.testnet" });
  api.demoAccounts.mockResolvedValue({ networkId: "testnet", contractId: "quizcity.testnet", accounts: [] });
});

describe("Onboard", () => {
  it("shows loading and read-only states without a secret-bearing picker", async () => {
    render(
      <Onboard session={null} chainPlayer={null} onLogin={vi.fn()} onLogout={vi.fn()} refresh={vi.fn()} />,
    );
    expect(screen.getByText(/Loading deployment configuration/)).toBeInTheDocument();
    expect(await screen.findByText(/This deployment is read-only/)).toBeInTheDocument();
    expect(screen.queryByText(/localStorage/)).not.toBeInTheDocument();
  });

  it("renders only demo accounts when demo mode is enabled", async () => {
    const user = userEvent.setup();
    api.config.mockResolvedValue({ demoMode: true, networkId: "testnet", contractId: "quizcity.testnet" });
    api.demoAccounts.mockResolvedValue({
      networkId: "testnet",
      contractId: "quizcity.testnet",
      accounts: [
        {
          accountId: "alice-quizcity.testnet",
          publicKey: "ed25519:11111111111111111111111111111111",
          secretKey: "ed25519:22222222222222222222222222222222",
        },
      ],
    });
    const onLogin = vi.fn();
    render(
      <Onboard session={null} chainPlayer={null} onLogin={onLogin} onLogout={vi.fn()} refresh={vi.fn()} />,
    );
    const account = await screen.findByRole("button", { name: /alice/ });
    await user.click(account);
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("registers once with a pending state and surfaces errors", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn().mockResolvedValue(undefined);
    let resolveCall: (value: string) => void = () => {};
    call.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveCall = resolve;
        }),
    );
    api.register.mockResolvedValue({ username: "alice", starter_claimed: false });

    render(
      <Onboard session={session} chainPlayer={null} onLogin={vi.fn()} onLogout={vi.fn()} refresh={refresh} />,
    );
    const button = await screen.findByRole("button", { name: "Register on chain" });
    await user.click(button);
    expect(await screen.findByRole("button", { name: "Registering..." })).toBeDisabled();
    resolveCall("x".repeat(44));
    await waitFor(() => expect(api.register).toHaveBeenCalledTimes(1));
    expect(api.register.mock.calls[0][1]).toBe("x".repeat(44));
    expect(refresh).toHaveBeenCalled();

    call.mockResolvedValue("y".repeat(44));
    api.register.mockRejectedValueOnce(new Error("registration failed"));
    const retry = await screen.findByRole("button", { name: "Register on chain" });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);
    expect(await screen.findByText("registration failed")).toBeInTheDocument();
  });

  it("claims for a registered player and has no serious accessibility violations", async () => {
    const user = userEvent.setup();
    call.mockResolvedValue("x".repeat(44));
    api.claim.mockResolvedValue({ balance: "500" });
    const chainPlayer: ChainPlayer = {
      username: "alice",
      starter_claimed: false,
      created_at: 0,
    };
    const { container } = render(
      <Onboard
        session={session}
        chainPlayer={chainPlayer}
        onLogin={vi.fn()}
        onLogout={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Claim 500 QC" }));
    await waitFor(() => expect(api.claim).toHaveBeenCalledTimes(1));
    await expectAccessible(container);
  });
});
