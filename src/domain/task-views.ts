import type { DidaTask } from "./entities";
import { localDateKey } from "./local-date";
import { instantToWallDateTime } from "./task-datetime";

// 日历范围、周一周首和已完成任务按完成时间归档的行为参考并改写自
// MIT 许可的 CYZice/Obsidian-DidaSync@c33aedd；跨日与全天时区规则为 Helix 补充。

export type TaskViewMode = "list" | "day" | "three-day" | "week" | "month" | "matrix";

export interface TaskViewDay {
  date: Date;
  key: string;
  inAnchorMonth: boolean;
}

export interface TaskDateRange {
  start: Date;
  end: Date;
  days: TaskViewDay[];
}

export type TaskMatrixQuadrantId =
  | "important-urgent"
  | "important-not-urgent"
  | "not-important-urgent"
  | "not-important-not-urgent";

export interface TaskMatrixQuadrant {
  id: TaskMatrixQuadrantId;
  title: string;
  tasks: DidaTask[];
}

export function buildTaskDateRange(
  mode: Extract<TaskViewMode, "day" | "three-day" | "week" | "month">,
  anchor: Date,
): TaskDateRange {
  const anchorDay = startOfLocalDay(anchor);
  let start = new Date(anchorDay);
  let end = new Date(anchorDay);
  if (mode === "three-day") {
    end = addLocalDays(start, 2);
  } else if (mode === "week") {
    const weekday = start.getDay();
    start = addLocalDays(start, -(weekday === 0 ? 6 : weekday - 1));
    end = addLocalDays(start, 6);
  } else if (mode === "month") {
    const monthStart = new Date(anchorDay.getFullYear(), anchorDay.getMonth(), 1);
    const monthEnd = new Date(anchorDay.getFullYear(), anchorDay.getMonth() + 1, 0);
    const startWeekday = monthStart.getDay();
    start = addLocalDays(monthStart, -(startWeekday === 0 ? 6 : startWeekday - 1));
    const endWeekday = monthEnd.getDay();
    end = addLocalDays(monthEnd, endWeekday === 0 ? 0 : 7 - endWeekday);
  }
  const days: TaskViewDay[] = [];
  for (let cursor = new Date(start); cursor.getTime() <= end.getTime(); cursor = addLocalDays(cursor, 1)) {
    days.push({
      date: cursor,
      key: localDateKey(cursor),
      inAnchorMonth: cursor.getMonth() === anchorDay.getMonth(),
    });
  }
  return { start, end, days };
}

export function groupTasksByViewDay(
  tasks: DidaTask[],
  range: TaskDateRange,
): Map<string, DidaTask[]> {
  const grouped = new Map(range.days.map((day) => [day.key, [] as DidaTask[]]));
  const rangeStart = range.days[0]?.key;
  const rangeEnd = range.days.at(-1)?.key;
  if (!rangeStart || !rangeEnd) return grouped;
  for (const task of tasks) {
    for (const key of taskViewDateKeys(task, rangeStart, rangeEnd)) {
      grouped.get(key)?.push(task);
    }
  }
  for (const group of grouped.values()) group.sort(compareCalendarTasks);
  return grouped;
}

export function buildTaskMatrix(tasks: DidaTask[], anchor: Date): TaskMatrixQuadrant[] {
  const quadrants: TaskMatrixQuadrant[] = [
    { id: "important-urgent", title: "重要且紧急", tasks: [] },
    { id: "important-not-urgent", title: "重要不紧急", tasks: [] },
    { id: "not-important-urgent", title: "紧急不重要", tasks: [] },
    { id: "not-important-not-urgent", title: "不重要不紧急", tasks: [] },
  ];
  const byId = new Map(quadrants.map((quadrant) => [quadrant.id, quadrant]));
  for (const task of tasks.filter((candidate) => candidate.status !== 2)) {
    const today = taskDateKey(anchor.toISOString(), false, task.timeZone) ?? localDateKey(anchor);
    const important = (task.priority ?? 0) >= 5;
    const urgencyDate = taskDateKey(task.dueDate, task.isAllDay, task.timeZone) ??
      taskDateKey(task.startDate, task.isAllDay, task.timeZone);
    const urgent = urgencyDate !== undefined && urgencyDate <= today;
    const id: TaskMatrixQuadrantId = important
      ? urgent ? "important-urgent" : "important-not-urgent"
      : urgent ? "not-important-urgent" : "not-important-not-urgent";
    byId.get(id)?.tasks.push(task);
  }
  for (const quadrant of quadrants) quadrant.tasks.sort(compareMatrixTasks);
  return quadrants;
}

export function taskViewDateKeys(
  task: DidaTask,
  rangeStart?: string,
  rangeEnd?: string,
): string[] {
  if (task.status === 2) {
    const completed = taskDateKey(task.completedTime, false, task.timeZone);
    return completed && insideRange(completed, rangeStart, rangeEnd) ? [completed] : [];
  }
  const start = taskDateKey(task.startDate, task.isAllDay, task.timeZone);
  const due = taskDateKey(task.dueDate, task.isAllDay, task.timeZone);
  if (!start && !due) return [];
  const first = start ?? due!;
  const last = due ?? start!;
  if (last < first) return insideRange(first, rangeStart, rangeEnd) ? [first] : [];
  const clippedStart = rangeStart && first < rangeStart ? rangeStart : first;
  const clippedEnd = rangeEnd && last > rangeEnd ? rangeEnd : last;
  if (clippedEnd < clippedStart) return [];
  const keys: string[] = [];
  for (
    let cursor = dateFromKey(clippedStart);
    localDateKey(cursor) <= clippedEnd;
    cursor = addLocalDays(cursor, 1)
  ) {
    keys.push(localDateKey(cursor));
  }
  return keys;
}

function taskDateKey(
  value: string | null | undefined,
  isAllDay: boolean | undefined,
  timeZone?: string,
): string | undefined {
  if (!value) return undefined;
  const literal = /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
  if ((isAllDay || /^\d{4}-\d{2}-\d{2}$/.test(value)) &&
    literal && localDateKey(dateFromKey(literal)) === literal) return literal;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const zone = validTimeZone(timeZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const wall = instantToWallDateTime(date.toISOString(), zone || "UTC");
  return wall ? wall.slice(0, 10) : undefined;
}

function compareCalendarTasks(left: DidaTask, right: DidaTask): number {
  if (Boolean(left.isAllDay) !== Boolean(right.isAllDay)) return left.isAllDay ? -1 : 1;
  const byDate = (left.startDate ?? left.dueDate ?? "").localeCompare(
    right.startDate ?? right.dueDate ?? "",
  );
  return byDate || (right.priority ?? 0) - (left.priority ?? 0) || left.title.localeCompare(right.title);
}

function compareMatrixTasks(left: DidaTask, right: DidaTask): number {
  const leftDate = taskDateKey(left.dueDate, left.isAllDay, left.timeZone) ?? "9999-12-31";
  const rightDate = taskDateKey(right.dueDate, right.isAllDay, right.timeZone) ?? "9999-12-31";
  return leftDate.localeCompare(rightDate) || (right.priority ?? 0) - (left.priority ?? 0) ||
    left.title.localeCompare(right.title);
}

function insideRange(key: string, start?: string, end?: string): boolean {
  return (!start || key >= start) && (!end || key <= end);
}

function dateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year!, month! - 1, day!, 12, 0, 0, 0);
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addLocalDays(value: Date, amount: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + amount);
  return result;
}

function validTimeZone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return undefined;
  }
}
