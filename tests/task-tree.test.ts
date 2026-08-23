import { describe, expect, it } from "vitest";
import type { DidaTask } from "../src/domain/entities";
import {
  applyPreferredTaskSiblingOrder,
  canReparentTask,
  completionLast,
  flattenTaskTree,
  withTaskDescendants,
} from "../src/domain/task-tree";

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

  it("restores managed sibling order without moving foreign task slots", () => {
    const tasks = [
      task("parent"),
      task("managed-3", 0, "parent"),
      task("foreign", 0, "parent"),
      task("managed-2", 0, "parent"),
      task("managed-1", 0, "parent"),
    ];

    const ordered = applyPreferredTaskSiblingOrder(tasks, [
      "parent",
      "managed-1",
      "managed-2",
      "managed-3",
    ]);

    expect(ordered.map((item) => item.id)).toEqual([
      "parent",
      "managed-1",
      "foreign",
      "managed-2",
      "managed-3",
    ]);
    expect(flattenTaskTree(ordered).map((row) => row.task.id)).toEqual([
      "parent",
      "managed-1",
      "foreign",
      "managed-2",
      "managed-3",
    ]);
  });

  it("keeps remote Stage parent root order when only action children are preferred", () => {
    const tasks = [
      task("stage-parent-2"),
      task("foreign-root"),
      task("stage-parent-1"),
      task("action-2", 0, "stage-parent-1"),
      task("action-1", 0, "stage-parent-1"),
    ];

    const ordered = applyPreferredTaskSiblingOrder(tasks, ["action-1", "action-2"]);

    expect(ordered.map((item) => item.id)).toEqual([
      "stage-parent-2",
      "foreign-root",
      "stage-parent-1",
      "action-1",
      "action-2",
    ]);
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

  it("recursively flattens arbitrary depth and collapses only the selected subtree", () => {
    const rows = flattenTaskTree([
      task("root"),
      task("child", 0, "root"),
      task("grandchild", 0, "child"),
      task("sibling", 0, "root"),
    ], { collapsedIds: new Set(["child"]) });
    expect(rows.map((row) => [row.task.id, row.depth, row.expanded])).toEqual([
      ["root", 0, true],
      ["child", 1, false],
      ["sibling", 1, false],
    ]);
  });

  it("reports direct-child progress even when completed children are hidden", () => {
    const all = [task("parent"), task("open", 0, "parent"), task("done", 2, "parent")];
    const [parent] = flattenTaskTree(all.filter((item) => item.status !== 2), {
      progressTasks: all,
    });
    expect(parent).toMatchObject({
      hasChildren: true,
      directChildCount: 2,
      completedDirectChildCount: 1,
    });
  });

  it("prevents a task from becoming itself or a descendant", () => {
    const tasks = [task("root"), task("child", 0, "root"), task("grandchild", 0, "child")];
    expect(canReparentTask(tasks, "root", "grandchild")).toBe(false);
    expect(canReparentTask(tasks, "child", "child")).toBe(false);
    expect(canReparentTask(tasks, "grandchild", "root")).toBe(true);
    expect(canReparentTask(tasks, "child", null)).toBe(true);
  });
});
