import assert from "node:assert/strict";
import test from "node:test";
import { percentile, worldLoadConfig } from "../src/world-load-config.js";

const valid = {
  APP_ENV: "test",
  WORLD_LOAD_CONFIRM: "1",
  TEST_DATABASE_URL: "postgresql://quizcity:secret@localhost:5432/quizcity_test",
  DATABASE_URL: "postgresql://quizcity:secret@localhost:5432/quizcity",
};

test("world load guard requires local confirmation and a dedicated loopback database", () => {
  assert.throws(() => worldLoadConfig({ ...valid, WORLD_LOAD_CONFIRM: "0" }), /WORLD_LOAD_CONFIRM=1/);
  assert.throws(() => worldLoadConfig({ ...valid, APP_ENV: "production" }), /only local and test/);
  assert.throws(
    () =>
      worldLoadConfig({
        ...valid,
        TEST_DATABASE_URL: "postgresql://quizcity:secret@db.example/quizcity_test",
      }),
    /non-loopback/,
  );
  assert.throws(
    () => worldLoadConfig({ ...valid, TEST_DATABASE_URL: valid.DATABASE_URL }),
    /dedicated test database/,
  );
});

test("world load configuration bounds work and exposes no credentials", () => {
  assert.throws(() => worldLoadConfig({ ...valid, WORLD_LOAD_EVENTS: "0" }), /1 through 10000/);
  assert.throws(() => worldLoadConfig({ ...valid, WORLD_LOAD_EVENTS: "1.5" }), /1 through 10000/);
  const config = worldLoadConfig({ ...valid, WORLD_LOAD_EVENTS: "10000" });
  assert.equal(config.events, 10_000);
  assert.deepEqual(config.database, { host: "localhost", port: "5432", database: "quizcity_test" });
  assert.equal(JSON.stringify(config.database).includes("secret"), false);
});

test("world load percentiles use a stable nearest-rank calculation", () => {
  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([5, 1, 4, 2, 3], 0.5), 3);
  assert.equal(percentile([5, 1, 4, 2, 3], 0.95), 5);
});
