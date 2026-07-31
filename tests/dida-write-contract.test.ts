import { describe, expect, it, vi } from "vitest";
import type { DidaProject, DidaTask } from "../src/domain/entities";
import { DidaHttpError } from "../src/integrations/dida/http-contract";
import { DidaWriteContractRunner } from "../src/integrations/dida/write-contract";

class ContractApiFake {
  projects = new Map<string, DidaProject>([
    ["original-project", { id: "original-project", name: "用户原有清单" }],
  ]);
  tasks = new Map<string, DidaTask>([
    ["original-task", {
      id: "original-task",
      projectId: "original-project",
      title: "用户原有任务",
      status: 0,
    }],
  ]);
  deletedProjects: string[] = [];
  deletedTasks: string[] = [];
  injectForeignTaskOnMove = false;
  injectForeignCompletedTaskOnMove = false;
  throwAfterMove = false;
  returnMoveTombstoneAtSource = false;
  duplicateSourceCollectionAfterMove = false;
  sourceTombstoneReads = 0;
  throwAfterComplete = false;
  throwAfterFirstProjectCreate = false;
  reuseOriginalProjectId = false;
  throwAfterDelete = false;
  staleReadsAfterDelete = 0;
  completedVisibilityDelay = 0;
  throwCompletedReads = false;
  collapseScheduleToPoint = false;
  corruptSchedule = false;
  keepTaskOnDelete = false;
  private staleProjects = new Map<string, { value: DidaProject; remaining: number }>();
  private staleTasks = new Map<string, { value: DidaTask; remaining: number }>();
  private moveSourceTombstones = new Map<string, DidaTask>();
  private moveSourceCollectionGhosts = new Map<string, DidaTask>();
  private projectSequence = 0;
  private taskSequence = 0;

  async getProjects(): Promise<DidaProject[]> {
    const projects = [...this.projects.values()].map((project) => ({ ...project }));
    for (const stale of this.staleProjects.values()) {
      if (stale.remaining <= 0) continue;
      stale.remaining -= 1;
      projects.push({ ...stale.value });
    }
    return projects;
  }

  async createProject(value: Partial<DidaProject> & Pick<DidaProject, "name">): Promise<DidaProject> {
    this.projectSequence += 1;
    const project = {
      id: this.reuseOriginalProjectId ? "original-project" : `test-project-${this.projectSequence}`,
      name: value.name,
    };
    this.projects.set(project.id, project);
    if (this.throwAfterFirstProjectCreate && this.projectSequence === 1) {
      throw new DidaHttpError("unknown-outcome", "project create unknown", 503, undefined, true);
    }
    return project;
  }

  async getProject(projectId: string): Promise<DidaProject> {
    const project = this.projects.get(projectId);
    if (!project) {
      const stale = this.staleProjects.get(projectId);
      if (!stale || stale.remaining <= 0) throw notFound();
      stale.remaining -= 1;
      return { ...stale.value };
    }
    return { ...project };
  }

  async getProjectData(projectId: string): Promise<{
    project: DidaProject;
    tasks: DidaTask[];
  }> {
    return {
      project: await this.getProject(projectId),
      tasks: [
        ...[...this.tasks.values()].filter(
          (task) => task.projectId === projectId && task.status !== 2,
        ),
        ...[...this.moveSourceCollectionGhosts.values()].filter(
          (task) => task.projectId === projectId && task.status !== 2,
        ),
      ],
    };
  }

  async getCompletedTasks(filter: Record<string, unknown>): Promise<DidaTask[]> {
    if (this.throwCompletedReads) throw new Error("completed endpoint timeout");
    const projectIds = new Set(Array.isArray(filter.projectIds) ? filter.projectIds : []);
    const start = Date.parse(String(filter.startDate));
    const end = Date.parse(String(filter.endDate));
    const inRange = (task: DidaTask): boolean => {
      const completed = Date.parse(task.completedTime ?? "");
      return Number.isFinite(completed) && completed >= start && completed <= end;
    };
    const activeCompleted = [...this.tasks.values()]
      .filter((task) => task.status === 2 && projectIds.has(task.projectId) && inRange(task));
    if (activeCompleted.length > 0 && this.completedVisibilityDelay > 0) {
      this.completedVisibilityDelay -= 1;
    }
    const tasks = activeCompleted
      .filter(() => this.completedVisibilityDelay <= 0)
      .map((task) => ({ ...task }));
    for (const stale of this.staleTasks.values()) {
      if (
        stale.remaining <= 0 ||
        stale.value.status !== 2 ||
        !projectIds.has(stale.value.projectId) ||
        !inRange(stale.value)
      ) {
        continue;
      }
      stale.remaining -= 1;
      tasks.push({ ...stale.value });
    }
    return tasks;
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = this.projects.get(projectId);
    this.deletedProjects.push(projectId);
    this.projects.delete(projectId);
    if (project && this.staleReadsAfterDelete > 0) {
      this.staleProjects.set(projectId, {
        value: { ...project },
        remaining: this.staleReadsAfterDelete,
      });
    }
    if (this.throwAfterDelete) throw new Error("empty response parse failure");
  }

  async createTask(
    value: Partial<DidaTask> & Pick<DidaTask, "title" | "projectId">,
  ): Promise<DidaTask> {
    const task: DidaTask = {
      ...value,
      id: `test-task-${++this.taskSequence}`,
      title: value.title,
      projectId: value.projectId,
      status: 0,
    };
    if (this.collapseScheduleToPoint && task.dueDate) task.startDate = task.dueDate;
    if (this.corruptSchedule) task.dueDate = "2030-01-01T00:00:00.000Z";
    this.tasks.set(task.id, task);
    return { ...task };
  }

  async getTask(projectId: string, taskId: string): Promise<DidaTask> {
    const task = this.tasks.get(taskId);
    if (!task || task.projectId !== projectId) {
      const moveTombstone = this.moveSourceTombstones.get(`${projectId}:${taskId}`);
      if (this.returnMoveTombstoneAtSource && moveTombstone) {
        this.sourceTombstoneReads += 1;
        return { ...moveTombstone };
      }
      const stale = this.staleTasks.get(`${projectId}:${taskId}`);
      if (!stale || stale.remaining <= 0) throw notFound();
      stale.remaining -= 1;
      return { ...stale.value };
    }
    return { ...task };
  }

  async updateTask(taskId: string, value: Partial<DidaTask>): Promise<DidaTask> {
    const current = this.tasks.get(taskId);
    if (!current) throw notFound();
    const updated = { ...current, ...value };
    if (this.collapseScheduleToPoint && updated.dueDate) updated.startDate = updated.dueDate;
    if (this.corruptSchedule) updated.dueDate = "2030-01-01T00:00:00.000Z";
    this.tasks.set(taskId, updated);
    return { ...updated };
  }

  async moveTask(input: {
    fromProjectId: string;
    toProjectId: string;
    taskId: string;
  }): Promise<{ id: string }> {
    const task = await this.getTask(input.fromProjectId, input.taskId);
    this.moveSourceTombstones.set(`${input.fromProjectId}:${task.id}`, { ...task });
    if (this.duplicateSourceCollectionAfterMove) {
      this.moveSourceCollectionGhosts.set(`${input.fromProjectId}:${task.id}`, { ...task });
    }
    this.tasks.set(task.id, { ...task, projectId: input.toProjectId });
    if (this.injectForeignTaskOnMove) {
      this.tasks.set("foreign-task", {
        id: "foreign-task",
        projectId: input.toProjectId,
        title: "用户意外放入的任务",
        status: 0,
      });
    }
    if (this.injectForeignCompletedTaskOnMove) {
      this.tasks.set("foreign-completed-task", {
        id: "foreign-completed-task",
        projectId: input.toProjectId,
        title: "用户意外放入并完成的任务",
        status: 2,
        completedTime: "2000-01-01T00:00:00.000Z",
      });
    }
    if (this.throwAfterMove) {
      throw new DidaHttpError("unknown-outcome", "move unknown", 503, undefined, true);
    }
    return { id: task.id };
  }

  async completeTask(projectId: string, taskId: string): Promise<void> {
    const task = await this.getTask(projectId, taskId);
    this.tasks.set(task.id, {
      ...task,
      status: 2,
      completedTime: "2026-07-31T00:00:00.000Z",
    });
    if (this.throwAfterComplete) {
      throw new DidaHttpError("unknown-outcome", "complete unknown", 503, undefined, true);
    }
  }

  async deleteTask(projectId: string, taskId: string): Promise<void> {
    const task = await this.getTask(projectId, taskId);
    this.deletedTasks.push(taskId);
    if (!this.keepTaskOnDelete) this.tasks.delete(taskId);
    if (this.staleReadsAfterDelete > 0) {
      this.staleTasks.set(`${projectId}:${taskId}`, {
        value: { ...task },
        remaining: this.staleReadsAfterDelete,
      });
    }
    if (this.throwAfterDelete) throw new Error("empty response parse failure");
  }
}

describe("DidaWriteContractRunner", () => {
  const fixedNow = () => new Date("2026-07-31T00:00:00.000Z");

  it("tests only run-created IDs and removes every temporary artifact", async () => {
    const api = new ContractApiFake();
    const report = await new DidaWriteContractRunner(api, () => "run-safe", fixedNow).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(api.projects.get("original-project")?.name).toBe("用户原有清单");
    expect(api.tasks.get("original-task")?.title).toBe("用户原有任务");
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.deletedTasks).toEqual(["test-task-1"]);
    expect([...api.projects]).toHaveLength(1);
    expect([...api.tasks]).toHaveLength(1);
  });

  it("does not let a progress observer interrupt cleanup", async () => {
    const api = new ContractApiFake();
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-progress-observer",
      fixedNow,
      undefined,
      () => {
        throw new Error("settings view was closed");
      },
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.deletedTasks).toEqual(["test-task-1"]);
  });

  it("classifies a server-collapsed schedule as point mode and completes the core contract", async () => {
    const api = new ContractApiFake();
    api.collapseScheduleToPoint = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-point-schedule",
      fixedNow,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      taskScheduleMode: "point",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(report.steps.join(" ")).toMatch(/单点任务时间/);
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.deletedTasks).toEqual(["test-task-1"]);
  });

  it("fails on an unexpected schedule transformation while still cleaning test artifacts", async () => {
    const api = new ContractApiFake();
    api.corruptSchedule = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-corrupt-schedule",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.taskScheduleMode).toBe("unknown");
    expect(report.failure).toMatch(/时间与提交值不一致/);
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(api.projects.has("original-project")).toBe(true);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("accepts a failed delete response only after a 404 reread proves deletion", async () => {
    const api = new ContractApiFake();
    api.throwAfterDelete = true;
    const report = await new DidaWriteContractRunner(api, () => "run-delete-reread", fixedNow).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect([...api.projects]).toHaveLength(1);
    expect([...api.tasks]).toHaveLength(1);
    expect(api.projects.has("original-project")).toBe(true);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("waits through bounded eventual-consistency reads after deletion", async () => {
    const api = new ContractApiFake();
    api.staleReadsAfterDelete = 2;
    const sleep = vi.fn(async () => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-eventual-delete",
      fixedNow,
      sleep,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(sleep).toHaveBeenCalled();
    expect([...api.projects]).toHaveLength(1);
    expect([...api.tasks]).toHaveLength(1);
  });

  it("waits until a completed task appears before attempting its deletion", async () => {
    const api = new ContractApiFake();
    api.completedVisibilityDelay = 2;
    const sleep = vi.fn(async () => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-completed-visible",
      fixedNow,
      sleep,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(sleep).toHaveBeenCalled();
  });

  it("does not multiply transport failures across consistency attempts", async () => {
    const api = new ContractApiFake();
    api.throwCompletedReads = true;
    const sleep = vi.fn(async () => undefined);
    const progress = vi.fn();
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-read-timeout",
      fixedNow,
      sleep,
      progress,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.failure).toMatch(/completed endpoint timeout/);
    expect(report.cleanupErrors.join(" ")).toMatch(/completed endpoint timeout/);
    expect(sleep).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      stage: "等待任务进入可观察集合",
      attempt: 1,
      maxAttempts: 20,
    }));
  });

  it("still succeeds when deletion becomes visible near the observation deadline", async () => {
    const api = new ContractApiFake();
    api.staleReadsAfterDelete = 18;
    const sleep = vi.fn(async () => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-near-deadline-delete",
      fixedNow,
      sleep,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(18);
    expect([...api.projects]).toHaveLength(1);
    expect([...api.tasks]).toHaveLength(1);
  });

  it("remains conservative when deletion is still readable past the observation deadline", async () => {
    const api = new ContractApiFake();
    api.staleReadsAfterDelete = 25;
    const sleep = vi.fn(async () => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-past-deadline-delete",
      fixedNow,
      sleep,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.failure).toMatch(/仍存在于可观察任务集合/);
    expect(report.cleanupErrors.length).toBeGreaterThan(0);
    expect(api.projects.has("original-project")).toBe(true);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("stops scheduling consistency retries when the wall-clock budget is exhausted", async () => {
    const api = new ContractApiFake();
    api.keepTaskOnDelete = true;
    let nowMs = 0;
    const readCompleted = api.getCompletedTasks.bind(api);
    api.getCompletedTasks = async (filter) => {
      nowMs += 6_000;
      return readCompleted(filter);
    };
    const sleep = vi.fn(async (milliseconds: number) => {
      nowMs += milliseconds;
    });
    const progress: Array<{ stage: string; attempt?: number }> = [];
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-wall-clock-budget",
      fixedNow,
      sleep,
      (value) => progress.push(value),
      () => nowMs,
    ).run();

    const deletionAttempts = progress
      .filter((value) => value.stage === "等待任务集合确认删除")
      .map((value) => value.attempt ?? 0);
    expect(report.status).toBe("failed");
    expect(Math.max(...deletionAttempts)).toBeLessThan(20);
    expect(api.deletedProjects).toEqual([]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("finds and safely removes a moved test task after an unknown move result", async () => {
    const api = new ContractApiFake();
    api.throwAfterMove = true;
    api.returnMoveTombstoneAtSource = true;
    const report = await new DidaWriteContractRunner(api, () => "run-unknown", fixedNow).run();

    expect(report.status).toBe("failed");
    expect(report.failure).toMatch(/move unknown/);
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(api.deletedTasks).toEqual(["test-task-1"]);
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.tasks.has("original-task")).toBe(true);
    expect(api.sourceTombstoneReads).toBe(0);
  });

  it("refuses to choose a task location while both candidate collections contain its ID", async () => {
    const api = new ContractApiFake();
    api.throwAfterMove = true;
    api.duplicateSourceCollectionAfterMove = true;
    const sleep = vi.fn(async () => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-dual-location",
      fixedNow,
      sleep,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.cleanupErrors.join(" ")).toMatch(/多个候选清单集合/);
    expect(api.deletedTasks).toEqual([]);
    expect(api.deletedProjects).toEqual([]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("finds a remotely completed task when the complete response outcome is unknown", async () => {
    const api = new ContractApiFake();
    api.throwAfterComplete = true;
    const report = await new DidaWriteContractRunner(api, () => "run-complete-unknown", fixedNow).run();

    expect(report.status).toBe("failed");
    expect(report.failure).toMatch(/complete unknown/);
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(api.deletedTasks).toEqual(["test-task-1"]);
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("does not delete test projects when task cleanup cannot prove absence", async () => {
    const api = new ContractApiFake();
    api.keepTaskOnDelete = true;
    const sleep = vi.fn(async () => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-task-cleanup-failed",
      fixedNow,
      sleep,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.cleanupErrors.join(" ")).toMatch(/可观察任务集合/);
    expect(api.deletedProjects).toEqual([]);
    expect(api.projects.has("test-project-1")).toBe(true);
    expect(api.projects.has("test-project-2")).toBe(true);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("refuses to delete a test project containing a foreign completed task", async () => {
    const api = new ContractApiFake();
    api.injectForeignCompletedTaskOnMove = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-foreign-completed",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.cleanupErrors.join(" ")).toMatch(/非本轮已完成任务/);
    expect(api.projects.has("test-project-2")).toBe(true);
    expect(api.tasks.has("foreign-completed-task")).toBe(true);
    expect(api.deletedProjects).toEqual(["test-project-1"]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("refuses to delete a test list when any non-run task appears", async () => {
    const api = new ContractApiFake();
    api.injectForeignTaskOnMove = true;
    const report = await new DidaWriteContractRunner(api, () => "run-foreign", fixedNow).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.cleanupErrors.join(" ")).toMatch(/非本轮任务/);
    expect(api.projects.has("test-project-2")).toBe(true);
    expect(api.tasks.get("foreign-task")?.title).toBe("用户意外放入的任务");
    expect(api.deletedProjects).toEqual(["test-project-1"]);
    expect(api.deletedTasks).toEqual(["test-task-1"]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("reports a possible leftover without guessing an ID after unknown project creation", async () => {
    const api = new ContractApiFake();
    api.throwAfterFirstProjectCreate = true;
    const report = await new DidaWriteContractRunner(api, () => "run-untracked", fixedNow).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(api.deletedProjects).toEqual([]);
    expect(api.deletedTasks).toEqual([]);
    expect(api.projects.get("original-project")?.name).toBe("用户原有清单");
    expect(api.tasks.get("original-task")?.title).toBe("用户原有任务");
  });

  it("never deletes a project ID that existed before the test", async () => {
    const api = new ContractApiFake();
    api.reuseOriginalProjectId = true;
    const report = await new DidaWriteContractRunner(api, () => "run-collision", fixedNow).run();

    expect(report.status).toBe("failed");
    expect(report.failure).toMatch(/测试前已存在/);
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(api.deletedProjects).toEqual([]);
    expect(api.deletedTasks).toEqual([]);
  });
});

function notFound(): DidaHttpError {
  return new DidaHttpError("permanent", "not found", 404);
}
