import { describe, expect, it, vi } from "vitest";
import type { DidaFocusRecord, DidaProject, DidaTask } from "../src/domain/entities";
import {
  HelixService,
  projectProjectionGlobalCapabilitiesReady,
} from "../src/services/helix-service";
import { HelixDataStore, type PluginDataPort } from "../src/storage/data-store";
import { createDefaultData, hydrateData } from "../src/storage/model";
import type { DidaRequestEmergencyLatch, HelixSecretStore } from "../src/storage/secrets";
import { createSnapshot } from "../src/sync/snapshots";
import type { SyncQueueOperation } from "../src/sync/types";
import { buildConflictFields } from "../src/sync/three-way-merge";
import { deterministicEventId, type HelixEvent } from "../src/domain/events";
import { rotatingChallenges } from "../src/domain/gamification";
import { stableHash } from "../src/domain/stable";
import { taskSyncProjection } from "../src/integrations/dida/adapters";
import { normalizeTask } from "../src/integrations/dida/normalization";
import { DIDA_CONTRACT_PROBE_VERSION } from "../src/domain/task-schedule";

function grantTaskCrud(
  data: ReturnType<typeof createDefaultData>,
  taskScheduleMode: "point" | "duration" = "duration",
): void {
  data.didaContractCapabilities = {
    probeVersion: DIDA_CONTRACT_PROBE_VERSION,
    authorizationBinding: didaAuthorizationBinding("token"),
    taskScheduleMode,
    boardPlacementVerified: true,
    columnCreateVerified: true,
    taskCrudVerified: true,
    reminderWriteVerified: true,
    repeatWriteVerified: true,
    itemsRoundTripVerified: true, itemIdStableVerified: true,
    taskReopenVerified: true,
    verifiedAt: "2026-08-03T00:00:00.000Z",
  };
}

it("keeps ordinary project writes globally ready when only task reopen is unverified", () => {
  const state = {
    connected: true,
    authorizationConfigured: true,
    taskCrudVerified: true,
    itemsRoundTripVerified: true, itemIdStableVerified: true,
    boardPlacementVerified: true,
    taskReopenVerified: false,
  };
  expect(projectProjectionGlobalCapabilitiesReady(state)).toBe(true);
  const serverAssignedIds = { ...state, itemIdStableVerified: false };
  expect(projectProjectionGlobalCapabilitiesReady(serverAssignedIds)).toBe(true);
});
import { didaAuthorizationBinding } from "../src/domain/dida-authorization";

async function createBoardMoveHarness(): Promise<{
  service: HelixService;
  project: DidaProject;
  task: DidaTask;
  control: {
    detailColumn: string;
    remoteTask: DidaTask;
    updateOutcome: "success" | "applied-unknown" | "not-applied-unknown" | "rejected";
    corruptContent: boolean;
    failSaveCall?: number;
    saveCalls: number;
    updateCalls: number;
    projectDataCalls: number;
    getTaskCalls: number;
  };
  persisted: () => ReturnType<typeof createDefaultData>;
}> {
  const data = createDefaultData("device-board-harness");
  grantTaskCrud(data, "point");
  const project: DidaProject = {
    id: "project-board-harness",
    name: "Board",
    viewMode: "kanban",
    permission: "write",
  };
  const task: DidaTask = {
    id: "task-board-harness",
    projectId: project.id,
    title: "Move safely",
    content: "keep me",
    status: 0,
    sortOrder: 10,
  };
  const projectBase = createSnapshot("project", project.id, project);
  const taskBase = createSnapshot("task", task.id, task);
  data.baseSnapshots[`project:${project.id}`] = projectBase;
  data.localSnapshots[`project:${project.id}`] = projectBase;
  data.baseSnapshots[`task:${task.id}`] = taskBase;
  data.localSnapshots[`task:${task.id}`] = taskBase;
  data.boardSnapshots[project.id] = {
    projectId: project.id,
    capturedAt: "2026-08-03T00:00:00.000Z",
    stale: false,
    columns: [
      { id: "todo", projectId: project.id, name: "To do", sortOrder: 10 },
      { id: "doing", projectId: project.id, name: "Doing", sortOrder: 20 },
    ],
    taskColumnIds: { [task.id]: "todo" },
  };
  let persisted = structuredClone(data);
  const control = {
    detailColumn: "todo",
    remoteTask: { ...task, columnId: "todo" } as DidaTask,
    updateOutcome: "success" as "success" | "applied-unknown" | "not-applied-unknown" | "rejected",
    corruptContent: false,
    failSaveCall: undefined as number | undefined,
    saveCalls: 0,
    updateCalls: 0,
    projectDataCalls: 0,
    getTaskCalls: 0,
  };
  const service = new HelixService(
    new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) {
        control.saveCalls += 1;
        if (control.failSaveCall === control.saveCalls) throw new Error("save failed");
        persisted = structuredClone(value) as typeof persisted;
      },
    }),
    { getDidaToken: () => "token" } as HelixSecretStore,
  );
  await service.initialize();
  (service as unknown as { patch(value: { connected: boolean }): void }).patch({ connected: true });
  const api = (service as unknown as { api: Record<string, unknown> }).api;
  Object.assign(api, {
    async getProjects() { return [project]; },
    async filterTasks() { return [{ ...control.remoteTask }]; },
    async getCompletedTasks() { return []; },
    async listHabits() { return []; },
    async listFocus() { return []; },
    async getProjectData() {
      control.projectDataCalls += 1;
      return {
        project,
        tasks: [{ ...control.remoteTask, columnId: control.detailColumn }],
        columns: persisted.boardSnapshots[project.id]!.columns,
      };
    },
    async getTask() {
      control.getTaskCalls += 1;
      return { ...control.remoteTask };
    },
    async updateTask(_taskId: string, payload: Partial<DidaTask>) {
      control.updateCalls += 1;
      if (control.updateOutcome === "not-applied-unknown") {
        throw Object.assign(new Error("unknown"), { remoteOutcomeUnknown: true });
      }
      if (control.updateOutcome === "rejected") throw new Error("rejected");
      control.remoteTask = { ...control.remoteTask, ...payload };
      if (typeof payload.columnId === "string") control.detailColumn = payload.columnId;
      if (control.corruptContent) control.remoteTask.content = "changed remotely";
      if (control.updateOutcome === "applied-unknown") {
        throw Object.assign(new Error("unknown"), { remoteOutcomeUnknown: true });
      }
      return { ...control.remoteTask };
    },
  });
  return { service, project, task, control, persisted: () => structuredClone(persisted) };
}

describe("HelixService layered Dida release gates", () => {
  it("blocks read, ordinary write and contract paths independently before remote access", async () => {
    const data = createDefaultData("device-layered-gates");
    grantTaskCrud(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(data); },
        async saveData() {},
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
      {
        didaReadAvailable: false,
        didaTaskWriteAvailable: false,
        didaContractTestAvailable: false,
      },
    );
    await service.initialize();
    let remoteCalls = 0;
    Object.assign((service as unknown as { api: Record<string, unknown> }).api, {
      async getProjects() { remoteCalls += 1; return []; },
      async createTask() { remoteCalls += 1; throw new Error("must not run"); },
      async createProject() { remoteCalls += 1; throw new Error("must not run"); },
    });

    await expect(service.sync()).rejects.toThrow(/暂未开放滴答远端读取/);
    await expect(service.createTask("blocked", "project-a")).rejects.toThrow(/暂未开放滴答普通任务写入/);
    await expect(service.runDidaWriteContractTest()).rejects.toThrow(/暂未开放滴答专用写入合同测试/);
    expect(remoteCalls).toBe(0);
  });

  it("forces read-only sync when ordinary writes are closed and preserves queued writes", async () => {
    const data = createDefaultData("device-read-only-gate");
    grantTaskCrud(data);
    const task: DidaTask = { id: "queued-task", projectId: "project-a", title: "Queued", status: 0 };
    const snapshot = createSnapshot("task", task.id, task);
    data.queue = [{
      id: "queued-operation",
      kind: "task",
      entityId: task.id,
      projectId: task.projectId,
      operation: "update",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      attempts: 0,
      status: "pending",
      base: snapshot,
      local: snapshot,
    }];
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(persisted); },
        async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
      { didaReadAvailable: true, didaTaskWriteAvailable: false, didaContractTestAvailable: false },
    );
    await service.initialize();
    let remoteWrites = 0;
    Object.assign((service as unknown as { api: Record<string, unknown> }).api, {
      async getProjects() { return []; },
      async filterTasks() { return []; },
      async getCompletedTasks() { return []; },
      async updateTask() { remoteWrites += 1; throw new Error("must not run"); },
    });
    Object.defineProperty(service, "habitService", {
      value: { async list() { return []; }, async checkins() { return []; } },
    });
    Object.defineProperty(service, "focusService", { value: { async list() { return []; } } });

    await service.sync();

    expect(remoteWrites).toBe(0);
    expect(persisted.queue).toEqual([expect.objectContaining({
      id: "queued-operation",
      status: "pending",
      attempts: 0,
    })]);
    await expect((service as unknown as { drainQueue(): Promise<void> }).drainQueue())
      .rejects.toThrow(/暂未开放滴答普通任务写入/);
  });

  it("rejects project projection unless both read and ordinary write gates are open", () => {
    const store = new HelixDataStore({ async loadData() { return null; }, async saveData() {} });
    expect(() => new HelixService(
      store,
      { getDidaToken: () => "token" } as HelixSecretStore,
      { projectDidaProjectionAvailable: true, didaReadAvailable: true, didaTaskWriteAvailable: false },
    )).toThrow(/要求同时开放滴答读取与普通写入门禁/);
  });
});

describe("HelixService runtime recovery", () => {
  it("blocks every ordinary remote request when persisted request control is invalid", async () => {
    let persisted: unknown = {
      ...createDefaultData("device-invalid-request-control"),
      pendingDidaContractCleanup: {
        authorizationBinding: didaAuthorizationBinding("token"),
        plan: {
          runId: "run-invalid-control",
          marker: "[Helix 合同测试 run-invalid-control]",
          projects: [],
          tasks: [],
        },
      },
      didaRequestControl: {
        authorizationBinding: "invalid",
        queryLimitLevel: 1,
        cooldownProbeUsed: false,
        requestCounts: { project: 0, task: 0, habit: 0, focus: 0, other: 0 },
        rateLimitCount: 1,
      },
    };
    const service = new HelixService(new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) { persisted = structuredClone(value); },
    }), { getDidaToken: () => "token" } as HelixSecretStore);
    await service.initialize();
    const request = vi.fn(async () => {
      throw new Error("transport must not run");
    });
    const api = (service as unknown as { api: object }).api;
    Object.defineProperty(api, "transport", { value: { request } });

    await expect(service.verifyRemoteTask("project", "task"))
      .rejects.toThrow(/只读恢复模式.*阻止远端访问/);
    expect(request).not.toHaveBeenCalled();
    expect(service.snapshot().recoveryIssues.join(" ")).toMatch(/请求冷却状态无效/);
    await expect(service.adoptPendingContractRunFromRemote())
      .rejects.toThrow(/只读恢复模式/);
    expect(request).not.toHaveBeenCalled();
  });

  it("replaces a persisted erroneous focus event with corrected milliseconds on sync", async () => {
    const record: DidaFocusRecord = {
      id: "focus-corrected",
      type: 1,
      duration: 2_827_000,
      startTime: "2026-08-04T09:00:00.000Z",
      endTime: "2026-08-04T09:47:08.000Z",
    };
    const occurredAt = record.endTime!;
    const data = createDefaultData("device-focus-correction");
    const erroneous: HelixEvent = {
      id: deterministicEventId({
        type: "focus-completed",
        entityId: record.id,
        occurrenceKey: record.id,
        occurredAt,
      }),
      type: "focus-completed",
      entityId: record.id,
      occurrenceKey: record.id,
      occurredAt,
      minutes: 47_117,
    };
    data.events = [erroneous];
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(persisted); },
        async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    Object.defineProperty(service, "api", {
      value: {
        async getProjects() { return []; },
        async filterTasks() { return []; },
        async getCompletedTasks() { return []; },
      },
    });
    Object.defineProperty(service, "habitService", {
      value: { async list() { return []; }, async checkins() { return []; } },
    });
    Object.defineProperty(service, "focusService", {
      value: { async list() { return [record]; } },
    });

    await service.pullOnlySync();

    const completed = persisted.events.filter((event): event is HelixEvent =>
      !!event && typeof event === "object" &&
      (event as HelixEvent).type === "focus-completed" &&
      (event as HelixEvent).entityId === record.id,
    );
    expect(completed).toEqual([expect.objectContaining({ minutes: 47 })]);
    expect(service.snapshot().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: erroneous.id, minutes: 47 }),
    ]));
  });

  it("does not cover a configured account or real cache with sample data", async () => {
    const configuredData = createDefaultData("device-configured");
    const configured = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(configuredData);
        },
        async saveData() {},
      }),
      { getDidaToken: () => "configured-token" } as HelixSecretStore,
    );
    await configured.initialize();
    expect(configured.snapshot()).toMatchObject({
      authorizationConfigured: true,
      connected: false,
      demoMode: false,
    });

    const cachedData = createDefaultData("device-cached");
    cachedData.localSnapshots["project:cached-project"] = createSnapshot(
      "project",
      "cached-project",
      { id: "cached-project", name: "Cached" },
    );
    const cached = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(cachedData);
        },
        async saveData() {},
      }),
      { getDidaToken: () => null } as HelixSecretStore,
    );
    await cached.initialize();
    expect(cached.snapshot()).toMatchObject({
      authorizationConfigured: false,
      connected: false,
      demoMode: false,
    });
    expect(cached.snapshot().projects).toHaveLength(1);
  });

  it("uses sample data only when neither authorization nor real cache exists", async () => {
    const data = createDefaultData("device-demo");
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(data);
        },
        async saveData() {},
      }),
      { getDidaToken: () => null } as HelixSecretStore,
    );
    await service.initialize();
    expect(service.snapshot()).toMatchObject({
      authorizationConfigured: false,
      connected: false,
      demoMode: true,
    });
  });

  it("restores the verified schedule mode and clears it when authorization changes", async () => {
    const data = createDefaultData("device-a");
    grantTaskCrud(data);
    data.didaContractCapabilities = {
      probeVersion: DIDA_CONTRACT_PROBE_VERSION,
      authorizationBinding: didaAuthorizationBinding("token"),
      taskScheduleMode: "point",
      boardPlacementVerified: true,
      verifiedAt: "2026-07-31T00:00:00.000Z",
    };
    let persisted = structuredClone(data);
    let token: string | null = "token";
    let latch: DidaRequestEmergencyLatch | null = null;
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
        getDidaToken: () => token,
        clearDidaToken: () => {
          token = null;
        },
        setDidaRequestEmergencyLatch: (value: DidaRequestEmergencyLatch) => { latch = value; },
        clearDidaRequestEmergencyLatch: () => { latch = null; },
        getDidaRequestEmergencyLatch: () => latch,
      } as unknown as HelixSecretStore,
    );

    await service.initialize();
    expect(service.snapshot().taskScheduleMode).toBe("point");
    expect(service.snapshot().boardPlacementVerified).toBe(true);
    expect(service.snapshot().authorizationConfigured).toBe(true);

    await service.clearDidaToken();
    expect(service.snapshot().taskScheduleMode).toBe("unknown");
    expect(service.snapshot().boardPlacementVerified).toBe(false);
    expect(service.snapshot().authorizationConfigured).toBe(false);
    expect(service.snapshot().demoMode).toBe(true);
    expect(persisted.didaContractCapabilities).toBeUndefined();
  });

  it("fails closed for a matching-token v3 contract cache after the probe version upgrade", async () => {
    const data = createDefaultData("device-v3-contract-cache");
    data.didaContractCapabilities = {
      probeVersion: 3,
      authorizationBinding: didaAuthorizationBinding("token"),
      taskScheduleMode: "duration",
      boardPlacementVerified: true,
      taskCrudVerified: true,
      reminderWriteVerified: true,
      repeatWriteVerified: true,
      itemsRoundTripVerified: true, itemIdStableVerified: true,
      verifiedAt: "2026-08-04T00:00:00.000Z",
    };
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(data); },
        async saveData() {},
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );

    await service.initialize();

    expect(service.snapshot()).toMatchObject({
      authorizationConfigured: true,
      taskScheduleMode: "unknown",
      boardPlacementVerified: false,
      taskCrudVerified: false,
      reminderWriteVerified: false,
      repeatWriteVerified: false,
      itemsRoundTripVerified: false,
    });
    expect(service.didaWriteContractRuntimeSummary()).toMatch(/合同版本 8.*本次插件运行尚未执行合同测试/);
    expect(service.didaWriteContractRuntimeSummary()).not.toContain("token");
  });

  it("does not reuse another authorization's cached write capabilities", async () => {
    const data = createDefaultData("device-auth-binding");
    data.didaContractCapabilities = {
      probeVersion: DIDA_CONTRACT_PROBE_VERSION,
      authorizationBinding: didaAuthorizationBinding("account-a-token"),
      taskScheduleMode: "duration",
      boardPlacementVerified: true,
      taskCrudVerified: true,
      reminderWriteVerified: true,
      repeatWriteVerified: true,
      itemsRoundTripVerified: true, itemIdStableVerified: true,
      verifiedAt: "2026-08-03T00:00:00.000Z",
    };
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(data); },
        async saveData() {},
      }),
      { getDidaToken: () => "account-b-token" } as HelixSecretStore,
    );

    await service.initialize();

    expect(service.snapshot()).toMatchObject({
      taskScheduleMode: "unknown",
      boardPlacementVerified: false,
      taskCrudVerified: false,
      reminderWriteVerified: false,
      repeatWriteVerified: false,
      itemsRoundTripVerified: false,
    });
  });

  it("blocks unverified task create update and complete before API or queue access", async () => {
    const data = createDefaultData("device-unverified-task-write");
    const task: DidaTask = {
      id: "task-unverified",
      projectId: "project-1",
      title: "Blocked",
      status: 0,
    };
    const snapshot = createSnapshot("task", task.id, task);
    data.baseSnapshots[`task:${task.id}`] = snapshot;
    data.localSnapshots[`task:${task.id}`] = snapshot;
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(persisted); },
        async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    const api = (service as unknown as { api: { createTask: () => Promise<never> } }).api;
    let apiCalls = 0;
    api.createTask = async () => {
      apiCalls += 1;
      throw new Error("must not run");
    };

    await expect(service.createTask("Blocked", "project-1")).rejects.toThrow(/基础写入合同/);
    await expect(service.queueTaskUpdate({ ...task, title: "Edited" }))
      .rejects.toThrow(/基础写入合同/);
    await expect(service.completeTask(task.id)).rejects.toThrow(/基础写入合同/);
    expect(apiCalls).toBe(0);
    expect(persisted.queue).toEqual([]);
  });

  it("blocks task and project conflict writes when board is verified but task CRUD is not", async () => {
    const data = createDefaultData("device-unverified-conflicts");
    data.didaContractCapabilities = {
      probeVersion: DIDA_CONTRACT_PROBE_VERSION,
      authorizationBinding: didaAuthorizationBinding("token"),
      taskScheduleMode: "point",
      boardPlacementVerified: true,
      taskCrudVerified: false,
      reminderWriteVerified: false,
      repeatWriteVerified: false,
      itemsRoundTripVerified: false,
      verifiedAt: "2026-08-04T00:00:00.000Z",
    };
    const taskBase = createSnapshot("task", "task-conflict", {
      id: "task-conflict", projectId: "project-1", title: "Base", status: 0,
    });
    const projectBase = createSnapshot("project", "project-conflict", {
      id: "project-conflict", name: "Base",
    });
    data.conflicts = [
      {
        id: "task-conflict", kind: "task", entityId: "task-conflict", title: "Task",
        createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
        status: "staged", base: taskBase,
        local: createSnapshot("task", "task-conflict", { ...taskBase.value, title: "Local" }),
        remote: taskBase,
        fields: buildConflictFields(taskBase.value, { ...taskBase.value, title: "Local" }, taskBase.value)
          .map((field) => ({ ...field, choice: "local" as const })),
        remoteRecheckCount: 0, sourceDeviceId: "device-a",
      },
      {
        id: "project-conflict", kind: "project", entityId: "project-conflict", title: "Project",
        createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
        status: "staged", base: projectBase,
        local: createSnapshot("project", "project-conflict", { ...projectBase.value, name: "Local" }),
        remote: projectBase,
        fields: buildConflictFields(projectBase.value, { ...projectBase.value, name: "Local" }, projectBase.value)
          .map((field) => ({ ...field, choice: "local" as const })),
        remoteRecheckCount: 0, sourceDeviceId: "device-a",
      },
    ];
    let persisted = structuredClone(data);
    const service = new HelixService(new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
    }), { getDidaToken: () => "token" } as HelixSecretStore);
    await service.initialize();
    let apiCalls = 0;
    const api = (service as unknown as { api: Record<string, () => void> }).api;
    api.getTask = () => { apiCalls += 1; throw new Error("must not run"); };
    api.getProject = () => { apiCalls += 1; throw new Error("must not run"); };

    expect(() => service.applyConflict("task-conflict")).toThrow(/完整有效的写入合同/);
    expect(() => service.applyConflict("project-conflict")).toThrow(/完整有效的写入合同/);
    expect(apiCalls).toBe(0);
    expect(persisted.conflicts.map((conflict) => conflict.status)).toEqual(["staged", "staged"]);
  });

  it("rejects a new duration before queueing when the account is in point mode", async () => {
    const data = createDefaultData("device-a");
    grantTaskCrud(data, "point");
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

  it("rejects moving an existing task into a list without a remote identity", async () => {
    const data = createDefaultData("device-a");
    grantTaskCrud(data);
    const task: DidaTask = {
      id: "task-existing",
      projectId: "project-remote",
      title: "Existing",
      status: 0,
    };
    const base = createSnapshot("task", task.id, task);
    data.baseSnapshots[`task:${task.id}`] = base;
    data.localSnapshots[`task:${task.id}`] = base;
    let persisted = structuredClone(data);
    let processCalls = 0;
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
          processCalls += 1;
          throw new Error("must not run");
        },
      },
    });

    await expect(service.queueTaskUpdate({
      ...task,
      projectId: "local-project-pending",
    })).rejects.toThrow(/目标清单尚未取得滴答远端 ID/);
    expect(processCalls).toBe(0);
    expect(persisted.queue).toEqual([]);
    expect((persisted.localSnapshots[`task:${task.id}`]?.value as DidaTask).projectId)
      .toBe("project-remote");
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

  it("pulls core data without draining a pending write and tolerates list coverage failure", async () => {
    const data = createDefaultData("device-pull-only");
    const pendingTask: DidaTask = {
      id: "pending-task",
      projectId: "project-1",
      title: "Pending local edit",
      status: 0,
    };
    data.queue = [{
      id: "op-pending-pull-only",
      kind: "task",
      entityId: pendingTask.id,
      projectId: pendingTask.projectId,
      operation: "update",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
      attempts: 0,
      status: "pending",
      base: createSnapshot("task", pendingTask.id, pendingTask),
      local: createSnapshot("task", pendingTask.id, { ...pendingTask, title: "Edited" }),
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
    Object.defineProperty(service, "api", {
      value: {
        async probeCapabilities() {
          return {
            projects: "available",
            tasks: "available",
            habits: "unavailable",
            focus: "unavailable",
            checkedAt: "2026-08-03T00:00:00.000Z",
            errors: [],
          };
        },
        async getProjects() {
          return [{ id: "project-1", name: "Remote list" }];
        },
        async getProjectData() {
          throw new Error("one list detail unavailable");
        },
        async filterTasks() {
          return [{
            id: "remote-task",
            projectId: "project-1",
            title: "Remote task",
            status: 0,
          }];
        },
        async getCompletedTasks() {
          return [];
        },
      },
    });
    Object.defineProperty(service, "habitService", {
      value: { async list() { return []; }, async checkins() { return []; } },
    });
    Object.defineProperty(service, "focusService", {
      value: { async list() { return []; } },
    });

    await service.pullOnlySync();

    expect(service.snapshot()).toMatchObject({
      connected: true,
      demoMode: false,
      projects: [{ id: "project-1", name: "Remote list" }],
      tasks: [{ id: "remote-task", projectId: "project-1", title: "Remote task" }],
      syncWarnings: ["1 个清单暂未完成删除覆盖校验"],
    });
    expect(persisted.queue).toMatchObject([{ id: "op-pending-pull-only", status: "pending" }]);
  });

  it("shares one in-flight sync instead of publishing an early success", async () => {
    const data = createDefaultData("device-single-sync");
    const service = new HelixService(
      new HelixDataStore({
        async loadData() {
          return structuredClone(data);
        },
        async saveData() {},
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    let finishProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      finishProbe = resolve;
    });
    let probes = 0;
    Object.defineProperty(service, "api", {
      value: {
        async getProjects() {
          probes += 1;
          await probeGate;
          throw new Error("shared failure");
        },
      },
    });

    const first = service.sync();
    const second = service.sync();
    finishProbe();
    await expect(first).rejects.toThrow("shared failure");
    await expect(second).rejects.toThrow("shared failure");
    expect(probes).toBe(1);
  });

  it("keeps a task returned by list detail when the global filter temporarily omits it", async () => {
    const data = createDefaultData("device-detail-coverage");
    const task: DidaTask = {
      id: "task-from-detail",
      projectId: "project-detail",
      title: "Detail truth",
      status: 0,
    };
    const snapshot = createSnapshot("task", task.id, task);
    data.baseSnapshots[`task:${task.id}`] = snapshot;
    data.localSnapshots[`task:${task.id}`] = snapshot;
    data.lastSyncAt = new Date().toISOString();
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
    Object.defineProperty(service, "api", {
      value: {
        async getProjects() {
          return [{ id: "project-detail", name: "Detail list" }];
        },
        async getProjectData() {
          return {
            project: { id: "project-detail", name: "Detail list" },
            columns: [],
            tasks: [task],
          };
        },
        async filterTasks() {
          return [];
        },
        async getCompletedTasks() {
          return [];
        },
      },
    });
    Object.defineProperty(service, "habitService", {
      value: { async list() { return []; }, async checkins() { return []; } },
    });
    Object.defineProperty(service, "focusService", {
      value: { async list() { return []; } },
    });

    await service.pullOnlySync();

    expect(service.snapshot().tasks).toMatchObject([{ id: "task-from-detail" }]);
    expect(persisted.localSnapshots[`task:${task.id}`]).toBeDefined();
    expect(persisted.conflicts).toEqual([]);
  });

  it("publishes remote kanban columns and preserves detail-only task placement", async () => {
    const data = createDefaultData("device-board-detail");
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(persisted); },
        async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    let boardDetailMode: "full" | "unavailable" | "missing-columns" = "full";
    Object.defineProperty(service, "api", {
      value: {
        async getProjects() {
          return boardDetailMode === "missing-columns"
            ? [{ id: "project-board", name: "Global truth", color: "#123456", viewMode: "kanban" }]
            : [{ id: "project-board", name: "Board", viewMode: "kanban" }];
        },
        async getProjectData() {
          if (boardDetailMode === "unavailable") throw new Error("board detail unavailable");
          if (boardDetailMode === "missing-columns") {
            return {
              project: { id: "project-board", name: "Stale detail", color: "#ffffff", viewMode: "list" },
              tasks: [{ id: "task-board", projectId: "project-board", title: "Placed", status: 0, columnId: "todo" }],
            };
          }
          return {
            project: { id: "project-board", name: "Board", viewMode: "kanban" },
            columns: [
              { id: "done", projectId: "project-board", name: "Done", sortOrder: 20 },
              { id: "todo", projectId: "project-board", name: "To do", sortOrder: 10 },
            ],
            tasks: [{
              id: "task-board",
              projectId: "project-board",
              title: "Placed",
              status: 0,
              columnId: "todo",
            }],
          };
        },
        async filterTasks() {
          return [{ id: "task-board", projectId: "project-board", title: "Placed", status: 0 }];
        },
        async getCompletedTasks() { return []; },
      },
    });
    Object.defineProperty(service, "habitService", {
      value: { async list() { return []; }, async checkins() { return []; } },
    });
    Object.defineProperty(service, "focusService", { value: { async list() { return []; } } });

    await service.pullOnlySync();

    expect(service.snapshot().projects[0]).toMatchObject({
      id: "project-board",
      viewMode: "kanban",
      columns: [{ id: "todo" }, { id: "done" }],
    });
    expect(service.snapshot().tasks[0]).toMatchObject({ id: "task-board", columnId: "todo" });
    expect(persisted.boardSnapshots["project-board"]?.taskColumnIds).toEqual({
      "task-board": "todo",
    });
    expect(persisted.localSnapshots["task:task-board"]?.value).not.toHaveProperty("columnId");

    boardDetailMode = "unavailable";
    await service.pullOnlySync();
    expect(service.snapshot().projects[0]).toMatchObject({
      columns: [{ id: "todo" }, { id: "done" }],
      boardStale: true,
    });
    expect(service.snapshot().tasks[0]).toMatchObject({ id: "task-board", columnId: "todo" });

    boardDetailMode = "missing-columns";
    await service.pullOnlySync();
    expect(service.snapshot().projects[0]).toMatchObject({
      name: "Global truth",
      color: "#123456",
      columns: [{ id: "todo" }, { id: "done" }],
      boardStale: true,
    });
  });

  it("keeps the completed endpoint authoritative over a stale open list detail", async () => {
    const data = createDefaultData("device-completed-priority");
    const baseTask: DidaTask = {
      id: "task-completed-priority",
      projectId: "project-completed-priority",
      title: "Completion wins",
      status: 0,
    };
    const snapshot = createSnapshot("task", baseTask.id, baseTask);
    data.baseSnapshots[`task:${baseTask.id}`] = snapshot;
    data.localSnapshots[`task:${baseTask.id}`] = snapshot;
    data.lastSyncAt = new Date(Date.now() - 60_000).toISOString();
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
    const completedTime = new Date().toISOString();
    Object.defineProperty(service, "api", {
      value: {
        async getProjects() {
          return [{ id: baseTask.projectId, name: "Completion list" }];
        },
        async getProjectData() {
          return {
            project: { id: baseTask.projectId, name: "Completion list" },
            tasks: [baseTask],
          };
        },
        async filterTasks() {
          return [baseTask];
        },
        async getCompletedTasks() {
          return [{ ...baseTask, status: 2, completedTime }];
        },
      },
    });
    Object.defineProperty(service, "habitService", {
      value: { async list() { return []; }, async checkins() { return []; } },
    });
    Object.defineProperty(service, "focusService", {
      value: { async list() { return []; } },
    });

    await service.pullOnlySync();

    expect(service.snapshot().tasks).toMatchObject([{
      id: baseTask.id,
      status: 2,
      completedTime,
    }]);
    expect(service.snapshot().events.filter((event) =>
      event.type === "task-completed" && event.entityId === baseTask.id)).toHaveLength(1);
    expect(service.snapshot().events.some((event) =>
      event.type === "task-reopened" && event.entityId === baseTask.id)).toBe(false);
  });

  it("publishes core tasks while preserving optional caches that temporarily fail", async () => {
    const data = createDefaultData("device-optional-cache");
    data.localSnapshots["habit:habit-old"] = createSnapshot("habit", "habit-old", {
      id: "habit-old",
      name: "Cached habit",
    });
    data.localSnapshots["focus:focus-old"] = createSnapshot("focus", "focus-old", {
      id: "focus-old",
      startTime: "2026-08-02T00:00:00.000Z",
      endTime: "2026-08-02T00:30:00.000Z",
      type: 1,
    });
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
    Object.defineProperty(service, "api", {
      value: {
        async probeCapabilities() {
          return {
            projects: "available",
            tasks: "available",
            habits: "available",
            focus: "available",
            checkedAt: "2026-08-03T00:00:00.000Z",
            errors: [],
          };
        },
        async getProjects() {
          return [];
        },
        async filterTasks() {
          return [{ id: "task-core", projectId: "inbox", title: "Core", status: 0 }];
        },
        async getCompletedTasks() {
          return [];
        },
      },
    });
    Object.defineProperty(service, "habitService", {
      value: {
        async list() {
          return [{ id: "habit-new", name: "New habit" }];
        },
        async checkins() {
          throw new Error("checkins unavailable");
        },
      },
    });
    Object.defineProperty(service, "focusService", {
      value: { async list() { throw new Error("focus unavailable"); } },
    });

    await service.pullOnlySync();

    expect(service.snapshot().tasks).toMatchObject([{ id: "task-core" }]);
    expect(service.snapshot().habits).toMatchObject([{ id: "habit-old" }]);
    expect(service.snapshot().focus).toMatchObject([{ id: "focus-old" }]);
    expect(service.snapshot().syncWarnings).toEqual([
      "习惯数据暂不可用，已保留上次缓存",
      "专注数据暂不可用，已保留上次缓存",
    ]);
  });

  it("keeps the last good cache and sync timestamp when a core read fails", async () => {
    const data = createDefaultData("device-core-failure");
    const previousTask: DidaTask = {
      id: "task-previous",
      projectId: "project-previous",
      title: "Previous",
      status: 0,
    };
    data.localSnapshots["task:task-previous"] = createSnapshot(
      "task",
      previousTask.id,
      previousTask,
    );
    data.lastSyncAt = "2026-08-02T00:00:00.000Z";
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
    Object.defineProperty(service, "api", {
      value: {
        async probeCapabilities() {
          return {
            projects: "available",
            tasks: "available",
            habits: "unavailable",
            focus: "unavailable",
            checkedAt: "2026-08-03T00:00:00.000Z",
            errors: [],
          };
        },
        async getProjects() {
          throw new Error("core unavailable");
        },
      },
    });

    await expect(service.pullOnlySync()).rejects.toThrow("core unavailable");

    expect(service.snapshot().tasks).toMatchObject([{ id: "task-previous" }]);
    expect(service.snapshot().lastSyncAt).toBe("2026-08-02T00:00:00.000Z");
    expect(persisted.lastSyncAt).toBe("2026-08-02T00:00:00.000Z");
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
    let returnedListId = "project-1";
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
        async getProject(projectId: string): Promise<DidaProject> {
          expect(projectId).toBe("project-1");
          return { id: returnedListId, name: "Verified list" };
        },
      },
    });

    await expect(service.verifyRemoteTask("project-1", "task-1"))
      .resolves.toMatchObject({ id: "task-1", projectId: "project-1" });
    returnedProjectId = "project-other";
    await expect(service.verifyRemoteTask("project-1", "task-1"))
      .rejects.toThrow(/身份或清单/);
    await expect(service.verifyRemoteProject("project-1"))
      .resolves.toMatchObject({ id: "project-1", name: "Verified list" });
    returnedListId = "project-other";
    await expect(service.verifyRemoteProject("project-1"))
      .rejects.toThrow(/清单身份/);
  });

  it("builds projection catalog readiness from exact project and dual-source column reads", async () => {
    const data = createDefaultData("device-projection-catalog");
    grantTaskCrud(data);
    data.didaContractCapabilities!.taskReopenVerified = true;
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(data); },
        async saveData() {},
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
      { projectDidaProjectionAvailable: true },
    );
    await service.initialize();
    const project: DidaProject = {
      id: "projection-list", name: "科研", viewMode: "kanban", permission: "write",
    };
    const columns = [{
      id: "projection-column", projectId: project.id, name: "Helix项目", sortOrder: 10,
    }];
    let mismatch = false;
    Object.defineProperty(service, "api", {
      value: {
        async getProject() { return project; },
        async getProjectData() {
          return { project, tasks: [], columns };
        },
        async getColumns() {
          return mismatch ? [{ ...columns[0], name: "竞争改名" }] : columns;
        },
      },
    });

    await expect(service.readProjectionCatalog(project.id)).resolves.toMatchObject({
      projects: [project],
      columns,
      readiness: {
        writable: true,
        queueEmpty: true,
        authorizationCurrent: true,
        itemsRoundTripVerified: true, itemIdStableVerified: true,
        boardPlacementVerified: true,
        boardFresh: true,
        taskReopenVerified: true,
        unknownOutcomes: 0,
      },
    });
    mismatch = true;
    await expect(service.readProjectionCatalog(project.id)).rejects.toThrow(/双源复读不一致/);
  });

  it("migrates an in-progress marker after an ordinary queued create succeeds", async () => {
    const data = createDefaultData("device-a");
    grantTaskCrud(data);
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
    grantTaskCrud(data);
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
    grantTaskCrud(data);
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
    let processed: SyncQueueOperation<DidaTask> | undefined;
    Object.defineProperty(service, "taskEngine", {
      value: {
        async process(operation: SyncQueueOperation<DidaTask>) {
          processed = structuredClone(operation);
          return { outcome: "pushed", snapshot: operation.local };
        },
      },
    });

    await service.queueTaskUpdate({ ...task, projectId: "project-new" });

    expect(processed).toMatchObject({
      operation: "update",
      projectId: "project-old",
      writeFields: [],
      local: { value: { projectId: "project-new" } },
    });
    expect(persisted.inProgress[0]?.projectId).toBe("project-new");
    expect(service.snapshot().inProgress[0]?.projectId).toBe("project-new");
    expect(service.visibleInProgress(false)[0]?.project).toBeUndefined();
  });

  it("queues a remote view-mode update without putting board cache into project truth", async () => {
    const data = createDefaultData("device-project-view");
    grantTaskCrud(data);
    const project = { id: "project-view", name: "Board", viewMode: "list", permission: "write" } as const;
    const base = createSnapshot("project", project.id, project);
    data.baseSnapshots[`project:${project.id}`] = base;
    data.localSnapshots[`project:${project.id}`] = base;
    data.boardSnapshots[project.id] = {
      projectId: project.id,
      capturedAt: "2026-08-03T00:00:00.000Z",
      stale: false,
      columns: [{ id: "todo", projectId: project.id, name: "To do", sortOrder: 10 }],
      taskColumnIds: {},
    };
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(persisted); },
        async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    (service as unknown as { patch(value: { connected: boolean }): void }).patch({ connected: true });
    let processed: SyncQueueOperation | undefined;
    Object.defineProperty(service, "projectEngine", {
      value: {
        async process(operation: SyncQueueOperation) {
          processed = structuredClone(operation);
          return { outcome: "pushed", snapshot: operation.local };
        },
      },
    });

    await service.setDidaProjectViewMode(project.id, "kanban");

    expect(processed?.local.value).toMatchObject({ id: project.id, viewMode: "kanban" });
    expect(processed?.local.value).not.toHaveProperty("columns");
    expect(persisted.boardSnapshots[project.id]?.columns).toMatchObject([{ id: "todo" }]);
    expect(service.snapshot().projects[0]).toMatchObject({
      viewMode: "kanban",
      columns: [{ id: "todo" }],
    });
  });

  it("keeps a view-mode update pending while offline and reports its sync state", async () => {
    const data = createDefaultData("device-project-view-offline");
    grantTaskCrud(data);
    const project = { id: "project-offline", name: "Offline", viewMode: "list", permission: "write" } as const;
    const base = createSnapshot("project", project.id, project);
    data.baseSnapshots[`project:${project.id}`] = base;
    data.localSnapshots[`project:${project.id}`] = base;
    data.boardSnapshots[project.id] = {
      projectId: project.id,
      capturedAt: "2026-08-03T00:00:00.000Z",
      stale: false,
      columns: [],
      taskColumnIds: {},
    };
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(persisted); },
        async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();

    await service.setDidaProjectViewMode(project.id, "kanban");

    expect(persisted.queue).toMatchObject([{ kind: "project", entityId: project.id, status: "pending" }]);
    expect(await service.getDidaProjectViewModeSyncStatus(project.id)).toBe("pending");
    expect(service.snapshot().projects[0]?.viewMode).toBe("kanban");
  });

  it("moves one board task only after exact remote column preflight", async () => {
    const data = createDefaultData("device-board-move");
    grantTaskCrud(data, "point");
    const project: DidaProject = {
      id: "project-board-move",
      name: "Board",
      viewMode: "kanban",
      permission: "write",
    };
    const task: DidaTask = {
      id: "task-board-move",
      projectId: project.id,
      title: "Move me",
      status: 0,
    };
    const projectBase = createSnapshot("project", project.id, project);
    const taskBase = createSnapshot("task", task.id, task);
    data.baseSnapshots[`project:${project.id}`] = projectBase;
    data.localSnapshots[`project:${project.id}`] = projectBase;
    data.baseSnapshots[`task:${task.id}`] = taskBase;
    data.localSnapshots[`task:${task.id}`] = taskBase;
    data.boardSnapshots[project.id] = {
      projectId: project.id,
      capturedAt: "2026-08-03T00:00:00.000Z",
      stale: false,
      columns: [
        { id: "todo", projectId: project.id, name: "To do", sortOrder: 10 },
        { id: "doing", projectId: project.id, name: "Doing", sortOrder: 20 },
      ],
      taskColumnIds: { [task.id]: "todo" },
    };
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(persisted); },
        async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    (service as unknown as { patch(value: { connected: boolean }): void }).patch({ connected: true });
    let updatePayload: Partial<DidaTask> | undefined;
    let remoteTask: DidaTask = { ...task, columnId: "todo" };
    Object.defineProperty(service, "api", { value: {
      async getProjectData() {
        return {
          project,
          tasks: [remoteTask],
          columns: persisted.boardSnapshots[project.id]!.columns,
        };
      },
      async updateTask(_taskId: string, payload: Partial<DidaTask>) {
        updatePayload = payload;
        remoteTask = { ...remoteTask, ...payload };
        return remoteTask;
      },
      async getTask() { return remoteTask; },
    } });

    await service.moveTaskToBoardColumn(project.id, task.id, "doing");

    expect(updatePayload).toEqual({ id: task.id, projectId: project.id, columnId: "doing" });
    expect(persisted.boardSnapshots[project.id]?.taskColumnIds[task.id]).toBe("doing");
    expect(service.snapshot().tasks.find((candidate) => candidate.id === task.id)?.columnId)
      .toBe("doing");
  });

  it("blocks board placement for an unverified account before any remote access", async () => {
    const { service, project, task, control } = await createBoardMoveHarness();
    (service as unknown as {
      patch(value: { boardPlacementVerified: boolean }): void;
    }).patch({ boardPlacementVerified: false });

    await expect(service.moveTaskToBoardColumn(project.id, task.id, "doing"))
      .rejects.toThrow(/当前滴答账号尚未通过/);
    expect(control.projectDataCalls).toBe(0);
    expect(control.getTaskCalls).toBe(0);
    expect(control.updateCalls).toBe(0);
  });

  it("blocks board placement before reads when only the historic board capability remains", async () => {
    const { service, project, task, control, persisted } = await createBoardMoveHarness();
    const before = structuredClone(persisted());
    (service as unknown as {
      patch(value: { boardPlacementVerified: boolean; taskCrudVerified: boolean }): void;
    }).patch({ boardPlacementVerified: true, taskCrudVerified: false });

    await expect(service.moveTaskToBoardColumn(project.id, task.id, "doing"))
      .rejects.toThrow(/完整有效的写入合同/);

    expect(control.projectDataCalls).toBe(0);
    expect(control.getTaskCalls).toBe(0);
    expect(control.updateCalls).toBe(0);
    expect(persisted()).toEqual(before);
  });

  it("treats a repeated move to the current column as a zero-write no-op", async () => {
    const { service, project, task, control } = await createBoardMoveHarness();

    await service.moveTaskToBoardColumn(project.id, task.id, "todo");

    expect(control.projectDataCalls).toBe(0);
    expect(control.getTaskCalls).toBe(0);
    expect(control.updateCalls).toBe(0);
  });

  it("refuses a board move when the remote task already changed columns", async () => {
    const data = createDefaultData("device-board-race");
    grantTaskCrud(data, "point");
    const project: DidaProject = { id: "project-board-race", name: "Board", permission: "write" };
    const task: DidaTask = { id: "task-board-race", projectId: project.id, title: "Race", status: 0 };
    const projectBase = createSnapshot("project", project.id, project);
    const taskBase = createSnapshot("task", task.id, task);
    data.baseSnapshots[`project:${project.id}`] = projectBase;
    data.localSnapshots[`project:${project.id}`] = projectBase;
    data.baseSnapshots[`task:${task.id}`] = taskBase;
    data.localSnapshots[`task:${task.id}`] = taskBase;
    data.boardSnapshots[project.id] = {
      projectId: project.id,
      capturedAt: "2026-08-03T00:00:00.000Z",
      stale: false,
      columns: [
        { id: "todo", projectId: project.id, name: "To do" },
        { id: "doing", projectId: project.id, name: "Doing" },
      ],
      taskColumnIds: { [task.id]: "todo" },
    };
    const service = new HelixService(
      new HelixDataStore({ async loadData() { return structuredClone(data); }, async saveData() {} }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    (service as unknown as { patch(value: { connected: boolean }): void }).patch({ connected: true });
    let writes = 0;
    Object.defineProperty(service, "api", { value: {
      async getProjectData() {
        return {
          project,
          tasks: [{ ...task, columnId: "doing" }],
          columns: data.boardSnapshots[project.id]!.columns,
        };
      },
      async getTask() { return { ...task, columnId: "doing" }; },
      async updateTask() { writes += 1; },
    } });

    await expect(service.moveTaskToBoardColumn(project.id, task.id, "doing"))
      .rejects.toThrow(/原分栏不一致/);
    expect(writes).toBe(0);
  });

  it("refuses a board move when detail and exact task endpoints disagree", async () => {
    const { service, project, task, control } = await createBoardMoveHarness();
    control.detailColumn = "doing";

    await expect(service.moveTaskToBoardColumn(project.id, task.id, "doing"))
      .rejects.toThrow(/详情、精确任务与本地快照.*不一致/);
    expect(control.updateCalls).toBe(0);
  });

  it("reconciles one applied unknown board move without resending", async () => {
    const { service, project, task, control, persisted } = await createBoardMoveHarness();
    control.updateOutcome = "applied-unknown";

    await service.moveTaskToBoardColumn(project.id, task.id, "doing");

    expect(control.updateCalls).toBe(1);
    expect(persisted().boardSnapshots[project.id]?.stale).toBe(false);
    expect(persisted().boardSnapshots[project.id]?.taskColumnIds[task.id]).toBe("doing");
    expect(persisted().boardSnapshots[project.id]?.capturedAt)
      .toBe("2026-08-03T00:00:00.000Z");
  });

  it("keeps the board frozen when an unknown board move was not applied", async () => {
    const { service, project, task, control, persisted } = await createBoardMoveHarness();
    control.updateOutcome = "not-applied-unknown";

    await expect(service.moveTaskToBoardColumn(project.id, task.id, "doing"))
      .rejects.toThrow(/结果未知.*未重发.*冻结/);

    expect(control.updateCalls).toBe(1);
    expect(persisted().boardSnapshots[project.id]?.stale).toBe(true);
    expect(persisted().boardSnapshots[project.id]?.taskColumnIds[task.id]).toBe("todo");
  });

  it("keeps the board frozen after a deterministic remote rejection", async () => {
    const { service, project, task, control, persisted } = await createBoardMoveHarness();
    control.updateOutcome = "rejected";

    await expect(service.moveTaskToBoardColumn(project.id, task.id, "doing"))
      .rejects.toThrow(/远端拒绝.*未重发.*冻结/);
    expect(control.updateCalls).toBe(1);
    expect(persisted().boardSnapshots[project.id]?.stale).toBe(true);
  });

  it("opens a field conflict and keeps the board frozen if placement changes other fields", async () => {
    const { service, project, task, control, persisted } = await createBoardMoveHarness();
    control.corruptContent = true;

    await expect(service.moveTaskToBoardColumn(project.id, task.id, "doing"))
      .rejects.toThrow(/分栏以外.*逐字段处理冲突/);

    expect(control.updateCalls).toBe(1);
    expect(persisted().boardSnapshots[project.id]?.stale).toBe(true);
    expect(persisted().conflicts).toHaveLength(1);
    expect(persisted().conflicts[0]?.fields.map((field) => field.path)).toContain("content");
    expect(persisted().conflicts[0]?.base.value).not.toHaveProperty("columnId");
    expect(persisted().conflicts[0]?.local.value).not.toHaveProperty("columnId");
    expect(persisted().conflicts[0]?.remote.value).not.toHaveProperty("columnId");
    expect(service.snapshot()).toMatchObject({ attentionCount: 1 });
    expect(service.snapshot().projects.find((candidate) => candidate.id === project.id))
      .toMatchObject({ boardStale: true });

    control.corruptContent = false;
    const conflictId = persisted().conflicts[0]!.id;
    expect(taskSyncProjection(normalizeTask(control.remoteTask)))
      .toEqual(persisted().conflicts[0]!.remote.value);
    await service.chooseConflict(conflictId, "content", "local");
    expect(taskSyncProjection(normalizeTask(control.remoteTask)))
      .toEqual(persisted().conflicts[0]!.remote.value);
    expect(persisted().conflicts[0]!.remote.stamp.hash)
      .toBe(stableHash(persisted().conflicts[0]!.remote.value));
    await service.applyConflict(conflictId);

    expect(persisted().conflicts).toEqual([]);
    expect(persisted().boardSnapshots[project.id]?.stale).toBe(false);
    expect(persisted().boardSnapshots[project.id]?.taskColumnIds[task.id]).toBe("doing");
    expect(service.snapshot().attentionCount).toBe(0);
    expect(service.snapshot().projects.find((candidate) => candidate.id === project.id))
      .toMatchObject({ boardStale: false });
  });

  it("keeps the first persisted stale intent if the final local board save fails", async () => {
    const { service, project, task, control, persisted } = await createBoardMoveHarness();
    control.failSaveCall = control.saveCalls + 2;

    await expect(service.moveTaskToBoardColumn(project.id, task.id, "doing"))
      .rejects.toThrow(/本地结果保存失败.*保持冻结/);

    expect(control.updateCalls).toBe(1);
    expect(persisted().boardSnapshots[project.id]?.stale).toBe(true);
    expect(persisted().boardSnapshots[project.id]?.taskColumnIds[task.id]).toBe("todo");
  });

  it("refuses board placement while another authorized remote read is active", async () => {
    const { service, project, task, control } = await createBoardMoveHarness();
    let releaseRead!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const api = (service as unknown as { api: { getTask(): Promise<DidaTask> } }).api;
    api.getTask = async () => {
      markStarted();
      await gate;
      return { ...control.remoteTask };
    };
    const read = service.verifyRemoteTask(project.id, task.id);
    await started;

    await expect(service.moveTaskToBoardColumn(project.id, task.id, "doing"))
      .rejects.toThrow(/已有滴答远端访问.*看板卡片归栏/);
    expect(control.updateCalls).toBe(0);

    releaseRead();
    await expect(read).resolves.toMatchObject({ id: task.id });
  });

  it("blocks an open task conflict before any board read but allows a resolved record", async () => {
    const { service, project, task, control } = await createBoardMoveHarness();
    const base = createSnapshot("task", task.id, task);
    const remoteValue = { ...task, content: "remote conflict" };
    const remote = createSnapshot("task", task.id, remoteValue);
    const store = (service as unknown as { store: HelixDataStore }).store;
    await store.mutate((draft) => {
      draft.conflicts.push({
        id: "conflict-board-gate",
        kind: "task",
        entityId: task.id,
        title: task.title,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
        status: "open",
        base,
        local: base,
        remote,
        fields: buildConflictFields(base.value, base.value, remote.value),
        remoteRecheckCount: 0,
        sourceDeviceId: draft.deviceId,
      });
    });

    await expect(service.moveTaskToBoardColumn(project.id, task.id, "doing"))
      .rejects.toThrow(/已有逐字段冲突/);
    expect(control.projectDataCalls).toBe(0);
    expect(control.getTaskCalls).toBe(0);
    expect(control.updateCalls).toBe(0);

    await store.mutate((draft) => {
      draft.conflicts[0]!.status = "resolved";
    });
    await service.moveTaskToBoardColumn(project.id, task.id, "doing");
    expect(control.projectDataCalls).toBe(1);
    expect(control.getTaskCalls).toBeGreaterThanOrEqual(2);
    expect(control.updateCalls).toBe(1);
  });

  it("refuses view-mode writes for a read-only list before queueing", async () => {
    const data = createDefaultData("device-project-read-only");
    grantTaskCrud(data);
    const project = { id: "project-read", name: "Shared", viewMode: "list", permission: "read" } as const;
    const base = createSnapshot("project", project.id, project);
    data.baseSnapshots[`project:${project.id}`] = base;
    data.localSnapshots[`project:${project.id}`] = base;
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(persisted); },
        async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();

    await expect(service.setDidaProjectViewMode(project.id, "kanban"))
      .rejects.toThrow(/没有写入权限/);
    expect(persisted.queue).toEqual([]);
  });

  it("records a verified completion immediately after the queue write succeeds", async () => {
    const data = createDefaultData("device-a");
    grantTaskCrud(data);
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

  it("reopens a completed task only through the verified status field", async () => {
    const data = createDefaultData("device-reopen");
    grantTaskCrud(data);
    const task: DidaTask = {
      id: "task-reopen",
      projectId: "project-1",
      title: "Reopen",
      status: 2,
      completedTime: "2026-08-13T00:00:00.000Z",
    };
    const base = createSnapshot("task", task.id, task);
    data.baseSnapshots[`task:${task.id}`] = base;
    data.localSnapshots[`task:${task.id}`] = base;
    let persisted = structuredClone(data);
    let captured: SyncQueueOperation<DidaTask> | undefined;
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(persisted); },
        async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    Object.defineProperty(service, "taskEngine", {
      value: {
        async process(operation: SyncQueueOperation<DidaTask>) {
          captured = structuredClone(operation);
          return { outcome: "pushed", snapshot: operation.local };
        },
      },
    });

    await service.reopenTask(task.id);

    expect(captured).toMatchObject({ operation: "update", writeFields: ["status"] });
    expect(captured?.local.value).toMatchObject({ status: 0, completedTime: null });
  });

  it("removes local task state only after verified remote deletion", async () => {
    const data = createDefaultData("device-delete");
    grantTaskCrud(data);
    const task: DidaTask = {
      id: "task-delete",
      projectId: "project-1",
      title: "Delete",
      status: 0,
    };
    const base = createSnapshot("task", task.id, task);
    data.baseSnapshots[`task:${task.id}`] = base;
    data.localSnapshots[`task:${task.id}`] = base;
    data.inProgress = [{
      taskId: task.id,
      projectId: task.projectId,
      markedAt: "2026-08-13T00:00:00.000Z",
      lastTouchedAt: "2026-08-13T00:00:00.000Z",
      activeFocus: false,
    }];
    let persisted = structuredClone(data);
    let captured: SyncQueueOperation<DidaTask> | undefined;
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(persisted); },
        async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    Object.defineProperty(service, "taskEngine", {
      value: {
        async process(operation: SyncQueueOperation<DidaTask>) {
          captured = structuredClone(operation);
          return { outcome: "deleted" };
        },
      },
    });

    await service.deleteTask(task.id);

    expect(captured).toMatchObject({
      operation: "delete",
      entityId: task.id,
      projectId: task.projectId,
      local: { value: null },
    });
    expect(persisted.baseSnapshots[`task:${task.id}`]).toBeUndefined();
    expect(persisted.localSnapshots[`task:${task.id}`]).toBeUndefined();
    expect(persisted.inProgress).toEqual([]);
    expect(service.snapshot().tasks).toEqual([]);
  });

  it("keeps a task visible when remote deletion is not verified", async () => {
    const data = createDefaultData("device-delete-failed");
    grantTaskCrud(data);
    const task: DidaTask = {
      id: "task-delete-failed",
      projectId: "project-1",
      title: "Keep visible",
      status: 0,
    };
    const base = createSnapshot("task", task.id, task);
    data.baseSnapshots[`task:${task.id}`] = base;
    data.localSnapshots[`task:${task.id}`] = base;
    let persisted = structuredClone(data);
    const service = new HelixService(
      new HelixDataStore({
        async loadData() { return structuredClone(persisted); },
        async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
      }),
      { getDidaToken: () => "token" } as HelixSecretStore,
    );
    await service.initialize();
    Object.defineProperty(service, "taskEngine", {
      value: {
        async process() {
          throw { category: "permanent", message: "rejected" };
        },
      },
    });

    await expect(service.deleteTask(task.id)).rejects.toThrow("rejected");

    expect(persisted.localSnapshots[`task:${task.id}`]?.value).toEqual(task);
    expect(service.snapshot().tasks).toEqual([task]);
    expect(persisted.queue).toMatchObject([{ operation: "delete", status: "failed" }]);
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
    await expect(service.releaseApplyingConflict("conflict-applying"))
      .rejects.toThrow(/不得解锁重试/);
    expect(persisted.conflicts[0]?.status).toBe("applying");
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
    grantTaskCrud(data);
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
    grantTaskCrud(data);
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

  it("recovers an interrupted projection create after restart without sending it again", async () => {
    const data = createDefaultData("device-projection-restart");
    grantTaskCrud(data);
    data.didaContractCapabilities!.taskReopenVerified = true;
    const clientIdentity = "helix-action:project-a:stage-a:uuid-a";
    const local: DidaTask = {
      id: "local-projection-restart",
      projectId: "target-list",
      title: "Restart safe",
      content: "helix-action-projection:uuid-a",
      parentId: "parent-a",
      columnId: "column-a",
      status: 0,
    };
    data.queue = [{
      id: "op-projection-restart",
      kind: "task",
      entityId: local.id,
      projectId: local.projectId,
      operation: "create",
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      attempts: 0,
      status: "running",
      idempotencyFingerprint: clientIdentity,
      local: createSnapshot("task", local.id, local),
      writeFields: ["title", "content", "parentId", "columnId"],
    }];
    let persisted = structuredClone(data);
    const service = new HelixService(new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
    }), { getDidaToken: () => "token" } as HelixSecretStore);
    await service.initialize();
    let sends = 0;
    Object.defineProperty(service, "taskEngine", {
      value: { async process() { sends += 1; throw new Error("must not resend"); } },
    });

    await expect(service.enqueueProjectionCreate(local, clientIdentity))
      .rejects.toThrow(/正式版暂未开放/);
    expect(sends).toBe(0);
    expect(persisted.queue).toMatchObject([{
      id: "op-projection-restart",
      status: "reconciliation",
      remoteOutcomeUnknown: true,
    }]);
  });

  it("keeps disabled projection operations untouched while draining ordinary tasks", async () => {
    const data = createDefaultData("device-projection-single-flight");
    grantTaskCrud(data);
    data.didaContractCapabilities!.taskReopenVerified = true;
    const ordinary: DidaTask = {
      id: "task-ordinary",
      projectId: "target-list",
      title: "Ordinary",
      status: 0,
    };
    const ordinarySnapshot = createSnapshot("task", ordinary.id, ordinary);
    data.baseSnapshots[`task:${ordinary.id}`] = ordinarySnapshot;
    data.localSnapshots[`task:${ordinary.id}`] = ordinarySnapshot;
    const projection: DidaTask = {
      id: ordinary.id,
      projectId: "target-list",
      title: "Projection",
      content: "helix-action-projection:uuid-b",
      status: 0,
    };
    const projectionSnapshot = createSnapshot("task", projection.id, projection);
    data.queue = [{
      id: "op-projection-disabled",
      kind: "task",
      entityId: ordinary.id,
      projectId: projection.projectId,
      operation: "update",
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      attempts: 0,
      status: "pending",
      idempotencyFingerprint: "helix-action:project-a:stage-a:uuid-b",
      base: ordinarySnapshot,
      local: projectionSnapshot,
    }, {
      id: "op-ordinary",
      kind: "task",
      entityId: ordinary.id,
      projectId: ordinary.projectId,
      operation: "update",
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      attempts: 0,
      status: "pending",
      base: ordinarySnapshot,
      local: ordinarySnapshot,
      writeFields: ["title"],
    }];
    let persisted = structuredClone(data);
    const store = new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
    });
    const service = new HelixService(store, { getDidaToken: () => "token" } as HelixSecretStore);
    await service.initialize();
    const processed: string[] = [];
    Object.defineProperty(service, "taskEngine", {
      value: {
        async process(operation: SyncQueueOperation<DidaTask>) {
          processed.push(operation.id);
          return { outcome: "pushed" as const, snapshot: operation.local };
        },
      },
    });

    await (service as unknown as { drainQueue(): Promise<void> }).drainQueue();

    expect(processed).toEqual(["op-ordinary"]);
    expect(persisted.queue).toEqual([expect.objectContaining({
      id: "op-projection-disabled",
      status: "pending",
      attempts: 0,
    })]);
    await store.mutate((draft) => {
      draft.queue[0]!.status = "failed";
      draft.queue[0]!.lastError = "historic projection failure";
    });
    await expect(service.retryFailedOperation("op-projection-disabled"))
      .rejects.toThrow(/正式版暂未开放/);
    expect(persisted.queue[0]).toMatchObject({
      id: "op-projection-disabled",
      status: "failed",
      attempts: 0,
      lastError: "historic projection failure",
    });
    expect(processed).toEqual(["op-ordinary"]);
  });

  it("recovers a verified projection receipt only from a matching Base snapshot", async () => {
    const data = createDefaultData("device-projection-receipt");
    const marker = "helix-action-projection:uuid-c";
    const remote: DidaTask = {
      id: "remote-projection-c",
      projectId: "target-list",
      title: "Projection",
      content: marker,
      status: 0,
    };
    data.baseSnapshots[`task:${remote.id}`] = createSnapshot("task", remote.id, remote);
    data.projectionOperationReceipts = [{
      clientIdentity: "helix-action:project-a:stage-a:uuid-c",
      projectId: remote.projectId,
      operationId: "op-projection-c",
      marker,
      outcome: "verified",
      remoteTaskId: remote.id,
    }];
    let persisted = structuredClone(data);
    const store = new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
    });
    const service = new HelixService(store, { getDidaToken: () => "token" } as HelixSecretStore);
    await service.initialize();

    await expect(service.recoverProjectionCreate(
      "helix-action:project-a:stage-a:uuid-c",
      "target-list",
    )).resolves.toMatchObject({ outcome: "verified", task: remote });
    expect(persisted.projectionOperationReceipts[0]).not.toHaveProperty("task");

    await store.mutate((draft) => {
      draft.baseSnapshots[`task:${remote.id}`] = createSnapshot("task", remote.id, {
        ...remote,
        content: "foreign-marker",
      });
    });
    await expect(service.recoverProjectionCreate(
      "helix-action:project-a:stage-a:uuid-c",
      "target-list",
    )).resolves.toMatchObject({ outcome: "conflict" });

    await store.mutate((draft) => {
      draft.baseSnapshots[`task:${remote.id}`] = createSnapshot("task", remote.id, {
        ...remote,
        projectId: "foreign-list",
      });
    });
    await expect(service.recoverProjectionCreate(
      "helix-action:project-a:stage-a:uuid-c",
      "target-list",
    )).resolves.toMatchObject({ outcome: "conflict" });
  });

  it("stages item conflicts from the projection ledger Base even when ordinary sync Base already absorbed remote edits", async () => {
    const data = createDefaultData("device-projection-owned-base");
    grantTaskCrud(data);
    const remote: DidaTask = {
      id: "parent-owned-base", projectId: "target-list", title: "Parent", status: 0,
      content: "helix-project-projection:project-a",
      items: [{ id: "owned", title: "远端改名", status: 0 }],
    };
    data.baseSnapshots[`task:${remote.id}`] = createSnapshot("task", remote.id, remote);
    let persisted = structuredClone(data);
    const service = new HelixService(new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
    }), { getDidaToken: () => "token" } as HelixSecretStore, {
      projectDidaProjectionAvailable: true,
    });
    await service.initialize();
    const projectionBase: DidaTask = {
      ...remote,
      items: [{ id: "owned", title: "投影账本旧标题", status: 0 }],
    };
    const local: DidaTask = {
      ...remote,
      items: [{ id: "owned", title: "本地改名", status: 0 }],
    };

    const receipt = await service.stageProjectionItemsConflict(local, remote, projectionBase, "op-owned-base");

    expect(receipt.outcome).toBe("conflict");
    expect(persisted.conflicts[0]?.base.value).toEqual(projectionBase);
    expect(persisted.conflicts[0]?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "items[owned].title", sameResult: false }),
    ]));

    const disabled = new HelixService(new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
    }), { getDidaToken: () => "token" } as HelixSecretStore);
    await disabled.initialize();
    let remoteCalls = 0;
    Object.defineProperty(disabled, "taskEngine", {
      value: { async process() { remoteCalls += 1; throw new Error("must not run"); } },
    });
    const conflictId = persisted.conflicts[0]!.id;
    await expect(disabled.chooseConflict(conflictId, "items[owned].title", "local"))
      .rejects.toThrow(/暂未开放/);
    await expect(disabled.applyConflict(conflictId))
      .rejects.toThrow(/暂未开放/);
    expect(remoteCalls).toBe(0);
    expect(persisted.conflicts[0]).toMatchObject({ id: conflictId, status: "open" });
  });

  it("blocks projection reopen before queue or network when reopen was not verified", async () => {
    const data = createDefaultData("device-projection-reopen-gate");
    grantTaskCrud(data);
    data.didaContractCapabilities!.taskReopenVerified = false;
    const task: DidaTask = {
      id: "task-completed",
      projectId: "target-list",
      title: "Completed",
      content: "helix-action-projection:uuid-d",
      status: 2,
      completedTime: "2026-08-05T00:00:00.000Z",
    };
    const snapshot = createSnapshot("task", task.id, task);
    data.baseSnapshots[`task:${task.id}`] = snapshot;
    data.localSnapshots[`task:${task.id}`] = snapshot;
    let persisted = structuredClone(data);
    const service = new HelixService(new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
    }), { getDidaToken: () => "token" } as HelixSecretStore, {
      projectDidaProjectionAvailable: true,
    });
    await service.initialize();
    let networkCalls = 0;
    Object.defineProperty(service, "taskEngine", {
      value: { async process() { networkCalls += 1; throw new Error("must not run"); } },
    });

    await expect(service.enqueueProjectionReopen({ ...task, status: 0, completedTime: null }))
      .rejects.toThrow(/重开能力/);
    expect(networkCalls).toBe(0);
    expect(persisted.queue).toEqual([]);
  });

  it("keeps projection enqueue out while an authorization switch owns the exclusive gate", async () => {
    const data = createDefaultData("device-projection-auth-race");
    grantTaskCrud(data);
    data.didaContractCapabilities!.taskReopenVerified = true;
    let persisted = structuredClone(data);
    let token: string | null = "token";
    let latch: DidaRequestEmergencyLatch | null = null;
    let blockNextSave = false;
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    let saveStarted!: () => void;
    const didStartSave = new Promise<void>((resolve) => { saveStarted = resolve; });
    const service = new HelixService(new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) {
        if (blockNextSave) {
          blockNextSave = false;
          saveStarted();
          await saveGate;
        }
        persisted = structuredClone(value) as typeof persisted;
      },
    }), {
      getDidaToken: () => token,
      setDidaToken(value: string) { token = value; },
      clearDidaToken() { token = null; },
      setDidaRequestEmergencyLatch(value: DidaRequestEmergencyLatch) { latch = value; },
      clearDidaRequestEmergencyLatch() { latch = null; },
      getDidaRequestEmergencyLatch() { return latch; },
    } as unknown as HelixSecretStore);
    await service.initialize();
    let networkCalls = 0;
    Object.defineProperty(service, "taskEngine", {
      value: { async process() { networkCalls += 1; throw new Error("must not run"); } },
    });
    blockNextSave = true;
    const switching = service.replaceDidaToken("replacement-token-12345");
    await didStartSave;

    await expect(service.enqueueProjectionCreate({
      id: "pending-auth-race",
      projectId: "target-list",
      title: "Blocked during switch",
      content: "helix-action-projection:uuid-auth-race",
      parentId: "parent-a",
      columnId: "column-a",
      status: 0,
    }, "helix-action:project-a:stage-a:uuid-auth-race"))
      .rejects.toThrow(/API 口令切换正在进行/);
    expect(networkCalls).toBe(0);
    expect(persisted.queue).toEqual([]);

    releaseSave();
    await switching;
    expect(token).toBe("replacement-token-12345");
    expect(service.snapshot().taskCrudVerified).toBe(false);
    expect(persisted.queue).toEqual([]);
  });
});
