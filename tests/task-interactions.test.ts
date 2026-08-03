import { describe, expect, it } from "vitest";
import {
  commitInlineTaskTitle,
  inlineTaskTitleKeyIntent,
  TaskSubmissionGate,
} from "../src/domain/task-interactions";

describe("task interaction boundaries", () => {
  it("allows only one create while the first submission is pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const gate = new TaskSubmissionGate();
    let writes = 0;
    const create = () => gate.run(async () => {
      writes += 1;
      await pending;
    });

    const first = create();
    const second = create();
    expect(gate.isWriting).toBe(true);
    await expect(second).resolves.toBe(false);
    expect(writes).toBe(1);
    release();
    await expect(first).resolves.toBe(true);
    expect(gate.isWriting).toBe(false);
  });

  it("maps Enter to save, Escape to cancel, and other keys to no action", () => {
    expect(inlineTaskTitleKeyIntent("Enter")).toBe("commit");
    expect(inlineTaskTitleKeyIntent("Escape")).toBe("cancel");
    expect(inlineTaskTitleKeyIntent("Tab")).toBeNull();
  });

  it("uses one save path for Enter or blur and makes Escape a zero-write action", async () => {
    const writes: string[] = [];
    const save = async (title: string) => { writes.push(title); };
    if (inlineTaskTitleKeyIntent("Enter") === "commit") {
      await commitInlineTaskTitle("旧标题", " Enter 标题 ", save);
    }
    await commitInlineTaskTitle("旧标题", "失焦标题", save);
    if (inlineTaskTitleKeyIntent("Escape") !== "cancel") {
      await commitInlineTaskTitle("旧标题", "不应保存", save);
    }
    expect(writes).toEqual(["Enter 标题", "失焦标题"]);
  });

  it("does not write an unchanged title and rejects an empty title", async () => {
    let writes = 0;
    const save = async () => { writes += 1; };
    await expect(commitInlineTaskTitle("标题", " 标题 ", save)).resolves.toBe("unchanged");
    await expect(commitInlineTaskTitle("标题", "  ", save)).rejects.toThrow(/不能为空/);
    expect(writes).toBe(0);
  });
});
