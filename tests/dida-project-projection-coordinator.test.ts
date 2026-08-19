import { describe, expect, it, vi } from "vitest";
import { buildProjectionActivationPreview } from "../src/domain/dida-project-projection";
import type { ProjectWorkspaceSnapshot } from "../src/services/project-workspace";
import {
  confirmProjectionActivation,
  projectionInputsFromProject,
  projectionInputFromStage,
  projectionStageInProject,
  type ProjectionApplicationPort,
} from "../src/services/dida-project-projection-coordinator";

const readiness = {
  writable: true,
  queueEmpty: true,
  authorizationCurrent: true,
  taskParentingVerified: true,
  itemsRoundTripVerified: true, itemIdStableVerified: true,
  boardPlacementVerified: true,
  boardFresh: true,
  taskReopenVerified: true,
  unknownOutcomes: 0,
};

describe("project projection application coordinator", () => {
  it("rejects confirmation when the stable workspace counts changed after preview", async () => {
    const target = { targetProjectId: "list-1", targetColumnId: "column-1" };
    const initial = buildProjectionActivationPreview({
      target,
      projects: [{ id: "list-1", name: "科研", permission: "write", viewMode: "kanban" }],
      columns: [{ id: "column-1", projectId: "list-1", name: "Helix项目" }],
      readiness,
      projectCount: 1,
      actionCount: 1,
    });
    const activate = vi.fn();
    const projection: ProjectionApplicationPort = {
      readProject: async (input) => ({
        enabled: false,
        project: {
          id: input.projectId,
          path: input.projectPath,
          title: input.projectTitle,
          status: input.projectStatus,
        },
        stages: input.stages.map((stage) => ({
          id: stage.stageId,
          path: stage.path,
          revisionHash: "hash",
          managed: [{ uuid: `${stage.stageId}-action`, line: 1, title: "行动", state: "active" }],
          unmanaged: [],
        })),
        receipts: [],
        receiptCleanupPending: [],
        orphanDiagnostics: [],
      }),
      previewActivation: async (candidate, counts) => buildProjectionActivationPreview({
        target: candidate,
        projects: [{ id: "list-1", name: "科研", permission: "write", viewMode: "kanban" }],
        columns: [{ id: "column-1", projectId: "list-1", name: "Helix项目" }],
        readiness,
        ...counts,
      }),
      activate,
    };
    await expect(confirmProjectionActivation(workspace(), projection, initial, initial.previewHash))
      .rejects.toThrow(/数量已变化/);
    expect(activate).not.toHaveBeenCalled();
  });

  it("never resolves a stage through another project's membership", () => {
    const snapshot = workspace();
    expect(projectionStageInProject(snapshot, "project-1", "stage-1").notePath).toBe("Stage-1.md");
    expect(() => projectionStageInProject(snapshot, "project-1", "stage-2"))
      .toThrow(/指定项目中的阶段/);
  });

  it("projects every stage as one parent task with only that stage's actions", () => {
    const project = workspace().projects[0]!;
    const second = {
      id: "stage-1b", title: "阶段二", notePath: "Stage-1b.md",
      sequence: 2, stageCode: "2", status: "completed" as const,
    };
    project.cycles.push(second);
    const inputs = projectionInputsFromProject(project);
    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => ({
      id: input.projectId,
      title: input.projectTitle,
      path: input.projectPath,
      stages: input.stages,
    }))).toEqual([
      { id: "stage-1", title: "阶段一", path: "Stage-1.md", stages: [{ path: "Stage-1.md", stageId: "stage-1" }] },
      { id: "stage-1b", title: "阶段二", path: "Stage-1b.md", stages: [{ path: "Stage-1b.md", stageId: "stage-1b" }] },
    ]);
    expect(projectionInputFromStage(project, second).projectStatus).toBe("completed");
  });
});

function workspace(): ProjectWorkspaceSnapshot {
  return {
    canvasPath: "Projects.canvas",
    canvasRevisionHash: "canvas-hash",
    managedMarkdownRevisionHashes: {},
    projects: [
      {
        id: "project-1",
        title: "项目一",
        status: "active",
        notePath: "Project-1.md",
        cycles: [{ id: "stage-1", title: "阶段一", notePath: "Stage-1.md", sequence: 1, stageCode: "1", status: "active" }],
      },
      {
        id: "project-2",
        title: "项目二",
        status: "active",
        notePath: "Project-2.md",
        cycles: [{ id: "stage-2", title: "阶段二", notePath: "Stage-2.md", sequence: 1, stageCode: "1", status: "active" }],
      },
    ],
    nextStageSequenceByProject: { "project-1": 2, "project-2": 2 },
    relations: [],
    migrationWarnings: [],
    migrationItems: [],
    migrationRequired: false,
    canvasNodes: [],
    collapsedCompletedProjectIds: [],
    nativeRelationCandidates: [],
  };
}
