import { afterEach, expect, it, vi } from "vitest";
import { loadManifest, validateManifest } from "./loadManifest";

const manifest = {
  schemaVersion: 1,
  catalogVersion: "phase7-v1",
  files: [{ path: "world/city.png", sha256: "a".repeat(64), bytes: 1 }],
};
afterEach(() => vi.unstubAllGlobals());

it("accepts the prepared inventory and rejects unsupported, duplicate and escaping entries", () => {
  expect(() => validateManifest(manifest)).not.toThrow();
  for (const value of [
    null,
    {},
    { ...manifest, schemaVersion: 2 },
    { ...manifest, files: [] },
    { ...manifest, files: [...manifest.files, ...manifest.files] },
    { ...manifest, files: [{ ...manifest.files[0], path: "../secret" }] },
  ]) {
    expect(() => validateManifest(value)).toThrow();
  }
});

it("passes cancellation to fetch and rejects failed responses", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => manifest })
    .mockResolvedValueOnce({ ok: false });
  vi.stubGlobal("fetch", fetcher);
  const abort = new AbortController();
  await expect(loadManifest(abort.signal)).resolves.toEqual(manifest);
  expect(fetcher).toHaveBeenCalledWith("/game-assets/runtime/asset-manifest.json", {
    signal: abort.signal,
  });
  await expect(loadManifest(abort.signal)).rejects.toThrow("unavailable");
});
