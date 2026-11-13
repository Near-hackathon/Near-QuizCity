import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WalletDialog } from "./WalletDialog";

describe("WalletDialog", () => {
  it("exposes connection state, errors, and both actions accessibly", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    const onClose = vi.fn();
    render(
      <WalletDialog
        networkId="testnet"
        contractId="quizcity.testnet"
        error="wallet unavailable"
        connecting={false}
        onConnect={onConnect}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Connect a NEAR wallet" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("wallet unavailable");
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConnect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables the connect action while connecting", () => {
    render(
      <WalletDialog
        networkId="testnet"
        contractId="quizcity.testnet"
        error={null}
        connecting
        onConnect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Connecting..." })).toBeDisabled();
  });
});
