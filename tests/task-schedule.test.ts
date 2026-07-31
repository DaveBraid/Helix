import { describe, expect, it } from "vitest";
import {
  isPointSchedule,
  taskScheduleEditorMode,
  taskScheduleForSubmission,
  validateTaskScheduleWrite,
} from "../src/domain/task-schedule";

describe("task schedule capability", () => {
  it("accepts empty, due-only, and equal point schedules", () => {
    expect(isPointSchedule({})).toBe(true);
    expect(isPointSchedule({ dueDate: "2026-08-01T15:00:00Z" })).toBe(true);
    expect(isPointSchedule({
      startDate: "2026-08-01T15:00:00Z",
      dueDate: "2026-08-01T15:00:00+00:00",
    })).toBe(true);
  });

  it("rejects a changed duration before writing in point or unknown mode", () => {
    const duration = {
      startDate: "2026-08-01T14:00:00Z",
      dueDate: "2026-08-01T15:00:00Z",
    };
    expect(() => validateTaskScheduleWrite(duration, "point"))
      .toThrow(/仅支持单点任务时间/);
    expect(() => validateTaskScheduleWrite(duration, "unknown"))
      .toThrow(/先在 Helix 设置中运行写入合同测试/);
  });

  it("allows an unchanged remote duration during unrelated writes", () => {
    const duration = {
      startDate: "2026-08-01T14:00:00Z",
      dueDate: "2026-08-01T15:00:00Z",
    };
    expect(() => validateTaskScheduleWrite(duration, "point", duration)).not.toThrow();
    expect(() => validateTaskScheduleWrite(duration, "unknown", duration)).not.toThrow();
  });

  it("treats time-zone and all-day changes as changes to an existing duration", () => {
    const remote = {
      startDate: "2026-08-01T14:00:00Z",
      dueDate: "2026-08-01T15:00:00Z",
      timeZone: "UTC",
      isAllDay: false,
    };
    expect(() => validateTaskScheduleWrite({
      ...remote,
      timeZone: "Asia/Shanghai",
    }, "point", remote)).toThrow(/仅支持单点任务时间/);
    expect(() => validateTaskScheduleWrite({
      ...remote,
      isAllDay: true,
    }, "point", remote)).toThrow(/仅支持单点任务时间/);
  });

  it("rejects an inverted tuple in every capability mode", () => {
    const inverted = {
      startDate: "2026-08-01T16:00:00Z",
      dueDate: "2026-08-01T15:00:00Z",
    };
    for (const mode of ["unknown", "point", "duration"] as const) {
      expect(() => validateTaskScheduleWrite(inverted, mode)).toThrow(/不能早于/);
    }
  });

  it("locks an existing duration instead of silently collapsing it in point mode", () => {
    expect(taskScheduleEditorMode({
      startDate: "2026-08-01T14:00:00Z",
      dueDate: "2026-08-01T15:00:00Z",
    }, "point")).toBe("locked-duration");
    expect(taskScheduleEditorMode({ dueDate: "2026-08-01T15:00:00Z" }, "point"))
      .toBe("point");
  });

  it("submits the exact remote duration when its editor is locked", () => {
    const original = {
      startDate: "2026-08-01T14:00:34.230Z",
      dueDate: "2026-08-01T15:00:56.789Z",
      timeZone: "Asia/Shanghai",
      isAllDay: false,
    };
    expect(taskScheduleForSubmission(original, {
      startDate: "2026-08-01T14:00:00.000Z",
      dueDate: "2026-08-01T15:00:00.000Z",
      timeZone: "UTC",
      isAllDay: true,
    }, "locked-duration")).toEqual(original);
  });

  it("rejects invalid time-zone and all-day values before writing", () => {
    expect(() => validateTaskScheduleWrite({
      dueDate: "2026-08-01T15:00:00Z",
      timeZone: "Mars/Olympus",
    }, "point")).toThrow(/时区无效/);
    expect(() => validateTaskScheduleWrite({
      dueDate: "2026-08-01T15:00:00Z",
      isAllDay: "yes" as unknown as boolean,
    }, "point")).toThrow(/全天状态格式无效/);
  });
});
