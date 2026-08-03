import type { DidaProject, EntitySnapshot } from "../domain/entities";
import { createSnapshot } from "../sync/snapshots";
import type { SyncQueueOperation } from "../sync/types";

export function buildProjectUpdateOperation(
  project: DidaProject,
  base: EntitySnapshot<DidaProject>,
  now: string,
  operationId: string,
): SyncQueueOperation<DidaProject> {
  return {
    id: operationId,
    kind: "project",
    entityId: project.id,
    operation: "update",
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    status: "pending",
    base,
    local: createSnapshot("project", project.id, project, { capturedAt: now }),
  };
}
