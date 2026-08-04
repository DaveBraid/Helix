import { describe, expect, it } from "vitest";
import { HOME_GREETINGS, greetingPeriod, homeGreeting } from "../src/domain/home-dashboard";

describe("home dashboard greeting", () => {
  it("ships at least thirty time-aware greetings", () => {
    expect(Object.values(HOME_GREETINGS).flat()).toHaveLength(36);
  });

  it("selects a stable greeting within each day and period", () => {
    const first = new Date(2026, 7, 4, 9, 1);
    const later = new Date(2026, 7, 4, 11, 59);
    expect(homeGreeting(first)).toBe(homeGreeting(later));
    expect(greetingPeriod(4)).toBe("night");
    expect(greetingPeriod(5)).toBe("dawn");
    expect(greetingPeriod(8)).toBe("morning");
    expect(greetingPeriod(12)).toBe("noon");
    expect(greetingPeriod(14)).toBe("afternoon");
    expect(greetingPeriod(18)).toBe("evening");
    expect(greetingPeriod(22)).toBe("night");
  });
});
