export function instantToWallDateTime(
  value: string | null | undefined,
  timeZone: string,
): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function wallDateTimeToInstant(
  value: string,
  timeZone: string,
): string | null {
  if (!value.trim()) return null;
  assertTimeZone(timeZone);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error("日期时间无效");
  const [, year, month, day, hour, minute] = match;
  const wallUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  let instant = wallUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = timeZoneOffsetMilliseconds(new Date(instant), timeZone);
    const next = wallUtc - offset;
    if (next === instant) break;
    instant = next;
  }
  const iso = new Date(instant).toISOString();
  if (instantToWallDateTime(iso, timeZone) !== value.trim()) {
    throw new Error("所选时区不存在这个本地时间，请避开夏令时切换时段");
  }
  return iso;
}

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new Error(`无效时区：${timeZone}`);
  }
}

function timeZoneOffsetMilliseconds(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const number = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const representedAsUtc = Date.UTC(
    number("year"),
    number("month") - 1,
    number("day"),
    number("hour"),
    number("minute"),
    number("second"),
  );
  return representedAsUtc - date.getTime();
}
