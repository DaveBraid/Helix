import { describe, expect, it } from "vitest";
import type { DidaTask } from "../src/domain/entities";
import { completionLast, flattenTaskTree, withTaskDescendants } from "../src/domain/task-tree";

const task = (id: string, status = 0, parentId?: string): DidaTask => ({
  id,
  projectId: "p",
  title: id,
  status,
  ...(parentId ? { parentId } : {}),
});

describe("task tree presentation", () => {
  it("keeps open tasks before completed tasks without disturbing relative order", () => {
    expect(completionLast([task("done-a", 2), task("open-a"), task("done-b", 2), task("open-b")])
      .map((item) => item.id)).toEqual(["open-a", "open-b", "done-a", "done-b"]);
  });

  it("renders real parentId children indented and keeps completed siblings last", () => {
    expect(flattenTaskTree([
      task("done-root", 2),
      task("child-done", 2, "parent"),
      task("parent"),
      task("child-open", 0, "parent"),
    ]).map((row) => [row.task.id, row.depth])).toEqual([
      ["parent", 0],
      ["child-open", 1],
      ["child-done", 1],
      ["done-root", 0],
    ]);
  });

  it("includes all descendants of an active parent", () => {
    expect([...withTaskDescendants([
      task("parent"),
      task("child", 0, "parent"),
      task("grandchild", 0, "child"),
      task("other"),
    ], new Set(["parent"]))]).toEqual(["parent", "child", "grandchild"]);
  });
});
