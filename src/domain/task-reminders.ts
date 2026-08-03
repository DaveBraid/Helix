export interface DidaReminderPresentation {
  raw: string;
  kind: "at-time" | "before" | "unsupported";
  label: string;
}

export interface DidaRepeatPresentation {
  raw: string | null;
  kind: "none" | "rrule" | "erule" | "unsupported";
  label: string;
  safelyUnderstood: boolean;
}

export function presentDidaReminder(raw: string): DidaReminderPresentation {
  if (raw === "TRIGGER:PT0S") {
    return { raw, kind: "at-time", label: "任务时间" };
  }
  const week = /^TRIGGER:-P(\d+)W$/u.exec(raw);
  const duration = /^TRIGGER:-P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u.exec(raw);
  if (!week && !duration) return { raw, kind: "unsupported", label: "自定义提醒（只读）" };
  if (duration && !duration.slice(1).some((value) => value !== undefined)) {
    return { raw, kind: "unsupported", label: "自定义提醒（只读）" };
  }
  if (duration && raw.includes("T") && !duration.slice(2).some((value) => value !== undefined)) {
    return { raw, kind: "unsupported", label: "自定义提醒（只读）" };
  }
  const seconds = week
    ? Number(week[1]) * 7 * 86_400
    : Number(duration?.[1] ?? 0) * 86_400 +
      Number(duration?.[2] ?? 0) * 3_600 +
      Number(duration?.[3] ?? 0) * 60 +
      Number(duration?.[4] ?? 0);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    return { raw, kind: "unsupported", label: "自定义提醒（只读）" };
  }
  return { raw, kind: "before", label: `${formatDuration(seconds)}前` };
}

export function presentDidaReminders(values: string[] | undefined): DidaReminderPresentation[] {
  return (values ?? []).map(presentDidaReminder);
}

export function presentDidaRepeat(raw: string | null | undefined): DidaRepeatPresentation {
  if (raw === null || raw === undefined) {
    return { raw: null, kind: "none", label: "不重复", safelyUnderstood: true };
  }
  if (raw.startsWith("ERULE:")) {
    return {
      raw,
      kind: "erule",
      label: "按完成日期重复（只读）",
      safelyUnderstood: false,
    };
  }
  if (!raw.startsWith("RRULE:")) {
    return {
      raw,
      kind: "unsupported",
      label: "自定义重复（只读）",
      safelyUnderstood: false,
    };
  }
  const rawParts = raw.slice(6).split(";");
  const entries = rawParts.map((part) => /^([A-Z]+)=([^=]+)$/u.exec(part));
  if (entries.some((entry) => !entry)) {
    return { raw, kind: "unsupported", label: "自定义重复（只读）", safelyUnderstood: false };
  }
  const rule = new Map<string, string>();
  for (const entry of entries) {
    const key = entry![1]!;
    if (rule.has(key)) {
      return { raw, kind: "rrule", label: "自定义重复（只读）", safelyUnderstood: false };
    }
    rule.set(key, entry![2]!);
  }
  const supportedKeys = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL"]);
  if ([...rule.keys()].some((key) => !supportedKeys.has(key)) || !rule.has("FREQ")) {
    return { raw, kind: "rrule", label: "自定义重复（只读）", safelyUnderstood: false };
  }
  const intervalToken = rule.get("INTERVAL") ?? "1";
  const interval = parsePositiveInteger(intervalToken);
  const frequency = rule.get("FREQ");
  const unit = frequency === "DAILY"
    ? "天"
    : frequency === "WEEKLY"
      ? "周"
      : frequency === "MONTHLY"
        ? "月"
        : frequency === "YEARLY"
          ? "年"
          : undefined;
  if (!unit || interval === null) {
    return { raw, kind: "rrule", label: "自定义重复（只读）", safelyUnderstood: false };
  }
  const parts = [interval === 1 ? `每${unit}` : `每 ${interval} ${unit}`];
  const byDay = rule.get("BYDAY");
  if (byDay) {
    const dayLabels: Record<string, string> = {
      MO: "一", TU: "二", WE: "三", TH: "四", FR: "五", SA: "六", SU: "日",
    };
    const days = byDay.split(",");
    if (days.some((day) => !dayLabels[day])) {
      return { raw, kind: "rrule", label: "自定义重复（只读）", safelyUnderstood: false };
    }
    parts.push(`周${days.map((day) => dayLabels[day]).join("、")}`);
  }
  const count = rule.get("COUNT");
  if (count) {
    const value = parsePositiveInteger(count);
    if (value === null) {
      return { raw, kind: "rrule", label: "自定义重复（只读）", safelyUnderstood: false };
    }
    parts.push(`共 ${value} 次`);
  }
  const until = rule.get("UNTIL");
  if (until) {
    if (count || !isValidUntil(until)) {
      return { raw, kind: "rrule", label: "自定义重复（只读）", safelyUnderstood: false };
    }
    parts.push("有结束日期");
  }
  return { raw, kind: "rrule", label: parts.join(" · "), safelyUnderstood: true };
}

function parsePositiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isValidUntil(value: string): boolean {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/u.exec(value);
  if (!match) return false;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const date = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ));
  return date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second);
}

function formatDuration(seconds: number): string {
  const units: Array<[number, string]> = [
    [86_400, "天"],
    [3_600, "小时"],
    [60, "分钟"],
    [1, "秒"],
  ];
  const parts: string[] = [];
  let remaining = seconds;
  for (const [size, label] of units) {
    const value = Math.floor(remaining / size);
    if (value > 0) parts.push(`${value} ${label}`);
    remaining %= size;
  }
  return parts.join(" ");
}
