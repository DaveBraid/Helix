import type { DidaFocusRecord } from "./entities";

/** 滴答公开专注记录的 duration 是毫秒；起止时间用于兼容旧值和交叉校验。 */
export function focusMinutes(record: DidaFocusRecord): number {
  const elapsed = elapsedMinutes(record.startTime, record.endTime);
  const duration = typeof record.duration === "number" && Number.isFinite(record.duration)
    ? Math.max(0, Math.round(record.duration / 60_000))
    : undefined;
  if (elapsed === undefined) return duration ?? 0;
  if (duration === undefined) return elapsed;
  // 时间戳与毫秒值合理接近时使用 duration；差异异常时以可靠的起止时间兜底。
  return Math.abs(duration - elapsed) <= 2 ? duration : elapsed;
}

function elapsedMinutes(startTime?: string, endTime?: string): number | undefined {
  if (!startTime || !endTime) return undefined;
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.round((end - start) / 60_000);
}
