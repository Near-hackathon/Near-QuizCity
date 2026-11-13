import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletProvider, useWallet } from "./WalletProvider";
import type { WalletAccount, WalletConnector } from "./types";

function Probe() {
  const wallet = useWallet();
  return (
    <div>
      <output>{wallet.account?.accountId ?? "signed-out"}</output>
      <button onClick={() => void wallet.connect("testnet", "quizcity.testnet")}>connect</button>
      <button onClick={() => void wallet.restore("testnet", "quizcity.testnet")}>restore</button>
      <button onClick={() => void wallet.disconnect()}>disconnect</button>
      <button
        onClick={() =>
          void wallet.sendTransaction({ receiverId: "quizcity.testnet", methodName: "ping", args: {} })
        }
      >
        send
      </button>
    </div>
  );
}

function fakeConnector(
  accounts: WalletAccount[] = [],
): WalletConnector & { emit(accounts: WalletAccount[]): void } {
  let listener: ((next: WalletAccount[]) => void) | null = null;
  return {
    id: "fake",
    networkId: "testnet",
    contractId: "quizcity.testnet",
    initialize: vi.fn(async () => undefined),
    getAccounts: vi.fn(async () => accounts),
    signIn: vi.fn(async () => [{ accountId: "alice.testnet" }]),
    signOut: vi.fn(async () => undefined),
    signMessage: vi.fn(async () => ({
      accountId: "alice.testnet",
      publicKey: "ed25519:public",
      signature: "signature",
    })),
    signAndSendTransaction: vi.fn(async () => ({ txHash: "tx-hash" })),
    onAccountsChange(callback) {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    recoverRedirect: vi.fn(async () => null),
    emit(next) {
      listener?.(next);
    },
  };
}

describe("WalletProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("connects, observes account changes, sends, and fully disconnects", async () => {
    const user = userEvent.setup();
    const connector = fakeConnector();
    render(
      <WalletProvider connectorFactory={() => connector}>
        <Probe />
      </WalletProvider>,
    );
    await user.click(screen.getByRole("button", { name: "connect" }));
    expect(await screen.findByText("alice.testnet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "send" }));
    expect(connector.signAndSendTransaction).toHaveBeenCalledOnce();
    act(() => connector.emit([{ accountId: "bob.testnet" }]));
    expect(screen.getByText("bob.testnet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "disconnect" }));
    expect(await screen.findByText("signed-out")).toBeInTheDocument();
    expect(connector.signOut).toHaveBeenCalledOnce();
  });

  it("restores an existing account and reports connector failures", async () => {
    const user = userEvent.setup();
    const connector = fakeConnector([{ accountId: "restored.testnet" }]);
    const { unmount } = render(
      <WalletProvider connectorFactory={() => connector}>
        <Probe />
      </WalletProvider>,
    );
    await user.click(screen.getByRole("button", { name: "restore" }));
    expect(await screen.findByText("restored.testnet")).toBeInTheDocument();
    unmount();

    const broken = fakeConnector();
    vi.mocked(broken.initialize).mockRejectedValueOnce(new Error("initialization failed"));
    render(
      <WalletProvider connectorFactory={() => broken}>
        <Probe />
      </WalletProvider>,
    );
    await user.click(screen.getByRole("button", { name: "connect" }));
    expect(screen.getByText("signed-out")).toBeInTheDocument();
  });
});
