import { describe, expect, it, vi } from "vitest";
import type { DidaColumn, DidaProject, DidaTask } from "../src/domain/entities";
import type { PendingDidaContractCleanup } from "../src/domain/dida-contract-cleanup";
import { DidaHttpError } from "../src/integrations/dida/http-contract";
import {
  DidaContractCleanupService,
  type ContractCleanupStore,
} from "../src/services/dida-contract-cleanup";

const binding = "a".repeat(64);

class MemoryStore implements ContractCleanupStore {
  constructor(public pending?: PendingDidaContractCleanup) {}
  async snapshot() { return structuredClone({ pendingDidaContractCleanup: this.pending }); }
  async mutate(mutator: (data: { pendingDidaContractCleanup?: PendingDidaContractCleanup }) => void) {
    const data = structuredClone({ pendingDidaContractCleanup: this.pending });
    mutator(data);
    this.pending = data.pendingDidaContractCleanup;
  }
}

function project(id: string, run = "run-1", side: "A" | "B" = "A"): DidaProject {
  return { id, name: `[Helix 合同测试 ${run}] 清单 ${side}` };
}

function column(projectId: string): DidaColumn {
  return { id: `column-${projectId}`, projectId, name: "默认", sortOrder: 0 };
}

function task(id: string, projectId: string, run = "run-1"): DidaTask {
  return { id, projectId, title: `[Helix 合同测试 ${run}] 任务`, status: 0 } as DidaTask;
}

function pendingPlan(): PendingDidaContractCleanup {
  return {
    authorizationBinding: binding,
    plan: {
      runId: "run-1",
      marker: "[Helix 合同测试 run-1]",
      projects: ["a", "b"].map((id, index) => ({
        id,
        name: project(id, "run-1", index === 0 ? "A" : "B").name,
        expectedColumns: [column(id)],
        baselineSource: "contract" as const,
      })),
      tasks: [{ id: "t", candidateProjectIds: ["a", "b"], state: "unknown" }],
    },
  };
}

function apiState() {
  const projects = [project("a", "run-1", "A"), project("b", "run-1", "B")];
  const tasks = new Map<string, DidaTask[]>([["a", [task("t", "a")]], ["b", []]]);
  const columns = new Map<string, DidaColumn[]>([["a", [column("a")]], ["b", [column("b")]]]);
  const api = {
    getProjects: vi.fn(async () => [...projects]),
    getProjectData: vi.fn(async (id: string) => ({
      project: projects.find((entry) => entry.id === id)!,
      tasks: [...(tasks.get(id) ?? [])],
      columns: [...(columns.get(id) ?? [])],
    })),
    getColumns: vi.fn(async (id: string) => [...(columns.get(id) ?? [])]),
    getCompletedTasks: vi.fn(async () => []),
    deleteTask: vi.fn(async (projectId: string, id: string) => {
      tasks.set(projectId, (tasks.get(projectId) ?? []).filter((entry) => entry.id !== id));
    }),
    deleteProject: vi.fn(async (id: string) => {
      const index = projects.findIndex((entry) => entry.id === id);
      if (index >= 0) projects.splice(index, 1);
    }),
  };
  return { api, projects, tasks, columns };
}

describe("DidaContractCleanupService", () => {
  it("strictly adopts one exact A/B run with a dual-source column baseline", async () => {
    const state = apiState();
    const store = new MemoryStore();
    await new DidaContractCleanupService(state.api as never, store).adoptStrictRemoteRun(binding);
    expect(store.pending?.plan.projects.map((entry) => entry.baselineSource)).toEqual(["adopted", "adopted"]);
    expect(store.pending?.plan.tasks).toHaveLength(1);
    expect(state.api.deleteTask).not.toHaveBeenCalled();
    expect(state.api.deleteProject).not.toHaveBeenCalled();
  });

  it("replaces only an empty authorization-bound placeholder during strict adoption", async () => {
    const state = apiState();
    const placeholder = pendingPlan();
    placeholder.plan.projects = [];
    placeholder.plan.tasks = [];
    const store = new MemoryStore(placeholder);
    await new DidaContractCleanupService(state.api as never, store).adoptStrictRemoteRun(binding);
    expect(store.pending?.plan.projects).toHaveLength(2);
    expect(state.api.deleteProject).not.toHaveBeenCalled();
  });

  it("preserves a competing placeholder before the final placeholder-path adoption CAS", async () => {
    const state = apiState();
    const placeholder = pendingPlan();
    placeholder.plan.projects = [];
    placeholder.plan.tasks = [];
    const store = new MemoryStore(placeholder);
    const competitor = structuredClone(placeholder);
    competitor.plan.runId = "run-competing";
    competitor.plan.marker = "[Helix 合同测试 run-competing]";
    store.mutate = async (mutator) => {
      store.pending = competitor;
      const data = structuredClone({ pendingDidaContractCleanup: store.pending });
      mutator(data);
      store.pending = data.pendingDidaContractCleanup;
    };
    await expect(new DidaContractCleanupService(state.api as never, store)
      .adoptStrictRemoteRun(binding)).rejects.toThrow(/竞争/);
    expect(store.pending).toEqual(competitor);
    expect(state.api.deleteProject).not.toHaveBeenCalled();
  });

  it("preserves a newly competing placeholder on the legacy no-placeholder adoption path", async () => {
    const state = apiState();
    const store = new MemoryStore();
    const competitor = pendingPlan();
    competitor.plan.runId = "run-competing";
    competitor.plan.marker = "[Helix 合同测试 run-competing]";
    competitor.plan.projects = [];
    competitor.plan.tasks = [];
    store.mutate = async (mutator) => {
      store.pending = competitor;
      const data = structuredClone({ pendingDidaContractCleanup: store.pending });
      mutator(data);
      store.pending = data.pendingDidaContractCleanup;
    };
    await expect(new DidaContractCleanupService(state.api as never, store)
      .adoptStrictRemoteRun(binding)).rejects.toThrow(/竞争/);
    expect(store.pending).toEqual(competitor);
    expect(state.api.deleteProject).not.toHaveBeenCalled();
  });

  it("ignores a different remote run and clears only the proven-empty placeholder", async () => {
    const state = apiState();
    const placeholder = pendingPlan();
    placeholder.plan.runId = "run-other";
    placeholder.plan.marker = "[Helix 合同测试 run-other]";
    placeholder.plan.projects = [];
    placeholder.plan.tasks = [];
    const store = new MemoryStore(placeholder);
    await new DidaContractCleanupService(state.api as never, store)
      .adoptStrictRemoteRun(binding);
    expect(store.pending).toBeUndefined();
    expect(state.api.deleteProject).not.toHaveBeenCalled();
  });

  it("clears a pre-create placeholder only after two stable reads prove this run has zero objects", async () => {
    const state = apiState();
    state.projects.splice(0, state.projects.length, { id: "ordinary", name: "用户清单" });
    const placeholder = pendingPlan();
    placeholder.plan.projects = [];
    placeholder.plan.tasks = [];
    const store = new MemoryStore(placeholder);
    await new DidaContractCleanupService(state.api as never, store).adoptStrictRemoteRun(binding);
    expect(state.api.getProjects).toHaveBeenCalledTimes(2);
    expect(store.pending).toBeUndefined();
    expect(state.api.deleteProject).not.toHaveBeenCalled();
  });

  it("keeps the placeholder when this run is partial or changes between the two reads", async () => {
    const state = apiState();
    const placeholder = pendingPlan();
    placeholder.plan.projects = [];
    placeholder.plan.tasks = [];
    const store = new MemoryStore(placeholder);
    state.projects.splice(1, 1);
    await expect(new DidaContractCleanupService(state.api as never, store)
      .adoptStrictRemoteRun(binding)).rejects.toThrow(/精确 A\/B/);
    expect(store.pending).toEqual(placeholder);

    state.projects.splice(0, state.projects.length);
    state.api.getProjects
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project("a", "run-1", "A")]);
    await expect(new DidaContractCleanupService(state.api as never, store)
      .adoptStrictRemoteRun(binding)).rejects.toThrow(/双读不稳定|重新出现/);
    expect(store.pending).toEqual(placeholder);
  });

  it("rejects multiple contract run groups without deleting anything", async () => {
    const state = apiState();
    state.projects.push(project("c", "run-2", "A"), project("d", "run-2", "B"));
    const store = new MemoryStore();
    await expect(new DidaContractCleanupService(state.api as never, store)
      .adoptStrictRemoteRun(binding)).rejects.toThrow(/唯一 A\/B/);
    expect(store.pending).toBeUndefined();
    expect(state.api.deleteProject).not.toHaveBeenCalled();
  });

  it("cleans tasks before projects and persists each proven removal", async () => {
    const state = apiState();
    const store = new MemoryStore(pendingPlan());
    const order: string[] = [];
    state.api.deleteTask.mockImplementation(async (projectId: string, id: string) => {
      order.push(`task:${id}`);
      state.tasks.set(projectId, []);
    });
    state.api.deleteProject.mockImplementation(async (id: string) => {
      expect(store.pending?.plan.projects.find((entry) => entry.id === id)?.deleteState)
        .toBe("sent-unknown");
      order.push(`project:${id}`);
      const index = state.projects.findIndex((entry) => entry.id === id);
      if (index >= 0) state.projects.splice(index, 1);
    });
    await new DidaContractCleanupService(state.api as never, store).recover(binding);
    expect(order).toEqual(["task:t", "project:a", "project:b"]);
    expect(store.pending).toBeUndefined();
  });

  it("honors bounded retryAfter for rate-limited reads", async () => {
    const state = apiState();
    const store = new MemoryStore(pendingPlan());
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    let now = 0;
    sleep.mockImplementation(async (ms: number) => { now += ms; });
    state.api.getProjectData
      .mockRejectedValueOnce(new DidaHttpError("rate-limit", "limit", 429, 25))
      .mockImplementation(async (id: string) => ({
        project: state.projects.find((entry) => entry.id === id)!,
        tasks: [...(state.tasks.get(id) ?? [])],
        columns: [...(state.columns.get(id) ?? [])],
      }));
    await new DidaContractCleanupService(
      state.api as never,
      store,
      sleep,
      () => now,
    ).recover(binding);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("never resends a delete whose remote outcome is unknown", async () => {
    const state = apiState();
    const store = new MemoryStore(pendingPlan());
    state.api.deleteTask.mockImplementation(async () => {
      expect(store.pending?.plan.tasks[0]?.deleteState).toBe("sent-unknown");
      throw new DidaHttpError("unknown-outcome", "network", undefined, undefined, true);
    });
    const cleanup = new DidaContractCleanupService(state.api as never, store);
    await expect(cleanup.recover(binding)).rejects.toThrow(/冻结重发/);
    expect(store.pending?.plan.tasks[0]?.deleteState).toBe("sent-unknown");
    await expect(new DidaContractCleanupService(state.api as never, store).recover(binding))
      .rejects.toThrow(/不会重发/);
    expect(state.api.deleteTask).toHaveBeenCalledTimes(1);
    expect(state.api.deleteProject).not.toHaveBeenCalled();
  });

  it("performs zero remote deletes when the pre-send sent-state CAS cannot persist", async () => {
    const state = apiState();
    const store = new MemoryStore(pendingPlan());
    store.mutate = async (mutator) => {
      const data = structuredClone({ pendingDidaContractCleanup: store.pending });
      mutator(data);
      if (data.pendingDidaContractCleanup?.plan.tasks[0]?.deleteState === "sent-unknown") {
        throw new Error("persist failed before send");
      }
      store.pending = data.pendingDidaContractCleanup;
    };
    await expect(new DidaContractCleanupService(state.api as never, store).recover(binding))
      .rejects.toThrow(/persist failed/);
    expect(state.api.deleteTask).not.toHaveBeenCalled();
    expect(state.api.deleteProject).not.toHaveBeenCalled();
  });

  it("never resends a project delete after its sent state survives a restart", async () => {
    const state = apiState();
    const plan = pendingPlan();
    plan.plan.tasks = [];
    state.tasks.set("a", []);
    const store = new MemoryStore(plan);
    state.api.deleteProject.mockImplementation(async (id: string) => {
      expect(store.pending?.plan.projects.find((entry) => entry.id === id)?.deleteState)
        .toBe("sent-unknown");
      throw new DidaHttpError("unknown-outcome", "network", undefined, undefined, true);
    });
    await expect(new DidaContractCleanupService(state.api as never, store).recover(binding))
      .rejects.toThrow(/冻结重发/);
    await expect(new DidaContractCleanupService(state.api as never, store).recover(binding))
      .rejects.toThrow(/不会重发/);
    expect(state.api.deleteProject).toHaveBeenCalledTimes(1);
  });

  it("preserves the plan and performs zero deletes on project competition", async () => {
    const state = apiState();
    state.tasks.set("a", []);
    const plan = pendingPlan();
    plan.plan.tasks = [];
    state.projects[0] = { ...state.projects[0]!, name: "用户清单" };
    const store = new MemoryStore(plan);
    await expect(new DidaContractCleanupService(state.api as never, store).recover(binding))
      .rejects.toThrow(/竞争/);
    expect(store.pending?.plan.projects).toHaveLength(2);
    expect(state.api.deleteProject).not.toHaveBeenCalled();
  });

  it("rejects a title that only shares the marker prefix without its boundary", async () => {
    const state = apiState();
    state.tasks.set("a", [{ ...task("t", "a"), title: "[Helix 合同测试 run-1]伪装任务" }]);
    const store = new MemoryStore(pendingPlan());
    await expect(new DidaContractCleanupService(state.api as never, store).recover(binding))
      .rejects.toThrow(/唯一标记/);
    expect(state.api.deleteTask).not.toHaveBeenCalled();
  });

  it("treats an absent candidate collection as absence proof without guessing a task location", async () => {
    const state = apiState();
    state.projects.splice(state.projects.findIndex((entry) => entry.id === "a"), 1);
    state.tasks.delete("a");
    const store = new MemoryStore(pendingPlan());
    await new DidaContractCleanupService(state.api as never, store).recover(binding);
    expect(state.api.deleteTask).not.toHaveBeenCalled();
    expect(state.api.deleteProject).toHaveBeenCalledTimes(1);
    expect(store.pending).toBeUndefined();
  });
});
