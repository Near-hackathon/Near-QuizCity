export type NpcSchedule = {
  id: string;
  npcId: string;
  sequence: number;
  dayMask: number;
  startMinute: number;
  endMinute: number;
  activity: string;
  destinationSceneId: string | null;
  destinationBuildingId: string | null;
  destinationSpawnId: string | null;
};

/** Deterministic daily routine: day 0 = Sunday, minute 0 = 00:00, end exclusive. */
export function activeScheduleAt(schedules: NpcSchedule[], day: number, minute: number): NpcSchedule | null {
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error("day must be 0..6");
  if (!Number.isInteger(minute) || minute < 0 || minute > 1439) throw new Error("minute must be 0..1439");
  return (
    schedules
      .filter(
        (schedule) =>
          (schedule.dayMask & (1 << day)) !== 0 &&
          minute >= schedule.startMinute &&
          minute < schedule.endMinute,
      )
      .sort((a, b) => a.sequence - b.sequence)[0] ?? null
  );
}

export function nextScheduleTransition(
  schedules: NpcSchedule[],
  day: number,
  minute: number,
): { schedule: NpcSchedule; atMinute: number } | null {
  const candidates = schedules
    .filter((schedule) => (schedule.dayMask & (1 << day)) !== 0 && schedule.startMinute > minute)
    .sort((a, b) => a.startMinute - b.startMinute || a.sequence - b.sequence);
  const next = candidates[0];
  return next ? { schedule: next, atMinute: next.startMinute } : null;
}

export function cityDayAndMinute(date: Date): { day: number; minute: number } {
  const day = date.getUTCDay();
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return { day, minute };
}

export type ScheduleDecision = {
  schedule: NpcSchedule | null;
  day: number;
  minute: number;
  nextTransitionAt: string | null;
  variation: string;
};

function parts(now: Date, timeZone: string): { day: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days.indexOf(values.weekday);
  const minute = Number(values.hour) * 60 + Number(values.minute);
  if (day < 0 || !Number.isFinite(minute)) throw new Error("invalid timezone output");
  return { day, minute };
}

export function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone }).format(new Date());
  } catch {
    throw new Error(`invalid IANA timezone: ${timeZone}`);
  }
}

function instantFor(now: Date, timeZone: string, dayOffset: number, minute: number): string {
  const targetDay = (parts(now, timeZone).day + dayOffset) % 7;
  const rounded = new Date(now);
  rounded.setUTCSeconds(0, 0);
  // Search civil minutes rather than hours. An hourly walk only works when the
  // current minute happens to equal the schedule minute and silently fails for
  // ordinary times such as 08:15. Walking UTC minutes also behaves correctly
  // through DST gaps and repeated local minutes.
  for (let minutesAhead = 0; minutesAhead <= 60 * 24 * 8; minutesAhead += 1) {
    const candidate = new Date(rounded.getTime() + minutesAhead * 60_000);
    const local = parts(candidate, timeZone);
    if (local.day === targetDay && local.minute === minute && candidate.getTime() > now.getTime()) {
      return candidate.toISOString();
    }
  }
  throw new Error(`could not resolve schedule transition in ${timeZone}`);
}

/** Pure, deterministic schedule evaluation. Bit 0 = Sunday ... bit 6 = Saturday. */
export function evaluateSchedule(input: {
  now: Date;
  timeZone: string;
  schedules: NpcSchedule[];
  seed: string;
}): ScheduleDecision {
  validateTimeZone(input.timeZone);
  const { day, minute } = parts(input.now, input.timeZone);
  const active = activeScheduleAt(input.schedules, day, minute);
  let nextTransitionAt: string | null = null;
  for (let offset = 0; offset <= 7 && !nextTransitionAt; offset += 1) {
    const candidateDay = (day + offset) % 7;
    const candidates = input.schedules
      .filter((schedule) => (schedule.dayMask & (1 << candidateDay)) !== 0)
      .filter((schedule) => offset > 0 || schedule.startMinute > minute)
      .sort((a, b) => a.startMinute - b.startMinute || a.sequence - b.sequence);
    if (candidates[0])
      nextTransitionAt = instantFor(input.now, input.timeZone, offset, candidates[0].startMinute);
  }
  return {
    schedule: active,
    day,
    minute,
    nextTransitionAt,
    variation: `${input.seed}:${active?.id ?? "idle"}`,
  };
}

export function assertNoScheduleOverlap(schedules: NpcSchedule[]): void {
  for (const day of [0, 1, 2, 3, 4, 5, 6]) {
    const rows = schedules
      .filter((schedule) => (schedule.dayMask & (1 << day)) !== 0)
      .sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].startMinute < rows[index - 1].endMinute) {
        throw new Error(`overlapping schedules for day ${day}: ${rows[index - 1].id}, ${rows[index].id}`);
      }
    }
  }
}
