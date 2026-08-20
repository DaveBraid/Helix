import type { DidaTask, EntitySnapshot, InProgressEntry } from "../domain/entities";
import { createSnapshot } from "../sync/snapshots";
import type { SyncQueueOperation } from "../sync/types";

export function buildTaskUpdateOperation(
  task: DidaTask,
  base: EntitySnapshot<DidaTask>,
  operationType: "update" | "complete",
  now: string,
  operationId: string,
  writeFields: string[] = [],
): SyncQueueOperation<DidaTask> {
  if (!base.value.projectId) throw new Error("同步基线缺少任务原清单");
  return {
    id: operationId,
    kind: "task",
    entityId: task.id,
    projectId: base.value.projectId,
    operation: operationType,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    status: "pending",
    base,
    local: createSnapshot("task", task.id, task, { capturedAt: now }),
    writeFields: [...new Set(writeFields)].sort(),
  };
}

export function buildTaskDeleteOperation(
  task: DidaTask,
  base: EntitySnapshot<DidaTask>,
  now: string,
  operationId: string,
): SyncQueueOperation<DidaTask> {
  if (!base.value.projectId) throw new Error("同步基线缺少任务原清单");
  return {
    id: operationId,
    kind: "task",
    entityId: task.id,
    projectId: base.value.projectId,
    operation: "delete",
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    status: "pending",
    base,
    local: createSnapshot("task", task.id, null, { capturedAt: now }) as unknown as EntitySnapshot<DidaTask>,
    writeFields: [],
  };
}

export function migrateInProgressTaskId(
  entries: InProgressEntry[],
  previousTaskId: string,
  task: DidaTask,
): InProgressEntry[] {
  return entries.map((entry) =>
    entry.taskId === previousTaskId
      ? { ...entry, taskId: task.id, projectId: task.projectId }
      : entry,
  );
}
