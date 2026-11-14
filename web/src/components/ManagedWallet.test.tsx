import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, it, expect, vi } from "vitest";
import { ManagedWalletSetup } from "./ManagedWalletSetup";
import { ManagedWalletBackup } from "./ManagedWalletBackup";
import { api, type Resident } from "../api";
vi.mock("../api", () => ({
  api: {
    managedWalletStatus: vi.fn(),
    enterProfile: vi.fn(),
    retryManagedWallet: vi.fn(),
    downloadManagedBackup: vi.fn(),
  },
}));
const profile: Resident = {
  id: "00000000-0000-4000-8000-000000000001",
  username: "reader",
  firstName: "Taylor",
  accountId: "guest-fixture",
  walletKind: "embedded",
  walletLinked: false,
  onboardingComplete: false,
};
const status = {
  enabled: true,
  accountId: "qc-fixture.testnet",
  stage: "registering" as const,
  errorCode: "CONTRACT_UPGRADE_REQUIRED",
  retryAt: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.managedWalletStatus).mockResolvedValue(status);
});
it("shows truthful setup progress and the contract gate without claiming the starter allowance", async () => {
  const explore = vi.fn(),
    ready = vi.fn();
  render(<ManagedWalletSetup profile={profile} onReady={ready} onExplore={explore} />);
  expect(await screen.findByText(/City registration is waiting/)).toBeInTheDocument();
  expect(screen.getByText("qc-fixture.testnet")).toBeInTheDocument();
  expect(screen.getByText(/Register your city resident/)).toHaveAttribute("aria-current", "step");
  expect(ready).not.toHaveBeenCalled();
  vi.mocked(api.retryManagedWallet).mockResolvedValue({ ...status, errorCode: null });
  await userEvent.click(screen.getByRole("button", { name: "Recheck saved setup" }));
  expect(api.retryManagedWallet).toHaveBeenCalledWith(profile.id);
  await userEvent.click(screen.getByRole("button", { name: "Explore while setup finishes" }));
  expect(explore).toHaveBeenCalledOnce();
});
it("waits for ready and obtains a fresh session before opening a remembered resident", async () => {
  vi.mocked(api.managedWalletStatus).mockResolvedValue({ ...status, stage: "ready", errorCode: null });
  const linked = { ...profile, accountId: status.accountId, walletLinked: true };
  vi.mocked(api.enterProfile).mockResolvedValue({
    profile: linked,
    csrfToken: "csrf",
    expiresAt: "2099-01-01",
  });
  const ready = vi.fn();
  render(<ManagedWalletSetup profile={profile} onReady={ready} />);
  await waitFor(() => expect(ready).toHaveBeenCalledWith(linked));
  expect(api.enterProfile).toHaveBeenCalledOnce();
});
it("preserves setup on network errors and cancels the pending status request on unmount", async () => {
  vi.mocked(api.managedWalletStatus).mockRejectedValue(Error("provider details"));
  const view = render(<ManagedWalletSetup profile={profile} onReady={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Your saved account has been kept");
  const signal = vi.mocked(api.managedWalletStatus).mock.calls[0][1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
it("exports a testnet backup only after explicit consent and never renders its content", async () => {
  const create = vi.fn(() => "blob:backup"),
    revoke = vi.fn();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.mocked(api.downloadManagedBackup).mockResolvedValue(
    new Blob(["private fixture"], { type: "application/octet-stream" }),
  );
  render(<ManagedWalletBackup profile={profile} />);
  const button = screen.getByRole("button", { name: "Download testnet wallet backup" });
  expect(button).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(button);
  expect(await screen.findByRole("status")).toHaveTextContent("Recovery backup downloaded");
  expect(api.downloadManagedBackup).toHaveBeenCalledWith(profile.id);
  expect(button).toBeDisabled();
  expect(screen.queryByText("private fixture")).not.toBeInTheDocument();
  expect(click).toHaveBeenCalledOnce();
  click.mockRestore();
});
it("keeps backup failures safe and hides backup controls for external wallets", async () => {
  vi.mocked(api.downloadManagedBackup).mockRejectedValue(Error("provider details"));
  const view = render(<ManagedWalletBackup profile={profile} />);
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "Download testnet wallet backup" }));
  expect(await screen.findByRole("status")).toHaveTextContent("could not be downloaded");
  view.rerender(<ManagedWalletBackup profile={{ ...profile, walletKind: "external" }} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("updates the top brief through each confirmed setup stage without another click", async () => {
  vi.useFakeTimers();
  vi.mocked(api.managedWalletStatus)
    .mockReset()
    .mockResolvedValueOnce({ ...status, stage: "creating_account", errorCode: null })
    .mockResolvedValueOnce({ ...status, stage: "registering", errorCode: null })
    .mockResolvedValueOnce({ ...status, stage: "claiming", errorCode: null })
    .mockResolvedValue({ ...status, stage: "ready", errorCode: null });
  vi.mocked(api.enterProfile).mockResolvedValue({
    profile: { ...profile, accountId: status.accountId, walletLinked: true },
    csrfToken: "csrf",
    expiresAt: "2099-01-01",
  });
  const ready = vi.fn(),
    view = render(<ManagedWalletSetup profile={profile} onReady={ready} />);
  try {
    await act(async () => {});
    const brief = screen.getByRole("status", { name: "Wallet setup progress" });
    expect(brief).toHaveTextContent("Creating your testnet account");
    expect(ready).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(brief).toHaveTextContent("Welcoming your account to Quiz City");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(brief).toHaveTextContent("Confirming your 500 QC");
    expect(ready).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(brief).toHaveTextContent("Your wallet is ready");
    expect(ready).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
