import assert from "node:assert/strict";
import test from "node:test";
import { decodeJobCursor, encodeJobCursor, pageResult } from "../src/cursor.js";

test("page results expose a stable next cursor and stop at the limit", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(
    pageResult(rows, 2, (row) => row.id),
    {
      items: [{ id: "a" }, { id: "b" }],
      nextCursor: "b",
    },
  );
  assert.deepEqual(
    pageResult(rows.slice(0, 2), 2, (row) => row.id),
    {
      items: [{ id: "a" }, { id: "b" }],
      nextCursor: null,
    },
  );
});

test("job cursors round-trip the timestamp and id tie-breaker", () => {
  const cursor = encodeJobCursor({
    created_at: "2026-11-12T12:00:00.000Z",
    id: "job-1",
  });
  assert.deepEqual(decodeJobCursor(cursor), {
    createdAt: "2026-11-12T12:00:00.000Z",
    id: "job-1",
  });
  assert.equal(decodeJobCursor(null), null);
  assert.equal(decodeJobCursor("missing-separator"), null);
});
