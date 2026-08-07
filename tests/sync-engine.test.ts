import { describe, expect, it } from "vitest";
import type { DidaTask, EntityKind, EntitySnapshot } from "../src/domain/entities";
import { createSnapshot } from "../src/sync/snapshots";
import { SyncEngine } from "../src/sync/sync-engine";
import { verifyClientChecklistAppendResult } from "../src/domain/dida-project-projection";
import type {
  ConflictRepository,
  RemoteEntityAdapter,
  ResolutionAuditEntry,
  SnapshotRepository,
  SyncConflict,
  SyncQueueOperation,
  RemoteWriteContext,
} from "../src/sync/types";

class MemoryRepository implements SnapshotRepository, ConflictRepository {
  base: EntitySnapshot<unknown> | null = null;
  local: EntitySnapshot<unknown> | null = null;
  conflicts: SyncConflict[] = [];
  audit: ResolutionAuditEntry[] = [];

  async getBase<T>(_kind: EntityKind, _entityId: string): Promise<EntitySnapshot<T> | null> {
    return this.base as EntitySnapshot<T> | null;
  }
  async getLocal<T>(_kind: EntityKind, _entityId: string): Promise<EntitySnapshot<T> | null> {
    return this.local as EntitySnapshot<T> | null;
  }
  async saveBase<T>(snapshot: EntitySnapshot<T>): Promise<void> {
    this.base = snapshot as EntitySnapshot<unknown>;
  }
  async saveLocal<T>(snapshot: EntitySnapshot<T>): Promise<void> {
    this.local = snapshot as EntitySnapshot<unknown>;
  }
  async removeBase(): Promise<void> {
    this.base = null;
  }
  async removeLocal(): Promise<void> {
    this.local = null;
  }
  async list(): Promise<SyncConflict[]> {
    return this.conflicts;
  }
  async get(conflictId: string): Promise<SyncConflict | null> {
    return this.conflicts.find((conflict) => conflict.id === conflictId) ?? null;
  }
  async save(conflict: SyncConflict): Promise<void> {
    const index = this.conflicts.findIndex((item) => item.id === conflict.id);
    if (index < 0) this.conflicts.push(conflict);
    else this.conflicts[index] = conflict;
  }
  async remove(conflictId: string): Promise<void> {
    this.conflicts = this.conflicts.filter((conflict) => conflict.id !== conflictId);
  }
  async appendAudit(entry: ResolutionAuditEntry): Promise<void> {
    this.audit.push(entry);
  }
}

class TaskAdapter implements RemoteEntityAdapter<DidaTask> {
  readonly kind = "task" as const;
  value: DidaTask | null;
  getCount = 0;
  updateCount = 0;
  lastContext: RemoteWriteContext | undefined;
  advanceEtimestampOnUpdate = false;
  checklistAppendResult: DidaTask | null = null;

  constructor(value: DidaTask | null) {
    this.value = value;
  }
  async get(): Promise<DidaTask | null> {
    this.getCount += 1;
    return this.value ? structuredClone(this.value) : null;
  }
  async create(value: DidaTask): Promise<DidaTask> {
    this.value = { ...value, id: value.id || "restored" };
    return structuredClone(this.value);
  }
  async update(
    _entityId: string,
    value: DidaTask,
    context?: RemoteWriteContext,
  ): Promise<DidaTask> {
    this.updateCount += 1;
    this.lastContext = structuredClone(context);
    this.value = this.checklistAppendResult ? structuredClone(this.checklistAppendResult) : {
      ...structuredClone(value),
      ...(this.advanceEtimestampOnUpdate
        ? { etimestamp: Number(value.etimestamp ?? 0) + 1 }
        : {}),
    };
    return structuredClone(this.value);
  }
  async delete(): Promise<void> {
    this.value = null;
  }
}

function task(title: string): DidaTask {
  return { id: "task-1", projectId: "project-1", title, status: 0 };
}

function operation(local: DidaTask, base: EntitySnapshot<DidaTask>): SyncQueueOperation<DidaTask> {
  const now = "2026-07-30T00:00:00.000Z";
  return {
    id: "op-1",
    kind: "task",
    entityId: "task-1",
    projectId: "project-1",
    operation: "update",
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    status: "pending",
    base,
    local: createSnapshot("task", "task-1", local, { capturedAt: now }),
  };
}

describe("SyncEngine safety gates", () => {
  it("pushes the queued local snapshot even when the repository now holds a resolved snapshot", async () => {
    const base = createSnapshot("task", "task-1", task("base"));
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", task("previous-resolution"));
    const adapter = new TaskAdapter(task("base"));
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
    });

    const result = await engine.process(operation(task("queued-rename"), base));

    expect(result.outcome).toBe("pushed");
    expect(adapter.value?.title).toBe("queued-rename");
    expect((repository.local?.value as DidaTask).title).toBe("queued-rename");
  });

  it("passes persisted explicit field intent from queue processing to the adapter", async () => {
    const baseTask = { ...task("base"), reminders: ["TRIGGER:CUSTOM"] };
    const localTask = { ...baseTask, reminders: ["TRIGGER:-PT10M"] };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", localTask);
    const adapter = new TaskAdapter(baseTask);
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
    });
    const queued = operation(localTask, base);
    queued.writeFields = ["reminders"];

    await engine.process(queued);

    expect(adapter.lastContext).toEqual({
      projectId: "project-1",
      writeFields: ["reminders"],
    });
  });

  it("adopts a server-generated checklist ID and server order through a scoped verifier", async () => {
    const ordinary = { id: "ordinary-1", title: "用户原项", status: 0, sortOrder: 10 };
    const baseTask: DidaTask = { ...task("项目"), kind: "CHECKLIST", items: [ordinary] };
    const desiredTask: DidaTask = {
      ...baseTask,
      items: [...baseTask.items!, { id: "1785772800000", title: "Helix 行动", status: 0, sortOrder: 11 }],
    };
    const serverCreated = { id: "1785772800000", title: "Helix 行动", status: 0, sortOrder: 11 };
    const serverTask: DidaTask = { ...desiredTask, items: [serverCreated, ordinary] };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = base;
    const adapter = new TaskAdapter(baseTask);
    adapter.checklistAppendResult = serverTask;
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
      verifyWriteResult: (_queued, actualBase, desired, actual) =>
        verifyClientChecklistAppendResult(actualBase.value, desired.value, actual),
    });

    const result = await engine.process(operation(desiredTask, base));

    expect(result.outcome).toBe("pushed");
    expect((repository.base?.value as DidaTask).items?.map((item) => item.id))
      .toEqual(["1785772800000", "ordinary-1"]);
    expect(repository.conflicts).toEqual([]);
  });

  it("passes local and custom empty reminder resolutions through conflict apply with explicit intent", async () => {
    for (const choice of ["local", "custom"] as const) {
      const baseTask = { ...task("base"), reminders: ["TRIGGER:BASE"] };
      const localTask = { ...baseTask, reminders: [] as string[] };
      const remoteTask = { ...baseTask, reminders: ["TRIGGER:REMOTE"] };
      const base = createSnapshot("task", "task-1", baseTask);
      const repository = new MemoryRepository();
      repository.base = base;
      repository.local = createSnapshot("task", "task-1", localTask);
      const adapter = new TaskAdapter(remoteTask);
      const engine = new SyncEngine({
        adapter,
        snapshots: repository,
        conflicts: repository,
        deviceId: "device-a",
      });

      const result = await engine.process(operation(localTask, base));
      expect(result.outcome).toBe("conflict");
      if (result.outcome !== "conflict") throw new Error("expected reminder conflict");
      await engine.choose(result.conflict.id, "reminders", choice, choice === "custom" ? [] : undefined);
      const applied = await engine.applyConflict(result.conflict.id, { projectId: "project-1" });

      expect(applied.outcome).toBe("resolved");
      expect(adapter.lastContext).toEqual({ projectId: "project-1", writeFields: ["reminders"] });
      expect((adapter.value as DidaTask).reminders).toEqual([]);
      expect((repository.base?.value as DidaTask).reminders).toEqual([]);
      expect((repository.local?.value as DidaTask).reminders).toEqual([]);
    }
  });

  it("normalizes a locally chosen checklist-item conflict to the root items write intent", async () => {
    const baseTask = { ...task("base"), items: [{ id: "item-1", title: "base", status: 0 }] };
    const localTask = { ...baseTask, items: [{ id: "item-1", title: "local", status: 0 }] };
    const remoteTask = { ...baseTask, items: [{ id: "item-1", title: "remote", status: 0 }] };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", localTask);
    const adapter = new TaskAdapter(remoteTask);
    const engine = new SyncEngine({ adapter, snapshots: repository, conflicts: repository, deviceId: "device-a" });
    const result = await engine.process(operation(localTask, base));
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected items conflict");
    const field = result.conflict.fields.find((candidate) => candidate.path.startsWith("items"));
    expect(field).toBeDefined();
    await engine.choose(result.conflict.id, field!.path, "local");
    await engine.applyConflict(result.conflict.id, { projectId: "project-1" });
    expect(adapter.lastContext?.writeFields).toEqual(["items"]);
  });

  it("applies a custom owned title with completion and adopts the API reread completedTime", async () => {
    const baseTask = { ...task("base"), items: [{ id: "owned", title: "base", status: 0 }] };
    const localTask = { ...baseTask, items: [{ id: "owned", title: "local", status: 2 }] };
    let remote: DidaTask = { ...baseTask, items: [{ id: "owned", title: "remote", status: 0 }] };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", localTask);
    const adapter: RemoteEntityAdapter<DidaTask> = {
      kind: "task",
      async get() { return structuredClone(remote); },
      async create(value) { return structuredClone(value); },
      async update(_id, value) {
        remote = {
          ...value,
          items: value.items?.map((item) => item.status === 2
            ? { ...item, completedTime: "2026-08-05T00:00:00.000Z" }
            : item),
        };
        return structuredClone(remote);
      },
      async delete() { throw new Error("not used"); },
    };
    const engine = new SyncEngine({ adapter, snapshots: repository, conflicts: repository, deviceId: "device-a" });
    const result = await engine.process(operation(localTask, base));
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected items conflict");
    await engine.choose(result.conflict.id, "items[owned].title", "custom", "人工标题");
    const applied = await engine.applyConflict(result.conflict.id, { projectId: "project-1" });
    expect(applied.outcome).toBe("resolved");
    expect((applied as { snapshot: EntitySnapshot<DidaTask> }).snapshot.value.items?.[0]).toEqual({
      id: "owned", title: "人工标题", status: 2,
      completedTime: "2026-08-05T00:00:00.000Z",
    });
  });

  it.each([
    ["local", " 本地标题 ", "远端标题"],
    ["remote", "本地标题", " 远端标题 "],
    ["remote", "本地标题", "远端\n标题"],
    ["remote", "本地标题", "<!-- helix-dida-action:伪造 -->"],
  ] as const)("rejects an unsafe %s checklist title before conflict apply writes", async (choice, localTitle, remoteTitle) => {
    const baseTask = { ...task("base"), items: [{ id: "owned", title: "base", status: 0 }] };
    const localTask = { ...baseTask, items: [{ id: "owned", title: localTitle, status: 0 }] };
    const remoteTask = { ...baseTask, items: [{ id: "owned", title: remoteTitle, status: 0 }] };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", localTask);
    const adapter = new TaskAdapter(remoteTask);
    const engine = new SyncEngine({ adapter, snapshots: repository, conflicts: repository, deviceId: "device-a" });
    const result = await engine.process({
      ...operation(localTask, base),
      conflictScope: "helix-projection-owned-items",
      conflictOwnedItemIds: ["owned"],
    });
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected items conflict");
    await engine.choose(result.conflict.id, "items[owned].title", choice);
    await expect(engine.applyConflict(result.conflict.id, { projectId: "project-1" }))
      .rejects.toThrow(/所选检查项标题/);
    expect(adapter.updateCount).toBe(0);
    expect(repository.conflicts).toHaveLength(1);
  });

  it("allows an ordinary task checklist title with surrounding spaces to be resolved byte-exactly", async () => {
    const baseTask = { ...task("base"), items: [{ id: "ordinary", title: "base", status: 0 }] };
    const localTask = { ...baseTask, items: [{ id: "ordinary", title: "  普通滴答项  ", status: 0 }] };
    const remoteTask = { ...baseTask, items: [{ id: "ordinary", title: "remote", status: 0 }] };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", localTask);
    const adapter = new TaskAdapter(remoteTask);
    const engine = new SyncEngine({ adapter, snapshots: repository, conflicts: repository, deviceId: "device-a" });
    const result = await engine.process(operation(localTask, base));
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected items conflict");
    await engine.choose(result.conflict.id, "items[ordinary].title", "local");
    await expect(engine.applyConflict(result.conflict.id, { projectId: "project-1" })).resolves.toMatchObject({
      outcome: "resolved",
    });
    expect(adapter.value?.items?.[0]?.title).toBe("  普通滴答项  ");
  });

  it("validates only the persisted owned item ID inside a projection conflict", async () => {
    const baseTask = { ...task("base"), items: [
      { id: "owned", title: "base-owned", status: 0 },
      { id: "ordinary", title: "base-ordinary", status: 0 },
    ] };
    const localTask = { ...baseTask, items: [
      { id: "owned", title: "local-owned", status: 0 },
      { id: "ordinary", title: "base-ordinary", status: 0 },
    ] };
    const remoteTask = { ...baseTask, items: [
      { id: "owned", title: "remote-owned", status: 0 },
      { id: "ordinary", title: "  普通远端项  ", status: 0 },
    ] };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", localTask);
    const adapter = new TaskAdapter(remoteTask);
    const engine = new SyncEngine({ adapter, snapshots: repository, conflicts: repository, deviceId: "device-a" });
    const result = await engine.process({
      ...operation(localTask, base),
      conflictScope: "helix-projection-owned-items",
      conflictOwnedItemIds: ["owned"],
    });
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected items conflict");
    await engine.choose(result.conflict.id, "items[owned].title", "local");
    await engine.choose(result.conflict.id, "items[ordinary].title", "remote");
    await expect(engine.applyConflict(result.conflict.id, { projectId: "project-1" })).resolves.toMatchObject({
      outcome: "resolved",
    });
    expect(adapter.value?.items).toEqual([
      { id: "owned", title: "local-owned", status: 0 },
      { id: "ordinary", title: "  普通远端项  ", status: 0 },
    ]);
  });

  it("keeps App-owned remote completion when applying a local title resolution", async () => {
    const baseTask = { ...task("base"), status: 0, completedTime: null };
    const localTask = { ...baseTask, title: "local" };
    const remoteTask = {
      ...baseTask,
      status: 2,
      completedTime: "2026-08-04T08:00:00.000Z",
    };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", localTask);
    let remote = structuredClone(remoteTask);
    let updateContext: RemoteWriteContext | undefined;
    const adapter: RemoteEntityAdapter<DidaTask> = {
      kind: "task",
      async get() { return structuredClone(remote); },
      async create(value) { return structuredClone(value); },
      async update(_id, value, context) {
        updateContext = structuredClone(context);
        // 模拟真实适配器的白名单 wire：只有 title 进入本次更新，状态留给滴答 App。
        if (context?.writeFields?.includes("title")) remote.title = value.title;
        return structuredClone(remote);
      },
      async delete() { throw new Error("not used"); },
    };
    const engine = new SyncEngine({ adapter, snapshots: repository, conflicts: repository, deviceId: "device-a" });
    const result = await engine.process(operation(localTask, base));
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected conflict");
    expect(result.conflict.fields.map((field) => field.path)).toEqual(["title"]);
    await engine.choose(result.conflict.id, "title", "local");
    const applied = await engine.applyConflict(result.conflict.id, { projectId: "project-1" });

    expect(applied.outcome).toBe("resolved");
    expect(updateContext?.writeFields).toEqual(["title"]);
    expect((applied as { snapshot: EntitySnapshot<DidaTask> }).snapshot.value).toMatchObject({
      title: "local",
      status: 2,
      completedTime: "2026-08-04T08:00:00.000Z",
    });
    expect(repository.conflicts).toEqual([]);
  });

  it("accepts a production update when only server etimestamp advances", async () => {
    const baseTask = { ...task("base"), etimestamp: 10 };
    const localTask = { ...baseTask, title: "local" };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", localTask);
    const adapter = new TaskAdapter(baseTask);
    adapter.advanceEtimestampOnUpdate = true;
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
    });

    const result = await engine.process(operation(localTask, base));

    expect(result.outcome).toBe("pushed");
    expect(adapter.updateCount).toBe(1);
    expect(adapter.value).toMatchObject({ title: "local", etimestamp: 11 });
    expect(repository.conflicts).toHaveLength(0);
  });

  it("opens a conflict instead of writing when remote changes during preflight", async () => {
    const base = createSnapshot("task", "task-1", task("base"));
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", task("local"));
    const adapter = new TaskAdapter(task("base"));
    const originalGet = adapter.get.bind(adapter);
    adapter.get = async () => {
      const value = await originalGet();
      if (adapter.getCount === 1) adapter.value = task("changed-after-first-read");
      return value;
    };
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
    });
    const result = await engine.process(operation(task("local"), base));
    expect(result.outcome).toBe("conflict");
    expect(adapter.value?.title).toBe("changed-after-first-read");
    expect(repository.conflicts).toHaveLength(1);
  });

  it("returns a proven-unsent rebaseline result without opening a generic conflict", async () => {
    const base = createSnapshot("task", "task-1", task("base"));
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", task("local"));
    const adapter = new TaskAdapter(task("base"));
    const originalGet = adapter.get.bind(adapter);
    adapter.get = async () => {
      const value = await originalGet();
      if (adapter.getCount === 1) adapter.value = task("changed-after-first-read");
      return value;
    };
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
      allowUnsentRebaseline: () => true,
    });
    const result = await engine.process(operation(task("local"), base));
    expect(result.outcome).toBe("preflight-changed");
    expect(adapter.updateCount).toBe(0);
    expect(repository.conflicts).toEqual([]);
    expect((repository.base?.value as DidaTask).title).toBe("changed-after-first-read");
  });

  it("treats the CHECKLIST kind transition as part of an items write and verifies without a false conflict", async () => {
    const baseTask = { ...task("parent"), kind: "TEXT", items: [{ id: "owned", title: "old", status: 0 }] };
    const desired = { ...baseTask, kind: "CHECKLIST", items: [{ id: "owned", title: "new", status: 0 }] };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", desired);
    const adapter = new TaskAdapter(baseTask);
    const engine = new SyncEngine({ adapter, snapshots: repository, conflicts: repository, deviceId: "device-a" });
    const result = await engine.process({
      ...operation(desired, base),
      writeFields: ["items", "kind"],
    });
    expect(result.outcome).toBe("pushed");
    expect(adapter.lastContext?.writeFields).toEqual(["items", "kind"]);
    expect(adapter.value).toMatchObject({ kind: "CHECKLIST", items: [{ id: "owned", title: "new", status: 0 }] });
    expect(repository.conflicts).toEqual([]);
  });

  it("carries the derived CHECKLIST kind through Base/Local/Remote conflict resolution", async () => {
    const baseTask = { ...task("parent"), kind: "TEXT", items: [{ id: "owned", title: "base", status: 0 }] };
    const localTask = { ...baseTask, kind: "CHECKLIST", items: [{ id: "owned", title: "local", status: 0 }] };
    const remoteTask = { ...baseTask, items: [{ id: "owned", title: "remote", status: 0 }] };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", localTask);
    const adapter = new TaskAdapter(remoteTask);
    const engine = new SyncEngine({ adapter, snapshots: repository, conflicts: repository, deviceId: "device-a" });
    const result = await engine.process({
      ...operation(localTask, base),
      writeFields: ["items", "kind"],
      conflictScope: "helix-projection-owned-items",
      conflictOwnedItemIds: ["owned"],
    });
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected conflict");
    expect(result.conflict.fields.find((field) => field.path === "kind")?.choice).toBe("local");
    await engine.choose(result.conflict.id, "items[owned].title", "local");
    adapter.value = { ...remoteTask, kind: "NOTE" };
    const refreshed = await engine.applyConflict(result.conflict.id, { projectId: "project-1" });
    expect(refreshed.outcome).toBe("remote-changed");
    if (refreshed.outcome !== "remote-changed") throw new Error("expected refreshed conflict");
    expect(refreshed.conflict.fields.find((field) => field.path === "kind")?.choice).toBe("local");
    await expect(engine.choose(result.conflict.id, "kind", "remote")).rejects.toThrow(/固定为 Local/);
    await expect(engine.choose(result.conflict.id, "kind", "custom", "NOTE")).rejects.toThrow(/固定为 Local/);
    expect(repository.conflicts[0]?.fields.find((field) => field.path === "kind")?.choice).toBe("local");
    // 模拟旧版本已持久化的非法选择；apply 必须再次强制回 Local。
    repository.conflicts[0]!.fields = repository.conflicts[0]!.fields.map((field) =>
      field.path === "kind" ? { ...field, choice: "remote", customValue: "NOTE" } : field);
    const applied = await engine.applyConflict(result.conflict.id, { projectId: "project-1" });
    expect(applied.outcome).toBe("resolved");
    expect(adapter.lastContext?.writeFields).toEqual(expect.arrayContaining(["items", "kind"]));
    expect(adapter.value).toMatchObject({ kind: "CHECKLIST", items: [{ id: "owned", title: "local", status: 0 }] });
  });

  it("requires an explicit whole-record choice for delete versus update", async () => {
    const base = createSnapshot("task", "task-1", task("base"));
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", null as unknown as DidaTask);
    const adapter = new TaskAdapter(task("remote-change"));
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
    });
    const deleteOperation = { ...operation(task("base"), base), operation: "delete" as const };
    const result = await engine.process(deleteOperation);
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected conflict");
    expect(result.conflict.fields).toMatchObject([{ path: "$", group: "deletion" }]);
    await engine.choose(result.conflict.id, "$", "remote");
    const applied = await engine.applyConflict(result.conflict.id, { projectId: "project-1" });
    expect(applied.outcome).toBe("resolved");
    expect(adapter.value?.title).toBe("remote-change");
  });

  it("removes base and local caches after explicitly resolving to deletion", async () => {
    const base = createSnapshot("task", "task-1", task("base"));
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", null as unknown as DidaTask);
    const adapter = new TaskAdapter(task("remote-change"));
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
    });
    const result = await engine.process({
      ...operation(task("base"), base),
      operation: "delete",
    });
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected conflict");
    await engine.choose(result.conflict.id, "$", "local");
    const applied = await engine.applyConflict(result.conflict.id, {
      projectId: "project-1",
    });
    expect(applied.outcome).toBe("resolved");
    expect(applied.outcome === "resolved" && applied.snapshot.value).toBeNull();
    expect(adapter.value).toBeNull();
    expect(repository.base).toBeNull();
    expect(repository.local).toBeNull();
  });

  it("recreates a locally chosen task after remote deletion and reports the new identity", async () => {
    const base = createSnapshot("task", "task-1", task("base"));
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", task("local"));
    const adapter = new TaskAdapter(null);
    adapter.create = async (value) => {
      adapter.value = { ...value, id: "task-restored" };
      return structuredClone(adapter.value);
    };
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
    });
    const result = await engine.process(operation(task("local"), base));
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected conflict");
    await engine.choose(result.conflict.id, "$", "local");
    const applied = await engine.applyConflict(result.conflict.id, { projectId: "project-1" });
    expect(applied).toMatchObject({
      outcome: "resolved",
      previousEntityId: "task-1",
      snapshot: { entityId: "task-restored" },
    });
    expect(repository.base?.entityId).toBe("task-restored");
    expect(repository.local?.entityId).toBe("task-restored");
  });

  it("keeps a recreated conflict applying when create succeeds but verification is unknown", async () => {
    const base = createSnapshot("task", "task-1", task("base"));
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", task("local"));
    const adapter = new TaskAdapter(null);
    let gets = 0;
    adapter.get = async () => {
      gets += 1;
      if (gets <= 2) return null;
      throw new Error("verification connection lost");
    };
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
    });
    const result = await engine.process(operation(task("local"), base));
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected conflict");
    await engine.choose(result.conflict.id, "$", "local");
    await expect(
      engine.applyConflict(result.conflict.id, { projectId: "project-1" }),
    ).rejects.toMatchObject({
      category: "unknown-outcome",
      remoteOutcomeUnknown: true,
    });
  });

  it("audits a chosen missing optional field after the verified remote write", async () => {
    const baseTask = { ...task("base"), dueDate: "2026-08-01T00:00:00Z" };
    const localTask = task("base");
    const remoteTask = { ...baseTask, title: "remote title" };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", localTask);
    const adapter = new TaskAdapter(remoteTask);
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
    });
    const result = await engine.process(operation(localTask, base));
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected conflict");
    for (const field of result.conflict.fields) {
      await engine.choose(
        result.conflict.id,
        field.path,
        field.path === "dueDate" ? "local" : "remote",
      );
    }
    const applied = await engine.applyConflict(result.conflict.id, { projectId: "project-1" });
    expect(applied.outcome).toBe("resolved");
    if (applied.outcome !== "resolved") throw new Error("expected resolved");
    expect(applied.audit.choices.dueDate?.valueHash).toMatch(/^[0-9a-f]{64}$/);
    expect((adapter.value as DidaTask).dueDate).toBeUndefined();
  });

  it("rejects an invalid field-by-field schedule merge before the remote write", async () => {
    const pointTime = "2026-08-01T10:00:00.000Z";
    const laterTime = "2026-08-01T11:00:00.000Z";
    const baseTask = { ...task("base"), startDate: pointTime, dueDate: pointTime };
    const localTask = { ...baseTask, dueDate: laterTime };
    const remoteTask = { ...baseTask, title: "remote title" };
    const base = createSnapshot("task", "task-1", baseTask);
    const repository = new MemoryRepository();
    repository.base = base;
    repository.local = createSnapshot("task", "task-1", localTask);
    const adapter = new TaskAdapter(remoteTask);
    const engine = new SyncEngine({
      adapter,
      snapshots: repository,
      conflicts: repository,
      deviceId: "device-a",
      validateWrite: (value, remoteBeforeWrite) => {
        const isPoint = value.startDate === value.dueDate || !value.startDate;
        const unchanged = value.startDate === remoteBeforeWrite?.startDate &&
          value.dueDate === remoteBeforeWrite?.dueDate;
        if (!isPoint && !unchanged) throw new Error("当前账号不支持独立起止时间");
      },
    });

    const result = await engine.process(operation(localTask, base));
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("expected conflict");
    for (const field of result.conflict.fields) {
      await engine.choose(
        result.conflict.id,
        field.path,
        field.path === "dueDate" ? "local" : "remote",
      );
    }

    await expect(
      engine.applyConflict(result.conflict.id, { projectId: "project-1" }),
    ).rejects.toThrow("当前账号不支持独立起止时间");
    expect(adapter.updateCount).toBe(0);
    expect(repository.conflicts[0]?.status).toBe("staged");
  });
});
