#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUDGETS = {
  initial: { raw: 300_000, gzip: 100_000 },
  routeChunk: { raw: 200_000, gzip: 70_000 },
  wallet: { raw: 500_000, gzip: 160_000 },
  game: { raw: 1_600_000, gzip: 460_800 },
  // Preserve the Phase 5 application budget independently of the new lazy engine.
  total: { raw: 800_000, gzip: 250_000 },
};

export function overBudget(label, size, budget) {
  const failures = [];
  if (size.raw > budget.raw) failures.push(`${label} raw ${size.raw} > ${budget.raw}`);
  if (size.gzip > budget.gzip) failures.push(`${label} gzip ${size.gzip} > ${budget.gzip}`);
  return failures;
}

function assetSize(dist, file) {
  const bytes = readFileSync(join(dist, file));
  return { raw: bytes.length, gzip: gzipSync(bytes).length };
}

function add(left, right) {
  return { raw: left.raw + right.raw, gzip: left.gzip + right.gzip };
}

export function inspectBundle(dist) {
  const manifestPath = join(dist, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`missing Vite manifest: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`malformed Vite manifest: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const entry = manifest["index.html"];
  if (!entry?.file) throw new Error("manifest has no index.html entry");

  const jsFiles = readdirSync(join(dist, "assets"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => `assets/${file}`);
  const sizes = new Map(jsFiles.map((file) => [file, assetSize(dist, file)]));
  const initial = sizes.get(entry.file);
  if (!initial) throw new Error(`entry asset is missing: ${entry.file}`);

  const gameRoots = Object.keys(manifest).filter((key) => key === "src/game/createGame.ts");
  const optionalRoots = (entry.dynamicImports ?? []).filter(
    (key) => !key.startsWith("src/routes/") && !key.startsWith("src/game/"),
  );
  const optionalKeys = new Set();
  const visit = (key) => {
    if (optionalKeys.has(key) || !manifest[key]) return;
    optionalKeys.add(key);
    for (const dependency of manifest[key].imports ?? []) visit(dependency);
  };
  for (const key of optionalRoots) visit(key);
  optionalKeys.delete("index.html");
  const optionalFiles = new Set([...optionalKeys].map((key) => manifest[key]?.file).filter(Boolean));
  const gameKeys = new Set();
  const visitGame = (key) => {
    if (gameKeys.has(key) || !manifest[key]) return;
    gameKeys.add(key);
    if (manifest[key].file === entry.file) return;
    for (const dependency of manifest[key].imports ?? []) visitGame(dependency);
  };
  for (const key of gameRoots) visitGame(key);
  const eagerClosure = (root) => {
    const keys = new Set();
    const walk = (key) => {
      if (keys.has(key) || !manifest[key]) return;
      keys.add(key);
      for (const dependency of manifest[key].imports ?? []) walk(dependency);
    };
    walk(root);
    return keys;
  };
  const protectedRoots = ["index.html", "src/routes/manage.tsx", "src/routes/admin.tsx"];
  const engineKeys = new Set([...gameRoots, ...Object.keys(manifest).filter((key) => /phaser/i.test(key))]);
  const leaked = protectedRoots.filter((root) => [...eagerClosure(root)].some((key) => engineKeys.has(key)));
  const applicationKeys = new Set(protectedRoots.flatMap((root) => [...eagerClosure(root)]));
  const gameFiles = new Set(
    [...gameKeys]
      .filter((key) => !applicationKeys.has(key))
      .map((key) => manifest[key]?.file)
      .filter(Boolean),
  );

  let wallet = { raw: 0, gzip: 0 };
  for (const file of optionalFiles) wallet = add(wallet, sizes.get(file) ?? { raw: 0, gzip: 0 });
  let game = { raw: 0, gzip: 0 };
  for (const file of gameFiles) game = add(game, sizes.get(file) ?? { raw: 0, gzip: 0 });
  let total = { raw: 0, gzip: 0 };
  for (const size of sizes.values()) total = add(total, size);
  const application = { raw: total.raw - game.raw, gzip: total.gzip - game.gzip };

  const failures = [
    ...overBudget("initial entry", initial, BUDGETS.initial),
    ...overBudget("optional wallet", wallet, BUDGETS.wallet),
    ...overBudget("game", game, BUDGETS.game),
    ...overBudget("application JavaScript excluding lazy engine", application, BUDGETS.total),
    ...leaked.map((root) => `Phaser is eagerly reachable from ${root}`),
  ];
  for (const [file, size] of sizes) {
    if (file === entry.file || optionalFiles.has(file) || gameFiles.has(file)) continue;
    failures.push(...overBudget(`route chunk ${basename(file)}`, size, BUDGETS.routeChunk));
  }
  return { initial, wallet, game, application, total, failures };
}

function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  if (!process.argv.includes("--skip-build")) {
    const build = spawnSync("npm", ["run", "build", "--workspace=web"], {
      cwd: root,
      encoding: "utf8",
    });
    const output = `${build.stdout ?? ""}${build.stderr ?? ""}`;
    process.stdout.write(output);
    if (build.status !== 0) process.exit(build.status ?? 1);
    if (/externalized for browser compatibility|Use of eval|mixed static and dynamic imports/i.test(output)) {
      throw new Error("production build emitted a forbidden compatibility, eval, or mixed-import warning");
    }
  }
  const result = inspectBundle(join(root, "web", "dist"));
  console.log(
    `Bundle budgets: initial ${result.initial.raw}/${result.initial.gzip}, wallet ${result.wallet.raw}/${result.wallet.gzip}, game ${result.game.raw}/${result.game.gzip}, total ${result.total.raw}/${result.total.gzip} (raw/gzip bytes)`,
  );
  if (result.failures.length) throw new Error(`bundle budget failed:\n- ${result.failures.join("\n- ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
