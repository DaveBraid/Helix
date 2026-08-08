import { describe, expect, it } from "vitest";
import {
  ProjectRefreshBatch,
  type ProjectRefreshBatchTimers,
} from "../src/services/project-refresh-batch";

describe("ProjectRefreshBatch", () => {
  it("coalesces delayed Project, Stage and Canvas events into one stable refresh", () => {
    const timers = new DeterministicTimers();
    let refreshes = 0;
    const batch = new ProjectRefreshBatch(() => { refreshes += 1; }, 300, timers);

    batch.begin();
    expect(batch.recordEvent()).toBe(true); // Project.md
    expect(batch.recordEvent()).toBe(true); // Stage-01.md
    batch.end();
    timers.advance(250);
    expect(batch.recordEvent()).toBe(true); // 延迟到达的 Canvas watcher
    timers.advance(299);
    expect(refreshes).toBe(0);
    timers.advance(1);
    expect(refreshes).toBe(1);
    expect(batch.recordEvent()).toBe(false); // 静默窗后的外部修改仍走普通监听
  });

  it("still schedules a stable refresh when the self-write operation fails", () => {
    const timers = new DeterministicTimers();
    let refreshes = 0;
    const batch = new ProjectRefreshBatch(() => { refreshes += 1; }, 300, timers);

    batch.begin();
    expect(batch.recordEvent()).toBe(true);
    batch.end(); // 对应 finally；失败不能吞掉已观察事件
    timers.advance(300);

    expect(refreshes).toBe(1);
  });
});

class DeterministicTimers implements ProjectRefreshBatchTimers {
  private now = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  set(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
    while (true) {
      const due = [...this.pending.entries()]
        .filter(([, item]) => item.at <= this.now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) return;
      this.pending.delete(due[0]);
      due[1].callback();
    }
  }
}
