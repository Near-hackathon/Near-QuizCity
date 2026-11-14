import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { Component } from "./landing";
import { api } from "../api";
import { saveSession } from "../chain";
import { expectAccessible } from "../test/axe";
vi.mock("../api", () => ({
  api: {
    profiles: vi.fn(),
    createProfile: vi.fn(),
    enterProfile: vi.fn(),
    config: vi.fn(),
    prepareProfileDevice: vi.fn(),
    managedWalletStatus: vi.fn(),
  },
}));
vi.mock("../chain", () => ({ saveSession: vi.fn(), loadSession: () => null }));
vi.mock("../wallet/WalletProvider", () => ({ useWallet: () => ({}) }));
const profile = {
  id: "00000000-0000-4000-8000-000000000001",
  username: "reader",
  firstName: "Taylor",
  accountId: "guest-fixture",
  walletLinked: false,
  onboardingComplete: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.profiles).mockResolvedValue({ profiles: [] });
  vi.mocked(api.config).mockResolvedValue({ networkId: "testnet" } as never);
});
function mount() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Component />} />
        <Route path="/play" element={<p>You entered the city</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
it("introduces the city and creates a resident with only first name and username", async () => {
  const { container } = mount();
  const user = userEvent.setup();
  await act(async () => {});
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your story.");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await expectAccessible(container);
  await user.click(screen.getByRole("button", { name: /Let’s play/ }));
  await user.type(screen.getByLabelText("First name"), "Taylor");
  await user.type(screen.getByLabelText("Username"), "reader");
  vi.mocked(api.createProfile).mockResolvedValue({ profile, csrfToken: "csrf", expiresAt: "2099-01-01" });
  await expectAccessible(container);
  await user.click(screen.getByRole("button", { name: /Start my story/ }));
  expect(await screen.findByText("You entered the city")).toBeInTheDocument();
  expect(api.createProfile).toHaveBeenCalledWith("reader", "Taylor");
  expect(saveSession).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: "guest-fixture", walletId: "browser" }),
  );
});
it("enters a remembered resident with one click and never signs in on a rejected request", async () => {
  vi.mocked(api.profiles).mockResolvedValue({ profiles: [profile] });
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Play now/ }));
  const resident = await screen.findByRole("button", { name: /reader/ });
  vi.mocked(api.enterProfile).mockRejectedValueOnce(new Error("This resident is not saved in this browser."));
  await user.click(resident);
  expect(await screen.findByRole("alert")).toHaveTextContent("not saved in this browser");
  expect(saveSession).not.toHaveBeenCalled();
  vi.mocked(api.enterProfile).mockResolvedValue({ profile, csrfToken: "csrf", expiresAt: "2099-01-01" });
  await user.click(resident);
  expect(await screen.findByText("You entered the city")).toBeInTheDocument();
  expect(api.enterProfile).toHaveBeenLastCalledWith(profile.id);
});

it("prepares the browser before wallet allocation and shows saved setup instead of entering with an invented balance", async () => {
  vi.mocked(api.config).mockResolvedValue({ networkId: "testnet", autoTestnetWallets: true } as never);
  vi.mocked(api.prepareProfileDevice).mockResolvedValue({ ok: true });
  vi.mocked(api.createProfile).mockResolvedValue({
    profile: { ...profile, accountId: `guest-${profile.id}`, walletKind: "embedded" },
    csrfToken: "csrf",
    expiresAt: "2099-01-01",
  });
  vi.mocked(api.managedWalletStatus).mockResolvedValue({
    enabled: true,
    accountId: "qc-player.testnet",
    stage: "registering",
    errorCode: "CONTRACT_UPGRADE_REQUIRED",
    retryAt: null,
  });
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Let’s play/ }));
  await user.type(screen.getByLabelText("First name"), "Taylor");
  await user.type(screen.getByLabelText("Username"), "reader");
  await user.click(screen.getByRole("button", { name: /Start my story/ }));
  expect(await screen.findByText(/City registration is waiting/)).toBeInTheDocument();
  expect(vi.mocked(api.prepareProfileDevice).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(api.createProfile).mock.invocationCallOrder[0],
  );
  expect(saveSession).not.toHaveBeenCalled();
  expect(screen.queryByText("You entered the city")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Explore while setup finishes" }));
  expect(await screen.findByText("You entered the city")).toBeInTheDocument();
  expect(saveSession).toHaveBeenCalledWith(
    expect.objectContaining({ walletId: "browser", profileId: profile.id }),
  );
});
