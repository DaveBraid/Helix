import { describe, expect, it } from "vitest";
import {
  assertTimeZone,
  instantToWallDateTime,
  wallDateTimeToInstant,
} from "../src/domain/task-datetime";

describe("task datetime and selected timezone", () => {
  it("round-trips a wall time in a timezone different from the computer", () => {
    const instant = wallDateTimeToInstant("2026-07-30T09:15", "Asia/Shanghai");
    expect(instant).toBe("2026-07-30T01:15:00.000Z");
    expect(instantToWallDateTime(instant, "Asia/Shanghai")).toBe("2026-07-30T09:15");
  });

  it("supports clearing and rejects invalid zones and DST gaps", () => {
    expect(wallDateTimeToInstant("", "Asia/Shanghai")).toBeNull();
    expect(() => assertTimeZone("Mars/Olympus")).toThrow(/无效时区/);
    expect(() =>
      wallDateTimeToInstant("2026-03-08T02:30", "America/New_York"),
    ).toThrow(/夏令时/);
  });

  it("keeps local dates stable for all-day midnight values", () => {
    const instant = wallDateTimeToInstant("2026-11-01T00:00", "America/New_York");
    expect(instantToWallDateTime(instant, "America/New_York")).toBe("2026-11-01T00:00");
  });
});
