import { describe, expect, it } from "vitest";
import type { DidaTask } from "../src/domain/entities";
import { HelixService } from "../src/services/helix-service";
import { HelixDataStore, type PluginDataPort } from "../src/storage/data-store";
import { createDefaultData, hydrateData } from "../src/storage/model";
import type { HelixSecretStore } from "../src/storage/secrets";
import { createSnapshot } from "../src/sync/snapshots";
import type { SyncQueueOperation } from "../src/sync/types";
import { buildConflictFields } from "../src/sync/three-way-merge";
import { deterministicEventId, type HelixEvent } from "../src/domain/events";
import { rotatingChallenges } from "../src/domain/gamification";

describe("HelixService runtime recovery", () => {
  it("restores the verified schedule mode and clears it when authorization changes", async () => {
    const data = createDefaultData("device-a");
    data.didaContractCapabilities = {
      probeVersion: 2,
      taskScheduleMode: "point",
      verifiedAt: "2026-07-31T00:00:00.000Z",
    };
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      {
        getDidaToken: () => "token",
        clearDidaToken: () => undefined,
      } as unknown as HelixSecretStore,
    );

    await service.initialize();
    expect(service.snapshot().taskScheduleMode).toBe("point");

    await service.clearDidaToken();
    expect(service.snapshot().taskScheduleMode).toBe("unknown");
    expect(persisted.didaContractCapabilities).toBeUndefined();
  });

  it("rejects a new duration before queueing when the account is in point mode", async () => {
    const data = createDefaultData("device-a");
    const baseTask: DidaTask = {
      id: "task-schedule",
      projectId: "project-1",
      title: "Task",
      status: 0,
    };
    data.baseSnapshots["task:task-schedule"] = createSnapshot("task", baseTask.id, baseTask);
    data.localSnapshots["task:task-schedule"] = createSnapshot("task", baseTask.id, baseTask);
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    (service as unknown as { state: { taskScheduleMode: string } }).state.taskScheduleMode = "point";

    await expect(service.queueTaskUpdate({
      ...baseTask,
      startDate: "2026-08-01T14:00:00Z",
      dueDate: "2026-08-01T15:00:00Z",
    })).rejects.toThrow(/仅支持单点任务时间/);
    expect(persisted.queue).toEqual([]);
  });

  it("migrates both persisted and live in-progress state when confirming an unknown create", async () => {
    const data = createDefaultData("device-a");
    const local: DidaTask = {
      id: "local-1",
      projectId: "project-old",
      title: "Task",
      content: "",
      desc: "",
      status: 0,
    };
    const operation: SyncQueueOperation<DidaTask> = {
      id: "op-1",
      kind: "task",
      entityId: local.id,
      projectId: local.projectId,
      operation: "create",
      createdAt: "2026-07-30T00:00:00Z",
      updatedAt: "2026-07-30T00:00:00Z",
      attempts: 1,
      status: "reconciliation",
      remoteOutcomeUnknown: true,
      local: createSnapshot("task", local.id, local),
    };
    data.localSnapshots["task:local-1"] = operation.local;
    data.queue = [operation];
    data.inProgress = [{
      taskId: "local-1",
      projectId: "project-old",
      markedAt: "2026-07-30T00:00:00Z",
      lastTouchedAt: "2026-07-30T00:00:00Z",
      activeFocus: false,
    }];
    let persisted = structuredClone(data);
    let saveCount = 0;
    const port: PluginDataPort = {
      async loadData() {
        return structuredClone(persisted);
      },
      async saveData(value) {
        saveCount += 1;
        persisted = structuredClone(value) as typeof persisted;
      },
    };
    const service = new HelixService(
      new HelixDataStore(port),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    Object.defineProperty(service, "api", {
      value: {
        async getTask(): Promise<DidaTask> {
          return { ...local, id: "remote-1" };
        },
      },
    });
    service.sync = async () => undefined;
    saveCount = 0;
    await service.resolveUnknownCreate("op-1", "confirmed", "remote-1");
    expect(saveCount).toBe(1);
    expect(service.snapshot().inProgress).toMatchObject([
      { taskId: "remote-1", projectId: "project-old" },
    ]);
    expect(persisted.inProgress).toMatchObject([
      { taskId: "remote-1", projectId: "project-old" },
    ]);
  });

  it("keeps a connection probe read-only even when a pending write exists", async () => {
    const data = createDefaultData("device-a");
    const local: DidaTask = {
      id: "task-1",
      projectId: "project-1",
      title: "Pending",
      status: 0,
    };
    data.queue = [{
      id: "op-pending",
      kind: "task",
      entityId: local.id,
      projectId: local.projectId,
      operation: "update",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      attempts: 0,
      status: "pending",
      base: createSnapshot("task", local.id, local),
      local: createSnapshot("task", local.id, { ...local, title: "Edited" }),
    }];
    let persisted = structuredClone(data);
    const store = new HelixDataStore({
      async loadData() {
        return structuredClone(persisted);
      },
      async saveData(value) {
        persisted = structuredClone(value) as typeof persisted;
      },
    });
    const service = new HelixService(
      store,
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    Object.defineProperty(service, "api", {
      value: {
        async probeCapabilities() {
          return {
            projects: "available",
            tasks: "available",
            habits: "unavailable",
            focus: "unavailable",
            checkedAt: "2026-07-30T00:00:00.000Z",
            errors: [],
          };
        },
      },
    });

    await service.probeConnection();

    expect(persisted.queue).toHaveLength(1);
    expect(persisted.queue[0]?.status).toBe("pending");
  });

  it("re-reads and verifies the exact remote task identity before reference rebinding", async () => {
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return createDefaultData("device-a");
        },
        async saveData() {},
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    let returnedProjectId = "project-1";
    Object.defineProperty(service, "api", {
      value: {
        async getTask(projectId: string, taskId: string): Promise<DidaTask> {
          expect(projectId).toBe("project-1");
          expect(taskId).toBe("task-1");
          return {
            id: "task-1",
            projectId: returnedProjectId,
            title: "Verified",
            status: 0,
          };
        },
      },
    });

    await expect(service.verifyRemoteTask("project-1", "task-1"))
      .resolves.toMatchObject({ id: "task-1", projectId: "project-1" });
    returnedProjectId = "project-other";
    await expect(service.verifyRemoteTask("project-1", "task-1"))
      .rejects.toThrow(/身份或清单/);
  });

  it("migrates an in-progress marker after an ordinary queued create succeeds", async () => {
    const data = createDefaultData("device-a");
    const local: DidaTask = {
      id: "local-ordinary",
      projectId: "project-1",
      title: "Create",
      status: 0,
    };
    data.queue = [{
      id: "op-create",
      kind: "task",
      entityId: local.id,
      projectId: local.projectId,
      operation: "create",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      attempts: 0,
      status: "pending",
      local: createSnapshot("task", local.id, local),
    }];
    data.inProgress = [{
      taskId: local.id,
      projectId: local.projectId,
      markedAt: "2026-07-30T00:00:00.000Z",
      lastTouchedAt: "2026-07-30T00:00:00.000Z",
      activeFocus: false,
    }];
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    const remote = { ...local, id: "remote-ordinary" };
    Object.defineProperty(service, "taskEngine", {
      value: {
        async process() {
          return {
            outcome: "pushed",
            snapshot: createSnapshot("task", remote.id, remote),
          };
        },
      },
    });

    await (service as unknown as { drainQueue(): Promise<void> }).drainQueue();

    expect(persisted.queue).toEqual([]);
    expect(persisted.inProgress).toMatchObject([
      { taskId: "remote-ordinary", projectId: "project-1" },
    ]);
    expect(service.snapshot().inProgress).toMatchObject([
      { taskId: "remote-ordinary", projectId: "project-1" },
    ]);
  });

  it("runs concurrent applications of the same conflict only once", async () => {
    const data = createDefaultData("device-a");
    const baseTask: DidaTask = {
      id: "task-1",
      projectId: "project-1",
      title: "Base",
      status: 0,
    };
    const base = createSnapshot("task", "task-1", baseTask);
    const localConflict = createSnapshot("task", "task-1", {
      ...baseTask,
      title: "Local",
    });
    data.conflicts = [{
      id: "conflict-1",
      kind: "task",
      entityId: "task-1",
      title: "Task",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      status: "staged",
      base,
      local: localConflict,
      remote: base,
      fields: buildConflictFields(base.value, localConflict.value, base.value)
        .map((field) => ({ ...field, choice: "local" as const })),
      remoteRecheckCount: 0,
      sourceDeviceId: "device-a",
    }];
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    let applications = 0;
    const resolvedTask = { ...baseTask, title: "Local" };
    Object.defineProperty(service, "taskEngine", {
      value: {
        async applyConflict() {
          applications += 1;
          await Promise.resolve();
          return {
            outcome: "resolved",
            snapshot: createSnapshot("task", "task-1", resolvedTask),
            audit: {
              id: "audit-1",
              conflictId: "conflict-1",
              entityId: "task-1",
              kind: "task",
              resolvedAt: "2026-07-30T01:00:00.000Z",
              sourceDeviceId: "device-a",
              choices: {},
              remoteBeforeHash: "before",
              remoteAfterHash: "after",
            },
          };
        },
      },
    });
    service.sync = async () => undefined;

    const first = service.applyConflict("conflict-1");
    const second = service.applyConflict("conflict-1");
    expect(first).toBe(second);
    await Promise.all([first, second]);

    expect(applications).toBe(1);
    expect(persisted.conflicts).toEqual([]);
  });

  it("keeps the in-progress project current after a task move", async () => {
    const data = createDefaultData("device-a");
    const task: DidaTask = {
      id: "task-move",
      projectId: "project-old",
      title: "Move",
      status: 0,
    };
    const snapshot = createSnapshot("task", task.id, task);
    data.baseSnapshots[`task:${task.id}`] = snapshot;
    data.localSnapshots[`task:${task.id}`] = snapshot;
    data.inProgress = [{
      taskId: task.id,
      projectId: task.projectId,
      markedAt: "2026-07-30T00:00:00.000Z",
      lastTouchedAt: "2026-07-30T00:00:00.000Z",
      activeFocus: false,
    }];
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    Object.defineProperty(service, "taskEngine", {
      value: {
        async process(operation: SyncQueueOperation<DidaTask>) {
          return { outcome: "pushed", snapshot: operation.local };
        },
      },
    });

    await service.queueTaskUpdate({ ...task, projectId: "project-new" });

    expect(persisted.inProgress[0]?.projectId).toBe("project-new");
    expect(service.snapshot().inProgress[0]?.projectId).toBe("project-new");
    expect(service.visibleInProgress(false)[0]?.project).toBeUndefined();
  });

  it("records a verified completion immediately after the queue write succeeds", async () => {
    const data = createDefaultData("device-a");
    const task: DidaTask = {
      id: "task-complete",
      projectId: "project-1",
      title: "Complete",
      status: 0,
      priority: 3,
    };
    const base = createSnapshot("task", task.id, task);
    data.baseSnapshots[`task:${task.id}`] = base;
    data.localSnapshots[`task:${task.id}`] = base;
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    Object.defineProperty(service, "taskEngine", {
      value: {
        async process(operation: SyncQueueOperation<DidaTask>) {
          return { outcome: "pushed", snapshot: operation.local };
        },
      },
    });

    await service.completeTask(task.id);

    expect(persisted.events).toMatchObject([
      {
        type: "task-completed",
        entityId: task.id,
        projectId: task.projectId,
        difficulty: 3,
      },
    ]);
    expect(service.snapshot().events).toHaveLength(1);
  });

  it("locks field choices while applying and supports explicit verified recovery", async () => {
    const data = createDefaultData("device-a");
    const task: DidaTask = {
      id: "task-applying",
      projectId: "project-1",
      title: "Base",
      status: 0,
    };
    const base = createSnapshot("task", task.id, task);
    const local = createSnapshot("task", task.id, { ...task, title: "Local" });
    data.conflicts = [{
      id: "conflict-applying",
      kind: "task",
      entityId: task.id,
      title: task.title,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      status: "applying",
      base,
      local,
      remote: base,
      fields: buildConflictFields(base.value, local.value, base.value)
        .map((field) => ({ ...field, choice: "local" as const })),
      remoteRecheckCount: 0,
      sourceDeviceId: "device-a",
    }];
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();

    await expect(
      service.chooseConflict("conflict-applying", "title", "remote"),
    ).rejects.toThrow(/不可修改字段选择/);
    await service.releaseApplyingConflict("conflict-applying");
    expect(persisted.conflicts[0]?.status).toBe("staged");
  });

  it("changes only the schedule field explicitly selected by the user", async () => {
    const data = createDefaultData("device-a");
    const baseTask: DidaTask = {
      id: "task-schedule-conflict",
      projectId: "project-1",
      title: "Schedule",
      status: 0,
      startDate: "2026-08-01T10:00:00Z",
      dueDate: "2026-08-01T11:00:00Z",
      timeZone: "UTC",
      isAllDay: false,
    };
    const localTask: DidaTask = {
      ...baseTask,
      startDate: "2026-08-01T12:00:00Z",
      dueDate: "2026-08-01T13:00:00Z",
      timeZone: "Asia/Shanghai",
      isAllDay: true,
    };
    const remoteTask: DidaTask = {
      ...baseTask,
      startDate: "2026-08-01T14:00:00Z",
      dueDate: "2026-08-01T15:00:00Z",
      timeZone: "Asia/Tokyo",
    };
    const base = createSnapshot("task", baseTask.id, baseTask);
    const local = createSnapshot("task", baseTask.id, localTask);
    const remote = createSnapshot("task", baseTask.id, remoteTask);
    data.conflicts = [{
      id: "conflict-schedule-fields",
      kind: "task",
      entityId: baseTask.id,
      title: baseTask.title,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      status: "open",
      base,
      local,
      remote,
      fields: buildConflictFields(base.value, local.value, remote.value),
      remoteRecheckCount: 0,
      sourceDeviceId: "device-a",
    }];
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();

    await service.chooseConflict("conflict-schedule-fields", "dueDate", "local");

    const fields = persisted.conflicts[0]?.fields ?? [];
    expect(fields.find((field) => field.path === "dueDate")?.choice).toBe("local");
    for (const path of ["startDate", "timeZone", "isAllDay"]) {
      expect(fields.find((field) => field.path === path)?.choice).toBeUndefined();
    }
  });

  it("blocks remote and local writes before network access in recovery mode", async () => {
    const data = createDefaultData("device-a");
    data.recoveryIssues = ["snapshot damaged"];
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(data);
        },
        async saveData() {
          throw new Error("recovery mode must not save");
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    let probes = 0;
    Object.defineProperty(service, "api", {
      value: {
        async probeCapabilities() {
          probes += 1;
          throw new Error("must not reach network");
        },
      },
    });

    await expect(service.sync()).rejects.toThrow(/只读恢复模式/);
    expect(probes).toBe(0);
  });

  it("finalizes an explicitly chosen deletion without persisting null caches", async () => {
    const data = createDefaultData("device-a");
    const task: DidaTask = {
      id: "task-delete",
      projectId: "project-1",
      title: "Delete",
      status: 0,
    };
    const base = createSnapshot("task", task.id, task);
    const tombstone = createSnapshot("task", task.id, null as unknown as DidaTask);
    const fields = buildConflictFields(base.value, tombstone.value, base.value)
      .map((field) => ({ ...field, choice: "local" as const }));
    data.baseSnapshots[`task:${task.id}`] = base;
    data.localSnapshots[`task:${task.id}`] = base;
    data.conflicts = [{
      id: "conflict-delete",
      kind: "task",
      entityId: task.id,
      title: task.title,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      status: "staged",
      base,
      local: tombstone,
      remote: base,
      fields,
      remoteRecheckCount: 0,
      sourceDeviceId: "device-a",
    }];
    data.queue = [{
      id: "op-delete",
      kind: "task",
      entityId: task.id,
      projectId: task.projectId,
      operation: "delete",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      attempts: 0,
      status: "blocked",
      conflictId: "conflict-delete",
      base,
      local: base,
    }];
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    Object.defineProperty(service, "taskEngine", {
      value: {
        async applyConflict() {
          return {
            outcome: "resolved",
            snapshot: tombstone,
            audit: {
              id: "audit-delete",
              conflictId: "conflict-delete",
              entityId: task.id,
              kind: "task",
              resolvedAt: "2026-07-30T01:00:00.000Z",
              sourceDeviceId: "device-a",
              choices: { "$": { choice: "local", valueHash: tombstone.stamp.hash } },
              remoteBeforeHash: base.stamp.hash,
              remoteAfterHash: tombstone.stamp.hash,
            },
          };
        },
      },
    });
    service.sync = async () => undefined;

    await service.applyConflict("conflict-delete");

    expect(persisted.baseSnapshots[`task:${task.id}`]).toBeUndefined();
    expect(persisted.localSnapshots[`task:${task.id}`]).toBeUndefined();
    expect(persisted.conflicts).toEqual([]);
    expect(persisted.queue).toEqual([]);
    expect(hydrateData(persisted).recoveryIssues).toEqual([]);
  });

  it("verifies and adopts an already-applied remote conflict result", async () => {
    const data = createDefaultData("device-a");
    const task: DidaTask = {
      id: "task-adopt",
      projectId: "project-1",
      title: "Base",
      status: 0,
    };
    const base = createSnapshot("task", task.id, task);
    const remote = createSnapshot("task", task.id, { ...task, title: "Local" });
    data.conflicts = [{
      id: "conflict-adopt",
      kind: "task",
      entityId: task.id,
      title: task.title,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      status: "applying",
      base,
      local: remote,
      remote: base,
      fields: buildConflictFields(base.value, remote.value, base.value)
        .map((field) => ({ ...field, choice: "local" as const })),
      remoteRecheckCount: 0,
      sourceDeviceId: "device-a",
    }];
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    Object.defineProperty(service, "taskEngine", {
      value: {
        async verifyAppliedConflict() {
          return {
            outcome: "resolved",
            snapshot: remote,
            audit: {
              id: "audit-adopt",
              conflictId: "conflict-adopt",
              entityId: task.id,
              kind: "task",
              resolvedAt: "2026-07-30T01:00:00.000Z",
              sourceDeviceId: "device-a",
              choices: { title: { choice: "local", valueHash: remote.stamp.hash } },
              remoteBeforeHash: base.stamp.hash,
              remoteAfterHash: remote.stamp.hash,
            },
          };
        },
      },
    });
    service.sync = async () => undefined;

    await service.adoptAppliedConflict("conflict-adopt");

    expect(persisted.conflicts).toEqual([]);
    expect(persisted.localSnapshots[`task:${task.id}`]?.value).toMatchObject({
      title: "Local",
    });
  });

  it("awards review challenges immediately through the shared local event path", async () => {
    let date = new Date("2026-07-01T12:00:00.000Z");
    let challenge = rotatingChallenges(date).find((candidate) => candidate.metric === "reviews");
    while (!challenge) {
      date = new Date(date.getTime() + 7 * 86_400_000);
      challenge = rotatingChallenges(date).find((candidate) => candidate.metric === "reviews");
    }
    const data = createDefaultData("device-a");
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    const events: HelixEvent[] = Array.from({ length: challenge.target }, (_, index) => {
      const occurredAt = new Date(
        new Date(challenge.startsAt).getTime() + (index + 1) * 1_000,
      ).toISOString();
      const event: HelixEvent = {
        id: "",
        type: "review-closed",
        entityId: `review-${index}`,
        occurrenceKey: `review-${index}`,
        occurredAt,
      };
      event.id = deterministicEventId(event);
      return event;
    });

    await service.appendLocalEvents(events);

    expect(service.snapshot().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "challenge-completed",
        entityId: challenge.id,
      }),
    ]));
  });

  it("does not finalize an in-flight queue result after service disposal", async () => {
    const data = createDefaultData("device-a");
    const task: DidaTask = {
      id: "task-dispose",
      projectId: "project-1",
      title: "Dispose",
      status: 0,
    };
    const snapshot = createSnapshot("task", task.id, task);
    data.queue = [{
      id: "op-dispose",
      kind: "task",
      entityId: task.id,
      projectId: task.projectId,
      operation: "update",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      attempts: 0,
      status: "pending",
      base: snapshot,
      local: snapshot,
    }];
    let persisted = structuredClone(data);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(persisted);
        },
        async saveData(value) {
          persisted = structuredClone(value) as typeof persisted;
        },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    Object.defineProperty(service, "taskEngine", {
      value: {
        async process() {
          started();
          await gate;
          return { outcome: "pushed", snapshot };
        },
      },
    });

    const drain = (service as unknown as { drainQueue(): Promise<void> }).drainQueue();
    await didStart;
    service.dispose();
    finish();
    await drain;

    expect(persisted.queue).toMatchObject([{ id: "op-dispose", status: "running" }]);
  });
});
