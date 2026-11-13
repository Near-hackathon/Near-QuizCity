#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else assets.push(path);
  }
}
try {
  walk(join(root, "web/dist"));
} catch {
  console.log("web build output not found; run `npm run build --workspace=web` first");
  process.exit(0);
}

console.log("\n### Bundle sizes\n");
console.log("| Asset | Raw | Gzip |");
console.log("| --- | ---: | ---: |");
let totalRaw = 0;
let totalGzip = 0;
for (const path of assets.sort()) {
  const raw = statSync(path).size;
  const gzip = gzipSync(readFileSync(path)).length;
  totalRaw += raw;
  totalGzip += gzip;
  console.log(`| ${relative(root, path)} | ${raw} | ${gzip} |`);
}
console.log(`| **total** | **${totalRaw}** | **${totalGzip}** |`);

for (const wasm of ["quizcity-production.wasm", "quizcity-demo.wasm"]) {
  try {
    const size = statSync(join(root, "contract/target/near", wasm)).size;
    console.log(`\n${wasm}: ${size} bytes (raw, gzip not applicable to deployment)`);
  } catch {
    // artifact may not be built in this job
  }
}
