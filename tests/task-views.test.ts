import { describe, expect, it } from "vitest";
import type { DidaTask } from "../src/domain/entities";
import {
  buildTaskDateRange,
  buildTaskMatrix,
  groupTasksByViewDay,
  taskViewDateKeys,
} from "../src/domain/task-views";
import { normalizeTask } from "../src/integrations/dida/normalization";

const task = (value: Partial<DidaTask> & Pick<DidaTask, "id" | "title">): DidaTask => ({
  projectId: "project",
  status: 0,
  ...value,
});

describe("task view projections", () => {
  it("builds day, three-day, Monday week, and complete month grids", () => {
    const anchor = new Date(2026, 7, 2, 12);
    expect(buildTaskDateRange("day", anchor).days.map((day) => day.key)).toEqual(["2026-08-02"]);
    expect(buildTaskDateRange("three-day", anchor).days.map((day) => day.key)).toEqual([
      "2026-08-02", "2026-08-03", "2026-08-04",
    ]);
    const week = buildTaskDateRange("week", anchor).days;
    expect([week[0]?.key, week.at(-1)?.key]).toEqual(["2026-07-27", "2026-08-02"]);
    const month = buildTaskDateRange("month", anchor).days;
    expect(month.length % 7).toBe(0);
    expect([month[0]?.key, month.at(-1)?.key]).toEqual(["2026-07-27", "2026-09-06"]);
  });

  it("keeps all-day date literals stable and expands a duration across every intersecting day", () => {
    const allDay = task({
      id: "all-day",
      title: "全天",
      isAllDay: true,
      startDate: "2026-08-02T00:00:00.000Z",
      dueDate: "2026-08-04T00:00:00.000Z",
    });
    expect(taskViewDateKeys(allDay)).toEqual(["2026-08-02", "2026-08-03", "2026-08-04"]);
    expect(taskViewDateKeys(allDay, "2026-08-03", "2026-08-03")).toEqual(["2026-08-03"]);
    expect(taskViewDateKeys(normalizeTask({
      ...allDay,
      startDate: "2026-08-02",
      dueDate: "2026-08-04",
    }))).toEqual(["2026-08-02", "2026-08-03", "2026-08-04"]);
  });

  it("projects instants in each task's own time zone at midnight boundaries", () => {
    const instant = "2026-08-03T00:30:00.000Z";
    expect(taskViewDateKeys(task({
      id: "los-angeles",
      title: "洛杉矶",
      dueDate: instant,
      timeZone: "America/Los_Angeles",
    }))).toEqual(["2026-08-02"]);
    expect(taskViewDateKeys(task({
      id: "tokyo",
      title: "东京",
      dueDate: instant,
      timeZone: "Asia/Tokyo",
    }))).toEqual(["2026-08-03"]);
    expect(taskViewDateKeys(task({
      id: "completed-west",
      title: "洛杉矶完成",
      status: 2,
      completedTime: instant,
      timeZone: "America/Los_Angeles",
    }))).toEqual(["2026-08-02"]);
  });

  it("expands task-zone dates correctly across the spring DST boundary", () => {
    expect(taskViewDateKeys(task({
      id: "dst",
      title: "跨夏令时",
      startDate: "2026-03-08T07:30:00.000Z",
      dueDate: "2026-03-08T10:30:00.000Z",
      timeZone: "America/Los_Angeles",
    }))).toEqual(["2026-03-07", "2026-03-08"]);
  });

  it("uses completion time for completed tasks and excludes invalid or undated tasks", () => {
    expect(taskViewDateKeys(task({
      id: "done",
      title: "完成",
      status: 2,
      startDate: "2026-07-01T00:00:00Z",
      completedTime: "2026-08-02T10:00:00Z",
    }))).toEqual(["2026-08-02"]);
    expect(taskViewDateKeys(task({ id: "none", title: "无日期" }))).toEqual([]);
    expect(taskViewDateKeys(task({ id: "bad", title: "坏日期", dueDate: "invalid" }))).toEqual([]);
  });

  it("groups only range intersections and sorts all-day entries first", () => {
    const range = buildTaskDateRange("day", new Date(2026, 7, 2, 12));
    const grouped = groupTasksByViewDay([
      task({ id: "timed", title: "定时", dueDate: "2026-08-02T10:00:00+08:00" }),
      task({ id: "all-day", title: "全天", isAllDay: true, dueDate: "2026-08-02" }),
      task({ id: "outside", title: "范围外", dueDate: "2026-08-05T10:00:00+08:00" }),
    ], range);
    expect(grouped.get("2026-08-02")?.map((candidate) => candidate.id)).toEqual([
      "all-day", "timed",
    ]);
  });

  it("builds a deterministic Eisenhower matrix from high priority and due date", () => {
    const quadrants = buildTaskMatrix([
      task({ id: "q1", title: "Q1", priority: 5, dueDate: "2026-08-02" }),
      task({ id: "q2", title: "Q2", priority: 5, dueDate: "2026-08-05" }),
      task({ id: "q3", title: "Q3", priority: 1, dueDate: "2026-08-01" }),
      task({ id: "q4", title: "Q4" }),
      task({ id: "done", title: "完成", status: 2, priority: 5, dueDate: "2026-08-01" }),
    ], new Date(2026, 7, 2, 12));
    expect(quadrants.map((quadrant) => [quadrant.id, quadrant.tasks.map((item) => item.id)])).toEqual([
      ["important-urgent", ["q1"]],
      ["important-not-urgent", ["q2"]],
      ["not-important-urgent", ["q3"]],
      ["not-important-not-urgent", ["q4"]],
    ]);
  });

  it("compares urgency against today in each task zone across the date line", () => {
    const candidate = task({
      id: "west",
      title: "洛杉矶明天到期",
      dueDate: "2026-08-02T07:30:00.000Z",
      timeZone: "America/Los_Angeles",
    });
    const beforeLocalMidnight = buildTaskMatrix([candidate], new Date("2026-08-02T01:00:00.000Z"));
    expect(beforeLocalMidnight.find((quadrant) => quadrant.id === "not-important-not-urgent")?.tasks)
      .toHaveLength(1);
    const afterLocalMidnight = buildTaskMatrix([candidate], new Date("2026-08-02T15:00:00.000Z"));
    expect(afterLocalMidnight.find((quadrant) => quadrant.id === "not-important-urgent")?.tasks)
      .toHaveLength(1);
  });
});
