import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
export function assetPath(root, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    !/^[A-Za-z0-9_./-]+$/.test(relative) ||
    relative.split("/").some((p) => !p || p === "." || p === "..") ||
    path.isAbsolute(relative)
  )
    throw Error("Invalid game asset path");
  return path.join(root, relative);
}
async function inventory(root, relative = "") {
  const files = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (item.name === ".DS_Store") continue;
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw Error("Game assets must not contain symlinks");
    if (item.isDirectory()) files.push(...(await inventory(root, name)));
    else if (item.isFile()) files.push(name);
  }
  return files.sort();
}
/** Curated game files are canonical, not copies rebuilt from external packs. */
export async function prepareGameAssets(repositoryRoot, catalog, check = false) {
  if (catalog.schemaVersion !== 2 || !Array.isArray(catalog.groups) || !catalog.groups.length)
    throw Error("Unsupported game asset catalogue");
  const root = assetPath(repositoryRoot, catalog.targetRoot),
    actual = await inventory(root),
    seen = new Set(),
    files = [],
    notices = [];
  for (const group of catalog.groups) {
    if (!Array.isArray(group.files) || !group.files.length) throw Error("Empty game asset group");
    if (group.permissionEvidence) {
      await readFile(assetPath(repositoryRoot, group.permissionEvidence.record), "utf8");
    } else {
      const license = await readFile(assetPath(root, `${group.target}/${group.licenseFile}`), "utf8");
      if (!/licen[cs]e|CC0/i.test(license)) throw Error("Missing game asset licence");
    }
    notices.push(
      `${group.id}\n${group.credit}\n${group.permissionEvidence ? `Permission evidence: ${group.permissionEvidence.record} (owner confirmation; no supplied licence)` : `Licence: ${group.target}/${group.licenseFile}`}\n`,
    );
    for (const relative of [...group.files].sort()) {
      const name = `${group.target}/${relative}`;
      const file = assetPath(root, name);
      if (seen.has(name)) throw Error("Duplicate game asset");
      seen.add(name);
      if (!actual.includes(name)) throw Error(`Missing game asset: ${name}`);
      const bytes = await readFile(file);
      if (!bytes.length) throw Error("Empty game asset");
      let dimensions;
      if (name.endsWith(".png")) {
        if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
          throw Error("Invalid PNG asset");
        dimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
        if (dimensions.some((n) => n < 1)) throw Error("Invalid PNG dimensions");
      }
      if (name.endsWith(".json")) JSON.parse(bytes.toString("utf8"));
      files.push({
        group: group.id,
        path: name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...(dimensions ? { dimensions } : {}),
      });
    }
  }
  const metadata = ["asset-manifest.json", "THIRD_PARTY_NOTICES.txt"];
  const extra = actual.filter((p) => !seen.has(p) && !metadata.includes(p));
  if (extra.length) throw Error(`Uncatalogued game assets: ${extra.join(", ")}`);
  const manifest = {
    schemaVersion: 1,
    catalogVersion: catalog.catalogVersion,
    sourcePolicy: "Canonical curated game assets; original download packs are not required.",
    rendering: catalog.rendering,
    groups: catalog.groups.map(({ id, tier, purpose, target, credit, creditRequired = false }) => ({
      id,
      tier,
      purpose,
      target,
      credit,
      creditRequired,
    })),
    files,
  };
  const outputs = {
    "asset-manifest.json": JSON.stringify(manifest, null, 2) + "\n",
    "THIRD_PARTY_NOTICES.txt": `QUIZ CITY - GAME ASSET NOTICES\n\n${notices.join("\n")}`,
  };
  for (const [name, contents] of Object.entries(outputs)) {
    if (check) {
      if ((await readFile(path.join(root, name), "utf8")) !== contents)
        throw Error(`Stale ${name}; run assets:prepare`);
    } else await writeFile(path.join(root, name), contents);
  }
  return {
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    groups: catalog.groups.length,
  };
}
