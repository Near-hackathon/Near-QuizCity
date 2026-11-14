import assert from "node:assert/strict";
import test from "node:test";
import { isVenueOpen } from "../src/index.js";

test("empty apartment hours mean always open; malformed schedules fail closed", () => {
  const night = new Date("2026-11-13T22:00:00Z");
  for (const hours of [{}, null, undefined]) assert.equal(isVenueOpen(hours, night), true);
  for (const hours of [
    { open: "08:00" },
    { close: "20:00" },
    { open: "25:00", close: "20:00" },
    [],
    "invalid",
  ])
    assert.equal(isVenueOpen(hours, night), false);
});
test("venue hours obey opening/closing boundaries and overnight schedules", () => {
  for (const [time, expected] of [
    ["07:59", false],
    ["08:00", true],
    ["19:59", true],
    ["20:00", false],
  ] as const)
    assert.equal(
      isVenueOpen({ open: "08:00", close: "20:00" }, new Date(`2026-11-13T${time}:00Z`)),
      expected,
    );
  assert.equal(isVenueOpen({ open: "22:00", close: "06:00" }, new Date("2026-11-13T23:00:00Z")), true);
  assert.equal(isVenueOpen({ open: "22:00", close: "06:00" }, new Date("2026-11-13T10:00:00Z")), false);
  assert.equal(isVenueOpen({ open: "00:00", close: "00:00" }, new Date("2026-11-13T12:00:00Z")), true);
});
