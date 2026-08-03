import { describe, expect, it } from "vitest";
import {
  presentDidaReminder,
  presentDidaReminders,
  presentDidaRepeat,
} from "../src/domain/task-reminders";

describe("Dida reminder and repeat read contract", () => {
  it("recognizes only exact at-time and before-task reminder shapes", () => {
    expect(presentDidaReminder("TRIGGER:PT0S")).toMatchObject({
      kind: "at-time",
      label: "任务时间",
    });
    expect(presentDidaReminder("TRIGGER:-P1DT2H30M")).toMatchObject({
      kind: "before",
      label: "1 天 2 小时 30 分钟前",
    });
    expect(presentDidaReminder("TRIGGER:P0DT9H0M0S")).toMatchObject({
      kind: "unsupported",
      label: "自定义提醒（只读）",
    });
    for (const invalid of ["TRIGGER:-P1DT", "TRIGGER:-P1W2D", "TRIGGER:-P1WT2H"]) {
      expect(presentDidaReminder(invalid).kind).toBe("unsupported");
    }
    expect(presentDidaReminders(undefined)).toEqual([]);
  });

  it("summarizes common RRULE values without pretending custom rules are editable", () => {
    expect(presentDidaRepeat(null)).toEqual({
      raw: null,
      kind: "none",
      label: "不重复",
      safelyUnderstood: true,
    });
    expect(presentDidaRepeat("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=5"))
      .toMatchObject({
        kind: "rrule",
        label: "每 2 周 · 周一、五 · 共 5 次",
        safelyUnderstood: true,
      });
    expect(presentDidaRepeat("RRULE:FREQ=MONTHLY;BYSETPOS=1")).toMatchObject({
      kind: "rrule",
      label: "自定义重复（只读）",
      safelyUnderstood: false,
    });
    expect(presentDidaRepeat("ERULE:FREQ=DAILY;INTERVAL=3")).toMatchObject({
      kind: "erule",
      label: "按完成日期重复（只读）",
      safelyUnderstood: false,
    });
    for (const invalid of [
      "RRULE:FREQ=WEEKLY;FREQ=DAILY",
      "RRULE:FREQ=DAILY;COUNT=1=2",
      "RRULE:FREQ=DAILY;INTERVAL=1e2",
      "RRULE:FREQ=DAILY;COUNT=1.0",
      "RRULE:FREQ=DAILY;UNTIL=nonsense",
      "RRULE:FREQ=DAILY;COUNT=2;UNTIL=20260803",
      "RRULE:FREQ=DAILY;UNTIL=20260230",
    ]) {
      expect(presentDidaRepeat(invalid).safelyUnderstood).toBe(false);
    }
    expect(presentDidaRepeat("RRULE:FREQ=DAILY;UNTIL=20260803")).toMatchObject({
      label: "每天 · 有结束日期",
      safelyUnderstood: true,
    });
    for (const original of [" RRULE:FREQ=DAILY ", "RRULE:FREQ=DAILY\n", "   ", ""]) {
      expect(presentDidaRepeat(original)).toMatchObject({
        raw: original,
        safelyUnderstood: false,
      });
    }
  });
});
