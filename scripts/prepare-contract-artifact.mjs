#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nearDir = join(root, "contract", "target", "near");
const source = join(nearDir, "quizcity.wasm");

const variants = {
  production: join(nearDir, "quizcity-production.wasm"),
  demo: join(nearDir, "quizcity-demo.wasm"),
};

const variant = process.argv[2];
const destination = variants[variant];

if (!destination) {
  console.error(`usage: node scripts/prepare-contract-artifact.mjs <${Object.keys(variants).join("|")}>`);
  process.exit(2);
}
if (!existsSync(source)) {
  console.error(`missing contract build output: ${source}`);
  process.exit(1);
}

copyFileSync(source, destination);
const bytes = readFileSync(destination);
const sha256 = createHash("sha256").update(bytes).digest("hex");
console.log(`${variant} artifact: ${destination} (${bytes.length} bytes)`);
console.log(`${variant} sha256: ${sha256}`);
