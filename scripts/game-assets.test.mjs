import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetPath, prepareGameAssets } from "./game-assets.mjs";

test("assetPath rejects traversal, absolute paths, and invalid characters", () => {
  const root = "/tmp/assets";
  assert.equal(assetPath(root, "world/city/file.png"), join(root, "world/city/file.png"));
  for (const value of ["../escape", "/absolute", "a//b", "a/./b", "a/../b", "bad space", "", null]) {
    assert.throws(() => assetPath(root, value), /Invalid game asset path/);
  }
});

test("prepareGameAssets validates a curated catalogue and detects missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "quizcity-assets-"));
  try {
    const runtime = join(root, "runtime");
    await mkdir(join(runtime, "world/city"), { recursive: true });
    await writeFile(join(runtime, "world/city/LICENSE.txt"), "licence");
    await writeFile(
      join(runtime, "world/city/tile.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const catalog = {
      schemaVersion: 2,
      targetRoot: "runtime",
      groups: [
        {
          id: "city",
          tier: "core",
          purpose: "test",
          target: "world/city",
          licenseFile: "LICENSE.txt",
          credit: "test",
          files: ["LICENSE.txt", "tile.png"],
        },
      ],
    };
    const result = await prepareGameAssets(root, catalog, false);
    assert.equal(result.files, 2);
    await prepareGameAssets(root, catalog, true);
    await assert.rejects(
      prepareGameAssets(
        root,
        { ...catalog, groups: [{ ...catalog.groups[0], files: ["missing.png"] }] },
        false,
      ),
      /missing|not found|ENOENT/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
