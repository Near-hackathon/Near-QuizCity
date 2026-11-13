import assert from "node:assert/strict";
import test from "node:test";
import { runCleanupSteps } from "./e2e/cleanup.js";

test("E2E cleanup attempts every step and aggregates failures", async () => {
  const visited: string[] = [];
  await assert.rejects(
    runCleanupSteps([
      {
        name: "first",
        run: async () => {
          visited.push("first");
          throw new Error("first failed");
        },
      },
      {
        name: "second",
        run: async () => {
          visited.push("second");
        },
      },
      {
        name: "third",
        run: async () => {
          visited.push("third");
          throw new Error("third failed");
        },
      },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /first failed/);
      assert.match(String(error.errors[1]), /third failed/);
      return true;
    },
  );
  assert.deepEqual(visited, ["first", "second", "third"]);
});
