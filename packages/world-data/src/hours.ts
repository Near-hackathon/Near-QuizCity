/** Empty hours mean unrestricted access; malformed or partial schedules fail closed. */
export function isVenueOpen(hours: unknown, now: Date): boolean {
  if (hours === null || hours === undefined) return true;
  if (typeof hours !== "object" || Array.isArray(hours)) return false;
  const { open, close } = hours as { open?: unknown; close?: unknown };
  if (open === undefined && close === undefined) return true;
  if (
    typeof open !== "string" ||
    typeof close !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(open) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(close)
  )
    return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Accra",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const current =
    Number(parts.find((part) => part.type === "hour")?.value) * 60 +
    Number(parts.find((part) => part.type === "minute")?.value);
  const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minute(open),
    end = minute(close);
  return (
    start === end || (start < end ? current >= start && current < end : current >= start || current < end)
  );
}
