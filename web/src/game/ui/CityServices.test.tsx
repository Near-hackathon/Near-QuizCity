import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, it, vi, expect } from "vitest";
import { CityServices } from "./CityServices";
import { api } from "../../api";
import { expectAccessible } from "../../test/axe";
vi.mock("../../api", () => ({
  api: {
    cityOverview: vi.fn(),
    authMe: vi.fn(),
    cityConfirm: vi.fn(),
    cityCommand: vi.fn(),
    cityHealth: vi.fn(),
    cityModeration: vi.fn(),
  },
}));
const overview = () => ({
  admissions: [],
  operations: [],
  purchases: [],
  sales: [],
  suppliers: [],
  items: [],
  businessSales: [],
  jobs: [],
  leases: [],
  rentOffers: [],
  drafts: [],
  staff: [],
  shops: [],
  market: [],
  policy: { available: true, dailyCap: "5000", issuedToday: "0" },
});
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  vi.mocked(api.cityOverview).mockResolvedValue(overview());
  vi.mocked(api.authMe).mockResolvedValue({
    accountId: "alice.testnet",
    roles: ["player"],
    expiresAt: "2026-12-01T00:00:00Z",
  });
});
it("keeps all services in the phone, hides operator controls and has accessible navigation", async () => {
  const { container } = render(<CityServices accountId="alice.testnet" onChanged={vi.fn()} />);
  await screen.findByRole("heading", { name: "Make your next move" });
  for (const name of ["Supplies", "Team", "Property market", "Quiz studio", "City hall"]) {
    await userEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  }
  expect(screen.queryByRole("button", { name: "Set category budget" })).not.toBeInTheDocument();
  expect(container.querySelector("a")).toBeNull();
  await expectAccessible(container);
});
it("rechecks an unknown transaction without asking the wallet to pay again", async () => {
  const data = overview();
  data.operations.push({
    id: "saved",
    kind: "supplier",
    method: "pay_charge",
    args: { amount: "10" },
    status: "unknown",
    tx_hash: "known-hash",
    reference: "quote",
    actor_account: "alice.testnet",
  } as never);
  vi.mocked(api.cityOverview).mockResolvedValue(data);
  vi.mocked(api.cityConfirm).mockResolvedValue({
    operation: {
      id: "saved",
      kind: "supplier",
      method: "pay_charge",
      args: {},
      reference: "quote",
      actor_account: "alice.testnet",
      tx_hash: "known-hash",
      status: "confirmed",
    },
  } as never);
  const send = vi.fn(),
    changed = vi.fn();
  render(<CityServices accountId="alice.testnet" send={send} onChanged={changed} />);
  await userEvent.click(await screen.findByRole("button", { name: "Continue saved payment" }));
  await waitFor(() => expect(api.cityConfirm).toHaveBeenCalledWith("saved", "known-hash"));
  expect(send).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
});
it("retains a newly signed hash through a failed confirmation and retries that proof only", async () => {
  const data = overview();
  data.operations.push({
    id: "new",
    kind: "supplier",
    method: "pay_charge",
    args: { amount: "10" },
    status: "awaiting",
    tx_hash: null,
    reference: "quote",
    actor_account: "alice.testnet",
  } as never);
  vi.mocked(api.cityOverview).mockResolvedValue(data);
  vi.mocked(api.cityConfirm)
    .mockRejectedValueOnce(Error("Confirmation pending"))
    .mockResolvedValueOnce({} as never);
  const send = vi.fn().mockResolvedValue("signed-once");
  render(<CityServices accountId="alice.testnet" send={send} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "Continue saved payment" }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "Continue saved payment" }));
  await waitFor(() => expect(api.cityConfirm).toHaveBeenCalledTimes(2));
  expect(send).toHaveBeenCalledOnce();
  expect(api.cityConfirm).toHaveBeenLastCalledWith("new", "signed-once");
});
it("disables payments on older contracts and displays refresh failures safely", async () => {
  const data = overview();
  data.policy.available = false;
  data.operations.push({
    id: "old",
    kind: "supplier",
    method: "pay_charge",
    args: {},
    status: "awaiting",
    tx_hash: null,
    reference: "old",
    actor_account: "alice.testnet",
  } as never);
  vi.mocked(api.cityOverview).mockResolvedValue(data);
  const first = render(<CityServices accountId="alice.testnet" onChanged={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Continue saved payment" })).toBeDisabled();
  first.unmount();
  vi.mocked(api.cityOverview).mockRejectedValue(Error("private provider data"));
  render(<CityServices accountId="alice.testnet" onChanged={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("City services could not refresh");
  expect(screen.queryByText("private provider data")).not.toBeInTheDocument();
});
it("presents exact large balances and customer metrics without numeric rounding", async () => {
  const health = {
    contractStats: {},
    propertyUse: { plots: 1, occupied: 1, active_businesses: 1, archived_businesses: 0 },
    supply: {
      issued: "9007199254740993",
      burned: "0",
      circulating: "9007199254740993",
      mirrored: "9007199254740993",
      difference: "0",
    },
    wealth: { residents: 2, gini: "0.25" },
    walletGroups: [],
    jobs: [],
    businesses: [
      {
        id: "1",
        name: "Market",
        owner_account: "alice.testnet",
        gross_revenue: "80",
        expenses: "10",
        treasury: "70",
        customers: 4,
        employees: 1,
        active: true,
      },
    ],
    inventory: [],
    rewardPools: [],
    budgets: [],
    alerts: [],
  };
  vi.mocked(api.cityHealth).mockResolvedValue(health);
  render(<CityServices accountId="alice.testnet" onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "City hall" }));
  await userEvent.click(screen.getByRole("button", { name: "View public economy" }));
  expect(await screen.findByText(/Confirmed circulation: 9,007,199,254,740,993/)).toBeInTheDocument();
  expect(screen.getByText(/4 customer payments/)).toBeInTheDocument();
});
