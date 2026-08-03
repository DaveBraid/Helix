import { describe, expect, it } from "vitest";
import type { TaskMatrixRules } from "../src/domain/task-views";
import { SerializedRunner } from "../src/services/serialized-runner";
import { TaskMatrixRuleUpdater } from "../src/services/task-view-settings";

const rules = (urgentWithinDays: 0 | 1 | 3 | 7): TaskMatrixRules => ({
  importantPriorityThreshold: 5,
  urgentWithinDays,
});

describe("TaskMatrixRuleUpdater", () => {
  it("serializes rapid updates and publishes each only after persistence", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const events: string[] = [];
    const updater = new TaskMatrixRuleUpdater(new SerializedRunner());
    const persist = async (snapshot: TaskMatrixRules): Promise<void> => {
      events.push(`persist:${snapshot.urgentWithinDays}:start`);
      if (snapshot.urgentWithinDays === 1) await firstGate;
      events.push(`persist:${snapshot.urgentWithinDays}:end`);
    };
    const publish = (snapshot: TaskMatrixRules): void => {
      events.push(`publish:${snapshot.urgentWithinDays}`);
    };

    const first = updater.update(rules(1), persist, publish);
    const second = updater.update(rules(3), persist, publish);
    await Promise.resolve();
    expect(events).toEqual(["persist:1:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "persist:1:start",
      "persist:1:end",
      "publish:1",
      "persist:3:start",
      "persist:3:end",
      "publish:3",
    ]);
  });

  it("does not publish a failed write and continues with the next update", async () => {
    const updater = new TaskMatrixRuleUpdater(new SerializedRunner());
    const persisted: number[] = [];
    const published: number[] = [];
    const persist = async (snapshot: TaskMatrixRules): Promise<void> => {
      if (snapshot.urgentWithinDays === 1) throw new Error("write failed");
      persisted.push(snapshot.urgentWithinDays);
    };
    const publish = (snapshot: TaskMatrixRules): void => {
      published.push(snapshot.urgentWithinDays);
    };

    const failed = updater.update(rules(1), persist, publish);
    const next = updater.update(rules(7), persist, publish);
    await expect(failed).rejects.toThrow("write failed");
    await next;
    expect(persisted).toEqual([7]);
    expect(published).toEqual([7]);
  });
});
