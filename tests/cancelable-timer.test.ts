import { afterEach, describe, expect, it, vi } from "vitest";
import { CancelableTimer } from "../src/services/cancelable-timer";

describe("CancelableTimer", () => {
  afterEach(() => vi.useRealTimers());

  it("never runs a pending lineage write after plugin disposal", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const timer = new CancelableTimer();
    timer.schedule(callback, 750);
    timer.dispose();
    vi.advanceTimersByTime(1_000);
    expect(callback).not.toHaveBeenCalled();
  });
});
