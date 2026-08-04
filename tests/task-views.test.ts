import { describe, expect, it } from "vitest";
import type { DidaTask } from "../src/domain/entities";
import {
  buildTaskBoard,
  buildTaskDateRange,
  buildTaskMatrix,
  buildTaskTimeBlocks,
  buildTaskYearSummary,
  filterTaskCollection,
  groupTasksByViewDay,
  taskViewDateKeys,
  todayOpenTasks,
} from "../src/domain/task-views";
import { normalizeTask } from "../src/integrations/dida/normalization";

const task = (value: Partial<DidaTask> & Pick<DidaTask, "id" | "title">): DidaTask => ({
  projectId: "project",
  status: 0,
  ...value,
});

describe("task view projections", () => {
  it("groups a selected list by remote kanban columns without inventing placement", () => {
    const project = {
      id: "project-1",
      name: "Research",
      columns: [
        { id: "done", projectId: "project-1", name: "Done", sortOrder: 20 },
        { id: "todo", projectId: "project-1", name: "To do", sortOrder: 10 },
      ],
    };
    const board = buildTaskBoard(project, [
      task({ id: "2", projectId: "project-1", title: "Second", columnId: "todo", sortOrder: 20 }),
      task({ id: "1", projectId: "project-1", title: "First", columnId: "todo", sortOrder: 10 }),
      task({ id: "3", projectId: "project-1", title: "Unknown", columnId: "missing" }),
      task({ id: "other", projectId: "project-2", title: "Other" }),
    ]);
    expect(board.map((column) => [column.id, column.tasks.map((item) => item.id)])).toEqual([
      ["todo", ["1", "2"]],
      ["done", []],
      ["unassigned", ["3"]],
    ]);
  });

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

  it("uses the day-view projection for today tasks, including task time zones", () => {
    const today = new Date(2026, 7, 3, 12);
    expect(todayOpenTasks([
      task({ id: "today", title: "今天", dueDate: "2026-08-03T09:00:00+08:00" }),
      task({ id: "west", title: "西海岸仍是昨天", dueDate: "2026-08-03T00:30:00.000Z", timeZone: "America/Los_Angeles" }),
      task({ id: "done", title: "今天完成", status: 2, completedTime: "2026-08-03T09:00:00+08:00" }),
      task({ id: "later", title: "明天", dueDate: "2026-08-04T09:00:00+08:00" }),
      task({ id: "undated", title: "无日期" }),
    ], today).map((item) => item.id)).toEqual(["today"]);
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

  it("applies reviewable matrix thresholds without changing task fields", () => {
    const source = task({ id: "medium", title: "中优先级", priority: 3, dueDate: "2026-08-05" });
    const quadrants = buildTaskMatrix([source], new Date("2026-08-02T04:00:00.000Z"), {
      importantPriorityThreshold: 3,
      urgentWithinDays: 3,
    });
    expect(quadrants.find((quadrant) => quadrant.id === "important-urgent")?.tasks)
      .toEqual([source]);
    expect(source).toMatchObject({ priority: 3, dueDate: "2026-08-05" });
  });

  it("combines list, Helix project, tag, priority and task-zone date filters", () => {
    const tasks = [
      task({
        id: "match",
        title: "命中",
        projectId: "list-a",
        tags: ["科研"],
        priority: 5,
        dueDate: "2026-08-03T00:30:00.000Z",
        timeZone: "America/Los_Angeles",
      }),
      task({ id: "wrong-list", title: "其他清单", projectId: "list-b", tags: ["科研"], priority: 5 }),
      task({ id: "unlinked", title: "未关联", projectId: "list-a", tags: ["科研"], priority: 5 }),
    ];
    const context = {
      anchor: new Date("2026-08-03T02:00:00.000Z"),
      helixProjectByTaskId: new Map([["match", "helix-a"], ["wrong-list", "helix-a"]]),
    };
    expect(filterTaskCollection(tasks, {
      didaProjectId: "list-a",
      helixProjectId: "helix-a",
      tag: "科研",
      priority: "5",
      date: "today",
    }, context).map((candidate) => candidate.id)).toEqual(["match"]);
    expect(filterTaskCollection(tasks, { helixProjectId: "unlinked", date: "all" }, context)
      .map((candidate) => candidate.id)).toEqual(["unlinked"]);
  });

  it("searches task titles, notes and checklist item text case-insensitively", () => {
    const tasks = [
      task({ id: "title", title: "Read PAPER" }),
      task({ id: "content", title: "整理", content: "复现实验备注" }),
      task({ id: "desc", title: "归档", desc: "补充消融结论" }),
      task({ id: "item", title: "检查清单", items: [{ id: "i", title: "核对图表", status: 0 }] }),
      task({ id: "miss", title: "无关任务", content: "普通内容" }),
    ];
    const context = { anchor: new Date("2026-08-03T04:00:00.000Z") };
    expect(filterTaskCollection(tasks, { date: "all", query: "paper" }, context)
      .map(({ id }) => id)).toEqual(["title"]);
    expect(filterTaskCollection(tasks, { date: "all", query: "实验备注" }, context)
      .map(({ id }) => id)).toEqual(["content"]);
    expect(filterTaskCollection(tasks, { date: "all", query: "消融" }, context)
      .map(({ id }) => id)).toEqual(["desc"]);
    expect(filterTaskCollection(tasks, { date: "all", query: "图表" }, context)
      .map(({ id }) => id)).toEqual(["item"]);
  });

  it("treats the seven-day filter as today plus six task-zone calendar days", () => {
    const tasks = [
      task({ id: "today", title: "今天", dueDate: "2026-08-03", isAllDay: true }),
      task({ id: "day-six", title: "第七个日期", dueDate: "2026-08-09", isAllDay: true }),
      task({ id: "day-seven", title: "范围外", dueDate: "2026-08-10", isAllDay: true }),
      task({ id: "overdue", title: "逾期", dueDate: "2026-08-02", isAllDay: true }),
    ];
    expect(filterTaskCollection(tasks, { date: "next-seven-days" }, {
      anchor: new Date("2026-08-03T04:00:00.000Z"),
    }).map((candidate) => candidate.id)).toEqual(["today", "day-six"]);
    expect(filterTaskCollection(tasks, { date: "overdue" }, {
      anchor: new Date("2026-08-03T04:00:00.000Z"),
    }).map((candidate) => candidate.id)).toEqual(["overdue"]);
  });

  it("matches date filters by interval intersection instead of a single endpoint", () => {
    const tasks = [
      task({
        id: "spans-today",
        title: "跨过今天",
        startDate: "2026-08-01",
        dueDate: "2026-08-05",
        isAllDay: true,
      }),
      task({
        id: "spans-window",
        title: "跨过未来窗口",
        startDate: "2026-08-01",
        dueDate: "2026-08-20",
        isAllDay: true,
      }),
    ];
    const context = { anchor: new Date("2026-08-03T04:00:00.000Z") };
    expect(filterTaskCollection(tasks, { date: "today" }, context).map(({ id }) => id))
      .toEqual(["spans-today", "spans-window"]);
    expect(filterTaskCollection(tasks, { date: "next-seven-days" }, context).map(({ id }) => id))
      .toEqual(["spans-today", "spans-window"]);
  });

  it("lays out time blocks with point defaults, all-day bands and overlap lanes", () => {
    const range = buildTaskDateRange("day", new Date(2026, 7, 3, 12));
    const blocks = buildTaskTimeBlocks([
      task({ id: "a", title: "A", startDate: "2026-08-03T01:00:00.000Z", dueDate: "2026-08-03T02:00:00.000Z", timeZone: "UTC" }),
      task({ id: "b", title: "B", startDate: "2026-08-03T01:30:00.000Z", dueDate: "2026-08-03T02:30:00.000Z", timeZone: "UTC" }),
      task({ id: "point", title: "单点", dueDate: "2026-08-03T05:00:00.000Z", timeZone: "UTC" }),
      task({
        id: "same-instant",
        title: "相同时刻",
        startDate: "2026-08-03T07:00:00.000Z",
        dueDate: "2026-08-03T09:00:00.000+02:00",
        timeZone: "UTC",
      }),
      task({ id: "all-day", title: "全天", dueDate: "2026-08-03", isAllDay: true }),
      task({
        id: "completed",
        title: "已完成",
        status: 2,
        startDate: "2026-08-01T01:00:00.000Z",
        dueDate: "2026-08-01T02:00:00.000Z",
        completedTime: "2026-08-03T06:00:00.000Z",
        timeZone: "UTC",
      }),
      task({
        id: "completed-all-day",
        title: "已完成全天任务",
        status: 2,
        isAllDay: true,
        dueDate: "2026-08-01",
        completedTime: "2026-08-03T08:00:00.000Z",
        timeZone: "UTC",
      }),
    ], range).get("2026-08-03")!;
    expect(blocks[0]).toMatchObject({ allDay: true, startMinute: 0, endMinute: 1_440 });
    expect(blocks.find((block) => block.task.id === "a")).toMatchObject({ lane: 0, laneCount: 2 });
    expect(blocks.find((block) => block.task.id === "b")).toMatchObject({ lane: 1, laneCount: 2 });
    expect(blocks.find((block) => block.task.id === "point")).toMatchObject({
      startMinute: 300,
      endMinute: 315,
      lane: 0,
      laneCount: 1,
    });
    expect(blocks.find((block) => block.task.id === "completed")).toMatchObject({
      startMinute: 360,
      endMinute: 375,
    });
    expect(blocks.find((block) => block.task.id === "completed-all-day")).toMatchObject({
      allDay: false,
      startMinute: 480,
      endMinute: 495,
    });
    expect(blocks.find((block) => block.task.id === "same-instant")).toMatchObject({
      startMinute: 420,
      endMinute: 435,
    });
  });

  it("projects spring gaps and fall folds onto a stable wall-clock grid", () => {
    const springRange = buildTaskDateRange("day", new Date(2026, 2, 8, 12));
    const spring = buildTaskTimeBlocks([task({
      id: "spring-gap",
      title: "春季跳时",
      startDate: "2026-03-08T09:30:00.000Z",
      dueDate: "2026-03-08T10:30:00.000Z",
      timeZone: "America/Los_Angeles",
    })], springRange).get("2026-03-08")?.[0];
    expect(spring).toMatchObject({ startMinute: 90, endMinute: 210 });

    const fallRange = buildTaskDateRange("day", new Date(2026, 10, 1, 12));
    const fall = buildTaskTimeBlocks([task({
      id: "fall-fold",
      title: "秋季重叠",
      startDate: "2026-11-01T08:30:00.000Z",
      dueDate: "2026-11-01T10:30:00.000Z",
      timeZone: "America/Los_Angeles",
    })], fallRange).get("2026-11-01")?.[0];
    expect(fall).toMatchObject({ startMinute: 90, endMinute: 150 });
  });

  it("summarizes each task once per intersecting month in the year view", () => {
    const summary = buildTaskYearSummary([
      task({ id: "span", title: "跨月", startDate: "2026-01-31", dueDate: "2026-02-02", isAllDay: true }),
      task({ id: "done", title: "完成", status: 2, completedTime: "2026-02-15T08:00:00.000Z", timeZone: "UTC" }),
      task({ id: "other-year", title: "其他年份", dueDate: "2025-12-31", isAllDay: true }),
    ], new Date(2026, 7, 3));
    expect(summary[0]).toMatchObject({ scheduled: 1, open: 1, completed: 0 });
    expect(summary[1]).toMatchObject({ scheduled: 2, open: 1, completed: 1 });
    expect(summary.slice(2).every((month) => month.scheduled === 0)).toBe(true);
  });
});
