#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractDir = join(root, "contract");
const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("usage: node scripts/run-contract.mjs <command> [...args]");
  process.exit(2);
}

const result = spawnSync(command, args, { cwd: contractDir, stdio: "inherit", env: process.env });
if (result.error) {
  console.error(`failed to run ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
