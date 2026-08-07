import { describe, expect, it } from "vitest";
import {
  createDidaChecklistClientItem,
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

  it("rejects checklist writes until a stable client ID has been assigned", () => {
    expect(() => serializeDidaChecklistItems([
      { title: "新检查项", status: 0 } as never,
    ])).toThrow(/客户端 ID/);
    expect(() => serializeDidaChecklistItems([
      { id: "", title: "新检查项", status: 0 },
    ])).toThrow(/客户端 ID/);
  });

  it("allocates a monotonic 13-digit client ID and a safe appended sortOrder", () => {
    const baseline = [
      { id: "1785888000001", title: "A", status: 0, sortOrder: 7 },
      { id: "ordinary", title: "B", status: 0, sortOrder: 12 },
    ];
    expect(createDidaChecklistClientItem(
      baseline, "new", 0, "2026-08-05T00:00:00.000Z",
    )).toEqual({ id: "1785888000002", title: "new", status: 0, sortOrder: 13 });
  });

  it("reuses a persisted ID but freezes collisions and unsafe sort baselines", () => {
    const baseline = [{ id: "ordinary", title: "A", status: 0, sortOrder: 4 }];
    expect(createDidaChecklistClientItem(
      baseline, "new", 0, "2026-08-05T00:00:00.000Z", "1785888000000",
    ).id).toBe("1785888000000");
    expect(() => createDidaChecklistClientItem(
      [{ ...baseline[0]!, id: "1785888000000" }], "new", 0,
      "2026-08-05T00:00:00.000Z", "1785888000000",
    )).toThrow(/碰撞/);
    expect(() => createDidaChecklistClientItem(
      [{ id: "ordinary", title: "A", status: 0 }], "new", 0,
      "2026-08-05T00:00:00.000Z",
    )).toThrow(/sortOrder/);
    expect(() => createDidaChecklistClientItem(
      baseline, "new", 0, "2026-08-05T00:00:00.000Z", "0000000000001",
    )).toThrow(/客户端 ID/);
  });
});
