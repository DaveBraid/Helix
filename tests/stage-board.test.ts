import { describe, expect, it } from "vitest";
import {
  STAGE_BOARD_COLUMNS,
  STAGE_STATUS_PRESENTATION,
  stageBoardCycleIds,
  stageBoardPointerDecision,
  requestStageBoardStatusChange,
  StageBoardMoveRegistry,
  stageBoardMoveDecision,
} from "../src/domain/stage-board";

describe("阶段看板领域合同", () => {
  it("uses one fixed five-state column order and shared presentation", () => {
    expect(STAGE_BOARD_COLUMNS).toEqual(["idea", "active", "completed", "paused", "terminated"]);
    expect(STAGE_BOARD_COLUMNS.map((status) => STAGE_STATUS_PRESENTATION[status].label))
      .toEqual(["想法", "进行中", "已完成", "已暂停", "已终止"]);
  });

  it("does not submit same-column or pending moves", () => {
    expect(stageBoardMoveDecision("active", "active", false)).toBe("noop");
    expect(stageBoardMoveDecision("active", "completed", true)).toBe("busy");
    expect(stageBoardMoveDecision("active", "completed", false)).toBe("commit");
  });

  it("keeps Markdown stages on the board even without Canvas nodes or completed projection", () => {
    const projects = [
      { id: "a", cycles: [{ id: "canvas-node-missing" }, { id: "completed-but-folded" }] },
      { id: "b", cycles: [{ id: "other-project" }] },
    ];
    expect(stageBoardCycleIds(projects, null))
      .toEqual(["canvas-node-missing", "completed-but-folded", "other-project"]);
    expect(stageBoardCycleIds(projects, "a"))
      .toEqual(["canvas-node-missing", "completed-but-folded"]);
  });

  it("suppresses note opening for every threshold drag end, while cancellation remains zero-write", () => {
    expect(stageBoardPointerDecision(6, "active", "completed", false))
      .toEqual({ suppressOpen: false, move: "noop" });
    expect(stageBoardPointerDecision(7, "active", undefined, false))
      .toEqual({ suppressOpen: true, move: "noop" });
    expect(stageBoardPointerDecision(7, "active", "active", false))
      .toEqual({ suppressOpen: true, move: "noop" });
    expect(stageBoardPointerDecision(7, "active", "completed", true))
      .toEqual({ suppressOpen: true, move: "noop" });
  });

  it("uses expected-status preparation before the writable Markdown commit and never touches Canvas", async () => {
    const writes: string[] = [];
    await requestStageBoardStatusChange(
      "stage-1", "active", "completed",
      async () => ({ currentStatus: "active" as const }),
      async (_plan, status) => { writes.push(status); },
    );
    expect(writes).toEqual(["completed"]);
    await expect(requestStageBoardStatusChange(
      "stage-1", "active", "completed",
      async () => ({ currentStatus: "paused" as const }),
      async () => { writes.push("unexpected"); },
    )).rejects.toThrow(/状态已变化/);
    await expect(requestStageBoardStatusChange(
      "stage-1", "active", "completed",
      async () => ({ currentStatus: "active" as const }),
      async () => { throw new Error("只读恢复模式"); },
    )).rejects.toThrow(/只读恢复模式/);
    expect(writes).toEqual(["completed"]);
  });

  it("locks repeated moves and releases pending even after a destroyed view settles", () => {
    const registry = new StageBoardMoveRegistry();
    expect(registry.tryBegin("stage-1")).toBe(true);
    expect(registry.tryBegin("stage-1")).toBe(false);
    expect(registry.finish("stage-1", false)).toBe(false);
    expect(registry.isPending("stage-1")).toBe(false);
    expect(registry.tryBegin("stage-1")).toBe(true);
    expect(registry.finish("stage-1", true)).toBe(true);
  });

  it("does not acquire a registry lock for a same-column move", () => {
    const registry = new StageBoardMoveRegistry();
    expect(stageBoardMoveDecision("active", "active", registry.isPending("stage-1"))).toBe("noop");
    expect(registry.isPending("stage-1")).toBe(false);
  });
});
