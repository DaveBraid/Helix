import { OfflineQueue } from "../sync/offline-queue";
import type { SyncQueueOperation } from "../sync/types";

export function claimNextQueueOperation(
  operations: SyncQueueOperation[],
): { operations: SyncQueueOperation[]; claimed: SyncQueueOperation | null } {
  const queue = new OfflineQueue(operations);
  const next = queue.nextRunnable();
  if (!next) return { operations: queue.list(), claimed: null };
  queue.markRunning(next.id);
  const claimed = queue.list().find((operation) => operation.id === next.id) ?? null;
  return { operations: queue.list(), claimed };
}
