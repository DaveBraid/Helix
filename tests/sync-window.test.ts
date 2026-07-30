import { describe, expect, it } from "vitest";
import { isInsideSyncWindow } from "../src/services/sync-window";

describe("bounded habit and focus deletion inference", () => {
  it("does not treat a record naturally sliding beyond the 31-day window as deleted", () => {
    const to = new Date("2026-07-30T12:00:00Z").getTime();
    const from = to - 31 * 86_400_000;
    expect(isInsideSyncWindow("2026-06-28T12:00:00Z", from, to)).toBe(false);
    expect(isInsideSyncWindow("2026-06-30T12:00:00Z", from, to)).toBe(true);
  });
});
