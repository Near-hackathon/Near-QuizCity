import assert from "node:assert/strict";
import test from "node:test";
import { collectPages, isLegacyMethodError, PaginationError } from "../src/pagination.js";

type Item = { id: number };

const items = (start: number, end: number): Item[] =>
  Array.from({ length: end - start }, (_, index) => ({ id: start + index }));

const ids = (rows: Item[]) => rows.map((row) => row.id);

test("collects multiple pages and a final partial page", async () => {
  const calls: number[] = [];
  const rows = await collectPages<Item>({
    total: 5,
    pageSize: 2,
    fetchPage: async (from, limit) => {
      calls.push(from);
      return items(from, Math.min(from + limit, 5));
    },
    idOf: (item) => item.id,
  });
  assert.deepEqual(ids(rows), [0, 1, 2, 3, 4]);
  assert.deepEqual(calls, [0, 2, 4]);
});

test("returns empty without fetching when total is zero", async () => {
  const rows = await collectPages<Item>({
    total: 0,
    pageSize: 100,
    fetchPage: async () => {
      throw new Error("should not fetch");
    },
    idOf: (item) => item.id,
  });
  assert.deepEqual(rows, []);
});

test("rejects duplicate ids across pages", async () => {
  await assert.rejects(
    collectPages<Item>({
      total: 2,
      pageSize: 1,
      fetchPage: async () => [{ id: 1 }],
      idOf: (item) => item.id,
    }),
    PaginationError,
  );
});

test("rejects an early empty page", async () => {
  let call = 0;
  await assert.rejects(
    collectPages<Item>({
      total: 3,
      pageSize: 2,
      fetchPage: async () => {
        call += 1;
        return call === 1 ? items(0, 2) : [];
      },
      idOf: (item) => item.id,
    }),
    /ended early/,
  );
});

test("rejects an oversized page", async () => {
  await assert.rejects(
    collectPages<Item>({
      total: 3,
      pageSize: 2,
      fetchPage: async () => items(0, 3),
      idOf: (item) => item.id,
    }),
    /returned 3 items/,
  );
});

test("propagates transient errors and does not fall back", async () => {
  let legacyCalled = false;
  await assert.rejects(
    collectPages<Item>({
      total: 2,
      pageSize: 2,
      fetchPage: async () => {
        throw new Error("RPC timeout");
      },
      idOf: (item) => item.id,
      legacy: async () => {
        legacyCalled = true;
        return [];
      },
    }),
    /RPC timeout/,
  );
  assert.equal(legacyCalled, false);
});

test("falls back only for a method-not-found error", async () => {
  const rows = await collectPages<Item>({
    total: 2,
    pageSize: 2,
    fetchPage: async () => {
      throw new Error("MethodNotFound: method get_properties is not found");
    },
    idOf: (item) => item.id,
    legacy: async () => items(0, 2),
  });
  assert.deepEqual(ids(rows), [0, 1]);
});

test("validates a legacy fallback count", async () => {
  await assert.rejects(
    collectPages<Item>({
      total: 2,
      pageSize: 2,
      fetchPage: async () => {
        throw new Error("MethodNotFound");
      },
      idOf: (item) => item.id,
      legacy: async () => items(0, 1),
    }),
    /legacy fallback returned 1 items/,
  );
});

test("rejects a non-array legacy fallback", async () => {
  await assert.rejects(
    collectPages<Item>({
      total: 1,
      pageSize: 100,
      fetchPage: async () => {
        throw new Error("MethodNotFound");
      },
      idOf: (item) => item.id,
      legacy: async () => null,
    }),
    /did not return an array/,
  );
});

test("legacy error matcher ignores unrelated failures", () => {
  assert.equal(isLegacyMethodError(new Error("RPC timeout")), false);
  assert.equal(isLegacyMethodError(new Error("Contract method 'get_properties' is not found")), true);
  assert.equal(isLegacyMethodError(new Error("MethodNotFound")), true);
  assert.equal(
    isLegacyMethodError(new Error("Failed to deserialize input: invalid type: map, expected unit")),
    true,
  );
});
