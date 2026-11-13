import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "../test/axe";
import { describe, expect, it, vi } from "vitest";
import { BusinessPanel } from "./BusinessPanel";
import type { Business } from "../api";

const business: Business = {
  id: 1,
  name: "E2E Cafe",
  owner_account: "alice.testnet",
  property_id: 1,
  treasury_wallet: "biz:1",
  revenue_total: "9007199254740993",
  status: "open",
};

describe("BusinessPanel", () => {
  it("shows the empty state", () => {
    render(<BusinessPanel businesses={[]} me={null} busy={false} onPay={vi.fn()} onTransfer={vi.fn()} />);
    expect(screen.getByText(/No businesses yet/)).toBeInTheDocument();
  });

  it("gives owners management controls and visitors a single ticket action", async () => {
    const user = userEvent.setup();
    const onPay = vi.fn();
    const { rerender } = render(
      <BusinessPanel
        businesses={[business]}
        me="alice.testnet"
        busy={false}
        onPay={onPay}
        onTransfer={vi.fn()}
      />,
    );
    expect(screen.getByText("9,007,199,254,740,993 QC")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "This is your venue" })).toBeDisabled();

    rerender(
      <BusinessPanel
        businesses={[business]}
        me="bob.testnet"
        busy={false}
        onPay={onPay}
        onTransfer={vi.fn()}
      />,
    );
    const ticket = screen.getByRole("button", { name: "Buy quiz ticket · 20 QC" });
    await user.click(ticket);
    expect(onPay).toHaveBeenCalledTimes(1);
    expect(onPay.mock.calls[0][1]).toBe("20");
  });

  it("disables the ticket while the request is pending", () => {
    render(
      <BusinessPanel businesses={[business]} me="bob.testnet" busy onPay={vi.fn()} onTransfer={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Buy quiz ticket · 20 QC" })).toBeDisabled();
  });

  it("has no serious accessibility violations", async () => {
    const { container } = render(
      <BusinessPanel
        businesses={[business]}
        me="bob.testnet"
        busy={false}
        onPay={vi.fn()}
        onTransfer={vi.fn()}
      />,
    );
    await expectAccessible(container);
  });
});
