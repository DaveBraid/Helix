import { describe, expect, it, vi } from "vitest";
import { didaAuthorizationBinding } from "../src/domain/dida-authorization";
import type { App } from "obsidian";
import type { DidaApi } from "../src/integrations/dida/api";
import type { DidaProject, DidaTask } from "../src/domain/entities";
import { HelixService } from "../src/services/helix-service";
import { HelixDataStore, type PluginDataPort } from "../src/storage/data-store";
import { createDefaultData } from "../src/storage/model";
import { HelixSecretStore } from "../src/storage/secrets";
import { createSnapshot } from "../src/sync/snapshots";
import type { SyncQueueOperation } from "../src/sync/types";
import { DIDA_CONTRACT_PROBE_VERSION } from "../src/domain/task-schedule";
import { DIDA_RATE_LIMIT_PERSISTENCE_RECOVERY_ISSUE } from "../src/integrations/dida/request-governor";

describe("HelixService contract-test exclusivity", () => {
  it("opens the isolated contract path without opening ordinary task writes", async () => {
    const { service } = await serviceFixture({
      didaReadAvailable: true,
      didaTaskWriteAvailable: false,
      didaContractTestAvailable: true,
      projectDidaProjectionAvailable: false,
    });
    const api = serviceApi(service);
    let contractCreates = 0;
    let ordinaryCreates = 0;
    api.getProjects = async () => [];
    api.createProject = async () => {
      contractCreates += 1;
      throw new Error("intentional contract boundary stop");
    };
    api.createTask = async () => {
      ordinaryCreates += 1;
      throw new Error("ordinary write must not run");
    };

    const report = await service.runDidaWriteContractTest();
    expect(report.status).toBe("failed");
    expect(contractCreates).toBe(1);
    await expect(service.createTask("blocked", "project-a"))
      .rejects.toThrow(/暂未开放滴答普通任务写入/);
    expect(ordinaryCreates).toBe(0);
  });

  it("preserves quick-entry task attributes through the normal create queue", async () => {
    const { service } = await serviceFixture();
    const api = serviceApi(service);
    let created: DidaTask | undefined;
    api.createTask = async (value) => {
      created = { ...value, id: "remote-quick", status: 0 } as DidaTask;
      return created;
    };
    api.getTask = async () => created!;

    await service.createTask("快速任务", "project-a", {
      priority: 5,
      tags: ["科研", "科研", "实验"],
    });
    expect(created).toMatchObject({
      title: "快速任务",
      projectId: "project-a",
      priority: 5,
      tags: ["实验", "科研"],
    });
    expect(service.snapshot().tasks.find((task) => task.id === "remote-quick"))
      .toMatchObject({ priority: 5, tags: ["实验", "科研"] });
  });

  it("creates a list through the project queue and rejects a duplicate name", async () => {
    const { service } = await serviceFixture();
    const api = serviceApi(service);
    let created: DidaProject | undefined;
    let createCalls = 0;
    api.createProject = async (value) => {
      createCalls += 1;
      created = { ...value, id: "remote-list" } as DidaProject;
      return created;
    };
    api.getProject = async () => created!;

    await service.createDidaProject("论文实验", "#5268d4");
    expect(service.snapshot().projects.find((project) => project.id === "remote-list"))
      .toMatchObject({
      id: "remote-list",
      name: "论文实验",
      color: "#5268d4",
      });
    await expect(service.createDidaProject("论文实验", "#5268d4"))
      .rejects.toThrow(/同名清单/);
    expect(createCalls).toBe(1);
  });

  it("rejects an invalid list color before enqueueing a remote write", async () => {
    const { service } = await serviceFixture();
    const api = serviceApi(service);
    let createCalls = 0;
    api.createProject = async () => {
      createCalls += 1;
      throw new Error("should not write");
    };

    await expect(service.createDidaProject("错误颜色", "red"))
      .rejects.toThrow(/#RRGGBB/);
    expect(createCalls).toBe(0);
  });

  it("blocks tasks from referencing a list whose remote identity needs confirmation", async () => {
    const { service } = await serviceFixture();
    const api = serviceApi(service);
    api.createProject = async (value) => ({ ...value, id: "remote-uncertain" }) as DidaProject;
    api.getProject = async () => {
      throw new Error("temporary reread failure");
    };
    let taskCreateCalls = 0;
    api.createTask = async (value) => {
      taskCreateCalls += 1;
      return { ...value, id: "must-not-run", status: 0 } as DidaTask;
    };

    await expect(service.createDidaProject("待核对清单", "#5268d4"))
      .rejects.toThrow(/复读验证失败/);
    const localProject = service.snapshot().projects.find((project) =>
      project.id.startsWith("local-project-"));
    expect(localProject?.name).toBe("待核对清单");
    await expect(service.createTask("禁止提交", localProject!.id))
      .rejects.toThrow(/尚未取得滴答远端 ID/);
    expect(taskCreateCalls).toBe(0);
    const pending = (await service.diagnosticSummary()).queue as Array<{
      id: string;
      kind: string;
      status: string;
      remoteOutcomeUnknown?: boolean;
    }>;
    expect(pending).toMatchObject([
      { kind: "project", status: "reconciliation", remoteOutcomeUnknown: true },
    ]);
    api.getProject = async () => ({
      id: "remote-uncertain",
      name: "待核对清单",
      color: "#5268d4",
    });
    service.sync = async () => undefined;
    await service.resolveUnknownCreate(pending[0]!.id, "confirmed", "remote-uncertain");
    expect((await service.diagnosticSummary()).queue).toEqual([]);
    let createdAfterClaim: DidaTask | undefined;
    api.createTask = async (value) => {
      createdAfterClaim = { ...value, id: "remote-task-after-claim", status: 0 } as DidaTask;
      return createdAfterClaim;
    };
    api.getTask = async () => createdAfterClaim!;
    await service.createTask("认领后创建", "remote-uncertain");
    expect(service.snapshot().tasks).toContainEqual(expect.objectContaining({
      id: "remote-task-after-claim",
      projectId: "remote-uncertain",
    }));
  });

  it("rejects contract startup while an ordinary remote write is in flight", async () => {
    const { service, secrets } = await serviceFixture();
    const api = serviceApi(service);
    const createStarted = deferred<void>();
    const allowCreate = deferred<void>();
    let created: DidaTask | null = null;
    api.createTask = async (value) => {
      createStarted.resolve();
      await allowCreate.promise;
      created = { ...value, id: "remote-task", status: 0 } as DidaTask;
      return created;
    };
    api.getTask = async () => created!;

    const ordinaryWrite = service.createTask("普通写入", "project-a");
    await createStarted.promise;
    await expect(service.runDidaWriteContractTest()).rejects.toThrow(/远端访问正在进行/);
    await expect(service.replaceDidaToken("replacement-token"))
      .rejects.toThrow(/远端访问正在进行/);
    expect(secrets.getDidaToken()).toBe("initial-contract-token");
    allowCreate.resolve();
    await ordinaryWrite;
  });

  it("blocks a new contract before any remote call while cleanup is pending", async () => {
    const { service, store } = await serviceFixture();
    const api = serviceApi(service);
    const getProjects = vi.fn(async () => []);
    api.getProjects = getProjects;
    await store.mutate((data) => {
      data.pendingDidaContractCleanup = {
        authorizationBinding: didaAuthorizationBinding("initial-contract-token"),
        plan: {
          runId: "pending-run",
          marker: "[Helix 合同测试 pending-run]",
          projects: [{
            id: "temporary-a",
            name: "[Helix 合同测试 pending-run] 清单 A",
            expectedColumns: [],
            baselineSource: "contract",
          }],
          tasks: [],
        },
      };
    });

    await expect(service.runDidaWriteContractTest()).rejects.toThrow(/待安全清理/);
    expect(getProjects).not.toHaveBeenCalled();
  });

  it("persists an empty cleanup placeholder before the first remote create", async () => {
    const { service, store } = await serviceFixture();
    const api = serviceApi(service);
    api.getProjects = async () => [];
    let placeholderSeen = false;
    api.createProject = async () => {
      const pending = (await store.snapshot()).pendingDidaContractCleanup;
      placeholderSeen = Boolean(pending && pending.plan.projects.length === 0 &&
        pending.plan.tasks.length === 0 && pending.plan.marker.includes(pending.plan.runId));
      throw new Error("stop after placeholder assertion");
    };
    const report = await service.runDidaWriteContractTest();
    expect(report.status).toBe("failed");
    expect(placeholderSeen).toBe(true);
  });

  it("preserves a competing plan at the first runner checkpoint and stops later remote calls", async () => {
    const { service, store } = await serviceFixture();
    const api = serviceApi(service);
    api.getProjects = async () => [];
    let createCalls = 0;
    let rereadCalls = 0;
    let deleteCalls = 0;
    api.createProject = async (value) => {
      createCalls += 1;
      await store.mutate((data) => {
        data.pendingDidaContractCleanup = competingCleanupPlan();
      });
      return { id: "created-before-competition", name: value.name } as DidaProject;
    };
    api.getProject = async () => { rereadCalls += 1; throw new Error("must not reread"); };
    api.deleteProject = async () => { deleteCalls += 1; };

    let failure: unknown;
    try { await service.runDidaWriteContractTest(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/竞争/);
    expect({ createCalls, rereadCalls, deleteCalls }).toEqual({
      createCalls: 1, rereadCalls: 0, deleteCalls: 0,
    });
    await store.mutate(() => undefined);
    expect((await store.snapshot()).pendingDidaContractCleanup).toEqual(competingCleanupPlan());
  });

  it("preserves a plan that competes before final clear and performs no later remote calls", async () => {
    const { service, store } = await serviceFixture();
    const api = serviceApi(service);
    let remoteCalls = 0;
    api.getProjects = async () => {
      remoteCalls += 1;
      await store.mutate((data) => {
        data.pendingDidaContractCleanup = competingCleanupPlan();
      });
      throw new Error("stop after final-plan competition");
    };
    api.createProject = async () => { remoteCalls += 1; throw new Error("must not create"); };

    let failure: unknown;
    try { await service.runDidaWriteContractTest(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/竞争/);
    expect(remoteCalls).toBe(1);
    await store.mutate(() => undefined);
    expect((await store.snapshot()).pendingDidaContractCleanup).toEqual(competingCleanupPlan());
  });

  it("performs zero remote calls when the initial placeholder cannot persist", async () => {
    const { service, store } = await serviceFixture();
    const api = serviceApi(service);
    const getProjects = vi.fn(async () => []);
    api.getProjects = getProjects;
    const originalMutate = store.mutate.bind(store);
    let mutations = 0;
    store.mutate = async (mutator) => {
      mutations += 1;
      if (mutations === 2) throw new Error("placeholder persist failed");
      return originalMutate(mutator);
    };
    await expect(service.runDidaWriteContractTest()).rejects.toThrow(/placeholder persist failed/);
    expect(getProjects).not.toHaveBeenCalled();
  });

  it("blocks after a placeholder crash and strictly adopts only the same remote run after reload", async () => {
    const { store, reload } = await serviceFixture();
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const marker = `[Helix 合同测试 ${runId}]`;
    await store.mutate((data) => {
      data.pendingDidaContractCleanup = {
        authorizationBinding: didaAuthorizationBinding("initial-contract-token"),
        plan: { runId, marker, projects: [], tasks: [] },
      };
    });
    const replacement = await reload();
    const api = serviceApi(replacement);
    const projects = [
      { id: "temporary-a", name: `${marker} 清单 A` },
      { id: "temporary-b", name: `${marker} 清单 B` },
    ];
    const getProjects = vi.fn(async () => projects);
    api.getProjects = getProjects;
    api.getProjectData = async (id) => ({
      project: projects.find((project) => project.id === id)!,
      tasks: [],
      columns: [],
    });
    api.getColumns = async () => [];
    api.getCompletedTasks = async () => [];

    await expect(replacement.runDidaWriteContractTest()).rejects.toThrow(/待安全清理/);
    expect(getProjects).not.toHaveBeenCalled();
    await replacement.adoptPendingContractRunFromRemote();
    const replacementStore = (replacement as unknown as { store: HelixDataStore }).store;
    expect((await replacementStore.snapshot()).pendingDidaContractCleanup?.plan.projects)
      .toHaveLength(2);
  });

  it("rechecks pending cleanup inside the exclusive gate before any remote call", async () => {
    const { service, store } = await serviceFixture();
    const api = serviceApi(service);
    const getProjects = vi.fn(async () => []);
    api.getProjects = getProjects;
    const snapshotEntered = deferred<void>();
    const releaseSnapshot = deferred<void>();
    const originalSnapshot = store.snapshot.bind(store);
    let snapshotCount = 0;
    store.snapshot = async () => {
      snapshotCount += 1;
      // 第一次读取是进入写门之前的全局冷却断言；拦截写门内的 cleanup 复查。
      if (snapshotCount === 2) {
        snapshotEntered.resolve();
        await releaseSnapshot.promise;
      }
      return originalSnapshot();
    };

    const run = service.runDidaWriteContractTest();
    await snapshotEntered.promise;
    await expect(service.createTask("竞争写入", "project-a")).rejects.toThrow(/合同测试正在运行/);
    await store.mutate((data) => {
      data.pendingDidaContractCleanup = {
        authorizationBinding: didaAuthorizationBinding("initial-contract-token"),
        plan: {
          runId: "run-race",
          marker: "[Helix 合同测试 run-race]",
          projects: [],
          tasks: [],
        },
      };
    });
    releaseSnapshot.resolve();

    await expect(run).rejects.toThrow(/待安全清理/);
    expect(getProjects).not.toHaveBeenCalled();
  });

  it("blocks new writes and credential mutation until the contract run exits", async () => {
    const { service, secrets } = await serviceFixture();
    const api = serviceApi(service);
    const readStarted = deferred<void>();
    const allowRead = deferred<void>();
    api.getProjects = async () => {
      readStarted.resolve();
      await allowRead.promise;
      return [];
    };
    api.createProject = async () => {
      throw new Error("stop after exclusivity assertions");
    };

    const contractRun = service.runDidaWriteContractTest();
    await readStarted.promise;
    await expect(service.createTask("并发写入", "project-a")).rejects.toThrow(/合同测试正在运行/);
    expect(() => secrets.setDidaToken("replacement-token")).toThrow(/授权切换流程/);
    expect(() => secrets.clearDidaToken()).toThrow(/授权切换流程/);

    allowRead.resolve();
    const report = await contractRun;
    expect(report.status).toBe("failed");
    await service.replaceDidaToken("replacement-token");
    expect(secrets.getDidaToken()).toBe("replacement-token");
  });

  it("persists contract invalidation before a failed run and remains read-only after reload", async () => {
    const { service, secrets, store, reload } = await serviceFixture();
    const api = serviceApi(service);
    api.getProjects = async () => [];
    api.createProject = async () => {
      throw new Error("contract runner intentionally stopped");
    };

    const report = await service.runDidaWriteContractTest();

    expect(report.status).toBe("failed");
    expect((await store.snapshot()).didaContractCapabilities).toBeUndefined();
    expect(service.snapshot()).toMatchObject({
      taskScheduleMode: "unknown",
      taskCrudVerified: false,
      boardPlacementVerified: false,
      reminderWriteVerified: false,
      repeatWriteVerified: false,
      itemsRoundTripVerified: false,
    });
    const reloaded = await reload();
    expect(reloaded.snapshot()).toMatchObject({
      authorizationConfigured: true,
      taskScheduleMode: "unknown",
      taskCrudVerified: false,
      boardPlacementVerified: false,
      reminderWriteVerified: false,
      repeatWriteVerified: false,
      itemsRoundTripVerified: false,
    });
    expect(secrets.getDidaToken()).toBe("initial-contract-token");
  });

  it("pulls read-only data after invalidation without draining pending task or project writes", async () => {
    const { service, store } = await serviceFixture();
    const api = serviceApi(service);
    // 通过真实服务路径使当前 runtime 与持久缓存同时失效。
    api.getProjects = async () => [];
    api.createProject = async () => { throw new Error("contract runner intentionally stopped"); };
    await service.runDidaWriteContractTest();
    const pendingTask: DidaTask = {
      id: "pending-task", projectId: "project-1", title: "Pending task", status: 0,
    };
    const pendingProject: DidaProject = { id: "pending-project", name: "Pending project" };
    const taskBase = createSnapshot("task", pendingTask.id, pendingTask);
    const projectBase = createSnapshot("project", pendingProject.id, pendingProject);
    await store.mutate((data) => {
      data.queue = [
        {
          id: "pending-task-update", kind: "task", entityId: pendingTask.id,
          projectId: pendingTask.projectId, operation: "update", createdAt: "2026-08-04T00:00:00Z",
          updatedAt: "2026-08-04T00:00:00Z", attempts: 0, status: "pending", base: taskBase,
          local: createSnapshot("task", pendingTask.id, { ...pendingTask, title: "Local task" }),
          writeFields: ["title"],
        },
        {
          id: "pending-project-update", kind: "project", entityId: pendingProject.id,
          operation: "update", createdAt: "2026-08-04T00:00:01Z", updatedAt: "2026-08-04T00:00:01Z",
          attempts: 0, status: "pending", base: projectBase,
          local: createSnapshot("project", pendingProject.id, { ...pendingProject, name: "Local project" }),
          writeFields: ["name"],
        },
      ];
    });
    // 模拟一次完全只读拉取；任意生产写入或队列引擎调用都应使测试失败。
    let readCalls = 0;
    let writeCalls = 0;
    api.getProjects = async () => { readCalls += 1; return []; };
    api.filterTasks = async () => { readCalls += 1; return []; };
    api.getCompletedTasks = async () => { readCalls += 1; return []; };
    api.listHabits = async () => { readCalls += 1; return []; };
    api.listFocus = async () => { readCalls += 1; return []; };
    api.updateTask = async () => { writeCalls += 1; throw new Error("must not write"); };
    api.updateProject = async () => { writeCalls += 1; throw new Error("must not write"); };
    Object.defineProperty(service, "taskEngine", { value: { async process() { writeCalls += 1; throw new Error("must not drain"); } } });
    Object.defineProperty(service, "projectEngine", { value: { async process() { writeCalls += 1; throw new Error("must not drain"); } } });

    await service.sync();

    expect(readCalls).toBeGreaterThanOrEqual(3);
    expect(writeCalls).toBe(0);
    expect((await store.snapshot()).queue).toMatchObject([
      { id: "pending-task-update", status: "pending", attempts: 0 },
      { id: "pending-project-update", status: "pending", attempts: 0 },
    ]);
  });

  it("keeps the old credential when capability invalidation cannot be persisted", async () => {
    let persisted = createDefaultData("authorization-test-device");
    persisted.didaContractCapabilities = {
      probeVersion: DIDA_CONTRACT_PROBE_VERSION,
      authorizationBinding: didaAuthorizationBinding("initial-contract-token"),
      taskScheduleMode: "duration",
      boardPlacementVerified: true,
      verifiedAt: "2026-07-31T00:00:00.000Z",
    };
    let failSave = false;
    const store = new HelixDataStore({
      async loadData() {
        return structuredClone(persisted);
      },
      async saveData(value) {
        if (failSave) throw new Error("persist failed");
        persisted = structuredClone(value) as typeof persisted;
      },
    });
    const secretValues = new Map<string, string>();
    const secrets = new HelixSecretStore({
      secretStorage: {
        getSecret: (key: string) => secretValues.get(key) ?? null,
        setSecret: (key: string, value: string) => secretValues.set(key, value),
      },
    } as unknown as App);
    secrets.setDidaToken("initial-contract-token");
    const service = new HelixService(store, secrets);
    await service.initialize();
    failSave = true;

    await expect(service.replaceDidaToken("replacement-token")).rejects.toThrow("persist failed");
    expect(secrets.getDidaToken()).toBe("initial-contract-token");
    expect(secrets.getDidaRequestEmergencyLatch()).toMatchObject({
      reason: "authorization-transition",
      authorizationBinding: didaAuthorizationBinding("initial-contract-token"),
      targetAuthorizationBinding: didaAuthorizationBinding("replacement-token"),
      stage: "prepared",
    });
    const request = vi.fn(async () => { throw new Error("transport must not run"); });
    Object.defineProperty(serviceApi(service), "transport", { value: { request } });
    await expect(service.verifyRemoteTask("project", "task"))
      .rejects.toMatchObject({ requestNotSent: true });
    expect(request).not.toHaveBeenCalled();
    expect(persisted.didaContractCapabilities?.taskScheduleMode).toBe("duration");
    expect(service.snapshot().taskScheduleMode).toBe("duration");
    expect(service.snapshot().boardPlacementVerified).toBe(true);
  });

  it("keeps a transition latch and sends nothing when SecretStorage rejects the token write", async () => {
    let persisted = createDefaultData("contract-secret-failure");
    const values = new Map<string, string>();
    let rejectTokenWrite = false;
    const secrets = new HelixSecretStore({
      secretStorage: {
        getSecret: (key: string) => values.get(key) ?? null,
        setSecret: (key: string, value: string) => {
          if (rejectTokenWrite && key === "helix-productivity-dida-token") {
            throw new Error("secret write failed");
          }
          values.set(key, value);
        },
      },
    } as unknown as App);
    secrets.setDidaToken("initial-contract-token");
    const service = new HelixService(new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
    }), secrets);
    await service.initialize();
    rejectTokenWrite = true;

    await expect(service.replaceDidaToken("replacement-contract-token"))
      .rejects.toThrow(/secret write failed/);
    expect(secrets.getDidaRequestEmergencyLatch()).toMatchObject({
      reason: "authorization-transition",
      stage: "prepared",
    });
    const request = vi.fn(async () => { throw new Error("transport must not run"); });
    Object.defineProperty(serviceApi(service), "transport", { value: { request } });
    await expect(service.verifyRemoteTask("project", "task"))
      .rejects.toMatchObject({ requestNotSent: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("clears an old emergency latch only after the replacement binding is persisted", async () => {
    const { service, secrets, store } = await serviceFixture();
    secrets.setDidaRequestEmergencyLatch({
      version: 1,
      authorizationBinding: didaAuthorizationBinding("initial-contract-token"),
      reason: "rate-limit-persistence-failed",
      createdAt: "2026-08-07T00:00:00.000Z",
    });

    await service.replaceDidaToken("replacement-contract-token");

    expect(secrets.getDidaRequestEmergencyLatch()).toBeNull();
    expect((await store.snapshot()).didaRequestControl?.authorizationBinding)
      .toBe(didaAuthorizationBinding("replacement-contract-token"));
  });

  it("keeps the same-authorization cooldown and latch closed", async () => {
    const { service, secrets, store } = await serviceFixture();
    const binding = didaAuthorizationBinding("initial-contract-token");
    await store.mutate((data) => {
      data.didaRequestControl = {
        authorizationBinding: binding,
        cooldownUntil: "2099-01-01T00:00:00.000Z",
        queryLimitLevel: 1,
        cooldownProbeUsed: false,
        recoveryReadPending: false,
        requestCounts: { project: 1, task: 2, habit: 0, focus: 0, other: 0 },
        rateLimitCount: 1,
      };
    });
    secrets.setDidaRequestEmergencyLatch({
      version: 1,
      authorizationBinding: binding,
      reason: "rate-limit-persistence-failed",
      createdAt: "2026-08-07T00:00:00.000Z",
    });
    const before = (await store.snapshot()).didaRequestControl;

    await service.replaceDidaToken("initial-contract-token");

    expect((await store.snapshot()).didaRequestControl).toEqual(before);
    expect(secrets.getDidaRequestEmergencyLatch()?.authorizationBinding).toBe(binding);
    const request = vi.fn(async () => { throw new Error("transport must not run"); });
    Object.defineProperty(serviceApi(service), "transport", { value: { request } });
    await expect(service.verifyRemoteTask("project", "task"))
      .rejects.toMatchObject({ requestNotSent: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a rate-limit latch across clear and restoring the same token after reload", async () => {
    const fixture = await serviceFixture();
    const binding = didaAuthorizationBinding("initial-contract-token");
    fixture.secrets.setDidaRequestEmergencyLatch({
      version: 1,
      authorizationBinding: binding,
      reason: "rate-limit-persistence-failed",
      createdAt: "2026-08-07T00:00:00.000Z",
    });
    await fixture.service.clearDidaToken();
    expect(fixture.secrets.getDidaRequestEmergencyLatch()?.authorizationBinding).toBe(binding);
    await fixture.service.replaceDidaToken("initial-contract-token");
    expect(fixture.secrets.getDidaRequestEmergencyLatch()?.authorizationBinding).toBe(binding);

    const reloaded = await fixture.reload();
    const request = vi.fn(async () => { throw new Error("transport must not run"); });
    Object.defineProperty(serviceApi(reloaded), "transport", { value: { request } });
    await expect(reloaded.verifyRemoteTask("project", "task"))
      .rejects.toMatchObject({ requestNotSent: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("clears only the rate-limit runtime issue after a genuine authorization replacement", async () => {
    const { service, secrets } = await serviceFixture();
    const binding = didaAuthorizationBinding("initial-contract-token");
    secrets.setDidaRequestEmergencyLatch({
      version: 1,
      authorizationBinding: binding,
      reason: "rate-limit-persistence-failed",
      createdAt: "2026-08-07T00:00:00.000Z",
    });
    const blockedRequest = vi.fn(async () => { throw new Error("transport must not run"); });
    Object.defineProperty(serviceApi(service), "transport", { value: { request: blockedRequest }, configurable: true });
    await expect(service.verifyRemoteTask("project", "task"))
      .rejects.toMatchObject({ requestNotSent: true });
    service.reportRecoveryIssue(DIDA_RATE_LIMIT_PERSISTENCE_RECOVERY_ISSUE);

    await service.replaceDidaToken("replacement-contract-token");
    expect(service.snapshot().recoveryIssues).toEqual([]);
    const request = vi.fn(async () => ({
      status: 200,
      headers: {},
      data: { id: "task", projectId: "project", title: "ok", status: 0 },
      text: "",
    }));
    Object.defineProperty(serviceApi(service), "transport", { value: { request }, configurable: true });
    await expect(service.verifyRemoteTask("project", "task")).resolves.toMatchObject({ id: "task" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves unrelated runtime recovery issues during authorization replacement", async () => {
    const { service } = await serviceFixture();
    service.reportRecoveryIssue(DIDA_RATE_LIMIT_PERSISTENCE_RECOVERY_ISSUE);
    service.reportRecoveryIssue("unrelated recovery issue");
    await service.replaceDidaToken("replacement-contract-token");
    expect(service.snapshot().recoveryIssues).toEqual(["unrelated recovery issue"]);
  });

  it("publishes the committed authorization without a fallible post-commit store snapshot", async () => {
    let persisted = createDefaultData("contract-post-commit-snapshot");
    let committed = false;
    const store = new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) {
        persisted = structuredClone(value) as typeof persisted;
        committed = true;
      },
    });
    const values = new Map<string, string>();
    const secrets = new HelixSecretStore({
      secretStorage: {
        getSecret: (key: string) => values.get(key) ?? null,
        setSecret: (key: string, value: string) => values.set(key, value),
      },
    } as unknown as App);
    secrets.setDidaToken("initial-contract-token");
    const service = new HelixService(store, secrets);
    await service.initialize();
    committed = false;
    const originalSnapshot = store.snapshot.bind(store);
    store.snapshot = async () => {
      if (committed) throw new Error("post-commit snapshot must not run");
      return originalSnapshot();
    };

    await expect(service.replaceDidaToken("replacement-contract-token")).resolves.toBeUndefined();
    expect(secrets.getDidaToken()).toBe("replacement-contract-token");
    expect(service.snapshot()).toMatchObject({
      authorizationConfigured: true,
      taskScheduleMode: "unknown",
      connected: false,
    });
    expect(secrets.getDidaRequestEmergencyLatch()).toBeNull();
  });

  it("rejects credential switching while a synchronization read is in flight", async () => {
    const { service, secrets } = await serviceFixture();
    const api = serviceApi(service);
    const readStarted = deferred<void>();
    const allowReadToFail = deferred<void>();
    api.getProjects = async () => {
      readStarted.resolve();
      await allowReadToFail.promise;
      throw new Error("stop synchronization after lease assertion");
    };

    const synchronization = service.sync();
    await readStarted.promise;
    await expect(service.replaceDidaToken("replacement-token"))
      .rejects.toThrow(/远端访问正在进行/);
    expect(secrets.getDidaToken()).toBe("initial-contract-token");

    allowReadToFail.resolve();
    await expect(synchronization).rejects.toThrow(/stop synchronization/);
  });

  it("holds the authorization lease while a failed queue operation is reactivated", async () => {
    const task: DidaTask = {
      id: "task-retry",
      projectId: "project-a",
      title: "Retry",
      status: 0,
    };
    const base = createSnapshot("task", task.id, task);
    const local = createSnapshot("task", task.id, { ...task, title: "Retry edited" });
    let persisted = createDefaultData("retry-lease-device");
    persisted.baseSnapshots[`task:${task.id}`] = base;
    persisted.localSnapshots[`task:${task.id}`] = local;
    persisted.queue = [{
      id: "op-retry",
      kind: "task",
      entityId: task.id,
      projectId: task.projectId,
      operation: "update",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      attempts: 1,
      status: "failed",
      lastError: "temporary failure",
      base,
      local,
    } satisfies SyncQueueOperation<DidaTask>];
    let blockSave = false;
    const retryPersistStarted = deferred<void>();
    const allowRetryPersist = deferred<void>();
    const store = new HelixDataStore({
      async loadData() {
        return structuredClone(persisted);
      },
      async saveData(value) {
        if (blockSave) {
          retryPersistStarted.resolve();
          await allowRetryPersist.promise;
          blockSave = false;
        }
        persisted = structuredClone(value) as typeof persisted;
      },
    });
    const secretValues = new Map<string, string>();
    const secrets = new HelixSecretStore({
      secretStorage: {
        getSecret: (key: string) => secretValues.get(key) ?? null,
        setSecret: (key: string, value: string) => secretValues.set(key, value),
      },
    } as unknown as App);
    secrets.setDidaToken("initial-contract-token");
    const service = new HelixService(store, secrets);
    await service.initialize();
    Object.defineProperty(service, "taskEngine", {
      value: {
        async process(operation: SyncQueueOperation<DidaTask>) {
          return { outcome: "pushed", snapshot: operation.local };
        },
      },
    });
    blockSave = true;

    const retry = service.retryFailedOperation("op-retry");
    await retryPersistStarted.promise;
    await expect(service.replaceDidaToken("replacement-token"))
      .rejects.toThrow(/远端访问正在进行/);
    expect(secrets.getDidaToken()).toBe("initial-contract-token");

    allowRetryPersist.resolve();
    await retry;
  });
});

async function serviceFixture(options: {
  didaReadAvailable?: boolean;
  didaTaskWriteAvailable?: boolean;
  didaContractTestAvailable?: boolean;
  projectDidaProjectionAvailable?: boolean;
} = {}): Promise<{
  service: HelixService;
  secrets: HelixSecretStore;
  store: HelixDataStore;
  reload: () => Promise<HelixService>;
}> {
  let persisted = createDefaultData("contract-test-device");
  persisted.didaContractCapabilities = {
    probeVersion: DIDA_CONTRACT_PROBE_VERSION,
    authorizationBinding: didaAuthorizationBinding("initial-contract-token"),
    taskScheduleMode: "duration",
    boardPlacementVerified: true,
    taskCrudVerified: true,
    reminderWriteVerified: true,
    repeatWriteVerified: true,
    itemsRoundTripVerified: true,
    verifiedAt: "2026-08-03T00:00:00.000Z",
  };
  const port: PluginDataPort = {
    async loadData() {
      return structuredClone(persisted);
    },
    async saveData(value) {
      persisted = structuredClone(value) as typeof persisted;
    },
  };
  const secretValues = new Map<string, string>();
  const app = {
    secretStorage: {
      getSecret: (key: string) => secretValues.get(key) ?? null,
      setSecret: (key: string, value: string) => secretValues.set(key, value),
    },
  } as unknown as App;
  const secrets = new HelixSecretStore(app);
  secrets.setDidaToken("initial-contract-token");
  const store = new HelixDataStore(port);
  const service = new HelixService(store, secrets, options);
  await service.initialize();
  return {
    service,
    secrets,
    store,
    async reload() {
      const replacement = new HelixService(new HelixDataStore(port), secrets, options);
      await replacement.initialize();
      return replacement;
    },
  };
}

function serviceApi(service: HelixService): DidaApi {
  const api = (service as unknown as { api: DidaApi }).api;
  api.withRequestPolicy = () => api;
  return api;
}

function competingCleanupPlan() {
  const runId = "run-competing";
  return {
    authorizationBinding: didaAuthorizationBinding("initial-contract-token"),
    plan: {
      runId,
      marker: `[Helix 合同测试 ${runId}]`,
      projects: [],
      tasks: [],
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
