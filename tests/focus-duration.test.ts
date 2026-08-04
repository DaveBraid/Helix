import { describe, expect, it } from "vitest";
import { focusMinutes } from "../src/domain/focus-duration";

describe("focus duration normalization", () => {
  it("treats Dida duration as milliseconds and cross-checks the recorded interval", () => {
    expect(focusMinutes({
      id: "focus-1",
      type: 1,
      duration: 2_827_000,
      startTime: "2026-08-04T09:00:00.000Z",
      endTime: "2026-08-04T09:47:08.000Z",
    })).toBe(47);
  });

  it("uses valid start/end timestamps when duration is missing or implausible", () => {
    expect(focusMinutes({
      id: "focus-2",
      type: 1,
      startTime: "2026-08-04T09:00:00.000Z",
      endTime: "2026-08-04T09:47:08.000Z",
    })).toBe(47);
    expect(focusMinutes({
      id: "focus-3",
      type: 1,
      duration: 2_827_000_000,
      startTime: "2026-08-04T09:00:00.000Z",
      endTime: "2026-08-04T09:47:08.000Z",
    })).toBe(47);
  });
});
