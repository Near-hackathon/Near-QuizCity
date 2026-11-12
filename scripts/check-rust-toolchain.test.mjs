import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-rust-toolchain.mjs", import.meta.url));
const contract = fileURLToPath(new URL("../contract", import.meta.url));

test("passes on the repository pin", () => {
  const result = spawnSync(process.execPath, [checker], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /toolchain check: pinned \d+\.\d+\.\d+/);
});

test("fails when the expected version diverges", () => {
  const dir = mkdtempSync(join(tmpdir(), "quizcity-toolchain-"));
  try {
    const file = join(dir, "rust-toolchain.toml");
    writeFileSync(file, '[toolchain]\nchannel = "9.9.9"\n');
    const result = spawnSync(
      process.execPath,
      [checker, "--toolchain-file", file, "--contract-dir", contract],
      {
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /9\.9\.9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
