import { describe, expect, it } from "vitest";
import { HelixDataStore, type PluginDataPort } from "../src/storage/data-store";
import { createDefaultData, hydrateData } from "../src/storage/model";
import { createSnapshot } from "../src/sync/snapshots";
import { buildConflictFields } from "../src/sync/three-way-merge";
import { deterministicEventId } from "../src/domain/events";
import { stableHash, stableStringify } from "../src/domain/stable";
import { didaAuthorizationBinding } from "../src/domain/dida-authorization";
import { DIDA_CONTRACT_PROBE_VERSION } from "../src/domain/task-schedule";
import { rotatingChallenges } from "../src/domain/gamification";
import {
  beginDataGeneration,
  invalidateDataGeneration,
} from "../src/storage/data-generation";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("HelixDataStore serialization", () => {
  it("removes only independently validated recovery issues while preserving other locks", async () => {
    let persisted = createDefaultData();
    persisted.recoveryIssues = ["聚焦桥接旧锁", "其他恢复锁"];
    const store = new HelixDataStore({
      loadData: async () => persisted,
      saveData: async (data) => { persisted = data as typeof persisted; },
    });

    await store.resolveRecoveryIssuesAfterValidation(["聚焦桥接旧锁"]);
    expect((await store.snapshot()).recoveryIssues).toEqual(["其他恢复锁"]);
    await expect(store.resolveRecoveryIssuesAfterValidation(["不存在的锁"]))
      .rejects.toThrow(/已经变化/);
    expect(persisted.recoveryIssues).toEqual(["其他恢复锁"]);
  });

  it("hydrates validated remote board caches and rejects malformed column identity", () => {
    const valid = hydrateData({
      schemaVersion: 2,
      boardSnapshots: {
        "project-1": {
          projectId: "project-1",
          capturedAt: "2026-08-03T00:00:00.000Z",
          stale: false,
          columns: [{ id: "todo", projectId: "project-1", name: "To do", sortOrder: 10 }],
        },
      },
    });
    expect(valid.boardSnapshots["project-1"]?.columns).toMatchObject([{ id: "todo" }]);
    expect(valid.boardSnapshots["project-1"]?.taskColumnIds).toEqual({});
    const invalid = hydrateData({
      schemaVersion: 2,
      boardSnapshots: {
        "project-1": {
          projectId: "project-1",
          capturedAt: "2026-08-03T00:00:00.000Z",
          stale: false,
          columns: [{ id: "todo", projectId: "other", name: "Wrong" }],
        },
      },
    });
    expect(invalid.boardSnapshots).toEqual({});
    expect(invalid.recoveryIssues).toEqual([]);
  });

  it("migrates task column placement into the read-only board cache", () => {
    const task = { id: "task-1", projectId: "project-1", title: "Placed", status: 0, columnId: "todo" };
    const snapshot = createSnapshot("task", task.id, task);
    const data = hydrateData({
      schemaVersion: 2,
      baseSnapshots: { [`task:${task.id}`]: snapshot },
      localSnapshots: { [`task:${task.id}`]: snapshot },
      boardSnapshots: {
        "project-1": {
          projectId: "project-1",
          capturedAt: "2026-08-03T00:00:00.000Z",
          stale: false,
          columns: [{ id: "todo", projectId: "project-1", name: "To do" }],
        },
      },
    });
    expect(data.boardSnapshots["project-1"]?.taskColumnIds).toEqual({ "task-1": "todo" });
    expect(data.baseSnapshots[`task:${task.id}`]?.value).not.toHaveProperty("columnId");
    expect(data.localSnapshots[`task:${task.id}`]?.value).not.toHaveProperty("columnId");
  });

  it("migrates legacy task conflicts before strict validation and preserves blocked queue references", () => {
    const baseValue = {
      id: "task-conflict",
      projectId: "project-1",
      title: "Original",
      status: 0,
      columnId: "todo",
    };
    const localValue = { ...baseValue, title: "Local title" };
    const remoteValue = { ...baseValue, columnId: "doing" };
    const base = createSnapshot("task", baseValue.id, baseValue);
    const local = createSnapshot("task", baseValue.id, localValue);
    const remote = createSnapshot("task", baseValue.id, remoteValue);
    const fields = buildConflictFields(
      base.value,
      local.value,
      remote.value,
    ).map((field) => field.path === "title" ? { ...field, choice: "local" as const } : field);
    fields.push({
      path: "columnId",
      label: "看板列",
      baseValue: "todo",
      localValue: "todo",
      remoteValue: "doing",
      localChanged: false,
      remoteChanged: true,
      sameResult: false,
      group: "scalar" as const,
      suggestedChoice: "remote" as const,
    });
    fields.sort((left, right) => left.path.localeCompare(right.path));
    const conflict = {
      id: "conflict-column",
      kind: "task" as const,
      entityId: baseValue.id,
      title: baseValue.title,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
      status: "staged" as const,
      base,
      local,
      remote,
      fields,
      remoteRecheckCount: 0,
      sourceDeviceId: "device-a",
    };
    const operation = {
      id: "op-column",
      kind: "task" as const,
      entityId: baseValue.id,
      projectId: baseValue.projectId,
      operation: "update" as const,
      createdAt: conflict.createdAt,
      updatedAt: conflict.updatedAt,
      attempts: 0,
      status: "blocked" as const,
      conflictId: conflict.id,
      base,
      local,
    };
    const data = hydrateData({
      schemaVersion: 2,
      boardSnapshots: {
        "project-1": {
          projectId: "project-1",
          capturedAt: "2026-08-03T00:00:00.000Z",
          stale: false,
          columns: [
            { id: "todo", projectId: "project-1", name: "To do" },
            { id: "doing", projectId: "project-1", name: "Doing" },
          ],
        },
      },
      queue: [operation],
      conflicts: [conflict],
    });
    expect(data.conflicts).toHaveLength(1);
    expect(data.conflicts[0]?.fields).toMatchObject([{ path: "title", choice: "local" }]);
    expect(data.queue).toHaveLength(1);
    expect(data.queue[0]?.conflictId).toBe(conflict.id);
    for (const snapshot of [
      data.conflicts[0]?.base,
      data.conflicts[0]?.local,
      data.conflicts[0]?.remote,
      data.queue[0]?.base,
      data.queue[0]?.local,
    ]) {
      expect(snapshot?.value).not.toHaveProperty("columnId");
    }
    expect(data.boardSnapshots["project-1"]?.taskColumnIds).toEqual({
      [baseValue.id]: "doing",
    });
    expect(data.recoveryIssues).toEqual([]);

    const forgedConflict = structuredClone(conflict);
    const forgedTitle = forgedConflict.fields.find((field) => field.path === "title");
    if (forgedTitle) forgedTitle.label = "伪造标题";
    const rejected = hydrateData({
      schemaVersion: 2,
      boardSnapshots: {
        "project-1": {
          projectId: "project-1",
          capturedAt: "2026-08-03T00:00:00.000Z",
          stale: false,
          columns: [{ id: "doing", projectId: "project-1", name: "Doing" }],
        },
      },
      queue: [operation],
      conflicts: [forgedConflict],
    });
    expect(rejected.conflicts).toEqual([]);
    expect(rejected.queue).toHaveLength(1);
    expect(rejected.recoveryIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/冲突记录含损坏条目/),
      expect.stringMatching(/冲突引用缺失/),
    ]));
  });

  it("degrades an already cached unsafe project sort order before any later write", () => {
    const project = {
      id: "project-unsafe",
      name: "Unsafe",
      sortOrder: Number.MAX_SAFE_INTEGER + 2,
    };
    const snapshot = createSnapshot("project", project.id, project);
    const data = hydrateData({
      schemaVersion: 2,
      baseSnapshots: { [`project:${project.id}`]: snapshot },
      localSnapshots: { [`project:${project.id}`]: snapshot },
    });
    expect(data.baseSnapshots[`project:${project.id}`]?.value).toMatchObject({ sortOrderUnsafe: true });
    expect(data.baseSnapshots[`project:${project.id}`]?.value).not.toHaveProperty("sortOrder");
    expect(data.localSnapshots[`project:${project.id}`]?.value).toMatchObject({ sortOrderUnsafe: true });
    expect(data.localSnapshots[`project:${project.id}`]?.value).not.toHaveProperty("sortOrder");
  });

  it("hydrates valid task matrix display rules and isolates nested defaults", () => {
    const first = createDefaultData("device-a");
    const second = createDefaultData("device-b");
    first.settings.taskMatrixRules.urgentWithinDays = 7;
    expect(second.settings.taskMatrixRules).toEqual({
      importantPriorityThreshold: 5,
      urgentWithinDays: 0,
    });
    expect(hydrateData({
      schemaVersion: 2,
      settings: {
        taskMatrixRules: {
          importantPriorityThreshold: 3,
          urgentWithinDays: 3,
        },
      },
    }).settings.taskMatrixRules).toEqual({
      importantPriorityThreshold: 3,
      urgentWithinDays: 3,
    });
  });

  it("rejects malformed task matrix display rules instead of partially applying them", () => {
    const data = hydrateData({
      schemaVersion: 2,
      settings: {
        taskMatrixRules: {
          importantPriorityThreshold: 2,
          urgentWithinDays: 30,
        },
      },
    });
    expect(data.settings.taskMatrixRules).toEqual({
      importantPriorityThreshold: 5,
      urgentWithinDays: 0,
    });
    expect(data.recoveryIssues).toContainEqual(expect.stringMatching(/taskMatrixRules/));
  });

  it("salvages malformed collection entries into an explicit read-only recovery state", () => {
    const data = hydrateData({
      schemaVersion: 1,
      queue: [{ id: "broken" }],
      baseSnapshots: { broken: { entityId: 1 } },
      conflicts: "not-an-array",
    });
    expect(data.queue).toEqual([]);
    expect(data.baseSnapshots).toEqual({});
    expect(data.conflicts).toEqual([]);
    expect(data.recoveryIssues.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects queue entries that look plausible but miss runtime-required fields", () => {
    const local = {
      kind: "task",
      entityId: "task-1",
      value: { id: "task-1" },
      capturedAt: "2026-07-30T00:00:00Z",
      stamp: { hash: "abc" },
    };
    const data = hydrateData({
      schemaVersion: 1,
      queue: [{
        id: "op-1",
        kind: "task",
        entityId: "task-1",
        operation: "update",
        status: "pending",
        updatedAt: "2026-07-30T00:00:00Z",
        local,
      }],
    });
    expect(data.queue).toEqual([]);
    expect(data.recoveryIssues).toContainEqual(expect.stringMatching(/队列操作/));
  });

  it("preserves a legacy unknown-result operation as frozen during schema migration", () => {
    const task = {
      id: "local-unknown",
      projectId: "project-1",
      title: "Unknown create",
      status: 0,
    };
    const local = createSnapshot("task", task.id, task);
    const data = hydrateData({
      schemaVersion: 1,
      queue: [{
        id: "op-unknown",
        kind: "task",
        entityId: task.id,
        projectId: task.projectId,
        operation: "create",
        status: "reconciliation",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:01:00.000Z",
        attempts: 1,
        remoteOutcomeUnknown: true,
        local,
      }],
    });

    expect(data.schemaVersion).toBe(2);
    expect(data.queue).toMatchObject([{
      id: "op-unknown",
      status: "reconciliation",
      attempts: 1,
      remoteOutcomeUnknown: true,
    }]);
  });

  it("rejects projection owned scope and item IDs unless both are persisted together", () => {
    const baseValue = { id: "task-owned", projectId: "project-1", title: "Base", status: 0,
      items: [{ id: "owned", title: "Base item", status: 0 }] };
    const localValue = { ...baseValue, items: [{ id: "owned", title: "Local item", status: 0 }] };
    const remoteValue = { ...baseValue, items: [{ id: "owned", title: "Remote item", status: 0 }] };
    const base = createSnapshot("task", baseValue.id, baseValue);
    const local = createSnapshot("task", baseValue.id, localValue);
    const remote = createSnapshot("task", baseValue.id, remoteValue);
    const queue = {
      id: "op-owned", kind: "task", entityId: baseValue.id, projectId: "project-1",
      operation: "update", status: "pending", createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z", attempts: 0, base, local,
    } as const;
    const conflict = {
      id: "conflict-owned", kind: "task", entityId: baseValue.id, title: "Owned",
      createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
      status: "open", base, local, remote,
      fields: buildConflictFields(baseValue, localValue, remoteValue),
      remoteRecheckCount: 0, sourceDeviceId: "device-1",
    } as const;
    const queueVariants = [
      { ...queue, conflictScope: "helix-projection-owned-items" as const },
      { ...queue, conflictOwnedItemIds: ["owned"] },
    ];
    for (const invalid of queueVariants) {
      const hydrated = hydrateData({ schemaVersion: createDefaultData().schemaVersion, queue: [invalid] });
      expect(hydrated.queue).toEqual([]);
      expect(hydrated.recoveryIssues.join(" ")).toMatch(/队列操作.*只读恢复模式/);
    }
    const conflictVariants = [
      { ...conflict, scope: "helix-projection-owned-items" as const },
      { ...conflict, ownedItemIds: ["owned"] },
    ];
    for (const invalid of conflictVariants) {
      const hydrated = hydrateData({ schemaVersion: createDefaultData().schemaVersion, conflicts: [invalid] });
      expect(hydrated.conflicts).toEqual([]);
      expect(hydrated.recoveryIssues.join(" ")).toMatch(/冲突记录.*只读恢复模式/);
    }
  });

  it("enters recovery mode for malformed events and kind-mismatched snapshot values", () => {
    const data = hydrateData({
      schemaVersion: 1,
      events: [{
        id: "bad-event",
        type: "task-completed",
        entityId: "task-1",
        occurredAt: "not-a-date",
      }],
      localSnapshots: {
        "task:task-1": {
          kind: "task",
          entityId: "task-1",
          capturedAt: "2026-07-30T00:00:00.000Z",
          stamp: { hash: "abc" },
          value: { id: "task-1", title: "missing project and status" },
        },
      },
    });
    expect(data.events).toEqual([]);
    expect(data.localSnapshots).toEqual({});
    expect(data.recoveryIssues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/事件账本/),
        expect.stringMatching(/Local 快照/),
      ]),
    );
  });

  it("preserves a valid pending lineage conflict for explicit later resolution", () => {
    const data = hydrateData({
      schemaVersion: 1,
      lineageConflict: {
        detectedAt: "2026-07-30T00:00:00.000Z",
        canvasPath: "Helix/Project Lineage.canvas",
      },
    });
    expect(data.lineageConflict).toEqual({
      detectedAt: "2026-07-30T00:00:00.000Z",
      canvasPath: "Helix/Project Lineage.canvas",
    });
    expect(data.recoveryIssues).toEqual([]);
  });

  it("rejects snapshot hash and entity ID mismatches", () => {
    const valid = createSnapshot("task", "task-1", {
      id: "task-1",
      projectId: "project-1",
      title: "Task",
      status: 0,
    });
    const data = hydrateData({
      schemaVersion: 1,
      localSnapshots: {
        "task:task-1": { ...valid, stamp: { ...valid.stamp, hash: "tampered" } },
        "task:task-2": {
          ...createSnapshot("task", "task-2", {
            id: "wrong-id",
            projectId: "project-1",
            title: "Wrong",
            status: 0,
          }),
        },
      },
    });
    expect(data.localSnapshots).toEqual({});
    expect(data.recoveryIssues).toContainEqual(expect.stringMatching(/Local 快照/));
  });

  it("rejects unsupported queue operations and forged conflict fields", () => {
    const project = { id: "project-1", name: "Project" };
    const projectSnapshot = createSnapshot("project", project.id, project);
    const baseTask = {
      id: "task-1",
      projectId: "project-1",
      title: "Base",
      status: 0,
    };
    const base = createSnapshot("task", baseTask.id, baseTask);
    const local = createSnapshot("task", baseTask.id, { ...baseTask, title: "Local" });
    const fields = buildConflictFields(base.value, local.value, base.value)
      .map((field) => ({ ...field, choice: "local" as const }));
    fields[0] = { ...fields[0]!, label: "伪造字段" };
    const data = hydrateData({
      schemaVersion: 1,
      queue: [{
        id: "op-1",
        kind: "project",
        entityId: project.id,
        operation: "complete",
        status: "pending",
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
        attempts: 0,
        local: projectSnapshot,
      }],
      conflicts: [{
        id: "conflict-1",
        kind: "task",
        entityId: baseTask.id,
        title: "Task",
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
        status: "staged",
        base,
        local,
        remote: base,
        fields,
        remoteRecheckCount: 0,
        sourceDeviceId: "device-a",
      }],
    });
    expect(data.queue).toEqual([]);
    expect(data.conflicts).toEqual([]);
    expect(data.recoveryIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/队列操作/),
      expect.stringMatching(/冲突记录/),
    ]));
  });

  it("migrates valid schema 1 hashes and event IDs without double-counting semantics", () => {
    const value = {
      id: "task-1",
      projectId: "project-1",
      title: "Legacy",
      status: 0,
    };
    const snapshot = createSnapshot("task", value.id, value);
    snapshot.stamp.hash = legacyHash(value);
    const legacyEvent = {
      id: "evt-old",
      type: "review-closed" as const,
      entityId: "Review.md",
      occurrenceKey: "Review.md",
      occurredAt: "2026-07-30T00:00:00.000Z",
    };
    const data = hydrateData({
      schemaVersion: 1,
      localSnapshots: { "task:task-1": snapshot },
      events: [legacyEvent, {
        ...legacyEvent,
        id: deterministicEventId(legacyEvent),
      }],
    });
    expect(data.schemaVersion).toBe(2);
    expect(data.localSnapshots["task:task-1"]?.stamp.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.events).toHaveLength(1);
    expect(data.events[0]).toMatchObject({ id: deterministicEventId(legacyEvent) });
    expect(data.recoveryIssues).toEqual([]);
  });

  it("does not bless a tampered schema 1 snapshot and reports malformed legacy events", () => {
    const value = {
      id: "task-1",
      projectId: "project-1",
      title: "Legacy",
      status: 0,
    };
    const snapshot = createSnapshot("task", value.id, value);
    snapshot.stamp.hash = legacyHash({ ...value, title: "Different" });
    const data = hydrateData({
      schemaVersion: 1,
      localSnapshots: { "task:task-1": snapshot },
      events: [{ id: "bad" }],
    });
    expect(data.localSnapshots).toEqual({});
    expect(data.events).toEqual([]);
    expect(data.recoveryIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/Local 快照/),
      expect.stringMatching(/事件账本/),
    ]));
  });

  it("freezes a legacy challenge definition from its persisted period identity", () => {
    const challenge = rotatingChallenges(new Date(2026, 6, 15, 12))[1]!;
    const legacy = {
      id: "evt-legacy-challenge",
      type: "challenge-completed" as const,
      entityId: challenge.id,
      occurrenceKey: challenge.id,
      occurredAt: new Date(2026, 6, 15, 12).toISOString(),
      metadata: { rewardXp: challenge.rewardXp },
    };
    const data = hydrateData({ schemaVersion: 1, events: [legacy] });
    expect(data.events).toMatchObject([{
      id: deterministicEventId(legacy),
      metadata: {
        ruleVersion: 1,
        metric: challenge.metric,
        target: challenge.target,
        rewardXp: challenge.rewardXp,
        startsAt: challenge.startsAt,
        endsAt: challenge.endsAt,
      },
    }]);
    expect(data.recoveryIssues).toEqual([]);
  });

  it("rejects duplicate collection identities and dangling blocked conflicts", () => {
    const task = {
      id: "task-1",
      projectId: "project-1",
      title: "Task",
      status: 0,
    };
    const snapshot = createSnapshot("task", task.id, task);
    const operation = {
      id: "op-same",
      kind: "task" as const,
      entityId: task.id,
      projectId: task.projectId,
      operation: "update" as const,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      attempts: 0,
      status: "blocked" as const,
      conflictId: "missing-conflict",
      base: snapshot,
      local: snapshot,
    };
    const changed = createSnapshot("task", task.id, { ...task, title: "Changed" });
    const conflict = {
      id: "conflict-same",
      kind: "task" as const,
      entityId: task.id,
      title: task.title,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      status: "staged" as const,
      base: snapshot,
      local: changed,
      remote: snapshot,
      fields: buildConflictFields(snapshot.value, changed.value, snapshot.value)
        .map((field) => ({ ...field, choice: "local" as const })),
      remoteRecheckCount: 0,
      sourceDeviceId: "device-a",
    };
    const data = hydrateData({
      schemaVersion: 2,
      queue: [operation, { ...operation }],
      conflicts: [conflict, { ...conflict }],
      inProgress: [
        { taskId: task.id, projectId: task.projectId, markedAt: operation.createdAt, lastTouchedAt: operation.updatedAt, activeFocus: false },
        { taskId: task.id, projectId: task.projectId, markedAt: operation.createdAt, lastTouchedAt: operation.updatedAt, activeFocus: false },
      ],
      resolutionAudit: [
        { id: "audit-same", conflictId: "c", entityId: task.id, kind: "task", resolvedAt: operation.createdAt, sourceDeviceId: "d", choices: {}, remoteBeforeHash: "a", remoteAfterHash: "b" },
        { id: "audit-same", conflictId: "c", entityId: task.id, kind: "task", resolvedAt: operation.createdAt, sourceDeviceId: "d", choices: {}, remoteBeforeHash: "a", remoteAfterHash: "b" },
      ],
    });
    expect(data.queue).toHaveLength(1);
    expect(data.inProgress).toHaveLength(1);
    expect(data.conflicts).toHaveLength(1);
    expect(data.resolutionAudit).toHaveLength(1);
    expect(data.recoveryIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/队列操作 ID重复/),
      expect.stringMatching(/正在进行任务 ID重复/),
      expect.stringMatching(/冲突记录 ID重复/),
      expect.stringMatching(/冲突审计 ID重复/),
      expect.stringMatching(/冲突引用缺失/),
    ]));
  });

  it("rejects forged schema 2 event IDs, invalid challenge payloads, and unsafe settings", () => {
    const challenge = {
      id: "forged",
      type: "challenge-completed" as const,
      entityId: "weekly-x",
      occurrenceKey: "weekly-x",
      occurredAt: "2026-07-30T00:00:00.000Z",
      metadata: { rewardXp: 100 },
    };
    const forgedReview = {
      id: "forged-review-id",
      type: "review-closed" as const,
      entityId: "Review.md",
      occurrenceKey: "Review.md",
      occurredAt: "2026-07-30T00:00:00.000Z",
    };
    const data = hydrateData({
      schemaVersion: 2,
      settings: {
        rootFolder: "../outside",
        autoSync: true,
        syncIntervalMinutes: Number.NaN,
        showSampleDataWhenDisconnected: true,
        lineageCanvasPath: "",
      },
      events: [challenge, forgedReview],
    });
    expect(data.events).toEqual([]);
    expect(data.settings).toMatchObject({
      rootFolder: "Helix",
      syncIntervalMinutes: 10,
      lineageCanvasPath: "Helix/Project Lineage.canvas",
    });
    expect(data.recoveryIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/事件账本/),
      expect.stringMatching(/rootFolder/),
      expect.stringMatching(/syncIntervalMinutes/),
      expect.stringMatching(/lineageCanvasPath/),
    ]));
  });

  it("hydrates template setup as a one-time migration for existing settings and rejects unsafe template paths", () => {
    const migrated = hydrateData({ schemaVersion: 2, settings: { rootFolder: "Helix" } });
    expect(migrated.settings).toMatchObject({ templateFolder: "Template", templateSetupCompleted: true });
    const fresh = hydrateData({ schemaVersion: 2 });
    expect(fresh.settings).toMatchObject({ templateFolder: "Template", templateSetupCompleted: false });
    for (const path of ["../outside", "/absolute", "\\\\server\\share", "C:\\Template", "Template/./Nested", "Template/../Nested", "~/Template", "Template\0evil"]) {
      const unsafe = hydrateData({ schemaVersion: 2, settings: { templateFolder: path } });
      expect(unsafe.settings.templateFolder).toBe("Template");
      expect(unsafe.recoveryIssues.join(" ")).toMatch(/templateFolder/);
    }
  });

  it("rejects invalid and newer schema versions", () => {
    expect(() => hydrateData({ schemaVersion: 0 })).toThrow(/schemaVersion 无效/);
    expect(() => hydrateData({ schemaVersion: 1.5 })).toThrow(/schemaVersion 无效/);
    expect(() => hydrateData({ schemaVersion: Number.NaN })).toThrow(/schemaVersion 无效/);
    expect(() => hydrateData({ schemaVersion: 3 })).toThrow(/更高版本/);
    expect(hydrateData({ schemaVersion: 1 }).schemaVersion).toBe(2);
    expect(hydrateData({ schemaVersion: 2 }).schemaVersion).toBe(2);
  });

  it("hydrates only a verified Dida task schedule capability", () => {
    const valid = hydrateData({
      schemaVersion: 2,
      didaContractCapabilities: {
        probeVersion: DIDA_CONTRACT_PROBE_VERSION,
        authorizationBinding: didaAuthorizationBinding("token"),
        taskScheduleMode: "point",
        boardPlacementVerified: true,
        verifiedAt: "2026-07-31T00:00:00.000Z",
      },
    });
    expect(valid.didaContractCapabilities).toEqual({
      probeVersion: DIDA_CONTRACT_PROBE_VERSION,
      authorizationBinding: didaAuthorizationBinding("token"),
      taskScheduleMode: "point",
      boardPlacementVerified: true,
      columnCreateVerified: false,
      taskCrudVerified: false,
      taskParentingVerified: false,
      projectProjectionVerified: false,
      reminderWriteVerified: false,
      repeatWriteVerified: false,
      itemsRoundTripVerified: false,
      itemIdStableVerified: false,
      taskReopenVerified: false,
      verifiedAt: "2026-07-31T00:00:00.000Z",
    });

    const v3 = hydrateData({
      schemaVersion: 2,
      didaContractCapabilities: {
        probeVersion: 3,
        authorizationBinding: didaAuthorizationBinding("token"),
        taskScheduleMode: "point",
        verifiedAt: "2026-07-31T00:00:00.000Z",
      },
    });
    expect(v3.didaContractCapabilities).toBeUndefined();
    expect(v3.recoveryIssues).toEqual([]);

    const invalidBoardCapability = hydrateData({
      schemaVersion: 2,
      didaContractCapabilities: {
        probeVersion: DIDA_CONTRACT_PROBE_VERSION,
        authorizationBinding: didaAuthorizationBinding("token"),
        taskScheduleMode: "point",
        boardPlacementVerified: "yes",
        verifiedAt: "2026-07-31T00:00:00.000Z",
      },
    });
    expect(invalidBoardCapability.didaContractCapabilities).toBeUndefined();
    expect(invalidBoardCapability.recoveryIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/滴答合同能力缓存字段无效/),
    ]));

    const invalid = hydrateData({
      schemaVersion: 2,
      didaContractCapabilities: {
        probeVersion: DIDA_CONTRACT_PROBE_VERSION,
        authorizationBinding: didaAuthorizationBinding("token"),
        taskScheduleMode: "unknown",
        verifiedAt: "not-a-date",
      },
    });
    expect(invalid.didaContractCapabilities).toBeUndefined();
    expect(invalid.recoveryIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/滴答合同能力缓存字段无效/),
    ]));

    const stale = hydrateData({
      schemaVersion: 2,
      didaContractCapabilities: {
        probeVersion: 1,
        taskScheduleMode: "duration",
        verifiedAt: "2026-07-31T00:00:00.000Z",
      },
    });
    expect(stale.didaContractCapabilities).toBeUndefined();
    expect(stale.recoveryIssues).toEqual([]);
  });

  it("rejects projection receipts carrying task shadow truth and incomplete enabled state", () => {
    const raw = createDefaultData("device-projection-strict");
    raw.projectionOperationReceipts = [{
      clientIdentity: "helix-action:project-a:stage-a:uuid-a",
      projectId: "target-list",
      operationId: "op-projection-a",
      marker: "helix-action-projection:uuid-a",
      outcome: "verified",
      remoteTaskId: "remote-a",
      task: { id: "remote-a", projectId: "target-list", title: "shadow", status: 0 },
    } as unknown as typeof raw.projectionOperationReceipts[number]];
    raw.didaProjectionState = {
      enabled: true,
      ledger: [],
      parentCheckpoints: [],
    };

    const hydrated = hydrateData(raw);

    expect(hydrated.projectionOperationReceipts).toEqual([]);
    expect(hydrated.didaProjectionState).toBeUndefined();
    expect(hydrated.recoveryIssues.join(" ")).toMatch(/同步状态.*同步创建收据/);
  });

  it("rejects projection state shadow fields, duplicate identities, and target ownership mismatch", () => {
    const validState = {
      enabled: true,
      target: { targetProjectId: "target-list", targetColumnId: "target-column" },
      confirmedPreviewHash: "a".repeat(64),
      ledger: [{
        uuid: "uuid-a",
        projectId: "project-a",
        stageId: "stage-a",
        parentTaskId: "parent-a",
        targetProjectId: "target-list",
        targetColumnId: "target-column",
        remoteId: "remote-a",
        remoteEntity: "task" as const,
        title: "Action",
        state: "active" as const,
        content: "行动备注",
        startDate: "2026-08-14T09:00:00+08:00",
        dueDate: "2026-08-14T09:00:00+08:00",
        timeZone: "Asia/Shanghai",
        isAllDay: false,
        priority: 5 as const,
        tags: ["科研"],
        sourceHash: "b".repeat(64),
      }],
      parentCheckpoints: [{
        projectId: "project-a",
        marker: "helix-project-projection:project-a",
      }],
      parentBases: [{ projectId: "project-a", remoteId: "parent-a", title: "Project", status: 0 }],
      receiptCleanupPending: [{
        kind: "action" as const,
        operationId: "op-cleanup-a",
        targetProjectId: "target-list",
        marker: "helix-project-projection:project-a",
        remoteTaskId: "parent-a",
        projectId: "project-a",
        stageId: "stage-a",
        uuid: "uuid-a",
      }],
    };

    const valid = createDefaultData("device-projection-valid-cleanup");
    valid.didaProjectionState = structuredClone(validState);
    expect(hydrateData(valid).didaProjectionState?.receiptCleanupPending).toEqual(
      validState.receiptCleanupPending,
    );
    expect(hydrateData(valid).didaProjectionState?.ledger[0]?.remoteEntity).toBe("task");

    const deletionTombstone = createDefaultData("device-projection-delete-tombstone");
    deletionTombstone.didaProjectionState = {
      ...structuredClone(validState),
      ledger: [],
      parentBases: [],
      receiptCleanupPending: [],
      parentCheckpoints: [{
        projectId: "project-a",
        remoteId: "parent-a",
        marker: "helix-project-projection:project-a",
        tombstone: true,
      }],
    };
    expect(hydrateData(deletionTombstone).didaProjectionState?.parentCheckpoints[0])
      .toMatchObject({ projectId: "project-a", remoteId: "parent-a", tombstone: true });

    const shadow = createDefaultData("device-projection-shadow-state");
    shadow.didaProjectionState = structuredClone(validState);
    (shadow.didaProjectionState!.ledger[0] as unknown as Record<string, unknown>).task = {
      id: "remote-a",
      title: "shadow truth",
    };
    const shadowHydrated = hydrateData(shadow);
    expect(shadowHydrated.didaProjectionState).toBeUndefined();
    expect(shadowHydrated.recoveryIssues.join(" ")).toMatch(/同步状态含损坏字段/);

    const duplicate = createDefaultData("device-projection-duplicate-state");
    duplicate.didaProjectionState = {
      ...structuredClone(validState),
      parentCheckpoints: [
        ...validState.parentCheckpoints,
        ...validState.parentCheckpoints,
      ],
    };
    const duplicateHydrated = hydrateData(duplicate);
    expect(duplicateHydrated.didaProjectionState).toBeUndefined();
    expect(duplicateHydrated.recoveryIssues.join(" ")).toMatch(/重复身份/);

    const mismatch = createDefaultData("device-projection-target-mismatch");
    mismatch.didaProjectionState = structuredClone(validState);
    mismatch.didaProjectionState.ledger[0]!.targetProjectId = "foreign-list";
    const mismatchHydrated = hydrateData(mismatch);
    expect(mismatchHydrated.didaProjectionState).toBeUndefined();
    expect(mismatchHydrated.recoveryIssues.join(" ")).toMatch(/目标归属不一致/);

    const parentMismatch = createDefaultData("device-projection-parent-mismatch");
    parentMismatch.didaProjectionState = structuredClone(validState);
    parentMismatch.didaProjectionState.parentCheckpoints[0]!.remoteId = "foreign-parent";
    const parentMismatchHydrated = hydrateData(parentMismatch);
    expect(parentMismatchHydrated.didaProjectionState).toBeUndefined();
    expect(parentMismatchHydrated.recoveryIssues.join(" ")).toMatch(/父任务检查点不一致/);

    const checkpointLedgerMismatch = createDefaultData("device-projection-checkpoint-ledger-mismatch");
    checkpointLedgerMismatch.didaProjectionState = {
      ...structuredClone(validState),
      parentBases: undefined,
      parentCheckpoints: [{
        projectId: "project-a",
        remoteId: "foreign-parent",
        marker: "helix-project-projection:project-a",
      }],
    };
    const checkpointLedgerMismatchHydrated = hydrateData(checkpointLedgerMismatch);
    expect(checkpointLedgerMismatchHydrated.didaProjectionState).toBeUndefined();
    expect(checkpointLedgerMismatchHydrated.recoveryIssues.join(" ")).toMatch(/父任务检查点不一致/);

    const invalidCleanup = createDefaultData("device-projection-invalid-cleanup");
    invalidCleanup.didaProjectionState = structuredClone(validState);
    invalidCleanup.didaProjectionState.receiptCleanupPending![0]!.marker = "helix-projection:foreign";
    expect(hydrateData(invalidCleanup).didaProjectionState).toBeUndefined();

    const foreignCleanupTarget = createDefaultData("device-projection-cleanup-target");
    foreignCleanupTarget.didaProjectionState = structuredClone(validState);
    foreignCleanupTarget.didaProjectionState.receiptCleanupPending![0]!.targetProjectId = "foreign-list";
    expect(hydrateData(foreignCleanupTarget).recoveryIssues.join(" ")).toMatch(/目标归属不一致/);

    const cleanupShadow = createDefaultData("device-projection-cleanup-shadow");
    cleanupShadow.didaProjectionState = structuredClone(validState);
    (cleanupShadow.didaProjectionState.receiptCleanupPending![0] as unknown as Record<string, unknown>).task = {};
    expect(hydrateData(cleanupShadow).didaProjectionState).toBeUndefined();
  });

  it("keeps legacy projection identities but disables an unversioned activation", () => {
    const raw = createDefaultData("device-projection-legacy-activation");
    raw.didaProjectionState = {
      enabled: true,
      target: { targetProjectId: "target-list", targetColumnId: "target-column" },
      confirmedPreviewHash: "a".repeat(64),
      ledger: [],
      parentCheckpoints: [],
    };

    expect(hydrateData(raw).didaProjectionState).toMatchObject({
      enabled: false,
      target: raw.didaProjectionState.target,
      confirmedPreviewHash: raw.didaProjectionState.confirmedPreviewHash,
    });
  });

  it("hydrates the persisted client checklist identity used by restart-safe append", () => {
    const raw = createDefaultData("projection-client-item-checkpoint");
    raw.didaProjectionState = {
      enabled: true,
      target: { targetProjectId: "target-list", targetColumnId: "target-column" },
      confirmedPreviewHash: "a".repeat(64),
      ledger: [{
        uuid: "uuid-a", projectId: "project-a", stageId: "stage-a", parentTaskId: "parent-a",
        targetProjectId: "target-list", targetColumnId: "target-column", title: "Action",
        state: "active", sourceHash: "b".repeat(64), frozen: "unknown-outcome",
        operationId: "op-create-a", createBaselineItemIds: [],
        createBaselineItemsHash: stableHash([]), createBaselineItemHashes: {},
        createItemId: "1785888000000", createItemSortOrder: 0,
      }],
      parentCheckpoints: [],
    };

    expect(hydrateData(raw).didaProjectionState?.ledger[0]).toMatchObject({
      createItemId: "1785888000000",
      createItemSortOrder: 0,
    });
    const corrupted = structuredClone(raw);
    corrupted.didaProjectionState!.ledger[0]!.createItemId = "0000000000001";
    expect(hydrateData(corrupted).didaProjectionState).toBeUndefined();
  });

  it("strictly validates the projection column creation checkpoint without secret-shaped extras", () => {
    const baselineColumns = [{ id: "todo", projectId: "target-list", name: "待处理" }];
    const valid = createDefaultData("projection-column-checkpoint");
    valid.didaProjectionState = {
      enabled: false,
      ledger: [],
      parentCheckpoints: [],
      columnCreation: {
        operationId: "projection-column:op-1",
        targetProjectId: "target-list",
        desiredName: "Helix项目",
        baselineColumns,
        baselineHash: stableHash(baselineColumns),
        previewHash: "a".repeat(64),
        status: "unknown",
        errorSummary: "分栏创建远端结果未知",
      },
    };
    expect(hydrateData(valid).didaProjectionState?.columnCreation).toEqual(
      valid.didaProjectionState.columnCreation,
    );

    const forged = structuredClone(valid);
    (forged.didaProjectionState!.columnCreation as unknown as Record<string, unknown>).token = "secret";
    expect(hydrateData(forged).didaProjectionState).toBeUndefined();

    const badHash = structuredClone(valid);
    badHash.didaProjectionState!.columnCreation!.baselineHash = "b".repeat(64);
    expect(hydrateData(badHash).didaProjectionState).toBeUndefined();

    const badPrepared = structuredClone(valid);
    badPrepared.didaProjectionState!.columnCreation!.status = "prepared";
    expect(hydrateData(badPrepared).didaProjectionState).toBeUndefined();
  });

  it("makes snapshots wait for an in-flight save and preserves a later interleaved mutation", async () => {
    const gate = deferred();
    let firstSave = true;
    let persisted = createDefaultData("device-a");
    const port: PluginDataPort = {
      async loadData() {
        return structuredClone(persisted);
      },
      async saveData(value) {
        if (firstSave) {
          firstSave = false;
          await gate.promise;
        }
        persisted = structuredClone(value) as typeof persisted;
      },
    };
    const store = new HelixDataStore(port);
    await store.load();
    const first = store.mutate((data) => {
      data.events.push("first");
    });
    let snapshotResolved = false;
    const during = store.snapshot().then((value) => {
      snapshotResolved = true;
      return value;
    });
    await Promise.resolve();
    expect(snapshotResolved).toBe(false);
    const second = store.mutate((data) => {
      data.events.push("second");
    });
    gate.resolve();
    await Promise.all([first, second]);
    expect((await during).events).toContain("first");
    expect((await store.snapshot()).events).toEqual(["first", "second"]);
  });

  it("fences an unloaded store generation before a reloaded store reads or writes", async () => {
    const saveGate = deferred();
    let saveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    let persisted = createDefaultData("device-a");
    const port: PluginDataPort = {
      async loadData() {
        return structuredClone(persisted);
      },
      async saveData(value) {
        saveStarted();
        await saveGate.promise;
        persisted = structuredClone(value) as typeof persisted;
      },
    };
    const oldGeneration = beginDataGeneration();
    const oldStore = new HelixDataStore(port, oldGeneration);
    await oldStore.load();
    const oldWrite = oldStore.mutate((data) => {
      data.lastSyncAt = "2026-07-30T01:00:00.000Z";
    });
    await started;

    invalidateDataGeneration(oldGeneration);
    oldStore.dispose();
    const newGeneration = beginDataGeneration();
    const newStore = new HelixDataStore(port, newGeneration);
    let newLoadFinished = false;
    const newLoad = newStore.load().then((data) => {
      newLoadFinished = true;
      return data;
    });
    await Promise.resolve();
    expect(newLoadFinished).toBe(false);
    saveGate.resolve();
    await expect(oldWrite).rejects.toThrow(/已卸载/);
    expect((await newLoad).lastSyncAt).toBe("2026-07-30T01:00:00.000Z");

    await newStore.mutate((data) => {
      data.lastSyncAt = "2026-07-30T02:00:00.000Z";
    });
    await expect(oldStore.mutate(() => undefined)).rejects.toThrow(/已卸载/);
    expect(persisted.lastSyncAt).toBe("2026-07-30T02:00:00.000Z");
    invalidateDataGeneration(newGeneration);
    newStore.dispose();
  });

  it("persists only a strict, authorization-bound Dida contract cleanup plan", () => {
    const raw = pendingDidaContractCleanupFixture();
    const hydrated = hydrateData({ schemaVersion: 2, pendingDidaContractCleanup: raw });
    expect(hydrated.pendingDidaContractCleanup).toEqual(raw);
    expect(hydrated.recoveryIssues).toEqual([]);

    const unknownField = structuredClone(raw);
    (unknownField.plan.projects[0] as Record<string, unknown>).unexpected = true;
    const rejectedUnknown = hydrateData({
      schemaVersion: 2,
      pendingDidaContractCleanup: unknownField,
    });
    expect(rejectedUnknown.pendingDidaContractCleanup).toBeUndefined();
    expect(rejectedUnknown.recoveryIssues.join(" ")).toMatch(/合同残留清理计划无效/);

    const foreignCandidate = structuredClone(raw);
    foreignCandidate.plan.tasks[0]!.candidateProjectIds = ["user-project"];
    const rejectedForeign = hydrateData({
      schemaVersion: 2,
      pendingDidaContractCleanup: foreignCandidate,
    });
    expect(rejectedForeign.pendingDidaContractCleanup).toBeUndefined();
    expect(rejectedForeign.recoveryIssues.join(" ")).toMatch(/合同残留清理计划无效/);
  });

  it("rejects forged cleanup marker, project identity and unsafe delete state", () => {
    const markerMismatch = pendingDidaContractCleanupFixture();
    markerMismatch.plan.marker = "[Helix 合同测试 other-run]";
    expect(hydrateData({ schemaVersion: 2, pendingDidaContractCleanup: markerMismatch })
      .pendingDidaContractCleanup).toBeUndefined();

    const renamedProject = pendingDidaContractCleanupFixture();
    renamedProject.plan.projects[1]!.name = `${renamedProject.plan.marker} 清单 C`;
    expect(hydrateData({ schemaVersion: 2, pendingDidaContractCleanup: renamedProject })
      .pendingDidaContractCleanup).toBeUndefined();

    const unsafeOutcome = pendingDidaContractCleanupFixture();
    (unsafeOutcome.plan.tasks[0] as Record<string, unknown>).deleteState = "retry";
    expect(hydrateData({ schemaVersion: 2, pendingDidaContractCleanup: unsafeOutcome })
      .pendingDidaContractCleanup).toBeUndefined();

    const spacedRun = pendingDidaContractCleanupFixture();
    spacedRun.plan.runId = "run bad";
    spacedRun.plan.marker = "[Helix 合同测试 run bad]";
    expect(hydrateData({ schemaVersion: 2, pendingDidaContractCleanup: spacedRun })
      .pendingDidaContractCleanup).toBeUndefined();
  });

  it("persists only strict authorization-bound and redacted Dida request control state", () => {
    const state = {
      authorizationBinding: "b".repeat(64),
      nextAllowedAt: "2026-08-07T00:00:01.000Z",
      cooldownUntil: "2026-08-07T00:15:00.000Z",
      queryLimitLevel: 1,
      cooldownProbeUsed: false,
      recoveryReadPending: false,
      requestCounts: { project: 1, task: 2, habit: 3, focus: 4, other: 5 },
      rateLimitCount: 1,
      lastRateLimitedAt: "2026-08-07T00:00:00.000Z",
      lastRateLimitKind: "query-limit",
    };
    const valid = hydrateData({ schemaVersion: 2, didaRequestControl: state });
    expect(valid.didaRequestControl).toEqual(state);
    expect(valid.recoveryIssues).toEqual([]);

    const leaked = { ...state, taskId: "must-not-persist" };
    const rejected = hydrateData({ schemaVersion: 2, didaRequestControl: leaked });
    expect(rejected.didaRequestControl).toBeUndefined();
    expect(rejected.recoveryIssues.join(" ")).toMatch(/请求冷却状态无效.*只读恢复模式/);

    const foreign = { ...state, authorizationBinding: "not-a-binding" };
    const rejectedBinding = hydrateData({ schemaVersion: 2, didaRequestControl: foreign });
    expect(rejectedBinding.didaRequestControl).toBeUndefined();
    expect(rejectedBinding.recoveryIssues).toHaveLength(1);

    const farFuture = { ...state, nextAllowedAt: "2099-01-01T00:00:00.000Z" };
    const rejectedDeadline = hydrateData({ schemaVersion: 2, didaRequestControl: farFuture });
    expect(rejectedDeadline.didaRequestControl).toBeUndefined();
    expect(rejectedDeadline.recoveryIssues).toHaveLength(1);

    const unsafeCount = {
      ...state,
      requestCounts: { ...state.requestCounts, task: Number.MAX_SAFE_INTEGER + 1 },
    };
    const rejectedCount = hydrateData({ schemaVersion: 2, didaRequestControl: unsafeCount });
    expect(rejectedCount.didaRequestControl).toBeUndefined();
    expect(rejectedCount.recoveryIssues).toHaveLength(1);

    const saturated = {
      ...state,
      requestCounts: { ...state.requestCounts, task: Number.MAX_SAFE_INTEGER },
      rateLimitCount: Number.MAX_SAFE_INTEGER,
    };
    expect(hydrateData({ schemaVersion: 2, didaRequestControl: saturated }).didaRequestControl)
      .toMatchObject({
        requestCounts: { task: Number.MAX_SAFE_INTEGER },
        rateLimitCount: Number.MAX_SAFE_INTEGER,
      });
  });
});

function pendingDidaContractCleanupFixture() {
  const runId = "run-4d";
  const marker = `[Helix 合同测试 ${runId}]`;
  return {
    authorizationBinding: "a".repeat(64),
    plan: {
      runId,
      marker,
      projects: [
        {
          id: "temporary-a",
          name: `${marker} 清单 A`,
          expectedColumns: [{ id: "column-a", projectId: "temporary-a", name: "待办", sortOrder: 1 }],
          baselineSource: "contract" as const,
        },
        {
          id: "temporary-b",
          name: `${marker} 清单 B`,
          expectedColumns: [],
          baselineSource: "adopted" as const,
          deleteState: "sent-unknown" as const,
        },
      ],
      tasks: [{
        id: "temporary-task",
        candidateProjectIds: ["temporary-a", "temporary-b"],
        state: "unknown" as const,
        deleteState: "sent-unknown" as const,
      }],
    },
  };
}

function legacyHash(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
