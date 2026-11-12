import assert from "node:assert/strict";
import test from "node:test";
import {
  DEMO_ONLY_EXPORTS,
  PRODUCTION_REQUIRED_EXPORTS,
  assertWasmExports,
  exportedFunctions,
  inspectWasmExports,
  wasmExportPolicy,
} from "./wasm-exports.mjs";

function uleb(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function section(id, content) {
  return Buffer.concat([Buffer.from([id]), uleb(content.length), content]);
}

function customSection(payload) {
  const name = Buffer.from("meta", "utf8");
  return section(0, Buffer.concat([uleb(name.length), name, Buffer.from(payload, "utf8")]));
}

/** Builds a valid WASM module exporting `names` as `() => ()` functions. */
function wasmWithExports(names, extraSections = []) {
  const types = section(1, Buffer.concat([uleb(1), Buffer.from([0x60, 0x00, 0x00])]));
  const functions = section(3, Buffer.concat([uleb(names.length), Buffer.alloc(names.length)]));

  const exportParts = [uleb(names.length)];
  names.forEach((name, index) => {
    const encoded = Buffer.from(name, "utf8");
    exportParts.push(uleb(encoded.length), encoded, Buffer.from([0x00]), uleb(index));
  });

  const bodies = [uleb(names.length)];
  for (let index = 0; index < names.length; index += 1) {
    bodies.push(Buffer.from([0x02, 0x00, 0x0b]));
  }

  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    types,
    functions,
    section(7, Buffer.concat(exportParts)),
    section(10, Buffer.concat(bodies)),
    ...extraSections,
  ]);
}

test("accepts a production artifact with every required function export", () => {
  const wasm = wasmWithExports(PRODUCTION_REQUIRED_EXPORTS);
  assert.doesNotThrow(() => assertWasmExports(wasm, { demo: false }));
  assert.deepEqual([...exportedFunctions(wasm)].sort(), [...PRODUCTION_REQUIRED_EXPORTS].sort());
});

test("rejects a production artifact with a missing required export", () => {
  const wasm = wasmWithExports(PRODUCTION_REQUIRED_EXPORTS.filter((name) => name !== "pay_job"));
  assert.throws(() => assertWasmExports(wasm, { demo: false }), /missing required function exports: pay_job/);
});

test("rejects a production artifact that exports a demo-only function", () => {
  const wasm = wasmWithExports([...PRODUCTION_REQUIRED_EXPORTS, "migrate_reset"]);
  assert.throws(() => assertWasmExports(wasm, { demo: false }), /forbidden function exports: migrate_reset/);
  assert.deepEqual(inspectWasmExports(wasm, { demo: false }).forbiddenExports, ["migrate_reset"]);
});

test("rejects a demo artifact missing migrate_reset", () => {
  const required = wasmExportPolicy(true).required.filter((name) => name !== "migrate_reset");
  const wasm = wasmWithExports(required);
  assert.throws(
    () => assertWasmExports(wasm, { demo: true }),
    /missing required function exports: migrate_reset/,
  );
});

test("accepts a complete demo artifact", () => {
  const wasm = wasmWithExports(wasmExportPolicy(true).required);
  assert.doesNotThrow(() => assertWasmExports(wasm, { demo: true }));
});

test("a method name appearing only as string data does not count as an export", () => {
  const wasm = wasmWithExports(["other_export"], [customSection("credit_reward")]);
  assert.equal(exportedFunctions(wasm).has("credit_reward"), false);
  assert.throws(
    () => assertWasmExports(wasm, { demo: false }),
    /missing required function exports: credit_reward/,
  );
});

test("invalid WASM bytes are rejected with a clear error", () => {
  assert.throws(() => assertWasmExports(Buffer.from([0x00, 0x61, 0x73]), { demo: false }), /invalid WASM/);
});

test("production and demo policies stay separate", () => {
  const production = wasmExportPolicy(false);
  const demo = wasmExportPolicy(true);
  assert.deepEqual(production.forbidden, DEMO_ONLY_EXPORTS);
  assert.deepEqual(demo.forbidden, []);
  for (const name of PRODUCTION_REQUIRED_EXPORTS) {
    assert.ok(production.required.includes(name));
    assert.ok(demo.required.includes(name));
  }
  for (const name of DEMO_ONLY_EXPORTS) {
    assert.ok(demo.required.includes(name));
    assert.equal(production.required.includes(name), false);
  }
});
