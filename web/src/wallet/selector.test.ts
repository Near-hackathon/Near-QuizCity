import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSelectorConnector, signerFromConnector } from "./selector";
import type { WalletConnector } from "./types";

const walletOrigin = "https://testnet.mynearwallet.com";

function completePopup(data: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", { origin: walletOrigin, data: { status: "success", ...data } }),
  );
}

describe("MyNearWallet connector", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.stubGlobal(
      "open",
      vi.fn(() => ({ closed: false, close: vi.fn() })),
    );
  });

  it("stores only public account metadata and signs authentication messages", async () => {
    const connector = createSelectorConnector("testnet", "quizcity.testnet");
    const signIn = connector.signIn();
    completePopup({ account_id: "alice.testnet", public_key: "ed25519:public" });
    await expect(signIn).resolves.toEqual([{ accountId: "alice.testnet", publicKey: "ed25519:public" }]);
    expect(localStorage.getItem("quizcity.my-near-wallet.account.v1")).not.toMatch(/private|secret/i);

    const signing = signerFromConnector(connector, "alice.testnet").signMessage({
      message: "sign in",
      recipient: "quizcity",
      nonce: new Uint8Array(32),
      callbackUrl: "http://localhost/callback",
    });
    completePopup({
      signedRequest: {
        accountId: "alice.testnet",
        publicKey: "ed25519:public",
        signature: "signature",
      },
    });
    await expect(signing).resolves.toMatchObject({ accountId: "alice.testnet" });
    await connector.signOut();
    expect(await connector.getAccounts()).toEqual([]);
  });

  it("creates a wallet-approved transaction and recovers callbacks", async () => {
    localStorage.setItem(
      "quizcity.my-near-wallet.account.v1",
      JSON.stringify({ accountId: "alice.testnet" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ result: { header: { hash: "11111111111111111111111111111111" } } }), {
            status: 200,
          }),
      ),
    );
    const connector = createSelectorConnector("testnet", "quizcity.testnet");
    const sending = connector.signAndSendTransaction({
      receiverId: "quizcity.testnet",
      methodName: "ping",
      args: { value: 1 },
    });
    await vi.waitFor(() => expect(window.open).toHaveBeenCalled());
    completePopup({ transactionHashes: "tx-hash" });
    await expect(sending).resolves.toEqual({ txHash: "tx-hash" });

    window.history.replaceState({}, "", "/?transactionHashes=callback-hash");
    await expect(connector.recoverRedirect()).resolves.toEqual({ txHash: "callback-hash" });
  });

  it("handles account subscriptions and every redirect result safely", async () => {
    const connector = createSelectorConnector("testnet", "quizcity.testnet");
    const listener = vi.fn();
    const unsubscribe = connector.onAccountsChange(listener);
    localStorage.setItem(
      "quizcity.my-near-wallet.account.v1",
      JSON.stringify({ accountId: "alice.testnet" }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "quizcity.my-near-wallet.account.v1" }));
    expect(listener).toHaveBeenCalledWith([{ accountId: "alice.testnet" }]);
    unsubscribe();

    window.history.replaceState({}, "", "/?account_id=bob.testnet&public_key=ed25519%3Apublic");
    await expect(connector.recoverRedirect()).resolves.toEqual({
      account: { accountId: "bob.testnet", publicKey: "ed25519:public" },
    });
    window.history.replaceState({}, "", "/");
    await expect(connector.recoverRedirect()).resolves.toEqual({
      account: { accountId: "bob.testnet", publicKey: "ed25519:public" },
    });
    window.history.replaceState({}, "", "/?errorCode=rejected");
    await expect(connector.recoverRedirect()).rejects.toThrow("wallet callback failed: rejected");
  });

  it("fails closed for blocked, failed, malformed, and mismatched wallet results", async () => {
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    const connector = createSelectorConnector("mainnet", "quizcity.near");
    await expect(connector.signIn()).rejects.toThrow("Popup window blocked");

    const fake = {
      signMessage: vi.fn(async () => null),
    } as unknown as WalletConnector;
    await expect(
      signerFromConnector(fake, "alice.testnet").signMessage({
        message: "sign in",
        recipient: "quizcity",
        nonce: new Uint8Array(32),
      }),
    ).rejects.toThrow("wallet returned no signature");
    fake.signMessage = vi.fn(async () => ({
      accountId: "mallory.testnet",
      publicKey: "ed25519:public",
      signature: "signature",
    }));
    await expect(
      signerFromConnector(fake, "alice.testnet").signMessage({
        message: "sign in",
        recipient: "quizcity",
        nonce: new Uint8Array(32),
      }),
    ).rejects.toThrow("wallet signed a different account");

    localStorage.setItem("quizcity.my-near-wallet.account.v1", "not-json");
    expect(await connector.getAccounts()).toEqual([]);
    await expect(
      connector.signAndSendTransaction({ receiverId: "quizcity.near", methodName: "ping", args: {} }),
    ).rejects.toThrow("wallet is not signed in");
  });

  it("rejects failed popup messages and bad block responses", async () => {
    const connector = createSelectorConnector("testnet", "quizcity.testnet");
    const signIn = connector.signIn();
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: walletOrigin,
        data: { status: "failure", error: "user rejected" },
      }),
    );
    await expect(signIn).rejects.toThrow("user rejected");

    localStorage.setItem(
      "quizcity.my-near-wallet.account.v1",
      JSON.stringify({ accountId: "alice.testnet" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 })),
    );
    await expect(
      connector.signAndSendTransaction({ receiverId: "quizcity.testnet", methodName: "ping", args: {} }),
    ).rejects.toThrow("wallet block lookup failed: 503");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: {} }), { status: 200 })),
    );
    await expect(
      connector.signAndSendTransaction({ receiverId: "quizcity.testnet", methodName: "ping", args: {} }),
    ).rejects.toThrow("invalid response");
  });
});
