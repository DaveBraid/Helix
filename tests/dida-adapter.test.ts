import { describe, expect, it } from "vitest";
import type { DidaTask } from "../src/domain/entities";
import {
  DidaProjectAdapter,
  DidaTaskAdapter,
  taskBoardPlacementPayload,
} from "../src/integrations/dida/adapters";
import type { DidaApi } from "../src/integrations/dida/api";
import { DidaHttpError } from "../src/integrations/dida/http-contract";
import {
  buildTaskUpdateOperation,
  migrateInProgressTaskId,
} from "../src/services/task-operations";
import { createSnapshot } from "../src/sync/snapshots";

class FakeTaskApi {
  calls: string[] = [];
  location = "project-old";
  task: DidaTask = {
    id: "task-1",
    projectId: "project-old",
    title: "旧任务",
    status: 0,
  };
  failMoveAfterApply = false;
  failCompleteAfterApply = false;
  lastUpdate: Partial<DidaTask> | null = null;
  lastCreate: Partial<DidaTask> | null = null;

  async createTask(value: Partial<DidaTask> & Pick<DidaTask, "title" | "projectId">): Promise<DidaTask> {
    this.calls.push("create");
    this.lastCreate = structuredClone(value);
    return { ...value, id: "created-task", status: 0 };
  }

  async getTask(projectId: string): Promise<DidaTask> {
    this.calls.push(`get:${projectId}`);
    if (projectId !== this.location) {
      throw new DidaHttpError("permanent", "not found", 404);
    }
    return { ...this.task, projectId: this.location };
  }

  async moveTask(input: { toProjectId: string }): Promise<{ id: string }> {
    this.calls.push("move");
    this.location = input.toProjectId;
    this.task.projectId = input.toProjectId;
    if (this.failMoveAfterApply) {
      throw new DidaHttpError(
        "unknown-outcome",
        "move response lost",
        undefined,
        undefined,
        true,
      );
    }
    return { id: this.task.id };
  }

  async updateTask(_id: string, value: Partial<DidaTask>): Promise<DidaTask> {
    this.calls.push("update");
    this.lastUpdate = structuredClone(value);
    this.task = { ...this.task, ...value, projectId: this.location };
    return this.task;
  }

  async completeTask(): Promise<void> {
    this.calls.push("complete");
    this.task.status = 2;
    if (this.failCompleteAfterApply) {
      throw new DidaHttpError(
        "unknown-outcome",
        "complete response lost",
        undefined,
        undefined,
        true,
      );
    }
  }
}

function desiredTask(status: number): DidaTask {
  return {
    id: "task-1",
    projectId: "project-new",
    title: status === 2 ? "已完成任务" : "开放任务",
    status,
  };
}

describe("DidaTaskAdapter", () => {
  it("adds columnId only to the dedicated board placement payload", () => {
    const payload = taskBoardPlacementPayload({
      id: "task-1",
      projectId: "project-1",
      title: "Board task",
      status: 0,
      content: "keep",
      reminders: ["TRIGGER:PT0S"],
      repeatFlag: "RRULE:FREQ=DAILY",
    }, "doing");
    expect(payload).toEqual({
      id: "task-1",
      projectId: "project-1",
      columnId: "doing",
    });
  });
  it("keeps board placement out of writable task snapshots", async () => {
    const api = new FakeTaskApi();
    api.task = { ...api.task, columnId: "todo" };
    await expect(new DidaTaskAdapter(api as unknown as DidaApi).get(
      api.task.id,
      { projectId: api.task.projectId },
    )).resolves.not.toHaveProperty("columnId");
  });
  it("migrates an in-progress marker when an unknown create is bound to a remote id", () => {
    expect(migrateInProgressTaskId([
      {
        taskId: "local-1",
        projectId: "project-old",
        markedAt: "2026-07-30T00:00:00Z",
        lastTouchedAt: "2026-07-30T00:00:00Z",
        activeFocus: false,
      },
    ], "local-1", {
      id: "remote-1",
      projectId: "project-new",
      title: "Task",
      status: 0,
    })).toMatchObject([{ taskId: "remote-1", projectId: "project-new" }]);
  });

  it("carries the base project as source context from Helix queue construction into the adapter", async () => {
    const api = new FakeTaskApi();
    const desired = desiredTask(0);
    const operation = buildTaskUpdateOperation(
      desired,
      createSnapshot("task", "task-1", {
        id: "task-1",
        projectId: "project-old",
        title: "旧任务",
        status: 0,
      }),
      "update",
      "2026-07-30T00:00:00Z",
      "op-move",
    );
    await new DidaTaskAdapter(api as unknown as DidaApi).update(
      operation.entityId,
      operation.local.value,
      { projectId: operation.projectId },
    );
    expect(operation.projectId).toBe("project-old");
    expect(api.location).toBe("project-new");
    expect(api.calls).toContain("move");
  });

  it("moves, updates, completes, then verifies a task in the target project", async () => {
    const api = new FakeTaskApi();
    const desired = desiredTask(2);
    const result = await new DidaTaskAdapter(api as unknown as DidaApi).update(
      "task-1",
      desired,
      { projectId: "project-old" },
    );

    expect(result).toMatchObject(desired);
    expect(api.calls).toEqual([
      "get:project-new",
      "get:project-old",
      "move",
      "get:project-new",
      "update",
      "get:project-new",
      "complete",
      "get:project-new",
    ]);
  });

  it("recovers lost move and complete responses by checking remote facts", async () => {
    const api = new FakeTaskApi();
    api.failMoveAfterApply = true;
    api.failCompleteAfterApply = true;
    const result = await new DidaTaskAdapter(api as unknown as DidaApi).update(
      "task-1",
      desiredTask(2),
      { projectId: "project-old" },
    );
    expect(result).toMatchObject({ projectId: "project-new", status: 2 });
    expect(api.calls.filter((call) => call === "move")).toHaveLength(1);
    expect(api.calls.filter((call) => call === "complete")).toHaveLength(1);
  });

  it("skips already applied non-idempotent steps during a safe replay", async () => {
    const api = new FakeTaskApi();
    api.location = "project-new";
    api.task = desiredTask(2);
    await new DidaTaskAdapter(api as unknown as DidaApi).update(
      "task-1",
      desiredTask(2),
      { projectId: "project-old" },
    );
    expect(api.calls).not.toContain("move");
    expect(api.calls).not.toContain("complete");
    expect(api.calls).toContain("update");
  });

  it("sends explicit clear values for fields removed by a manual merge", async () => {
    const api = new FakeTaskApi();
    const desired = desiredTask(0);
    Object.defineProperty(desired, "dueDate", {
      value: undefined,
      enumerable: true,
      writable: true,
    });
    await new DidaTaskAdapter(api as unknown as DidaApi).update(
      "task-1",
      desired,
      { projectId: "project-old" },
    );
    expect(api.lastUpdate?.dueDate).toBeNull();
  });

  it("never writes back an unsafe remote sort order during an ordinary task edit", async () => {
    const api = new FakeTaskApi();
    api.task = { ...api.task, sortOrderUnsafe: true };
    const desired = { ...api.task, title: "Edited", sortOrderUnsafe: true };
    await new DidaTaskAdapter(api as unknown as DidaApi).update(
      desired.id,
      desired,
      { projectId: desired.projectId },
    );
    expect(api.lastUpdate?.sortOrder).toBeUndefined();
  });

  it("keeps reminder and repeat fields out of ordinary task updates", async () => {
    const api = new FakeTaskApi();
    const desired = {
      ...desiredTask(0),
      reminders: [" TRIGGER:CUSTOM "],
      repeatFlag: " ERULE:CUSTOM ",
    };
    await new DidaTaskAdapter(api as unknown as DidaApi).update(
      desired.id,
      desired,
      { projectId: "project-old" },
    );
    expect(api.lastUpdate).not.toHaveProperty("reminders");
    expect(api.lastUpdate).not.toHaveProperty("repeatFlag");
  });

  it("keeps reminder and repeat fields out of ordinary task creation", async () => {
    const api = new FakeTaskApi();
    await new DidaTaskAdapter(api as unknown as DidaApi).create({
      id: "local-task",
      projectId: "project-old",
      title: "新任务",
      status: 0,
      reminders: ["TRIGGER:PT0S"],
      repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
    });
    expect(api.lastCreate).not.toHaveProperty("reminders");
    expect(api.lastCreate).not.toHaveProperty("repeatFlag");
  });

  it("serializes task dates in the documented Dida write format", async () => {
    const api = new FakeTaskApi();
    const desired = desiredTask(0);
    desired.startDate = "2026-08-01T14:37:34.230Z";
    desired.dueDate = "2026-08-01T15:37:34.230Z";
    desired.timeZone = "Asia/Shanghai";

    const result = await new DidaTaskAdapter(api as unknown as DidaApi).update(
      "task-1",
      desired,
      { projectId: "project-old" },
    );

    expect(api.lastUpdate).toMatchObject({
      startDate: "2026-08-01T14:37:34+0000",
      dueDate: "2026-08-01T15:37:34+0000",
      timeZone: "Asia/Shanghai",
    });
    expect(result).toMatchObject({
      startDate: "2026-08-01T14:37:34.000Z",
      dueDate: "2026-08-01T15:37:34.000Z",
    });
  });

  it("blocks a changed duration in point mode before the update request", async () => {
    const api = new FakeTaskApi();
    const desired = desiredTask(0);
    desired.startDate = "2026-08-01T14:00:00Z";
    desired.dueDate = "2026-08-01T15:00:00Z";
    const adapter = new DidaTaskAdapter(api as unknown as DidaApi, () => "point");

    await expect(adapter.update("task-1", desired, { projectId: "project-old" }))
      .rejects.toThrow(/仅支持单点任务时间/);
    expect(api.calls).not.toContain("move");
    expect(api.calls).not.toContain("update");
  });

  it("allows an unrelated update when a remote duration is unchanged", async () => {
    const api = new FakeTaskApi();
    api.location = "project-new";
    api.task = {
      ...desiredTask(0),
      title: "旧标题",
      startDate: "2026-08-01T14:00:00Z",
      dueDate: "2026-08-01T15:00:00Z",
    };
    const desired = { ...api.task, title: "新标题" };
    const adapter = new DidaTaskAdapter(api as unknown as DidaApi, () => "point");

    await expect(adapter.update("task-1", desired, { projectId: "project-new" }))
      .resolves.toMatchObject({ title: "新标题" });
    expect(api.calls).toContain("update");
  });
});

describe("DidaProjectAdapter", () => {
  it("never writes back an unsafe remote project sort order with view-mode changes", async () => {
    let lastUpdate: Record<string, unknown> | undefined;
    const api = {
      async updateProject(_id: string, value: Record<string, unknown>) {
        lastUpdate = structuredClone(value);
        return { id: "project-1", name: "Board", viewMode: value.viewMode };
      },
    } as unknown as DidaApi;
    await new DidaProjectAdapter(api).update("project-1", {
      id: "project-1",
      name: "Board",
      viewMode: "kanban",
      sortOrderUnsafe: true,
    });
    expect(lastUpdate).toMatchObject({ viewMode: "kanban", sortOrder: undefined });
  });
});
