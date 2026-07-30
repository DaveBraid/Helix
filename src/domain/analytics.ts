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
    const bucket = buckets.get(date);
    if (!bucket) continue;
    const occurrence = `${event.entityId}:${event.occurrenceKey ?? date}`;
    if (event.type === "task-completed") {
      if (!completedOccurrences.has(occurrence)) {
        completedOccurrences.set(occurrence, date);
        bucket.tasksCompleted += 1;
      }
    } else if (event.type === "task-reopened") {
      const completedDate = completedOccurrences.get(occurrence);
      if (completedDate) {
        const completedBucket = buckets.get(completedDate);
        if (completedBucket) {
          completedBucket.tasksCompleted = Math.max(0, completedBucket.tasksCompleted - 1);
        }
        completedOccurrences.delete(occurrence);
      }
    } else if (event.type === "habit-checkin") {
      if (!habitOccurrences.has(occurrence)) {
        habitOccurrences.set(occurrence, date);
        bucket.habitCheckins += 1;
      }
    } else if (event.type === "habit-unchecked") {
      const checkinDate = habitOccurrences.get(occurrence);
      if (checkinDate) {
        const checkinBucket = buckets.get(checkinDate);
        if (checkinBucket) {
          checkinBucket.habitCheckins = Math.max(0, checkinBucket.habitCheckins - 1);
        }
        habitOccurrences.delete(occurrence);
      }
    } else if (event.type === "focus-completed") {
      if (!focusOccurrences.has(occurrence)) {
        const minutes = Math.max(0, event.minutes ?? 0);
        focusOccurrences.set(occurrence, { date, minutes });
        bucket.focusMinutes += minutes;
      }
    } else if (event.type === "focus-deleted") {
      const completed = focusOccurrences.get(occurrence);
      if (completed) {
        const completedBucket = buckets.get(completed.date);
        if (completedBucket) {
          completedBucket.focusMinutes = Math.max(0, completedBucket.focusMinutes - completed.minutes);
        }
        focusOccurrences.delete(occurrence);
      }
    } else if (event.type === "review-closed") {
      bucket.reviewsClosed += 1;
    }
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
