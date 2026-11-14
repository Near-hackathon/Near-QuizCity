import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareGameAssets } from "./game-assets.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.slice(2).some((arg) => arg !== "--check"))
  throw Error("Use assets:prepare or assets:check; unused optional packs have been removed.");
const catalog = JSON.parse(await readFile(path.join(root, "assets/phase7-catalog.json"), "utf8"));
const result = await prepareGameAssets(root, catalog, process.argv.includes("--check"));
console.log(
  `${process.argv.includes("--check") ? "Validated" : "Prepared"} ${result.files} canonical game files in ${result.groups} groups (${(result.bytes / 1024 / 1024).toFixed(2)} MiB); no original packs required.`,
);
