#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const toolchainFile = resolve(option("--toolchain-file", join(root, "contract", "rust-toolchain.toml")));
const contractDir = resolve(option("--contract-dir", join(root, "contract")));
const rustc = option("--rustc", "rustc");

const toml = readFileSync(toolchainFile, "utf8");
const channel = toml.match(/^\s*channel\s*=\s*"([^"]+)"/m)?.[1];
if (!channel) {
  console.error(`toolchain check: no channel found in ${toolchainFile}`);
  process.exit(1);
}
const expected = channel.replace(/^v/, "");

let rustcOutput;
try {
  rustcOutput = execFileSync(rustc, ["--version"], { cwd: contractDir, encoding: "utf8" }).trim();
} catch (error) {
  console.error(`toolchain check: could not run ${rustc} in ${contractDir}: ${error.message}`);
  process.exit(1);
}
const actual = rustcOutput.match(/rustc (\d+\.\d+\.\d+)/)?.[1];
const cargoOutput = execFileSync("cargo", ["--version"], { cwd: contractDir, encoding: "utf8" }).trim();

console.log(`toolchain check: pinned ${expected} | active ${actual ?? "unknown"} | ${cargoOutput}`);
if (actual !== expected) {
  console.error(
    `toolchain check failed: expected rustc ${expected} from ${toolchainFile}, found ${actual ?? rustcOutput}.\n` +
      `Run the contract commands from ${contractDir} (or use scripts/run-contract.mjs).`,
  );
  process.exit(1);
}
