import { describe, expect, it } from "vitest";
import type { DidaProject } from "../src/domain/entities";
import {
  commitTaskBoardMove,
  normalizeInlineTaskTitle,
  taskBoardColumnLabels,
  taskBoardDropTarget,
  taskBoardKeyboardTarget,
  taskBoardMoveAvailability,
} from "../src/domain/task-board-move";

const project: DidaProject = {
  id: "project-1",
  name: "Board",
  permission: "write",
  columns: [
    { id: "one", projectId: "project-1", name: "分析" },
    { id: "two", projectId: "project-1", name: "分析" },
    { id: "three", projectId: "project-1", name: "完成" },
  ],
};

describe("task board move presentation", () => {
  it.each([
    [{ connected: true, demoMode: true, boardPlacementVerified: true }, /演示数据/],
    [{ connected: true, demoMode: false, boardPlacementVerified: false }, /尚未通过/],
    [{ connected: false, demoMode: false, boardPlacementVerified: true }, /离线/],
  ] as const)("returns a specific disabled reason for %o", (state, reason) => {
    expect(taskBoardMoveAvailability(state, project, "one")).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(reason),
    });
  });

  it("covers permission, stale data, no target, and the enabled state", () => {
    const state = { connected: true, demoMode: false, boardPlacementVerified: true };
    expect(taskBoardMoveAvailability(state, { ...project, permission: "read" }, "one").reason)
      .toMatch(/没有写入权限/);
    expect(taskBoardMoveAvailability(state, { ...project, boardStale: true }, "one").reason)
      .toMatch(/详情已过期/);
    expect(taskBoardMoveAvailability(state, { ...project, columns: [project.columns![0]!] }, "one").reason)
      .toMatch(/没有其他/);
    expect(taskBoardMoveAvailability(state, project, "one")).toEqual({
      enabled: true,
      reason: "移动到其他分栏",
    });
  });

  it("disambiguates duplicate column names with their visible order", () => {
    expect(Object.fromEntries(taskBoardColumnLabels(project.columns!))).toEqual({
      one: "分析 · 第 1 列",
      two: "分析 · 第 2 列",
      three: "完成",
    });
  });

  it("commits only on explicit confirmation and refreshes only after success", async () => {
    const calls: string[] = [];
    const move = async (target: string) => { calls.push(`move:${target}`); };
    const refresh = async () => { calls.push("refresh"); };

    await expect(commitTaskBoardMove("", move, refresh)).rejects.toThrow(/请选择/);
    expect(calls).toEqual([]);

    await commitTaskBoardMove("two", move, refresh);
    expect(calls).toEqual(["move:two", "refresh"]);
  });

  it("does not refresh after a failed remote move", async () => {
    let refreshes = 0;
    await expect(commitTaskBoardMove(
      "two",
      async () => { throw new Error("remote failed"); },
      () => { refreshes += 1; },
    )).rejects.toThrow("remote failed");
    expect(refreshes).toBe(0);
  });

  it("writes only when a card is dropped into a different real column", () => {
    expect(taskBoardDropTarget("one", undefined)).toBeNull();
    expect(taskBoardDropTarget("one", "one")).toBeNull();
    expect(taskBoardDropTarget("one", "two")).toBe("two");
  });

  it("moves by keyboard only to an adjacent real column", () => {
    expect(taskBoardKeyboardTarget(project.columns!, "one", "left")).toBeNull();
    expect(taskBoardKeyboardTarget(project.columns!, "one", "right")).toBe("two");
    expect(taskBoardKeyboardTarget(project.columns!, "two", "left")).toBe("one");
    expect(taskBoardKeyboardTarget(project.columns!, "three", "right")).toBeNull();
    expect(taskBoardKeyboardTarget(project.columns!, undefined, "right")).toBe("one");
  });

  it("normalizes an inline title and rejects an empty title", () => {
    expect(normalizeInlineTaskTitle("  新标题  ")).toBe("新标题");
    expect(() => normalizeInlineTaskTitle("  ")).toThrow(/不能为空/);
  });
});
