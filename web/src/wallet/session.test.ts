import { beforeEach, describe, expect, it } from "vitest";
import { clearWalletSession, loadWalletSession, saveWalletSession } from "./session";

describe("wallet session storage", () => {
  beforeEach(() => localStorage.clear());

  it("stores only public session metadata and clears it", () => {
    saveWalletSession({
      accountId: "alice.testnet",
      publicKey: "ed25519:public",
      networkId: "testnet",
      walletId: "my-near-wallet",
      authenticatedAt: "2026-11-13T00:00:00.000Z",
    });
    expect(loadWalletSession()).toMatchObject({ accountId: "alice.testnet", publicKey: "ed25519:public" });
    expect(localStorage.getItem("quizcity.wallet-session.v1")).not.toMatch(/secret|private/i);
    clearWalletSession();
    expect(loadWalletSession()).toBeNull();
  });

  it.each(["not-json", "{}", '{"accountId":"alice.testnet"}'])(
    "rejects malformed persisted data: %s",
    (value) => {
      localStorage.setItem("quizcity.wallet-session.v1", value);
      expect(loadWalletSession()).toBeNull();
    },
  );
});
