import assert from "node:assert/strict";
import test from "node:test";
import { coverageFailures, SERVER_COVERAGE_FLOORS } from "./server-coverage-reporter.mjs";

test("server coverage floors accept the reviewed baseline", () => {
  const result = coverageFailures({
    coveredLinePercent: SERVER_COVERAGE_FLOORS.lines,
    coveredBranchPercent: SERVER_COVERAGE_FLOORS.branches,
    coveredFunctionPercent: SERVER_COVERAGE_FLOORS.functions,
  });
  assert.deepEqual(result.failures, []);
});

test("server coverage floors reject regressions and missing totals", () => {
  const regressed = coverageFailures({
    coveredLinePercent: 67.99,
    coveredBranchPercent: 87.99,
    coveredFunctionPercent: 77.99,
  });
  assert.equal(regressed.failures.length, 3);
  assert.match(regressed.failures.join("\n"), /lines coverage 67\.99% is below 68\.00%/);

  const missing = coverageFailures(undefined);
  assert.equal(missing.failures.length, 3);
  assert.match(missing.failures[0], /missing/);
});
