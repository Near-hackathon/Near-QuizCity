import { tap } from "node:test/reporters";

export const SERVER_COVERAGE_FLOORS = Object.freeze({
  lines: 68,
  branches: 88,
  functions: 78,
});

export function coverageFailures(totals, floors = SERVER_COVERAGE_FLOORS) {
  const values = {
    lines: Number(totals?.coveredLinePercent),
    branches: Number(totals?.coveredBranchPercent),
    functions: Number(totals?.coveredFunctionPercent),
  };
  const failures = [];
  for (const key of Object.keys(values)) {
    if (!Number.isFinite(values[key])) {
      failures.push(`${key} coverage is missing`);
    } else if (values[key] < floors[key]) {
      failures.push(`${key} coverage ${values[key].toFixed(2)}% is below ${floors[key].toFixed(2)}%`);
    }
  }
  return { values, failures };
}

export default async function* serverCoverageReporter(source) {
  let totals;
  async function* observe() {
    for await (const event of source) {
      if (event.type === "test:coverage") totals = event.data?.summary?.totals;
      yield event;
    }
  }

  for await (const output of tap(observe())) yield output;

  const { values, failures } = coverageFailures(totals);
  yield `# server coverage gate: lines ${values.lines.toFixed(2)}% / branches ${values.branches.toFixed(2)}% / functions ${values.functions.toFixed(2)}%\n`;
  if (failures.length > 0) {
    throw new Error(`server coverage gate failed: ${failures.join("; ")}`);
  }
}
