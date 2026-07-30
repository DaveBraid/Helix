import type { DailyMetric } from "../domain/analytics";
import { localDateKey } from "../domain/local-date";

export function analyticsChartSeries(daily: DailyMetric[], now: Date): {
  trend: Array<{ label: string; value: number }>;
  week: Array<{ label: string; value: number }>;
} {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = monday.getDay() || 7;
  monday.setDate(monday.getDate() - day + 1);
  const weekStart = localDateKey(monday);
  return {
    trend: daily.map((item) => ({
      label: item.date.slice(5).replace("-", "/"),
      value: item.tasksCompleted,
    })),
    week: daily
      .filter((item) => item.date >= weekStart)
      .map((item) => ({
        label: weekdayLabel(item.date),
        value: item.activity,
      })),
  };
}

function weekdayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(year!, month! - 1, day!).getDay() || 7;
  return ["一", "二", "三", "四", "五", "六", "日"][value - 1]!;
}
