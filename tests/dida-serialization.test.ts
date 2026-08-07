import { describe, expect, it } from "vitest";
import {
  newDidaChecklistItemDraft,
  serializeDidaChecklistItems,
  serializeDidaDate,
} from "../src/integrations/dida/serialization";

describe("Dida write serialization", () => {
  it("uses the documented compact numeric UTC offset", () => {
    expect(serializeDidaDate("2026-08-01T14:37:34.230Z"))
      .toBe("2026-08-01T14:37:34+0000");
    expect(serializeDidaDate("2026-08-01T22:37:34.230+08:00"))
      .toBe("2026-08-01T14:37:34+0000");
  });

  it("preserves explicit clears and rejects malformed dates", () => {
    expect(serializeDidaDate(null)).toBeNull();
    expect(serializeDidaDate(undefined)).toBeUndefined();
    expect(() => serializeDidaDate("not-a-date", "任务开始日期"))
      .toThrow("Dida 任务开始日期格式无效");
  });

  it("preserves checklist wire values without mutating the input", () => {
    const items = [{
      id: "item-1",
      title: "检查项",
      status: 0,
      startDate: "2026-08-01T14:37:34.230Z",
      completedTime: "2026-08-01T15:37:34.230Z",
    }];
    const serialized = serializeDidaChecklistItems(items);

    expect(serialized?.[0]).toMatchObject({
      startDate: "2026-08-01T14:37:34.230Z",
      completedTime: "2026-08-01T15:37:34.230Z",
    });
    expect(items[0]?.startDate).toBe("2026-08-01T14:37:34.230Z");
  });

  it("omits the ID property entirely for a new checklist item draft", () => {
    const draft = newDidaChecklistItemDraft("新检查项", 0);
    const serialized = serializeDidaChecklistItems([draft]);

    expect(draft).not.toHaveProperty("id");
    expect(serialized?.[0]).not.toHaveProperty("id");
    expect(JSON.stringify(serialized)).toBe('[{"title":"新检查项","status":0}]');
  });
});
