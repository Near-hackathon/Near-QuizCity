import assert from "node:assert/strict";
import test from "node:test";
import {
  activeScheduleAt,
  assertNoScheduleOverlap,
  cityDayAndMinute,
  evaluateSchedule,
  nextScheduleTransition,
  validateTimeZone,
} from "../src/world-schedules.js";

const schedules = [
  {
    id: "teach",
    npcId: "professor-kofi",
    sequence: 1,
    dayMask: 127,
    startMinute: 720,
    endMinute: 1080,
    activity: "teach",
    destinationSceneId: "library-interior",
    destinationBuildingId: "building-library",
    destinationSpawnId: "library-spawn",
  },
  {
    id: "research",
    npcId: "professor-kofi",
    sequence: 0,
    dayMask: 127,
    startMinute: 480,
    endMinute: 720,
    activity: "research",
    destinationSceneId: "library-interior",
    destinationBuildingId: "building-library",
    destinationSpawnId: "library-spawn",
  },
] as const;

test("schedule selection is deterministic and end-exclusive", () => {
  assert.equal(activeScheduleAt([...schedules], 1, 479), null);
  assert.equal(activeScheduleAt([...schedules], 1, 480)?.id, "research");
  assert.equal(activeScheduleAt([...schedules], 1, 719)?.id, "research");
  assert.equal(activeScheduleAt([...schedules], 1, 720)?.id, "teach");
  assert.equal(activeScheduleAt([...schedules], 1, 1080), null);
  assert.equal(activeScheduleAt([...schedules].reverse(), 1, 720)?.id, "teach");
});

test("day mask is respected and transitions are ordered", () => {
  const mondayOnly = schedules.map((schedule) => ({ ...schedule, dayMask: 1 << 1 }));
  assert.equal(activeScheduleAt(mondayOnly, 0, 500), null);
  assert.equal(activeScheduleAt(mondayOnly, 1, 500)?.id, "research");
  assert.deepEqual(nextScheduleTransition(mondayOnly, 1, 500), {
    schedule: mondayOnly[0],
    atMinute: 720,
  });
  assert.equal(nextScheduleTransition(mondayOnly, 1, 1080), null);
});

test("city time derives a stable UTC day/minute", () => {
  assert.deepEqual(cityDayAndMinute(new Date("2026-11-13T12:34:00.000Z")), { day: 5, minute: 754 });
});

test("timezone evaluator handles Accra, New York DST, midnight, and next-week transitions", () => {
  const rows = [
    { ...schedules[0], dayMask: 127 },
    { ...schedules[1], dayMask: 127 },
  ];
  const accra = evaluateSchedule({
    now: new Date("2026-11-13T12:00:00Z"),
    timeZone: "Africa/Accra",
    schedules: rows,
    seed: "kofi",
  });
  assert.equal(accra.schedule?.id, "teach");
  assert.equal(accra.minute, 720);
  assert.ok(accra.nextTransitionAt);

  const dst = evaluateSchedule({
    now: new Date("2026-03-08T06:30:00Z"),
    timeZone: "America/New_York",
    schedules: rows,
    seed: "kofi",
  });
  assert.equal(dst.minute, 90);
  assert.equal(dst.schedule, null);

  const midnight = evaluateSchedule({
    now: new Date("2026-11-13T23:59:00Z"),
    timeZone: "Africa/Accra",
    schedules: rows,
    seed: "kofi",
  });
  assert.equal(midnight.minute, 1439);
  assert.ok(midnight.nextTransitionAt);

  assert.throws(() => validateTimeZone("Not/AZone"), /invalid IANA/);
  assert.throws(() => assertNoScheduleOverlap([rows[1], { ...rows[1], id: "overlap" }]), /overlapping/);
});

test("walking routes pause, advance, wrap and recover deterministically", async () => {
  const { advancePatrol } = await import("../src/world-schedules.js");
  const now = new Date("2026-11-14T03:00:00Z");
  const input = {
    route: ["park", "walk"],
    index: 0,
    waitUntil: null,
    atDestination: true,
    reset: false,
    now,
  };
  const paused = advancePatrol(input);
  assert.deepEqual(paused, { index: 0, waitUntil: "2026-11-14T03:00:12.000Z" });
  assert.deepEqual(advancePatrol({ ...input, ...paused, now: new Date(now.getTime() + 11_999) }), paused);
  assert.deepEqual(advancePatrol({ ...input, ...paused, now: new Date(now.getTime() + 12_000) }), {
    index: 1,
    waitUntil: null,
  });
  assert.deepEqual(advancePatrol({ ...input, index: 1, waitUntil: now.toISOString() }), {
    index: 0,
    waitUntil: null,
  });
  assert.deepEqual(
    advancePatrol({ ...input, index: 1, waitUntil: now.toISOString(), atDestination: false }),
    { index: 1, waitUntil: null },
  );
  assert.deepEqual(advancePatrol({ ...input, index: 1, reset: true }), { index: 0, waitUntil: null });
  assert.deepEqual(advancePatrol({ ...input, index: 999 }), paused);
  assert.throws(() => advancePatrol({ ...input, route: ["park"] }), /distinct waypoint/);
  assert.throws(() => advancePatrol({ ...input, route: ["park", "park"] }), /distinct waypoint/);
});
