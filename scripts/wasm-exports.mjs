/**
 * Inspect a compiled NEAR WASM artifact by its real WebAssembly exports.
 *
 * String search over raw bytes cannot prove a method is exported: the same
 * bytes can appear in a custom section, a panic message, or a data segment.
 * ABI checks must compile the module and read `WebAssembly.Module.exports`.
 */

export const PRODUCTION_REQUIRED_EXPORTS = [
  "credit_reward",
  "pay_job",
  "pay_order",
  "supports_orders",
  "supports_city_economy",
  "fund_escrow",
  "settle_escrow",
  "npc_purchase",
  "pay_admission",
  "list_lease",
  "pay_rent",
  "cancel_order",
  "refund_order",
  "refund_admission",
  "list_business",
  "buy_business",
  "cancel_charge",
  "sponsor_quiz",
  "pay_business_tax",
  "get_lease",
  "get_reward_policy",
  "migrate_economy",
  "get_properties",
  "get_businesses",
];

export const DEMO_ONLY_EXPORTS = ["migrate_reset", "reset_demo"];

/**
 * Returns the set of exported function names, or throws for malformed WASM.
 * @param {Buffer | Uint8Array} wasm
 * @returns {Set<string>}
 */
export function exportedFunctions(wasm) {
  let module;
  try {
    module = new WebAssembly.Module(wasm);
  } catch (error) {
    throw new Error(`invalid WASM: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return new Set(
    WebAssembly.Module.exports(module)
      .filter((entry) => entry.kind === "function")
      .map((entry) => entry.name),
  );
}

/**
 * The separate production and demo ABI policies.
 * @param {boolean} demo
 */
export function wasmExportPolicy(demo) {
  return {
    required: demo
      ? [...PRODUCTION_REQUIRED_EXPORTS, ...DEMO_ONLY_EXPORTS]
      : [...PRODUCTION_REQUIRED_EXPORTS],
    forbidden: demo ? [] : [...DEMO_ONLY_EXPORTS],
  };
}

/**
 * Inspects actual exports against the selected policy without throwing for
 * policy violations. Malformed WASM still throws a clear error.
 * @param {Buffer | Uint8Array} wasm
 * @param {{ demo?: boolean }} [options]
 */
export function inspectWasmExports(wasm, { demo = false } = {}) {
  const { required, forbidden } = wasmExportPolicy(demo);
  const exports = exportedFunctions(wasm);
  const missing = required.filter((name) => !exports.has(name));
  const forbiddenExports = forbidden.filter((name) => exports.has(name));
  return { exports, required, forbidden, missing, forbiddenExports };
}

/**
 * Throws when the artifact violates its policy; returns the inspection result.
 * @param {Buffer | Uint8Array} wasm
 * @param {{ demo?: boolean }} [options]
 */
export function assertWasmExports(wasm, { demo = false } = {}) {
  const result = inspectWasmExports(wasm, { demo });
  const label = demo ? "demo" : "production";
  if (result.missing.length > 0) {
    throw new Error(`${label} WASM is missing required function exports: ${result.missing.join(", ")}`);
  }
  if (result.forbiddenExports.length > 0) {
    throw new Error(
      `${label} WASM exposes forbidden function exports: ${result.forbiddenExports.join(", ")}`,
    );
  }
  return result;
}
