import { describe, expect, it } from "vitest";
import {
  buildMonthHeatmap,
  buildYearHeatmap,
} from "../src/domain/month-heatmap";
import type { DailyMetric } from "../src/domain/analytics";

function metric(
  date: string,
  tasksCompleted: number,
  habitCheckins: number,
): DailyMetric {
  return {
    date,
    tasksCompleted,
    habitCheckins,
    focusMinutes: 0,
    reviewsClosed: 0,
    activity: tasksCompleted + habitCheckins,
  };
}

describe("month heatmap", () => {
  const daily = [
    metric("2026-07-01", 1, 4),
    metric("2026-07-02", 2, 1),
    metric("2026-07-31", 4, 2),
    metric("2026-08-01", 99, 99),
  ];

  it("builds complete Sunday-to-Saturday weeks and excludes adjacent months", () => {
    const result = buildMonthHeatmap(daily, new Date(2026, 6, 15), "tasks");
    expect(result.monthLabel).toBe("2026 年 7 月");
    expect(result.weeks.every((week) => week.length === 7)).toBe(true);
    expect(result.total).toBe(7);
    expect(result.weeks.flat().find((day) => day.date === "2026-08-01")).toMatchObject({
      inMonth: false,
      value: 0,
    });
  });

  it("switches between task and habit values with bounded intensities", () => {
    const result = buildMonthHeatmap(daily, new Date(2026, 6, 1), "habits");
    expect(result.total).toBe(7);
    expect(result.weeks.flat().find((day) => day.date === "2026-07-01")).toMatchObject({
      value: 4,
      intensity: 4,
    });
    expect(result.weeks.flat().every((day) => day.intensity >= 0 && day.intensity <= 4)).toBe(true);
  });

  it("builds twelve framed month grids with one annual intensity scale", () => {
    const result = buildYearHeatmap(
      [
        metric("2026-01-05", 2, 0),
        metric("2026-02-05", 2, 0),
        metric("2026-03-05", 4, 0),
      ],
      2026,
      "tasks",
    );

    expect(result.months).toHaveLength(12);
    expect(result.months.every((month) =>
      month.weeks.length === 6 &&
      month.weeks.every((week) => week.length === 7),
    )).toBe(true);
    expect(result.total).toBe(8);
    const january = result.months[0]!.weeks.flat().find(
      (day) => day?.date === "2026-01-05",
    );
    const february = result.months[1]!.weeks.flat().find(
      (day) => day?.date === "2026-02-05",
    );
    expect(january?.intensity).toBe(february?.intensity);
    expect(result.months[0]!.weeks.flat().some(
      (day) => day?.date.startsWith("2025-"),
    )).toBe(false);
  });
});
