import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const catalogPath = path.join(repositoryRoot, "assets/phase7-catalog.json");
const args = new Set(process.argv.slice(2));
const supportedArgs = new Set(["--check", "--include-household"]);

for (const arg of args) {
  if (!supportedArgs.has(arg)) {
    throw new Error(`unknown argument: ${arg}`);
  }
}

const checkOnly = args.has("--check");
const includeHousehold = args.has("--include-household");

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

async function listFiles(directory, recursive) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isFile()) {
      files.push(absolute);
    } else if (recursive && entry.isDirectory()) {
      files.push(...(await listFiles(absolute, true)));
    }
  }
  return files;
}

async function expandGroup(group) {
  const sourceRoot = path.resolve(repositoryRoot, group.sourceRoot);
  if (!inside(repositoryRoot, sourceRoot)) {
    throw new Error(`${group.id}: source root escapes the repository`);
  }
  await stat(sourceRoot).catch(() => {
    throw new Error(
      `${group.id}: source pack is missing at ${group.sourceRoot}. Keep the licensed pack at this exact local path.`,
    );
  });

  const licensePath = path.resolve(sourceRoot, group.licenseFile);
  if (!inside(sourceRoot, licensePath)) {
    throw new Error(`${group.id}: license path escapes its source root`);
  }
  const license = await readFile(licensePath, "utf8");
  if (!/licen[cs]e|CC0/i.test(license)) {
    throw new Error(`${group.id}: license file did not contain an expected license marker`);
  }

  const selected = new Set();
  for (const rule of group.rules) {
    if (rule.type === "files") {
      for (const relative of rule.paths) selected.add(relative);
      continue;
    }
    if (rule.type !== "directory") {
      throw new Error(`${group.id}: unsupported catalog rule ${String(rule.type)}`);
    }
    const directory = path.resolve(sourceRoot, rule.path);
    if (!inside(sourceRoot, directory)) {
      throw new Error(`${group.id}: rule directory escapes its source root`);
    }
    const pattern = new RegExp(rule.pattern);
    for (const absolute of await listFiles(directory, rule.recursive)) {
      const relative = toPosix(path.relative(sourceRoot, absolute));
      if (pattern.test(relative.slice(toPosix(rule.path).length + 1))) selected.add(relative);
    }
  }

  if (selected.size === 0) throw new Error(`${group.id}: catalog selected no files`);
  return { sourceRoot, files: [...selected].sort() };
}

function readPngSize(buffer, label) {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error(`${label}: invalid PNG signature`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error(`${label}: invalid PNG dimensions`);
  return [width, height];
}

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
if (catalog.schemaVersion !== 1) throw new Error("unsupported Phase 7 asset catalog version");

const targetRoot = path.resolve(repositoryRoot, catalog.targetRoot);
if (!inside(repositoryRoot, targetRoot)) throw new Error("asset target root escapes the repository");

const selectedGroups = catalog.groups.filter(
  (group) => group.tier === "core" || (includeHousehold && group.tier === "optional-household"),
);
const manifestFiles = [];
const notices = [];
const seenTargets = new Set();

for (const group of selectedGroups) {
  const expanded = await expandGroup(group);
  const groupTarget = path.resolve(targetRoot, group.target);
  if (!inside(targetRoot, groupTarget)) throw new Error(`${group.id}: target escapes generated root`);
  notices.push(`${group.id}\n${group.credit}\nSource licence: ${group.target}/${group.licenseFile}\n`);

  for (const relative of expanded.files) {
    const source = path.resolve(expanded.sourceRoot, relative);
    if (!inside(expanded.sourceRoot, source)) throw new Error(`${group.id}: source file escapes root`);
    const target = path.resolve(groupTarget, relative);
    if (!inside(groupTarget, target)) throw new Error(`${group.id}: target file escapes group root`);
    const targetRelative = toPosix(path.relative(targetRoot, target));
    if (seenTargets.has(targetRelative)) throw new Error(`duplicate asset target: ${targetRelative}`);
    seenTargets.add(targetRelative);

    const buffer = await readFile(source).catch(() => {
      throw new Error(`${group.id}: missing catalogued file ${relative}`);
    });
    let dimensions;
    if (relative.endsWith(".png")) dimensions = readPngSize(buffer, `${group.id}/${relative}`);
    if (relative.endsWith(".json")) {
      try {
        JSON.parse(buffer.toString("utf8"));
      } catch (error) {
        throw new Error(`${group.id}/${relative}: invalid JSON (${error.message})`, { cause: error });
      }
    }
    const digest = createHash("sha256").update(buffer).digest("hex");
    manifestFiles.push({
      group: group.id,
      path: targetRelative,
      bytes: buffer.length,
      sha256: digest,
      ...(dimensions ? { dimensions } : {}),
    });

    if (!checkOnly) {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
}

const manifest = {
  schemaVersion: 1,
  catalogVersion: catalog.catalogVersion,
  generatedAt: new Date().toISOString(),
  sourcePolicy: "generated from local licensed packs; source packs are not repository content",
  rendering: catalog.rendering,
  groups: selectedGroups.map(({ id, tier, purpose, target, credit, creditRequired = false }) => ({
    id,
    tier,
    purpose,
    target,
    credit,
    creditRequired,
  })),
  files: manifestFiles,
};

if (!checkOnly) {
  await mkdir(targetRoot, { recursive: true });
  await writeFile(path.join(targetRoot, "asset-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    path.join(targetRoot, "THIRD_PARTY_NOTICES.txt"),
    `QUIZ CITY - GENERATED ASSET NOTICES\n\n${notices.join("\n")}`,
  );
}

const totalBytes = manifestFiles.reduce((sum, file) => sum + file.bytes, 0);
const mode = checkOnly ? "validated" : "prepared";
console.log(
  `${mode} ${manifestFiles.length} files in ${selectedGroups.length} groups (${(totalBytes / 1024 / 1024).toFixed(2)} MiB)`,
);
if (!includeHousehold) {
  console.log(
    "optional household atlases were not staged; use npm run assets:prepare:optional to include them",
  );
}
