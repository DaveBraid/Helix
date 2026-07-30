import type { HelixEvent } from "./events";
import { localDateKeyFromInstant } from "./local-date";

export interface DailyMetric {
  date: string;
  tasksCompleted: number;
  habitCheckins: number;
  focusMinutes: number;
  reviewsClosed: number;
  activity: number;
}

export interface AnalyticsSummary {
  daily: DailyMetric[];
  totalTasks: number;
  totalHabitCheckins: number;
  totalFocusMinutes: number;
  activeDays: number;
}

export function aggregateAnalytics(
  events: HelixEvent[],
  options: { from: string; to: string },
): AnalyticsSummary {
  const dates = enumerateDates(options.from, options.to);
  const buckets = new Map<string, DailyMetric>(
    dates.map((date) => [
      date,
      {
        date,
        tasksCompleted: 0,
        habitCheckins: 0,
        focusMinutes: 0,
        reviewsClosed: 0,
        activity: 0,
      },
    ]),
  );
  const completedOccurrences = new Map<string, string>();
  const habitOccurrences = new Map<string, string>();
  const focusOccurrences = new Map<string, { date: string; minutes: number }>();
  for (const event of events) {
    const date = localDateKeyFromInstant(event.occurredAt);
    const occurrence = `${event.entityId}:${event.occurrenceKey ?? date}`;
    if (event.type === "task-completed") {
      if (!completedOccurrences.has(occurrence)) {
        completedOccurrences.set(occurrence, date);
      }
    } else if (event.type === "task-reopened") {
      completedOccurrences.delete(occurrence);
    } else if (event.type === "habit-checkin") {
      if (!habitOccurrences.has(occurrence)) {
        habitOccurrences.set(occurrence, date);
      }
    } else if (event.type === "habit-unchecked") {
      habitOccurrences.delete(occurrence);
    } else if (event.type === "focus-completed") {
      if (!focusOccurrences.has(occurrence)) {
        const minutes = Math.max(0, event.minutes ?? 0);
        focusOccurrences.set(occurrence, { date, minutes });
      }
    } else if (event.type === "focus-deleted") {
      focusOccurrences.delete(occurrence);
    } else if (event.type === "review-closed") {
      const bucket = buckets.get(date);
      if (bucket) bucket.reviewsClosed += 1;
    }
  }
  for (const date of completedOccurrences.values()) {
    const bucket = buckets.get(date);
    if (bucket) bucket.tasksCompleted += 1;
  }
  for (const date of habitOccurrences.values()) {
    const bucket = buckets.get(date);
    if (bucket) bucket.habitCheckins += 1;
  }
  for (const completed of focusOccurrences.values()) {
    const bucket = buckets.get(completed.date);
    if (bucket) bucket.focusMinutes += completed.minutes;
  }
  const daily = [...buckets.values()];
  for (const bucket of daily) {
    bucket.activity =
      bucket.tasksCompleted * 2 +
      bucket.habitCheckins +
      Math.min(6, Math.floor(bucket.focusMinutes / 25)) +
      bucket.reviewsClosed * 3;
  }
  return {
    daily,
    totalTasks: daily.reduce((sum, item) => sum + item.tasksCompleted, 0),
    totalHabitCheckins: daily.reduce((sum, item) => sum + item.habitCheckins, 0),
    totalFocusMinutes: daily.reduce((sum, item) => sum + item.focusMinutes, 0),
    activeDays: daily.filter((item) => item.activity > 0).length,
  };
}

function enumerateDates(from: string, to: string): string[] {
  const current = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(current.getTime()) || Number.isNaN(end.getTime()) || current > end) {
    throw new Error("Invalid analytics date range");
  }
  const dates: string[] = [];
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}
