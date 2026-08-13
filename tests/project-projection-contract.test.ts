import { describe, expect, it } from "vitest";
import type { DidaColumn, DidaProject, DidaTask } from "../src/domain/entities";
import { runDidaProjectProjectionContractProbe } from "../src/integrations/dida/project-projection-contract";
import type {
  ContractApi,
  DidaProjectProjectionContractContext,
} from "../src/integrations/dida/write-contract";
import { DidaHttpError } from "../src/integrations/dida/http-contract";

describe("Dida project projection contract probe", () => {
  it("creates a parent, exercises a real child task, and cleans every tracked probe task", async () => {
    const harness = createHarness();
    await runDidaProjectProjectionContractProbe(harness.context);

    expect(harness.untrackedCreates).toBe(0);
    expect(harness.tracked).toEqual([]);
    expect([...harness.tasks.values()]).toEqual([]);
  });

  it("accepts collection absence when the task detail endpoint still returns a deleted ghost", async () => {
    const harness = createHarness();
    harness.keepDeletedDetailGhost = true;

    await runDidaProjectProjectionContractProbe(harness.context);

    expect(harness.tracked).toEqual([]);
    expect([...harness.tasks.values()]).toEqual([]);
  });

  it("marks an unknown create before refusing to continue", async () => {
    const harness = createHarness();
    harness.failNextCreateUnknown = true;
    await expect(runDidaProjectProjectionContractProbe(harness.context)).rejects.toThrow(/unknown/u);
    expect(harness.untrackedCreates).toBe(1);
  });
});

function createHarness() {
  const project: DidaProject = {
    id: "contract-project",
    name: "[Helix 合同测试 unit] 清单 A",
    viewMode: "kanban",
    permission: "write",
  };
  const column: DidaColumn = {
    id: "contract-column",
    projectId: project.id,
    name: "[Helix 合同测试 unit] 分栏创建能力",
  };
  const tasks = new Map<string, DidaTask>();
  const tracked: string[] = [];
  let counter = 0;
  let untrackedCreates = 0;
  let failNextCreateUnknown = false;
  let keepDeletedDetailGhost = false;
  const deletedGhosts = new Map<string, DidaTask>();
  const api = {
    createTask: async (draft: Partial<DidaTask> & Pick<DidaTask, "title" | "projectId">) => {
      if (failNextCreateUnknown) {
        failNextCreateUnknown = false;
        throw new DidaHttpError("transient", "unknown", undefined, undefined, true);
      }
      const task: DidaTask = {
        ...structuredClone(draft),
        id: `remote-${++counter}`,
        projectId: draft.projectId,
        title: draft.title,
        status: draft.status ?? 0,
      };
      tasks.set(task.id, task);
      return structuredClone(task);
    },
    getTask: async (projectId: string, taskId: string) => {
      const task = tasks.get(taskId) ?? deletedGhosts.get(taskId);
      if (!task || task.projectId !== projectId) {
        throw new DidaHttpError("permanent", "not found", 404);
      }
      return structuredClone(task);
    },
    updateTask: async (taskId: string, patch: Partial<DidaTask>) => {
      const current = tasks.get(taskId);
      if (!current) throw new DidaHttpError("permanent", "not found", 404);
      const next = { ...current, ...structuredClone(patch), id: taskId };
      tasks.set(taskId, next);
      return structuredClone(next);
    },
    completeTask: async (projectId: string, taskId: string) => {
      const current = tasks.get(taskId);
      if (!current || current.projectId !== projectId) throw new DidaHttpError("permanent", "not found", 404);
      tasks.set(taskId, { ...current, status: 2, completedTime: "2026-08-13T00:00:00.000Z" });
    },
    deleteTask: async (projectId: string, taskId: string) => {
      const current = tasks.get(taskId);
      if (!current || current.projectId !== projectId) throw new DidaHttpError("permanent", "not found", 404);
      tasks.delete(taskId);
      if (keepDeletedDetailGhost) deletedGhosts.set(taskId, structuredClone(current));
    },
    getProjectData: async (projectId: string) => ({
      project: structuredClone(project),
      tasks: [...tasks.values()].filter((task) => task.projectId === projectId)
        .map((task) => structuredClone(task)),
      columns: [structuredClone(column)],
    }),
  } as unknown as ContractApi;
  const context: DidaProjectProjectionContractContext = {
    api,
    marker: "[Helix 合同测试 unit]",
    project,
    column,
    taskScheduleMode: "duration",
    trackTask: async (task) => { tracked.push(task.id); },
    untrackTask: async (taskId) => {
      const index = tracked.indexOf(taskId);
      if (index < 0) throw new Error("not tracked");
      tracked.splice(index, 1);
    },
    markTaskDeleteUnknown: async () => undefined,
    markUntrackedCreate: async () => { untrackedCreates += 1; },
  };
  return {
    project,
    column,
    tasks,
    tracked,
    context,
    get untrackedCreates() { return untrackedCreates; },
    get failNextCreateUnknown() { return failNextCreateUnknown; },
    set failNextCreateUnknown(value: boolean) { failNextCreateUnknown = value; },
    get keepDeletedDetailGhost() { return keepDeletedDetailGhost; },
    set keepDeletedDetailGhost(value: boolean) { keepDeletedDetailGhost = value; },
  };
}
