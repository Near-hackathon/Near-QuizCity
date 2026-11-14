import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ShopsPanel } from "./ShopsPanel";
import { api, type Business } from "../../api";
vi.mock("../../api", () => ({
  api: {
    catalogue: vi.fn(),
    myOrders: vi.fn(),
    commerceCapabilities: vi.fn(),
    reserveOrder: vi.fn(),
    confirmOrder: vi.fn(),
    createItem: vi.fn(),
    deliverStock: vi.fn(),
    transferBusiness: vi.fn(),
  },
}));
const business = {
  id: "1",
  name: "City Books",
  owner_account: "alice.testnet",
  revenue_total: "0",
} as Business;
const item = {
  id: "item-one",
  business_id: "1",
  sku: "guide",
  name: "City guide",
  unit_price: "20",
  on_hand: 3,
  reserved: 0,
  low_stock: 1,
  active: true,
};
const order = {
  id: "order-one",
  buyer_account: "bob.testnet",
  business_id: "1",
  item_id: item.id,
  item_name: item.name,
  quantity: 1,
  unit_price: "20",
  total: "20",
  reference: "order:order-one",
  status: "reserved",
  tx_hash: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.catalogue).mockResolvedValue({ items: [item] });
  vi.mocked(api.myOrders).mockResolvedValue({ orders: [] });
  vi.mocked(api.commerceCapabilities).mockResolvedValue({ orderPayments: true });
});
it("uses the reserved server price and keeps checkout and confirmation inside the phone", async () => {
  const send = vi.fn().mockResolvedValue("transaction-proof"),
    changed = vi.fn();
  render(
    <ShopsPanel businesses={[business]} accountId="bob.testnet" online send={send} onChanged={changed} />,
  );
  const user = userEvent.setup();
  await screen.findByText("City guide");
  vi.mocked(api.reserveOrder).mockResolvedValue({ order });
  vi.mocked(api.myOrders).mockResolvedValue({ orders: [order] });
  await user.click(screen.getByRole("button", { name: "Reserve one · 20 QC" }));
  expect(api.reserveOrder).toHaveBeenCalledWith(item.id, 1);
  const pay = await screen.findByRole("button", { name: "Pay 20 QC" });
  vi.mocked(api.confirmOrder).mockRejectedValueOnce(new Error("Confirmation is still pending."));
  await user.click(pay);
  expect(await screen.findByRole("alert")).toHaveTextContent("still pending");
  vi.mocked(api.confirmOrder).mockResolvedValue({
    order: { ...order, status: "paid", tx_hash: "transaction-proof" },
  });
  vi.mocked(api.myOrders).mockResolvedValue({
    orders: [{ ...order, status: "paid", tx_hash: "transaction-proof" }],
  });
  await user.click(screen.getByRole("button", { name: "Pay 20 QC" }));
  await screen.findByText(/Purchase confirmed/);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith("pay_order", {
    business_id: 1,
    amount: "20",
    reference: order.reference,
  });
  expect(api.confirmOrder).toHaveBeenLastCalledWith(order.id, "transaction-proof");
});
it("disables checkout if the deployed city does not support order payments", async () => {
  vi.mocked(api.commerceCapabilities).mockResolvedValue({ orderPayments: false });
  render(<ShopsPanel businesses={[business]} accountId="bob.testnet" online onChanged={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Reserve one · 20 QC" })).toBeDisabled();
  expect(screen.getByText(/getting ready for checkout/)).toBeInTheDocument();
  expect(api.reserveOrder).not.toHaveBeenCalled();
});

it("directs restocking to paid suppliers and keeps ownership actions within the phone", async () => {
  render(
    <ShopsPanel
      businesses={[business]}
      accountId="alice.testnet"
      online
      send={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  await screen.findByText("City guide");
  expect(screen.getByRole("button", { name: "Transfer ownership" })).toBeInTheDocument();
  expect(screen.getByText(/Restock through Business/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Record received stock" })).toBeNull();
  expect(api.deliverStock).not.toHaveBeenCalled();
});
