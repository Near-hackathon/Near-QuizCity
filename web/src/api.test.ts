import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  sessionStorage.clear();
});

describe("api client", () => {
  it("sends credentialed JSON requests and parses the success envelope", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        demoMode: true,
        networkId: "testnet",
        contractId: "quizcity.testnet",
        protocolVersion: "1.0.0",
      }),
    );

    const config = await api.config();
    expect(config.demoMode).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/config$/);
    expect(init.credentials).toBe("include");
  });

  it("preserves exact QC strings from list responses", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            wallet_id: "player:alice.testnet",
            owner_type: "player",
            balance: "9007199254740993",
            updated_at: "2026-11-13T00:00:00.000Z",
            last_tx_hash: null,
          },
        ],
        nextCursor: null,
      }),
    );
    const wallets = await api.wallets();
    expect(wallets[0].balance).toBe("9007199254740993");
    expect(typeof wallets[0].balance).toBe("string");
  });

  it("stores the CSRF token and attaches it to later mutations", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        accountId: "alice.testnet",
        roles: ["player"],
        csrfToken: "csrf-token",
        expiresAt: "2026-11-13T00:00:00.000Z",
      }),
    );
    await api.authVerify({
      accountId: "alice.testnet",
      publicKey: "ed25519:11111111111111111111111111111111",
      signature: "signature",
      nonce: "nonce",
    });
    expect(sessionStorage.getItem("quizcity.csrf")).toBe("csrf-token");

    fetchMock.mockResolvedValueOnce(jsonResponse({ balance: "500" }));
    await api.claim("x".repeat(44));
    const [, init] = fetchMock.mock.calls[1];
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-token");
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [429, "RATE_LIMITED"],
    [500, "INTERNAL_ERROR"],
  ])("surfaces the stable error message for HTTP %i", async (status, code) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code, message: `stable ${code} message` } }, status));
    const result = api.jobs();
    await expect(result).rejects.toThrow(`stable ${code} message`);
    await expect(result).rejects.toMatchObject({ status, code });
  });

  it("rejects malformed responses and network failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{not-json", { status: 200 }));
    await expect(api.config()).rejects.toThrow();

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(api.config()).rejects.toThrow("network down");
  });
});

describe("api abort and pagination", () => {
  it("passes the exact abort signal and preserves AbortError semantics", async () => {
    const controller = new AbortController();
    const abort = new DOMException("aborted", "AbortError");
    fetchMock.mockImplementationOnce(async (_url, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      throw abort;
    });
    await expect(api.walletPage({ signal: controller.signal })).rejects.toBe(abort);

    controller.abort();
    fetchMock.mockImplementationOnce(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(api.jobs({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("builds opaque encoded cursors, omits absent values, and keeps exact amounts", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            wallet_id: "player:alice.testnet",
            owner_type: "player",
            balance: "9007199254740993",
            updated_at: "2026-11-13T00:00:00.000Z",
            last_tx_hash: null,
          },
        ],
        nextCursor: "opaque/cursor+value=",
      }),
    );
    const first = await api.walletPage();
    const [firstUrl] = fetchMock.mock.calls[0];
    expect(String(firstUrl)).toMatch(/\/v1\/wallets$/);
    expect(first.nextCursor).toBe("opaque/cursor+value=");
    expect(first.items[0].balance).toBe("9007199254740993");

    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    const second = await api.walletPage({ cursor: "opaque/cursor+value=", limit: 25 });
    const [secondUrl] = fetchMock.mock.calls[1];
    expect(String(secondUrl)).toContain("limit=25");
    expect(String(secondUrl)).toContain("cursor=opaque%2Fcursor%2Bvalue%3D");
    expect(second.nextCursor).toBeNull();
  });

  it("rejects malformed pagination responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: "nope", nextCursor: 3 }));
    await expect(api.walletPage()).rejects.toThrow("returned a malformed response");
  });

  it("rejects non-canonical amounts and unexpected response fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            wallet_id: "player:alice.testnet",
            owner_type: "player",
            balance: "340282366920938463463374607431768211456",
            updated_at: "2026-11-13T00:00:00.000Z",
            last_tx_hash: null,
          },
        ],
        nextCursor: null,
      }),
    );
    await expect(api.walletPage()).rejects.toThrow("/balance");

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        demoMode: false,
        networkId: "testnet",
        contractId: "quizcity.testnet",
        protocolVersion: "1.0.0",
        secret: "must-not-pass",
      }),
    );
    await expect(api.config()).rejects.toThrow("/secret");
  });

  it("attaches only the locally stored CSRF token", async () => {
    sessionStorage.setItem("quizcity.csrf", "stale");
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    await api.walletPage();
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("stale");
  });
});

describe("protocol version policy", () => {
  it("accepts the same major with newer minor and rejects missing or newer majors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        demoMode: false,
        networkId: "testnet",
        contractId: "quizcity.testnet",
        protocolVersion: "1.9.2",
      }),
    );
    await expect(api.config()).resolves.toMatchObject({ protocolVersion: "1.9.2" });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        demoMode: false,
        networkId: "testnet",
        contractId: "quizcity.testnet",
        protocolVersion: "2.0.0",
      }),
    );
    await expect(api.config()).rejects.toThrow(/Unsupported protocol version/);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ demoMode: false, networkId: "testnet", contractId: "quizcity.testnet" }),
    );
    await expect(api.config()).rejects.toThrow(/malformed response/);
  });
});
