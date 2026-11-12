#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWasmExports } from "./wasm-exports.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nearDir = join(root, "contract", "target", "near");

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const wasmIndex = args.indexOf("--wasm");
if (wasmIndex !== -1 && !args[wasmIndex + 1]) {
  console.error("usage: node scripts/check-contract-abi.mjs [--demo] [--wasm <path>]");
  process.exit(2);
}
const defaultWasm = join(nearDir, demo ? "quizcity-demo.wasm" : "quizcity-production.wasm");
const wasmPath = wasmIndex === -1 ? defaultWasm : resolve(args[wasmIndex + 1]);

if (!existsSync(wasmPath)) {
  console.error(`missing WASM: ${wasmPath}`);
  console.error(`build it first (npm run ${demo ? "contract:build:demo" : "contract:build"})`);
  process.exit(1);
}

const wasm = readFileSync(wasmPath);

try {
  assertWasmExports(wasm, { demo });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`${demo ? "demo" : "production"} WASM contract surface is correct (${basename(wasmPath)})`);
