import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createMaps, validateMaps } from "./phase7-map-lib.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const maps = createMaps();
validateMaps(maps);
const entries = [];
for (const map of maps) {
  const contents = `${JSON.stringify(map, null, 2)}\n`;
  const source = join(root, "assets/maps", `${map.sceneId}.tmj`);
  if (check) {
    const saved = await readFile(source, "utf8");
    if (saved !== contents) throw new Error(`Stale map: ${map.sceneId}; run maps:prepare`);
  } else {
    await mkdir(join(root, "assets/maps"), { recursive: true });
    await writeFile(source, contents);
  }
  entries.push({
    sceneId: map.sceneId,
    path: `${map.sceneId}.tmj`,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
}
const registry = `${JSON.stringify({ version: 1, maps: entries }, null, 2)}\n`;
const registryPath = join(root, "assets/maps/registry.json");
if (check) {
  if ((await readFile(registryPath, "utf8")) !== registry) throw new Error("Stale map registry");
} else {
  await writeFile(registryPath, registry);
}
console.log(
  `${check ? "Validated" : "Prepared"} ${maps.length} deterministic maps with shared collision/door/spawn definitions`,
);
