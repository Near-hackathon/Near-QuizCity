#!/usr/bin/env node
/**
 * Install the pinned NEAR sandbox binary used by the local E2E suite.
 *
 * near-workspaces 5 resolves the near-sandbox 0.1.5 package, which downloads
 * neard 2.6.2. That node predates protocol 84 and cannot execute contracts
 * built by the pinned Rust 1.95 toolchain. This installer substitutes the
 * pinned 2.14.0 sandbox binary. The download URL and SHA-256 are fixed here;
 * the test body itself never downloads or selects an executable.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2.14.0";
const artifacts = {
  "darwin-arm64": {
    url: `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Darwin-arm64/${VERSION}/near-sandbox.tar.gz`,
    sha256: "ea53448ef97540c012e5c3d967c74d78292b0465a98cf7027811a936718fe232",
  },
  "linux-x64": {
    url: `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/${VERSION}/near-sandbox.tar.gz`,
    sha256: "a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691",
  },
};

const platform = `${process.platform}-${process.arch}`;
const artifact = artifacts[platform];
if (!artifact) {
  throw new Error(`unsupported platform for local E2E sandbox: ${platform}`);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "node_modules", "near-sandbox", "bin");
const binPath = join(binDir, "near-sandbox");

function currentVersion() {
  try {
    return execFileSync(binPath, ["--version"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

if (existsSync(binPath) && currentVersion().includes(VERSION)) {
  console.log(`near sandbox ${VERSION} already installed`);
  process.exit(0);
}

console.log(`downloading pinned near sandbox ${VERSION} for ${platform}`);
const response = await fetch(artifact.url);
if (!response.ok) throw new Error(`sandbox download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== artifact.sha256) {
  throw new Error(`sandbox checksum mismatch: expected ${artifact.sha256}, got ${digest}`);
}

mkdirSync(binDir, { recursive: true });
const archive = join(binDir, "near-sandbox.tar.gz");
writeFileSync(archive, bytes);
try {
  execFileSync("tar", ["-xzf", archive, "-C", binDir, "--strip-components=1"], {
    stdio: "inherit",
  });
} finally {
  rmSync(archive, { force: true });
}
if (!existsSync(binPath)) throw new Error("sandbox archive did not contain near-sandbox");
chmodSync(binPath, 0o755);
console.log(currentVersion().split("\n")[0]);
