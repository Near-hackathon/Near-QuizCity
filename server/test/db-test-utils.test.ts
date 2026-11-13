import assert from "node:assert/strict";
import test from "node:test";
import { validateTestDatabaseUrl } from "./db-test-utils.js";

const dev = "postgresql://quizcity:secret@127.0.0.1:5432/quizcity";

test("test database guard rejects missing, malformed, unsafe, and non-disposable targets", () => {
  for (const [input, pattern] of [
    [undefined, /required/],
    ["", /required/],
    ["   ", /required/],
    ["not a url", /valid URL/],
    ["mysql://127.0.0.1:3306/quizcity_test", /postgres/],
    ["postgresql://quizcity:secret@db.example.com:5432/quizcity_test", /non-loopback/],
    ["postgresql://quizcity:secret@127.0.0.1:5432/", /name a database/],
    ["postgresql://quizcity:secret@127.0.0.1:5432/quizcity", /dedicated test database/],
    ["postgresql://quizcity:secret@127.0.0.1:5432/quizcity_prod_test", /dedicated test database/],
  ] as const) {
    assert.throws(() => validateTestDatabaseUrl(input, undefined), pattern);
  }
});

test("test database guard rejects the configured development target", () => {
  const sameTarget = "postgresql://quizcity:secret@127.0.0.1:5432/quizcity_test";
  assert.throws(
    () => validateTestDatabaseUrl(sameTarget, sameTarget),
    /must not point at the configured DATABASE_URL/,
  );
  assert.throws(() => validateTestDatabaseUrl(dev, dev), /dedicated test database/);
});

test("test database guard accepts dedicated loopback databases", () => {
  for (const url of [
    "postgresql://quizcity:secret@127.0.0.1:5432/quizcity_test",
    "postgresql://quizcity:secret@localhost:5432/quizcity_test",
    "postgresql://quizcity:secret@[::1]:5432/quizcity_test",
    "postgresql://quizcity:secret@127.0.0.1:5432/quizcity_test_alpha1",
  ]) {
    assert.equal(validateTestDatabaseUrl(url, dev), url);
  }
  assert.ok(validateTestDatabaseUrl("postgresql://quizcity:secret@127.0.0.1:5433/quizcity_test", dev));
});
