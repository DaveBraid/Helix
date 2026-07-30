import { describe, expect, it } from "vitest";
import type { DidaTask } from "../src/domain/entities";
import { claimNextQueueOperation } from "../src/services/queue-claim";
import { OfflineQueue } from "../src/sync/offline-queue";
import { createSnapshot } from "../src/sync/snapshots";
import type { SyncQueueOperation } from "../src/sync/types";

function update(id: string, title: string): SyncQueueOperation<DidaTask> {
  const task = { id: "task-1", projectId: "project-1", title, status: 0 };
  return {
    id,
    kind: "task",
    entityId: task.id,
    projectId: task.projectId,
    operation: "update",
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
    attempts: 0,
    status: "pending",
    local: createSnapshot("task", task.id, task),
  };
}

describe("atomic queue claim", () => {
  it("claims the latest coalesced Local instead of a stale pre-enqueue copy", () => {
    const queue = new OfflineQueue([update("op-1", "A")]);
    queue.enqueue(update("op-2", "B"));
    const result = claimNextQueueOperation(queue.list());
    expect(result.claimed).toMatchObject({
      id: "op-1",
      status: "running",
      local: { value: { title: "B" } },
    });
  });
});
