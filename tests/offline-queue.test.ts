import { describe, expect, it } from "vitest";
import { createSnapshot } from "../src/sync/snapshots";
import { OfflineQueue } from "../src/sync/offline-queue";
import type { DidaTask } from "../src/domain/entities";
import type { SyncQueueOperation } from "../src/sync/types";
import { hydrateData } from "../src/storage/model";

function operation(
  id: string,
  type: SyncQueueOperation<DidaTask>["operation"],
  overrides: Partial<SyncQueueOperation<DidaTask>> = {},
): SyncQueueOperation<DidaTask> {
  const task: DidaTask = {
    id: "task-1",
    projectId: "project-1",
    title: id,
    status: 0,
  };
  return {
    id,
    kind: "task",
    entityId: "task-1",
    operation: type,
    createdAt: `2026-07-30T00:00:0${id.at(-1) ?? "0"}.000Z`,
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 0,
    status: "pending",
    local: createSnapshot("task", "task-1", task),
    projectId: "project-1",
    ...overrides,
  };
}

describe("OfflineQueue", () => {
  it("coalesces safe consecutive updates but preserves causal operations", () => {
    const queue = new OfflineQueue();
    queue.enqueue(operation("op-1", "update"));
    queue.enqueue(operation("op-2", "update"));
    queue.enqueue(operation("op-3", "complete"));
    queue.enqueue(operation("op-4", "delete"));
    expect(queue.list().map((item) => item.operation)).toEqual([
      "update",
      "complete",
      "delete",
    ]);
  });

  it("cancels a never-attempted local create followed by delete", () => {
    const queue = new OfflineQueue();
    queue.enqueue(operation("op-1", "create"));
    queue.enqueue(operation("op-2", "delete"));
    expect(queue.list()).toHaveLength(0);
  });

  it("moves an unknown create outcome to reconciliation and never retries it", () => {
    const queue = new OfflineQueue([operation("op-1", "create")]);
    queue.markRunning("op-1");
    queue.markFailed("op-1", {
      category: "unknown-outcome",
      message: "timeout after request was sent",
      remoteOutcomeUnknown: true,
    });
    expect(queue.list()[0]).toMatchObject({
      status: "reconciliation",
      remoteOutcomeUnknown: true,
    });
    expect(queue.nextRunnable()).toBeNull();
    queue.resolveReconciliation("op-1", "not-created");
    expect(queue.nextRunnable()?.id).toBe("op-1");
  });

  it("blocks later operations for the same entity but not other entities", () => {
    const first = operation("op-1", "update");
    const second = operation("op-2", "complete");
    const other = operation("op-3", "update", {
      entityId: "task-2",
      local: createSnapshot("task", "task-2", {
        id: "task-2",
        projectId: "project-1",
        title: "other",
        status: 0,
      }),
    });
    const queue = new OfflineQueue([first, second, other]);
    expect(queue.nextRunnable()?.id).toBe("op-1");
    queue.markBlocked("op-1", "conflict-1");
    expect(queue.nextRunnable()?.id).toBe("op-3");
  });

  it("preserves queue position when same-entity operations share a timestamp", () => {
    const timestamp = "2026-07-30T00:00:00.000Z";
    const first = operation("op-1", "complete", { createdAt: timestamp });
    const second = operation("op-2", "delete", { createdAt: timestamp });
    const queue = new OfflineQueue([first, second]);
    queue.markRunning("op-1");
    queue.markFailed("op-1", {
      category: "unknown-outcome",
      message: "completion result unknown",
      remoteOutcomeUnknown: true,
    });
    expect(queue.nextRunnable()).toBeNull();
  });

  it("recovers an interrupted running operation into manual reconciliation after restart", () => {
    const queue = new OfflineQueue([
      operation("op-1", "create", { status: "running" }),
    ], { recoverInterrupted: true });
    expect(queue.list()[0]).toMatchObject({
      status: "reconciliation",
      remoteOutcomeUnknown: true,
    });
    expect(queue.nextRunnable()).toBeNull();
  });

  it("preserves a live in-flight operation during ordinary reads and mutations", () => {
    const queue = new OfflineQueue([
      operation("op-1", "update", { status: "running" }),
    ]);
    expect(queue.list()[0]).toMatchObject({ status: "running" });
    expect(queue.list()[0]).not.toHaveProperty("remoteOutcomeUnknown");
    expect(queue.nextRunnable()).toBeNull();
  });

  it("returns the retained id when coalescing a pending update", () => {
    const queue = new OfflineQueue([operation("op-1", "update")]);
    expect(queue.enqueue(operation("op-2", "update"))).toBe("op-1");
    expect(queue.list()).toHaveLength(1);
  });

  it("treats a new edit as an explicit retry of a failed update", () => {
    const queue = new OfflineQueue([
      operation("op-1", "update", {
        status: "failed",
        attempts: 8,
        lastError: "invalid payload",
      }),
    ]);
    expect(queue.enqueue(operation("op-2", "update"))).toBe("op-1");
    expect(queue.list()[0]).toMatchObject({
      id: "op-1",
      status: "pending",
      attempts: 0,
      local: { value: { title: "op-2" } },
    });
  });

  it("keeps a new edit causally after a blocked conflict without changing its Local", () => {
    const queue = new OfflineQueue([
      operation("op-1", "update", {
        status: "blocked",
        conflictId: "conflict-1",
      }),
    ]);
    expect(queue.enqueue(operation("op-2", "update"))).toBe("op-2");
    expect(queue.list()).toMatchObject([
      { id: "op-1", status: "blocked", local: { value: { title: "op-1" } } },
      { id: "op-2", status: "pending", local: { value: { title: "op-2" } } },
    ]);
  });

  it("skips an exhausted operation and runs another object", () => {
    const exhausted = operation("op-1", "update", {
      status: "failed",
      attempts: 8,
    });
    const other = operation("op-2", "update", {
      entityId: "task-2",
      local: createSnapshot("task", "task-2", {
        id: "task-2",
        projectId: "project-1",
        title: "other",
        status: 0,
      }),
    });
    const queue = new OfflineQueue([exhausted, other]);
    expect(queue.nextRunnable()?.id).toBe("op-2");
  });

  it("migrates later operations when a remote deletion is resolved by recreating locally", () => {
    const blocked = operation("op-1", "update", {
      status: "blocked",
      conflictId: "conflict-1",
    });
    const later = operation("op-2", "complete");
    const queue = new OfflineQueue([blocked, later]);
    queue.resolveBlockedConflict(
      "conflict-1",
      createSnapshot("task", "task-restored", {
        id: "task-restored",
        projectId: "project-1",
        title: "restored",
        status: 0,
      }),
    );
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]).toMatchObject({
      entityId: "task-restored",
      operation: "complete",
      projectId: "project-1",
      base: { entityId: "task-restored" },
      local: { entityId: "task-restored", value: { id: "task-restored" } },
    });
  });

  it("advances source project context causally across queued moves after conflict resolution", () => {
    const baseA = createSnapshot("task", "task-1", {
      id: "task-1",
      projectId: "project-a",
      title: "base",
      status: 0,
    });
    const blocked = operation("op-1", "update", {
      status: "blocked",
      conflictId: "conflict-1",
      base: baseA,
    });
    const moveToC = operation("op-2", "update", {
      base: baseA,
      local: createSnapshot("task", "task-1", {
        id: "task-1",
        projectId: "project-c",
        title: "rename-c",
        status: 0,
      }),
    });
    const baseC = createSnapshot("task", "task-1", moveToC.local.value);
    const moveToD = operation("op-3", "complete", {
      base: baseC,
      local: createSnapshot("task", "task-1", {
        ...moveToC.local.value,
        projectId: "project-d",
        status: 2,
      }),
    });
    const queue = new OfflineQueue([blocked, moveToC, moveToD]);
    queue.resolveBlockedConflict(
      "conflict-1",
      createSnapshot("task", "task-1", {
        id: "task-1",
        projectId: "project-b",
        title: "remote-b",
        status: 0,
      }),
    );
    expect(queue.list()).toMatchObject([
      {
        id: "op-2",
        projectId: "project-b",
        base: { value: { projectId: "project-b" } },
        local: { value: { projectId: "project-c", title: "rename-c" } },
      },
      {
        id: "op-3",
        projectId: "project-c",
        base: { value: { projectId: "project-c" } },
        local: { value: { projectId: "project-d", status: 2 } },
      },
    ]);
  });

  it("rebases a queued rename onto the resolved remote project without moving it back", () => {
    const baseA = createSnapshot("task", "task-1", {
      id: "task-1",
      projectId: "project-a",
      title: "base",
      status: 0,
    });
    const queue = new OfflineQueue([
      operation("op-1", "update", {
        status: "blocked",
        conflictId: "conflict-1",
        base: baseA,
      }),
      operation("op-2", "update", {
        base: baseA,
        local: createSnapshot("task", "task-1", {
          ...baseA.value,
          title: "rename only",
        }),
      }),
    ]);
    queue.resolveBlockedConflict(
      "conflict-1",
      createSnapshot("task", "task-1", {
        ...baseA.value,
        projectId: "project-b",
      }),
    );
    expect(queue.list()[0]).toMatchObject({
      projectId: "project-b",
      local: { value: { projectId: "project-b", title: "rename only" } },
    });
  });

  it("rebases operations after adopting the remote result of an unknown move", () => {
    const baseA = createSnapshot("task", "task-1", {
      id: "task-1",
      projectId: "project-a",
      title: "base",
      status: 0,
    });
    const unknownMove = operation("op-1", "update", {
      status: "reconciliation",
      base: baseA,
      local: createSnapshot("task", "task-1", {
        ...baseA.value,
        projectId: "project-b",
      }),
    });
    const laterMove = operation("op-2", "update", {
      base: baseA,
      local: createSnapshot("task", "task-1", {
        ...baseA.value,
        projectId: "project-c",
        title: "later",
      }),
    });
    const queue = new OfflineQueue([unknownMove, laterMove]);
    queue.resolveOperationWithSnapshot(
      "op-1",
      createSnapshot("task", "task-1", {
        ...baseA.value,
        projectId: "project-b",
      }),
    );
    expect(queue.list()[0]).toMatchObject({
      projectId: "project-b",
      base: { value: { projectId: "project-b" } },
      local: { value: { projectId: "project-c", title: "later" } },
    });
  });

  it("persists a tombstone causal base without losing task project context", () => {
    const base = createSnapshot("task", "task-1", {
      id: "task-1",
      projectId: "project-1",
      title: "base",
      status: 0,
    });
    const blocked = operation("op-1", "delete", {
      status: "blocked",
      conflictId: "conflict-delete",
      base,
    });
    const later = operation("op-2", "update", {
      base,
      local: createSnapshot("task", "task-1", {
        ...base.value,
        title: "later local change",
      }),
    });
    const queue = new OfflineQueue([blocked, later]);
    queue.resolveBlockedConflict(
      "conflict-delete",
      createSnapshot("task", "task-1", null as unknown as DidaTask),
    );
    const remaining = queue.list();
    expect(remaining).toMatchObject([
      {
        id: "op-2",
        projectId: "project-1",
        base: { value: null },
        local: { value: { projectId: "project-1", title: "later local change" } },
      },
    ]);
    const hydrated = hydrateData({ schemaVersion: 2, queue: remaining });
    expect(hydrated.queue).toHaveLength(1);
    expect(hydrated.recoveryIssues).toEqual([]);
  });
});
