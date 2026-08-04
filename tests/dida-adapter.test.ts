import { describe, expect, it } from "vitest";
import type { DidaTask } from "../src/domain/entities";
import { taskEditWriteFields } from "../src/domain/task-edit-fields";
import {
  DidaProjectAdapter,
  DidaTaskAdapter,
  sameTaskBoardPlacementInvariant,
  taskBoardPlacementPayload,
  taskCreatePayload,
  taskUpdatePayload,
  taskSyncProjection,
} from "../src/integrations/dida/adapters";
import type { DidaApi, DidaTaskUpdateWirePayload } from "../src/integrations/dida/api";
import { DidaHttpError } from "../src/integrations/dida/http-contract";
import {
  buildTaskUpdateOperation,
  migrateInProgressTaskId,
} from "../src/services/task-operations";
import { createSnapshot } from "../src/sync/snapshots";
import {
  applyResolutions,
  buildConflictFields,
  setFieldResolution,
} from "../src/sync/three-way-merge";
import type { SyncConflict } from "../src/sync/types";

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
  lastUpdate: DidaTaskUpdateWirePayload | null = null;
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

  async updateTask(_id: string, value: DidaTaskUpdateWirePayload): Promise<DidaTask> {
    this.calls.push("update");
    this.lastUpdate = structuredClone(value);
    this.task = {
      ...this.task,
      ...value,
      reminders: value.reminders === null ? [] : (value.reminders ?? this.task.reminders),
      projectId: this.location,
    };
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

function verifiedTaskAdapter(
  api: FakeTaskApi,
  scheduleMode: () => "point" | "duration" = () => "duration",
): DidaTaskAdapter {
  return new DidaTaskAdapter(api as unknown as DidaApi, scheduleMode, () => ({
    taskCrudVerified: true,
    reminderWriteVerified: true,
    repeatWriteVerified: true,
    parentTaskVerified: true,
  }));
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
  it("does not select an untouched whitespace title, but selects a deliberate title edit", () => {
    const before = { title: "  保留原样  " };
    expect(taskEditWriteFields(before, { title: "  保留原样  " }, {
      reminders: false,
      repeatFlag: false,
    })).not.toContain("title");
    expect(taskEditWriteFields(before, { title: "保留原样" }, {
      reminders: false,
      repeatFlag: false,
    })).toContain("title");
  });

  it("does not infer a time-zone write when a missing remote time zone is only displayed locally", () => {
    const uiTimeZone = "Asia/Shanghai";
    const fields = taskEditWriteFields({
      title: "任务",
      timeZone: uiTimeZone,
      priority: 0,
    }, {
      title: "任务",
      timeZone: uiTimeZone,
      priority: 1,
    }, { reminders: false, repeatFlag: false });
    expect(fields).toEqual(["priority"]);
  });

  it("blocks unverified create update and delete before any API call", async () => {
    const api = new FakeTaskApi();
    const adapter = new DidaTaskAdapter(api as unknown as DidaApi);

    await expect(adapter.create(desiredTask(0))).rejects.toThrow(/基础写入合同/);
    await expect(adapter.update("task-1", desiredTask(0), { projectId: "project-old" }))
      .rejects.toThrow(/基础写入合同/);
    await expect(adapter.delete("task-1", { projectId: "project-old" }))
      .rejects.toThrow(/基础写入合同/);
    expect(api.calls).toEqual([]);
  });
  it("adds columnId only to the dedicated board placement payload", () => {
    const payload = taskBoardPlacementPayload({
      id: "task-1",
      projectId: "project-1",
      title: "Board task",
      status: 0,
      content: "keep",
      columnName: "待办",
      reminders: ["TRIGGER:PT0S"],
      repeatFlag: "RRULE:FREQ=DAILY",
    }, "doing");
    expect(payload).toEqual({
      id: "task-1",
      projectId: "project-1",
      columnId: "doing",
    });
    expect(payload).not.toHaveProperty("columnName");
  });
  it("ignores server-managed etimestamp while verifying board placement", () => {
    const before: DidaTask = {
      id: "task-1",
      projectId: "project-1",
      title: "Board task",
      status: 0,
      columnId: "todo",
      columnName: "待办",
      etimestamp: 10,
    };
    expect(sameTaskBoardPlacementInvariant(before, {
      ...before,
      columnId: "doing",
      columnName: "进行中",
      etimestamp: 11,
    })).toBe(true);
  });
  it("does not include the server-derived columnName in normal create or update payloads", () => {
    const value = { ...desiredTask(0), columnName: "待办" };
    expect(taskCreatePayload(value)).not.toHaveProperty("columnName");
    expect(taskUpdatePayload(value)).not.toHaveProperty("columnName");
  });
  it("keeps server-derived board placement names out of writable task snapshots", async () => {
    const api = new FakeTaskApi();
    api.task = { ...api.task, columnId: "todo", columnName: "待办" };
    await expect(verifiedTaskAdapter(api).get(
      api.task.id,
      { projectId: api.task.projectId },
    )).resolves.not.toHaveProperty("columnName");
  });
  it("keeps server metadata out of writable task snapshots", () => {
    expect(taskSyncProjection({
      ...desiredTask(0),
      etag: "etag-1",
      modifiedTime: "2026-08-03T00:00:00.000Z",
      etimestamp: 11,
    })).not.toHaveProperty("etimestamp");
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
    await verifiedTaskAdapter(api).update(
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
    const result = await verifiedTaskAdapter(api).update(
      "task-1",
      desired,
      { projectId: "project-old", writeFields: ["title"] },
    );

    expect(result).toMatchObject({ id: desired.id, projectId: desired.projectId, status: desired.status });
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

  it("moves without an empty update payload when no business field is selected", async () => {
    const api = new FakeTaskApi();
    const desired = desiredTask(0);
    const result = await verifiedTaskAdapter(api).update(
      "task-1",
      desired,
      { projectId: "project-old", writeFields: [] },
    );

    expect(result).toMatchObject({ id: desired.id, projectId: desired.projectId, status: desired.status });
    expect(api.calls).toContain("move");
    expect(api.calls).not.toContain("update");
    expect(api.calls.filter((call) => call === "get:project-new")).toHaveLength(3);
  });

  it("recovers lost move and complete responses by checking remote facts", async () => {
    const api = new FakeTaskApi();
    api.failMoveAfterApply = true;
    api.failCompleteAfterApply = true;
    const result = await verifiedTaskAdapter(api).update(
      "task-1",
      desiredTask(2),
      { projectId: "project-old", writeFields: ["dueDate"] },
    );
    expect(result).toMatchObject({ projectId: "project-new", status: 2 });
    expect(api.calls.filter((call) => call === "move")).toHaveLength(1);
    expect(api.calls.filter((call) => call === "complete")).toHaveLength(1);
  });

  it("skips already applied non-idempotent steps during a safe replay", async () => {
    const api = new FakeTaskApi();
    api.location = "project-new";
    api.task = desiredTask(2);
    await verifiedTaskAdapter(api).update(
      "task-1",
      desiredTask(2),
      { projectId: "project-old", writeFields: ["title"] },
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
    await verifiedTaskAdapter(api).update(
      "task-1",
      desired,
      { projectId: "project-old", writeFields: ["startDate", "dueDate", "timeZone"] },
    );
    expect(api.lastUpdate?.dueDate).toBeNull();
  });

  it("never writes back an unsafe remote sort order during an ordinary task edit", async () => {
    const api = new FakeTaskApi();
    api.task = { ...api.task, sortOrderUnsafe: true };
    const desired = { ...api.task, title: "Edited", sortOrderUnsafe: true };
    await verifiedTaskAdapter(api).update(
      desired.id,
      desired,
      { projectId: desired.projectId, writeFields: ["title"] },
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
    await verifiedTaskAdapter(api).update(
      desired.id,
      desired,
      { projectId: "project-old", writeFields: ["title"] },
    );
    expect(api.lastUpdate).not.toHaveProperty("reminders");
    expect(api.lastUpdate).not.toHaveProperty("repeatFlag");
  });

  it("keeps reminder and repeat fields out of ordinary task creation", async () => {
    const api = new FakeTaskApi();
    await new DidaTaskAdapter(
      api as unknown as DidaApi,
      () => "duration",
      () => ({ taskCrudVerified: true }),
    ).create({
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

  it("writes only explicitly changed verified reminder repeat and parent fields", async () => {
    const api = new FakeTaskApi();
    api.location = "project-old";
    api.task = {
      ...api.task,
      projectId: "project-old",
      reminders: ["TRIGGER:CUSTOM"],
      repeatFlag: "ERULE:CUSTOM",
      parentId: "parent-old",
    };
    const desired = {
      ...api.task,
      title: "Edited",
      reminders: ["TRIGGER:-PT10M"],
      repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
      parentId: null,
    };
    await new DidaTaskAdapter(
      api as unknown as DidaApi,
      () => "duration",
      () => ({
        taskCrudVerified: true,
        reminderWriteVerified: true,
        repeatWriteVerified: true,
        parentTaskVerified: true,
      }),
    ).update(desired.id, desired, {
      projectId: "project-old",
      writeFields: ["reminders", "repeatFlag", "parentId"],
    });

    expect(api.lastUpdate).toMatchObject({
      reminders: ["TRIGGER:-PT10M"],
      repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
      parentId: null,
    });
  });

  it("uses null only for an explicitly changed verified empty reminder list", async () => {
    const api = new FakeTaskApi();
    api.location = "project-old";
    api.task = {
      ...api.task,
      projectId: "project-old",
      reminders: ["TRIGGER:-PT10M"],
    };

    await new DidaTaskAdapter(
      api as unknown as DidaApi,
      () => "duration",
      () => ({ taskCrudVerified: true, reminderWriteVerified: true }),
    ).update(api.task.id, { ...api.task, reminders: [] }, {
      projectId: "project-old",
      writeFields: ["reminders"],
    });

    expect(api.lastUpdate).toHaveProperty("reminders", null);

    api.lastUpdate = null;
    await verifiedTaskAdapter(api).update(api.task.id, {
      ...api.task,
      title: "No reminder intent",
      reminders: [],
    }, { projectId: "project-old", writeFields: [] });
    expect(api.lastUpdate).toBeNull();
  });

  it("omits an explicitly requested reminder update until the reminder capability is verified", async () => {
    const api = new FakeTaskApi();
    api.location = "project-old";
    api.task = { ...api.task, projectId: "project-old", reminders: ["TRIGGER:OLD"] };

    await new DidaTaskAdapter(
      api as unknown as DidaApi,
      () => "duration",
      () => ({ taskCrudVerified: true, reminderWriteVerified: false }),
    ).update(api.task.id, { ...api.task, reminders: [] }, {
      projectId: "project-old", writeFields: ["reminders"],
    });

    expect(api.lastUpdate).not.toHaveProperty("reminders");
  });

  it("keeps an empty reminder array on verified creation payloads", () => {
    expect(taskCreatePayload({
      id: "local-task",
      projectId: "project-old",
      title: "Create with no reminder",
      status: 0,
      reminders: [],
    }, { reminderWriteVerified: true })).toHaveProperty("reminders", []);
  });

  it("sends a resolved local or custom empty reminder through the explicit write path", async () => {
    const base = { ...desiredTask(0), projectId: "project-old", reminders: ["TRIGGER:BASE"] };
    const local = { ...base, reminders: [] as string[] };
    const remote = { ...base, reminders: ["TRIGGER:REMOTE"] };
    let conflict: SyncConflict<DidaTask> = {
      id: "reminder-conflict",
      kind: "task" as const,
      entityId: base.id,
      title: base.title,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
      status: "open" as const,
      base: createSnapshot("task", base.id, base),
      local: createSnapshot("task", base.id, local),
      remote: createSnapshot("task", base.id, remote),
      fields: buildConflictFields(base, local, remote),
      remoteRecheckCount: 0,
      sourceDeviceId: "device-a",
    };
    expect(conflict.base.value.reminders).toEqual(["TRIGGER:BASE"]);
    expect(conflict.local.value.reminders).toEqual([]);
    expect(conflict.remote.value.reminders).toEqual(["TRIGGER:REMOTE"]);
    conflict = setFieldResolution(conflict, "reminders", "local") as SyncConflict<DidaTask>;
    const resolvedLocal = { ...remote, ...applyResolutions(conflict) };

    const api = new FakeTaskApi();
    api.location = "project-old";
    api.task = remote;
    await verifiedTaskAdapter(api).update(base.id, resolvedLocal, {
      projectId: "project-old",
      writeFields: ["reminders"],
    });
    expect(api.lastUpdate).toHaveProperty("reminders", null);

    conflict = setFieldResolution(conflict, "reminders", "custom", []) as SyncConflict<DidaTask>;
    const resolvedCustom = { ...remote, ...applyResolutions(conflict) };
    await verifiedTaskAdapter(api).update(base.id, resolvedCustom, {
      projectId: "project-old",
      writeFields: ["reminders"],
    });
    expect(api.lastUpdate).toHaveProperty("reminders", null);
  });

  it("serializes a custom checklist-item resolution as exactly one root items payload", async () => {
    const base = {
      ...desiredTask(0), projectId: "project-old",
      items: [{ id: "item-1", title: "base", status: 0 }],
    };
    const local = {
      ...base,
      items: [{ id: "item-1", title: "local", status: 0 }],
    };
    const remote = {
      ...base,
      items: [{ id: "item-1", title: "remote", status: 0 }],
    };
    let conflict: SyncConflict<DidaTask> = {
      id: "items-custom-conflict",
      kind: "task",
      entityId: base.id,
      title: base.title,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      status: "open",
      base: createSnapshot("task", base.id, base),
      local: createSnapshot("task", base.id, local),
      remote: createSnapshot("task", base.id, remote),
      fields: buildConflictFields(base, local, remote),
      remoteRecheckCount: 0,
      sourceDeviceId: "device-a",
    };
    conflict = setFieldResolution(conflict, "items[item-1]", "custom", {
      id: "item-1", title: "merged", status: 2,
    }) as SyncConflict<DidaTask>;
    const api = new FakeTaskApi();
    api.location = "project-old";
    api.task = remote;
    await verifiedTaskAdapter(api).update(base.id, applyResolutions(conflict), {
      projectId: "project-old",
      writeFields: ["items"],
    });
    expect(api.lastUpdate).toMatchObject({
      id: base.id,
      projectId: "project-old",
      items: [{ id: "item-1", title: "merged", status: 2 }],
    });
    expect(Object.keys(api.lastUpdate ?? {})).not.toContain("items[item-1]");
    expect(Object.keys(api.lastUpdate ?? {})).toEqual(["id", "projectId", "items"]);
  });

  it("preserves unknown reminder and repeat rules byte-for-byte without writing untouched fields", async () => {
    const api = new FakeTaskApi();
    api.location = "project-old";
    api.task = {
      ...api.task,
      projectId: "project-old",
      reminders: ["TRIGGER:CUSTOM"],
      repeatFlag: "ERULE:CUSTOM",
    };
    await new DidaTaskAdapter(
      api as unknown as DidaApi,
      () => "duration",
      () => ({
        taskCrudVerified: true,
        reminderWriteVerified: true,
        repeatWriteVerified: true,
      }),
    ).update(api.task.id, { ...api.task, title: "Only title changed" }, {
      projectId: "project-old", writeFields: ["title"],
    });

    expect(api.lastUpdate).not.toHaveProperty("reminders");
    expect(api.lastUpdate).not.toHaveProperty("repeatFlag");
  });

  it("does not overwrite a concurrently changed remote reminder without explicit intent", async () => {
    const api = new FakeTaskApi();
    api.location = "project-old";
    api.task = {
      ...api.task,
      projectId: "project-old",
      reminders: ["TRIGGER:-PT5M"],
    };
    const staleLocal = {
      ...api.task,
      title: "Only title changed",
      reminders: ["TRIGGER:CUSTOM-OLD"],
    };
    const result = await new DidaTaskAdapter(
      api as unknown as DidaApi,
      () => "duration",
      () => ({ taskCrudVerified: true, reminderWriteVerified: true }),
    ).update(api.task.id, staleLocal, { projectId: "project-old", writeFields: ["title"] });

    expect(api.lastUpdate).not.toHaveProperty("reminders");
    expect(result.reminders).toEqual(["TRIGGER:-PT5M"]);
  });

  it("serializes task dates in the documented Dida write format", async () => {
    const api = new FakeTaskApi();
    const desired = desiredTask(0);
    desired.startDate = "2026-08-01T14:37:34.230Z";
    desired.dueDate = "2026-08-01T15:37:34.230Z";
    desired.timeZone = "Asia/Shanghai";

    const result = await verifiedTaskAdapter(api).update(
      "task-1",
      desired,
      { projectId: "project-old", writeFields: ["startDate", "dueDate", "timeZone"] },
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
    const adapter = verifiedTaskAdapter(api, () => "point");

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
    const adapter = verifiedTaskAdapter(api, () => "point");

    await expect(adapter.update("task-1", desired, { projectId: "project-new", writeFields: ["title"] }))
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
