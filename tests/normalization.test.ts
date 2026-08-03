import { describe, expect, it } from "vitest";
import {
  normalizeColumns,
  normalizeFocus,
  normalizeHabit,
  normalizeHabitCheckin,
  normalizeProject,
  normalizeTask,
} from "../src/integrations/dida/normalization";

describe("Dida normalization", () => {
  it("normalizes and deterministically orders kanban columns", () => {
    expect(normalizeColumns([
      { id: "b", projectId: "project-1", name: " Done ", sortOrder: 20 },
      { id: "a", projectId: "project-1", name: "Doing", sortOrder: 10 },
    ])).toEqual([
      { id: "a", projectId: "project-1", name: "Doing", sortOrder: 10 },
      { id: "b", projectId: "project-1", name: "Done", sortOrder: 20 },
    ]);
    expect(() => normalizeColumns([
      { id: "", projectId: "project-1", name: "Broken" },
    ])).toThrow(/看板列 id/);
    expect(normalizeColumns([
      { id: "unsafe", projectId: "project-1", name: "Large", sortOrder: Number.MAX_SAFE_INTEGER + 2 },
    ])).toMatchObject([{ id: "unsafe", sortOrder: undefined, sortOrderUnsafe: true }]);
    expect(normalizeTask({
      id: "unsafe-task",
      projectId: "project-1",
      title: "Large order",
      status: 0,
      sortOrder: Number.MAX_SAFE_INTEGER + 2,
    })).toMatchObject({ sortOrder: undefined, sortOrderUnsafe: true });
    expect(normalizeProject({
      id: "project-unsafe",
      name: "Large order",
      sortOrder: Number.MAX_SAFE_INTEGER + 2,
    })).toMatchObject({ sortOrder: undefined, sortOrderUnsafe: true });
    expect(() => normalizeColumns(undefined)).toThrow(/字段缺失/);
  });

  it("normalizes date forms, set ordering, empty values, and checklist ordering", () => {
    const first = normalizeTask({
      id: "task-1",
      projectId: "project-1",
      title: " Test ",
      status: 0,
      dueDate: "2026-07-30T10:00:00+0000",
      tags: ["b", "a", "a"],
      reminders: ["later", "before"],
      items: [
        { id: "b", title: " second ", status: 0 },
        { id: "a", title: " first ", status: 0 },
      ],
    });
    const second = normalizeTask({
      id: "task-1",
      projectId: "project-1",
      title: "Test",
      status: 0,
      dueDate: "2026-07-30T10:00:00.000Z",
      tags: ["a", "b"],
      reminders: ["before", "later"],
      items: [
        { id: "a", title: "first", status: 0 },
        { id: "b", title: "second", status: 0 },
      ],
    });
    expect(first).toEqual(second);
  });

  it("rejects invalid task, checklist, focus, and habit-checkin dates", () => {
    expect(() => normalizeTask({
      id: "task-column-invalid",
      projectId: "project-1",
      title: "Bad column",
      status: 0,
      columnId: 7 as unknown as string,
    })).toThrow(/columnId/);
    expect(() => normalizeTask({
      id: "task-1",
      projectId: "project-1",
      title: "Bad",
      status: 0,
      dueDate: "not-a-date",
    })).toThrow(/任务截止日期格式无效/);
    expect(() => normalizeTask({
      id: "task-1",
      projectId: "project-1",
      title: "Bad",
      status: 0,
      items: [{ id: "item-1", title: "x", status: 0, startDate: "broken" }],
    })).toThrow(/检查项开始日期格式无效/);
    expect(() => normalizeFocus({
      id: "focus-1",
      type: 1,
      startTime: "broken",
    })).toThrow(/专注开始日期格式无效/);
    expect(() => normalizeHabitCheckin({
      habitId: "habit-1",
      checkinTime: "broken",
    })).toThrow(/checkinTime 格式无效/);
    expect(() => normalizeHabit({
      id: "habit-1",
      name: "Habit",
      modifiedTime: "broken",
    })).toThrow(/习惯修改日期格式无效/);
  });
});
