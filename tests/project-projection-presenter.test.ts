import { describe, expect, it } from "vitest";
import {
  ProjectionUiActionCoordinator,
  conflictCenterIsEmpty,
  loadProjectionConflictModels,
  projectionActivationText,
  projectionCatalogChoices,
  projectionProjectSummary,
  projectionSyncSummaryText,
} from "../src/ui/project-projection-presenter";
import type { ProjectionProjectReadModel } from "../src/services/dida-project-projection";

describe("project projection presenter", () => {
  it("shows exact names with stable IDs and never invents an empty column", () => {
    expect(projectionCatalogChoices([{
      projects: [{ id: "list-1", name: "科研" }],
      columns: [{ id: "column-1", projectId: "list-1", name: "进行中" }],
      readiness: {
        writable: true, queueEmpty: true, authorizationCurrent: true, taskParentingVerified: true, itemsRoundTripVerified: true, itemIdStableVerified: true,
        boardPlacementVerified: true, boardFresh: true, taskReopenVerified: true, unknownOutcomes: 0,
      },
    }])).toEqual([{
      projectId: "list-1",
      projectLabel: "科研 · list-1",
      columns: [{ id: "column-1", label: "进行中 · column-1" }],
    }]);
  });

  it("summarizes frozen, orphaned and cleanup-pending project state", () => {
    const model = baseModel();
    expect(projectionProjectSummary(model)).toMatchObject({
      managed: 1, unmanaged: 1, orphan: 0, frozen: 0, cleanup: 0,
    });
    expect(projectionProjectSummary({
      ...model,
      orphanDiagnostics: [{ uuid: "orphan", stageId: "stage-1", state: "active", tombstone: true, frozen: "unknown-outcome" }],
    }).frozen).toBe(1);
  });

  it("presents target, counts, and blockers in the activation confirmation", () => {
    const lines = projectionActivationText({
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      projectName: "科研", columnName: "进行中", projectCount: 3, actionCount: 8,
      blockers: ["队列非空"], createsColumn: false, previewHash: "a".repeat(64),
    });
    expect(lines.join(" ")).toMatch(/科研.*list-1.*进行中.*column-1.*3 个.*8 条.*队列非空/);
  });

  it("serializes projection actions and only the latest completion refreshes", async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { finishSecond = resolve; });
    const events: string[] = [];
    const busy: boolean[] = [];
    let refreshes = 0;
    const coordinator = new ProjectionUiActionCoordinator();
    const first = coordinator.run(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    }, (value) => busy.push(value), () => { refreshes += 1; });
    const second = coordinator.run(async () => {
      events.push("second:start");
      await secondGate;
      events.push("second:end");
    }, (value) => busy.push(value), () => { refreshes += 1; });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    finishFirst();
    await first;
    await Promise.resolve();
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    finishSecond();
    await second;
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(busy).toEqual([true, true, false]);
    expect(refreshes).toBe(1);
  });

  it("reports every sync outcome and warns when any object is frozen", () => {
    const base = {
      createdParents: 1, updatedParents: 2, completedParents: 3,
      createdActions: 4, updatedActions: 5, completedActions: 6,
      deletedActions: 7, frozen: [],
    };
    expect(projectionSyncSummaryText(base)).toEqual({
      text: "项目同步已收口。创建 5 · 更新 7 · 完成 9 · 删除 7 · 冻结 0",
      warning: false,
    });
    expect(projectionSyncSummaryText({
      ...base,
      frozen: [{ uuid: "uuid-1", reason: "unknown-outcome" as const, message: "未知" }],
    })).toEqual({
      text: "部分冻结，转冲突中心处理。创建 5 · 更新 7 · 完成 9 · 删除 7 · 冻结 1",
      warning: true,
    });
  });

  it("degrades a rejected project workspace to a redacted read-only diagnostic", async () => {
    const result = await loadProjectionConflictModels(
      async () => { throw new Error("failed private-path token_abcdefghijklmnop"); },
      async () => baseModel(),
    );
    expect(result.models).toEqual([]);
    expect(result.diagnostic).toMatch(/路径已隐藏|标识已隐藏/);
    expect(result.diagnostic).not.toMatch(/private-path|abcdefghijklmnop/);
  });

  it("never shows the conflict empty state over recovery, column unknown, or workspace diagnostics", () => {
    const empty = {
      conflicts: 0, focusConflicts: 0, recoveryIssues: 0, reconciliation: 0,
      failed: 0, orphanedBlocked: 0, projectionIssues: 0,
      workspaceDiagnostic: false, lineageConflict: false, contractCleanup: false,
    };
    expect(conflictCenterIsEmpty(empty)).toBe(true);
    expect(conflictCenterIsEmpty({ ...empty, recoveryIssues: 1 })).toBe(false);
    expect(conflictCenterIsEmpty({ ...empty, projectionIssues: 1 })).toBe(false);
    expect(conflictCenterIsEmpty({ ...empty, workspaceDiagnostic: true })).toBe(false);
    expect(conflictCenterIsEmpty({ ...empty, contractCleanup: true })).toBe(false);
  });
});

function baseModel(): ProjectionProjectReadModel {
  return {
    enabled: true,
    target: { targetProjectId: "list-1", targetColumnId: "column-1" },
    project: { id: "project-1", path: "Project.md", title: "项目", status: "active" },
    stages: [{
      id: "stage-1", path: "Stage.md", revisionHash: "hash",
      managed: [{ uuid: "uuid-1", line: 1, title: "行动", state: "active" }],
      unmanaged: [{ line: 2, title: "未受管", completed: false }],
    }],
    receipts: [], receiptCleanupPending: [], orphanDiagnostics: [],
  };
}
