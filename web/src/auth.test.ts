import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./chain";

const api = {
  authMe: vi.fn(),
  authNonce: vi.fn(),
  authVerify: vi.fn(),
  authLogout: vi.fn(),
};

vi.mock("./api", () => ({ api }));

const { ensureAuth, logout } = await import("./auth");

const session: Session = {
  accountId: "alice.testnet",
  publicKey: "ed25519:11111111111111111111111111111111",
  secretKey: "ed25519:22222222222222222222222222222222",
};

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
  vi.unstubAllGlobals();
});

describe("wallet authentication adapter", () => {
  it("passes a decoded 32-byte nonce to the wallet signer and verifies", async () => {
    const signMessage = vi.fn(
      async (_input: { nonce: Uint8Array; recipient: string; callbackUrl: string }) => ({
        signature: btoa(String.fromCharCode(...new Uint8Array(64).fill(1))),
        publicKey: session.publicKey,
        accountId: session.accountId,
      }),
    );
    vi.stubGlobal("nearWallet", { signMessage });

    const result = await ensureAuth(session, false);
    expect(result.accountId).toBe("alice.testnet");
    expect(signMessage).toHaveBeenCalledTimes(1);
    const payload = signMessage.mock.calls[0][0] as {
      nonce: Uint8Array;
      recipient: string;
      callbackUrl: string;
    };
    expect(payload.nonce).toHaveLength(32);
    expect(payload.recipient).toBe("quizcity.testnet");
    expect(payload.callbackUrl).toBe("http://localhost:5173");
  });

  it("rejects a wallet that signs for a different account or rejects the request", async () => {
    vi.stubGlobal("nearWallet", {
      signMessage: async () => ({
        signature: btoa(String.fromCharCode(...new Uint8Array(64))),
        publicKey: session.publicKey,
        accountId: "bob.testnet",
      }),
    });
    await expect(ensureAuth(session, false)).rejects.toThrow(/different account/);

    vi.stubGlobal("nearWallet", {
      signMessage: async () => {
        throw new Error("user rejected");
      },
    });
    await expect(ensureAuth(session, false)).rejects.toThrow(/user rejected/);
  });

  it("does not silently use demo keys for non-demo sign-in", async () => {
    vi.stubGlobal("nearWallet", undefined);
    await expect(ensureAuth(session, false)).rejects.toThrow(/wallet sign-in is not configured/);
    await expect(
      ensureAuth({ ...session, secretKey: undefined } as unknown as Session, true),
    ).rejects.toThrow(/wallet sign-in is not configured/);
  });

  it("clears the server session on logout and tolerates an expired session", async () => {
    api.authLogout.mockResolvedValueOnce({ ok: true });
    await logout();
    expect(api.authLogout).toHaveBeenCalledTimes(1);

    api.authLogout.mockRejectedValueOnce(new Error("expired"));
    await expect(logout()).resolves.toBeUndefined();
  });
});
