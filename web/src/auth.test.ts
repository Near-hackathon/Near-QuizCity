import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageSigner } from "./wallet/types";

const api = {
  authMe: vi.fn(),
  authNonce: vi.fn(),
  authVerify: vi.fn(),
  authLogout: vi.fn(),
  clearCsrf: vi.fn(),
};

vi.mock("./api", () => ({ api }));

const { ensureAuth, logout } = await import("./auth");

const nonce = {
  accountId: "alice.testnet",
  nonce: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
  message: "Sign in to http://localhost:5173 as alice.testnet",
  expiresAt: "2026-11-13T00:00:00.000Z",
  domain: "http://localhost:5173",
  networkId: "testnet",
  recipient: "quizcity.testnet",
  callbackUrl: "http://localhost:5173",
};

function signer(overrides: Partial<MessageSigner> = {}): MessageSigner {
  return {
    accountId: "alice.testnet",
    signMessage: vi.fn(async () => ({
      accountId: "alice.testnet",
      publicKey: "ed25519:11111111111111111111111111111111",
      signature: btoa(String.fromCharCode(...new Uint8Array(64).fill(1))),
    })),
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.authMe.mockRejectedValue(new Error("no session"));
  api.authNonce.mockResolvedValue(nonce);
  api.authVerify.mockResolvedValue({
    accountId: "alice.testnet",
    roles: ["player"],
    expiresAt: "2026-11-13T00:00:00.000Z",
    csrfToken: "csrf",
  });
});

describe("wallet authentication adapter", () => {
  it("passes a decoded 32-byte nonce to the injected signer and verifies", async () => {
    const wallet = signer();
    const result = await ensureAuth("alice.testnet", wallet);
    expect(result.accountId).toBe("alice.testnet");
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    const payload = (wallet.signMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      nonce: Uint8Array;
      recipient: string;
      callbackUrl: string;
    };
    expect(payload.nonce).toHaveLength(32);
    expect(payload.recipient).toBe("quizcity.testnet");
    expect(payload.callbackUrl).toBe("http://localhost:5173");
  });

  it("rejects a signer for a different account and propagates wallet rejection", async () => {
    await expect(
      ensureAuth(
        "alice.testnet",
        signer({
          signMessage: async () => ({
            accountId: "bob.testnet",
            publicKey: "ed25519:11111111111111111111111111111111",
            signature: "signature",
          }),
        }),
      ),
    ).rejects.toThrow(/different account/);

    await expect(
      ensureAuth(
        "alice.testnet",
        signer({
          signMessage: async () => {
            throw new Error("user rejected");
          },
        }),
      ),
    ).rejects.toThrow(/user rejected/);
  });

  it("reuses an existing server session for the same account", async () => {
    api.authMe.mockResolvedValue({
      accountId: "alice.testnet",
      roles: ["player"],
      expiresAt: "2026-11-13T00:00:00.000Z",
    });
    const wallet = signer();
    await expect(ensureAuth("alice.testnet", wallet)).resolves.toMatchObject({
      accountId: "alice.testnet",
    });
    expect(wallet.signMessage).not.toHaveBeenCalled();
  });

  it("clears CSRF and server state on logout, tolerating an expired session", async () => {
    api.authLogout.mockResolvedValueOnce({ ok: true });
    await logout();
    expect(api.authLogout).toHaveBeenCalledTimes(1);
    expect(api.clearCsrf).toHaveBeenCalledTimes(1);

    api.authLogout.mockRejectedValueOnce(new Error("expired"));
    await expect(logout()).resolves.toBeUndefined();
    expect(api.clearCsrf).toHaveBeenCalledTimes(2);
  });
});
