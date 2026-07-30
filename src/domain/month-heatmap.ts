import type { DailyMetric } from "./analytics";
import { localDateKey } from "./local-date";

export type HeatmapMetric = "tasks" | "habits";

export interface HeatmapDay {
  date: string;
  dayOfMonth: number;
  weekday: number;
  value: number;
  intensity: 0 | 1 | 2 | 3 | 4;
  inMonth: boolean;
}

export interface MonthHeatmap {
  monthLabel: string;
  weeks: HeatmapDay[][];
  total: number;
}

export interface YearHeatmapMonth {
  monthLabel: string;
  weeks: Array<Array<HeatmapDay | null>>;
  total: number;
}

export interface YearHeatmap {
  year: number;
  months: YearHeatmapMonth[];
  total: number;
}

export function buildMonthHeatmap(
  daily: DailyMetric[],
  month: Date,
  metric: HeatmapMetric,
): MonthHeatmap {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const gridStart = new Date(first);
  const firstWeekday = gridStart.getDay();
  gridStart.setDate(gridStart.getDate() - firstWeekday);
  const gridEnd = new Date(last);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));
  const values = new Map(
    daily.map((item) => [
      item.date,
      metric === "tasks" ? item.tasksCompleted : item.habitCheckins,
    ]),
  );
  const inMonthValues = daily
    .filter((item) => {
      const date = new Date(`${item.date}T12:00:00`);
      return (
        !Number.isNaN(date.getTime()) &&
        date.getFullYear() === first.getFullYear() &&
        date.getMonth() === first.getMonth()
      );
    })
    .map((item) => metric === "tasks" ? item.tasksCompleted : item.habitCheckins);
  const max = Math.max(1, ...inMonthValues);
  const weeks: HeatmapDay[][] = [];
  let total = 0;
  for (
    const cursor = new Date(gridStart);
    cursor <= gridEnd;
    cursor.setDate(cursor.getDate() + 1)
  ) {
    const date = localDateKey(cursor);
    const inMonth =
      cursor.getFullYear() === month.getFullYear() &&
      cursor.getMonth() === month.getMonth();
    const value = inMonth ? values.get(date) ?? 0 : 0;
    if (inMonth) total += value;
    const intensity = heatmapIntensity(value, max);
    if (cursor.getDay() === 0 || weeks.length === 0) weeks.push([]);
    weeks[weeks.length - 1]!.push({
      date,
      dayOfMonth: cursor.getDate(),
      weekday: cursor.getDay(),
      value,
      intensity,
      inMonth,
    });
  }
  return {
    monthLabel: `${month.getFullYear()} 年 ${month.getMonth() + 1} 月`,
    weeks,
    total,
  };
}

export function buildYearHeatmap(
  daily: DailyMetric[],
  year: number,
  metric: HeatmapMetric,
): YearHeatmap {
  const monthly = Array.from(
    { length: 12 },
    (_, month) => buildMonthHeatmap(
      daily,
      new Date(year, month, 1),
      metric,
    ),
  );
  const maximum = Math.max(
    1,
    ...monthly.flatMap((month) =>
      month.weeks.flatMap((week) =>
        week.filter((day) => day.inMonth).map((day) => day.value))),
  );
  const months = monthly.map((month) => ({
    monthLabel: month.monthLabel,
    total: month.total,
    weeks: Array.from({ length: 6 }, (_, weekIndex) =>
      Array.from({ length: 7 }, (_, weekday) => {
        const day = month.weeks[weekIndex]?.[weekday];
        if (!day?.inMonth) return null;
        return {
          ...day,
          intensity: heatmapIntensity(day.value, maximum),
        };
      })),
  }));
  return {
    year,
    months,
    total: months.reduce((sum, month) => sum + month.total, 0),
  };
}

function heatmapIntensity(
  value: number,
  maximum: number,
): 0 | 1 | 2 | 3 | 4 {
  return value === 0
    ? 0
    : Math.min(
        4,
        Math.max(1, Math.ceil((value / maximum) * 4)),
      ) as 1 | 2 | 3 | 4;
}
