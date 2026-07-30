import { describe, expect, it } from "vitest";
import type { DailyMetric } from "../src/domain/analytics";
import { analyticsChartSeries } from "../src/ui/chart-series";

function metric(date: string, tasksCompleted: number, activity: number): DailyMetric {
  return { date, tasksCompleted, activity, habitCheckins: 0, focusMinutes: 0, reviewsClosed: 0 };
}

describe("analytics chart labels", () => {
  it("uses real cross-month dates and Monday-to-today week labels", () => {
    const daily = [
      metric("2026-07-30", 1, 1),
      metric("2026-07-31", 2, 2),
      metric("2026-08-01", 3, 3),
      metric("2026-08-02", 4, 4),
      metric("2026-08-03", 5, 5),
      metric("2026-08-04", 6, 6),
      metric("2026-08-05", 7, 7),
    ];
    const series = analyticsChartSeries(daily, new Date(2026, 7, 5, 12));
    expect(series.trend.map((point) => point.label)).toEqual([
      "07/30", "07/31", "08/01", "08/02", "08/03", "08/04", "08/05",
    ]);
    expect(series.week.map((point) => point.label)).toEqual(["一", "二", "三"]);
    expect(series.week.map((point) => point.value)).toEqual([5, 6, 7]);
  });
});
