import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { demoSigner, demoTransaction, registerDemoKey } from "../wallet/demo-loader";
import { sendDemoWalletTransaction } from "./demo-wallet";

vi.mock("../api", () => ({ api: { demoAccounts: vi.fn() } }));
vi.mock("../wallet/demo-loader", () => ({
  demoSigner: vi.fn(),
  demoTransaction: vi.fn(),
  registerDemoKey: vi.fn(),
}));
const input = { receiverId: "quizcity.testnet", methodName: "register_player", args: { username: "bob" } };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(demoTransaction).mockResolvedValue({ txHash: "confirmed-proof" });
});
it("restores only the selected demo account after a reload before sending once", async () => {
  vi.mocked(demoSigner).mockResolvedValue(null);
  vi.mocked(api.demoAccounts).mockResolvedValue({
    networkId: "testnet",
    contractId: "quizcity.testnet",
    accounts: [
      { accountId: "alice.testnet", publicKey: "alice-public", secretKey: "disposable-fixture-alice" },
      { accountId: "bob.testnet", publicKey: "bob-public", secretKey: "disposable-fixture-bob" },
    ],
  });
  await expect(sendDemoWalletTransaction(true, "bob.testnet", input)).resolves.toEqual({
    txHash: "confirmed-proof",
  });
  expect(registerDemoKey).toHaveBeenCalledExactlyOnceWith(
    true,
    "bob.testnet",
    "bob-public",
    "disposable-fixture-bob",
  );
  expect(demoTransaction).toHaveBeenCalledExactlyOnceWith(true, "bob.testnet", input);
});
it("uses a live in-memory signer without fetching credentials again", async () => {
  vi.mocked(demoSigner).mockResolvedValue({ accountId: "bob.testnet", signMessage: vi.fn() });
  await sendDemoWalletTransaction(true, "bob.testnet", input);
  expect(api.demoAccounts).not.toHaveBeenCalled();
  expect(registerDemoKey).not.toHaveBeenCalled();
});
it("cannot fetch credentials or send when demo mode is disabled", async () => {
  await expect(sendDemoWalletTransaction(false, "bob.testnet", input)).rejects.toThrow();
  expect(api.demoAccounts).not.toHaveBeenCalled();
  expect(demoTransaction).not.toHaveBeenCalled();
});
it("does not substitute another account when the selected account is unavailable", async () => {
  vi.mocked(demoSigner).mockResolvedValue(null);
  vi.mocked(api.demoAccounts).mockResolvedValue({
    networkId: "testnet",
    contractId: "quizcity.testnet",
    accounts: [],
  });
  await expect(sendDemoWalletTransaction(true, "bob.testnet", input)).rejects.toThrow();
  expect(registerDemoKey).not.toHaveBeenCalled();
  expect(demoTransaction).not.toHaveBeenCalled();
});
it("does not send when the guarded demo endpoint fails", async () => {
  vi.mocked(demoSigner).mockResolvedValue(null);
  vi.mocked(api.demoAccounts).mockRejectedValue(new Error("unavailable"));
  await expect(sendDemoWalletTransaction(true, "bob.testnet", input)).rejects.toThrow();
  expect(demoTransaction).not.toHaveBeenCalled();
});
