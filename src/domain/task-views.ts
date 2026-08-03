import type { DidaTask } from "./entities";
import { localDateKey } from "./local-date";
import { instantToWallDateTime } from "./task-datetime";

// 日历范围、周一周首和已完成任务按完成时间归档的行为参考并改写自
// MIT 许可的 CYZice/Obsidian-DidaSync@c33aedd；时间块的全天/定时分层也参考其
// timeGrid 投影。跨日、重叠泳道与任务自身时区规则为 Helix 补充。

const POINT_TIME_BLOCK_MINUTES = 15;

export type TaskViewMode =
  | "list"
  | "day"
  | "three-day"
  | "week"
  | "month"
  | "year"
  | "matrix";

export interface TaskMatrixRules {
  importantPriorityThreshold: 1 | 3 | 5;
  urgentWithinDays: 0 | 1 | 3 | 7;
}

export const DEFAULT_TASK_MATRIX_RULES: TaskMatrixRules = {
  importantPriorityThreshold: 5,
  urgentWithinDays: 0,
};

export type TaskDateFilter = "all" | "overdue" | "today" | "next-seven-days" | "undated";

export interface TaskCollectionFilters {
  didaProjectId?: string;
  helixProjectId?: string;
  tag?: string;
  priority?: "0" | "1" | "3" | "5";
  date: TaskDateFilter;
  query?: string;
}

export interface TaskFilterContext {
  anchor: Date;
  helixProjectByTaskId?: ReadonlyMap<string, string>;
}

export interface TaskTimeBlock {
  task: DidaTask;
  dayKey: string;
  startMinute: number;
  endMinute: number;
  lane: number;
  laneCount: number;
  allDay: boolean;
}

export interface TaskYearMonthSummary {
  month: number;
  key: string;
  scheduled: number;
  completed: number;
  open: number;
}

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

export function buildTaskMatrix(
  tasks: DidaTask[],
  anchor: Date,
  rules: TaskMatrixRules = DEFAULT_TASK_MATRIX_RULES,
): TaskMatrixQuadrant[] {
  const quadrants: TaskMatrixQuadrant[] = [
    { id: "important-urgent", title: "重要且紧急", tasks: [] },
    { id: "important-not-urgent", title: "重要不紧急", tasks: [] },
    { id: "not-important-urgent", title: "紧急不重要", tasks: [] },
    { id: "not-important-not-urgent", title: "不重要不紧急", tasks: [] },
  ];
  const byId = new Map(quadrants.map((quadrant) => [quadrant.id, quadrant]));
  for (const task of tasks.filter((candidate) => candidate.status !== 2)) {
    const today = taskDateKey(anchor.toISOString(), false, task.timeZone) ?? localDateKey(anchor);
    const important = (task.priority ?? 0) >= rules.importantPriorityThreshold;
    const urgencyDate = taskDateKey(task.dueDate, task.isAllDay, task.timeZone) ??
      taskDateKey(task.startDate, task.isAllDay, task.timeZone);
    const urgentThrough = addDateKeyDays(today, rules.urgentWithinDays);
    const urgent = urgencyDate !== undefined && urgencyDate <= urgentThrough;
    const id: TaskMatrixQuadrantId = important
      ? urgent ? "important-urgent" : "important-not-urgent"
      : urgent ? "not-important-urgent" : "not-important-not-urgent";
    byId.get(id)?.tasks.push(task);
  }
  for (const quadrant of quadrants) quadrant.tasks.sort(compareMatrixTasks);
  return quadrants;
}

export function filterTaskCollection(
  tasks: DidaTask[],
  filters: TaskCollectionFilters,
  context: TaskFilterContext,
): DidaTask[] {
  return tasks.filter((task) => {
    const query = filters.query?.trim().toLocaleLowerCase();
    if (query && !taskSearchText(task).includes(query)) return false;
    if (filters.didaProjectId && task.projectId !== filters.didaProjectId) return false;
    if (filters.helixProjectId) {
      const linked = context.helixProjectByTaskId?.get(task.id);
      if (filters.helixProjectId === "unlinked" ? linked !== undefined : linked !== filters.helixProjectId) {
        return false;
      }
    }
    if (filters.tag && !(task.tags ?? []).includes(filters.tag)) return false;
    if (filters.priority !== undefined && (task.priority ?? 0) !== Number(filters.priority)) return false;
    return matchesDateFilter(task, filters.date, context.anchor);
  });
}

function taskSearchText(task: DidaTask): string {
  return [
    task.title,
    task.content,
    task.desc,
    ...(task.items ?? []).map((item) => item.title),
  ].filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLocaleLowerCase();
}

export function buildTaskTimeBlocks(
  tasks: DidaTask[],
  range: TaskDateRange,
): Map<string, TaskTimeBlock[]> {
  const blocks = new Map(range.days.map((day) => [day.key, [] as TaskTimeBlock[]]));
  const rangeStart = range.days[0]?.key;
  const rangeEnd = range.days.at(-1)?.key;
  if (!rangeStart || !rangeEnd) return blocks;
  for (const task of tasks) {
    for (const dayKey of taskViewDateKeys(task, rangeStart, rangeEnd)) {
      blocks.get(dayKey)?.push(timeBlockForDay(task, dayKey));
    }
  }
  for (const [dayKey, dayBlocks] of blocks) {
    const allDay = dayBlocks.filter((block) => block.allDay)
      .sort((left, right) => compareCalendarTasks(left.task, right.task));
    const timed = assignTimeBlockLanes(dayBlocks.filter((block) => !block.allDay));
    blocks.set(dayKey, [...allDay, ...timed]);
  }
  return blocks;
}

export function buildTaskYearSummary(tasks: DidaTask[], anchor: Date): TaskYearMonthSummary[] {
  const year = anchor.getFullYear();
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const scheduledByMonth = Array.from({ length: 12 }, () => new Set<string>());
  const completedByMonth = Array.from({ length: 12 }, () => new Set<string>());
  const openByMonth = Array.from({ length: 12 }, () => new Set<string>());
  for (const task of tasks) {
    const months = new Set(taskViewDateKeys(task, start, end).map((key) => Number(key.slice(5, 7)) - 1));
    for (const month of months) {
      if (month < 0 || month > 11) continue;
      scheduledByMonth[month]!.add(task.id);
      (task.status === 2 ? completedByMonth : openByMonth)[month]!.add(task.id);
    }
  }
  return Array.from({ length: 12 }, (_, month) => ({
    month: month + 1,
    key: `${year}-${String(month + 1).padStart(2, "0")}`,
    scheduled: scheduledByMonth[month]!.size,
    completed: completedByMonth[month]!.size,
    open: openByMonth[month]!.size,
  }));
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

function matchesDateFilter(task: DidaTask, filter: TaskDateFilter, anchor: Date): boolean {
  if (filter === "all") return true;
  const today = taskDateKey(anchor.toISOString(), false, task.timeZone) ?? localDateKey(anchor);
  const keys = taskViewDateKeys(task);
  if (filter === "undated") return keys.length === 0;
  if (filter === "overdue") {
    const due = taskDateKey(task.dueDate, task.isAllDay, task.timeZone);
    return task.status !== 2 && due !== undefined && due < today;
  }
  const end = filter === "today" ? today : addDateKeyDays(today, 6);
  return taskViewDateKeys(task, today, end).length > 0;
}

function timeBlockForDay(task: DidaTask, dayKey: string): TaskTimeBlock {
  const completed = task.status === 2;
  if (task.isAllDay && !completed) {
    return { task, dayKey, startMinute: 0, endMinute: 1_440, lane: 0, laneCount: 1, allDay: true };
  }
  const startWall = wallDateTime(completed ? task.completedTime : task.startDate, task.timeZone);
  const dueWall = wallDateTime(completed ? task.completedTime : task.dueDate, task.timeZone);
  const startKey = startWall?.slice(0, 10);
  const dueKey = dueWall?.slice(0, 10);
  const isPoint = completed || !startWall || !dueWall || sameInstant(task.startDate, task.dueDate);
  if (isPoint) {
    const anchorWall = startWall ?? dueWall;
    const anchorKey = anchorWall?.slice(0, 10);
    const anchorMinute = anchorKey === dayKey ? minuteFromWall(anchorWall!) : 0;
    const startMinute = Math.min(anchorMinute, 1_440 - POINT_TIME_BLOCK_MINUTES);
    return {
      task,
      dayKey,
      startMinute,
      endMinute: startMinute + POINT_TIME_BLOCK_MINUTES,
      lane: 0,
      laneCount: 1,
      allDay: false,
    };
  }
  const startMinute = startKey === dayKey ? minuteFromWall(startWall) : 0;
  let endMinute = dueKey === dayKey ? minuteFromWall(dueWall) : 1_440;
  if (endMinute <= startMinute) endMinute = Math.min(1_440, startMinute + POINT_TIME_BLOCK_MINUTES);
  return { task, dayKey, startMinute, endMinute, lane: 0, laneCount: 1, allDay: false };
}

function assignTimeBlockLanes(blocks: TaskTimeBlock[]): TaskTimeBlock[] {
  const sorted = [...blocks].sort((left, right) =>
    left.startMinute - right.startMinute || left.endMinute - right.endMinute ||
    left.task.title.localeCompare(right.task.title));
  const result: TaskTimeBlock[] = [];
  let group: TaskTimeBlock[] = [];
  let groupEnd = -1;
  const flush = (): void => {
    if (group.length === 0) return;
    const laneEnds: number[] = [];
    for (const block of group) {
      let lane = laneEnds.findIndex((end) => end <= block.startMinute);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = block.endMinute;
      block.lane = lane;
    }
    const laneCount = Math.max(1, laneEnds.length);
    result.push(...group.map((block) => ({ ...block, laneCount })));
    group = [];
    groupEnd = -1;
  };
  for (const block of sorted) {
    if (group.length > 0 && block.startMinute >= groupEnd) flush();
    group.push(block);
    groupEnd = Math.max(groupEnd, block.endMinute);
  }
  flush();
  return result;
}

function wallDateTime(value: string | null | undefined, timeZone?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const zone = validTimeZone(timeZone) ??
    (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  return instantToWallDateTime(date.toISOString(), zone);
}

function sameInstant(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function minuteFromWall(value: string): number {
  return Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
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

function addDateKeyDays(key: string, amount: number): string {
  return localDateKey(addLocalDays(dateFromKey(key), amount));
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
