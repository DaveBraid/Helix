import { describe, expect, it } from "vitest";
import {
  cloneTaskDetailDraft,
  validateTaskDetailDraft,
  type TaskDetailDraft,
} from "../src/domain/task-detail";

const draft = (): TaskDetailDraft => ({
  id: "task-1",
  source: "stage-action",
  breadcrumb: ["Helix", "项目", "阶段 1"],
  syncLabel: "保存到阶段 Markdown",
  title: "任务",
  status: "active",
  priority: 3,
  date: "2026-08-20",
  startTime: "09:30",
  endTime: "16:00",
  timeMode: "range",
  timeZone: "Asia/Shanghai",
  tags: ["科研"],
  reminders: [],
  repeatFlag: null,
  subtasks: [{
    id: "child-1",
    title: "子任务",
    status: "idea",
    priority: 0,
    date: "",
    startTime: "",
    endTime: "",
  }],
});

describe("task detail domain", () => {
  it("clones all mutable collections", () => {
    const source = draft();
    const cloned = cloneTaskDetailDraft(source);
    cloned.tags.push("实验");
    cloned.subtasks[0]!.title = "已改";
    expect(source.tags).toEqual(["科研"]);
    expect(source.subtasks[0]!.title).toBe("子任务");
  });

  it("rejects empty titles and inverted ranges", () => {
    const empty = draft();
    empty.title = " ";
    expect(() => validateTaskDetailDraft(empty)).toThrow("标题不能为空");
    const range = draft();
    range.startTime = "17:00";
    expect(() => validateTaskDetailDraft(range)).toThrow("结束时间不能早于开始时间");
  });
});
