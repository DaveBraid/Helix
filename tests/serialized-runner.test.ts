import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SelfWriteTracker,
  SerializedRunner,
} from "../src/services/serialized-runner";

describe("SerializedRunner", () => {
  it("queues an edit arriving while a lineage write is running", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const runner = new SerializedRunner();

    const first = runner.run(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = runner.run(async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(runner.isBusy()).toBe(true);
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues with the next queued edit after a failed write", async () => {
    const runner = new SerializedRunner();
    const events: string[] = [];
    const failed = runner.run(async () => {
      throw new Error("conflict");
    });
    const next = runner.run(async () => {
      events.push("next");
    });
    await expect(failed).rejects.toThrow("conflict");
    await next;
    expect(events).toEqual(["next"]);
  });

  it("returns each serialized operation result", async () => {
    const runner = new SerializedRunner();
    const first = runner.run(async () => "first");
    const second = runner.run(async () => 2);
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe(2);
  });
});

describe("SelfWriteTracker", () => {
  afterEach(() => vi.useRealTimers());

  it("distinguishes a plugin write event from a later user edit", () => {
    vi.useFakeTimers();
    const tracker = new SelfWriteTracker();
    tracker.mark("Helix/Projects/a.md");
    expect(tracker.consume("Helix/Projects/a.md")).toBe(true);
    expect(tracker.consume("Helix/Projects/a.md")).toBe(false);
  });

  it("expires an unmatched marker instead of hiding future edits", () => {
    vi.useFakeTimers();
    const tracker = new SelfWriteTracker(100);
    tracker.mark("Helix/Projects/a.md");
    vi.advanceTimersByTime(101);
    expect(tracker.consume("Helix/Projects/a.md")).toBe(false);
  });
});
