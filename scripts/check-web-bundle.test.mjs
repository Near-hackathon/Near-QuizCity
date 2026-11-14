import assert from "node:assert/strict";
import test from "node:test";
import { BUDGETS, inspectBundle, overBudget } from "./check-web-bundle.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bundle budgets enforce both raw and gzip limits", () => {
  assert.deepEqual(overBudget("chunk", { raw: 10, gzip: 5 }, { raw: 10, gzip: 5 }), []);
  assert.deepEqual(overBudget("chunk", { raw: 11, gzip: 6 }, { raw: 10, gzip: 5 }), [
    "chunk raw 11 > 10",
    "chunk gzip 6 > 5",
  ]);
});

function bundle(run) {
  const directory = mkdtempSync(join(tmpdir(), "quizcity-bundle-"));
  mkdirSync(join(directory, "assets"));
  mkdirSync(join(directory, ".vite"));
  const manifest = {
    "index.html": { file: "assets/app.js", dynamicImports: ["src/game/layout.tsx", "src/routes/manage.tsx"] },
    "src/game/layout.tsx": { file: "assets/layout.js", dynamicImports: ["src/game/createGame.ts"] },
    "src/game/createGame.ts": { file: "assets/game.js", imports: ["index.html"] },
    "src/routes/manage.tsx": { file: "assets/manage.js", imports: ["index.html"] },
  };
  for (const entry of Object.values(manifest)) writeFileSync(join(directory, entry.file), "export {};\n");
  const save = () => writeFileSync(join(directory, ".vite/manifest.json"), JSON.stringify(manifest));
  save();
  try {
    run(directory, manifest, save);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("nested lazy engine is counted separately while application budgets stay unchanged", () => {
  bundle((directory) => {
    const result = inspectBundle(directory);
    assert.deepEqual(result.failures, []);
    assert.equal(result.game.raw, Buffer.byteLength("export {};\n"));
    assert.equal(result.application.raw, result.total.raw - result.game.raw);
    assert.deepEqual(BUDGETS.total, { raw: 800_000, gzip: 250_000 });
  });
});

test("a management route importing the engine fails the eager-load check", () => {
  bundle((directory, manifest, save) => {
    manifest["src/routes/manage.tsx"].imports.push("src/game/createGame.ts");
    save();
    assert.ok(
      inspectBundle(directory).failures.includes("Phaser is eagerly reachable from src/routes/manage.tsx"),
    );
  });
});

test("oversized lazy engines fail their separate budget", () => {
  bundle((directory) => {
    writeFileSync(join(directory, "assets/game.js"), "x".repeat(BUDGETS.game.raw + 1));
    assert.ok(inspectBundle(directory).failures.some((failure) => failure.startsWith("game raw")));
  });
});
