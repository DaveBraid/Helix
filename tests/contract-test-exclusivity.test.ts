import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { DidaApi } from "../src/integrations/dida/api";
import type { DidaTask } from "../src/domain/entities";
import { HelixService } from "../src/services/helix-service";
import { HelixDataStore, type PluginDataPort } from "../src/storage/data-store";
import { createDefaultData } from "../src/storage/model";
import { HelixSecretStore } from "../src/storage/secrets";
import { createSnapshot } from "../src/sync/snapshots";
import type { SyncQueueOperation } from "../src/sync/types";

describe("HelixService contract-test exclusivity", () => {
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

  it("keeps the old credential when capability invalidation cannot be persisted", async () => {
    let persisted = createDefaultData("authorization-test-device");
    persisted.didaContractCapabilities = {
      probeVersion: 2,
      taskScheduleMode: "duration",
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
    expect(persisted.didaContractCapabilities?.taskScheduleMode).toBe("duration");
    expect(service.snapshot().taskScheduleMode).toBe("duration");
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

async function serviceFixture(): Promise<{
  service: HelixService;
  secrets: HelixSecretStore;
}> {
  let persisted = createDefaultData("contract-test-device");
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
  const service = new HelixService(new HelixDataStore(port), secrets);
  await service.initialize();
  return { service, secrets };
}

function serviceApi(service: HelixService): DidaApi {
  const api = (service as unknown as { api: DidaApi }).api;
  api.withRequestPolicy = () => api;
  return api;
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
