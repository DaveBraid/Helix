export function isInsideSyncWindow(
  value: string | number | undefined,
  from: number,
  to: number,
): boolean {
  if (value === undefined) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= from && time <= to;
}
