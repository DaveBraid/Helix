import type { EntitySnapshot } from "../domain/entities";
import { cloneValue, deepEqual } from "../domain/stable";
import { createSnapshot } from "./snapshots";
import type { SyncFailure, SyncQueueOperation } from "./types";

const MAX_ATTEMPTS = 8;

export class OfflineQueue {
  private operations: SyncQueueOperation[];

  constructor(
    initial: SyncQueueOperation[] = [],
    options: { recoverInterrupted?: boolean } = {},
  ) {
    this.operations = cloneValue(initial);
    if (!options.recoverInterrupted) return;
    for (const operation of this.operations) {
      if (
        operation.status === "failed" &&
        operation.operation === "delete" &&
        operation.lastError === "删除后验证失败：远端记录仍然存在"
      ) {
        operation.status = "reconciliation";
        operation.remoteOutcomeUnknown = true;
        operation.lastError = "旧版在删除请求发送后使用了滞后的详情复读；已转为结果未知，禁止重试";
        operation.updatedAt = new Date().toISOString();
        continue;
      }
      if (operation.status !== "running") continue;
      operation.status = "reconciliation";
      operation.remoteOutcomeUnknown = true;
      operation.lastError = "应用在请求执行期间中断，远端结果未知，必须人工核对";
      operation.updatedAt = new Date().toISOString();
    }
  }

  list(): SyncQueueOperation[] {
    return cloneValue(this.operations).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  enqueue<T>(operation: SyncQueueOperation<T>): string {
    const entityOperations = this.operations.filter(
      (candidate) =>
        candidate.kind === operation.kind &&
        candidate.entityId === operation.entityId,
    );
    const previous = entityOperations.at(-1);
    if (!previous) {
      this.operations.push(cloneValue(operation) as SyncQueueOperation);
      return operation.id;
    }

    if (
      previous.status === "pending" &&
      previous.operation === "create" &&
      operation.operation === "update"
    ) {
      previous.local = cloneValue(operation.local);
      previous.writeFields = mergeWriteFields(previous.writeFields, operation.writeFields);
      previous.updatedAt = operation.updatedAt;
      return previous.id;
    }
    if (
      previous.status === "pending" &&
      previous.operation === "update" &&
      operation.operation === "update"
    ) {
      previous.local = cloneValue(operation.local);
      previous.writeFields = mergeWriteFields(previous.writeFields, operation.writeFields);
      previous.updatedAt = operation.updatedAt;
      return previous.id;
    }
    if (
      previous.status === "failed" &&
      previous.operation === "update" &&
      operation.operation === "update"
    ) {
      previous.local = cloneValue(operation.local);
      previous.writeFields = mergeWriteFields(previous.writeFields, operation.writeFields);
      previous.status = "pending";
      previous.attempts = 0;
      previous.nextAttemptAt = undefined;
      previous.lastError = undefined;
      previous.updatedAt = operation.updatedAt;
      return previous.id;
    }
    if (
      previous.status === "pending" &&
      previous.operation === "create" &&
      previous.attempts === 0 &&
      operation.operation === "delete"
    ) {
      this.complete(previous.id);
      return operation.id;
    }
    this.operations.push(cloneValue(operation) as SyncQueueOperation);
    return operation.id;
  }

  /** 投影 prepared 操作必须保持精确 ID，禁止与同实体的普通队列操作合并。 */
  enqueueExact<T>(operation: SyncQueueOperation<T>): string {
    const sameId = this.operations.find((candidate) => candidate.id === operation.id);
    if (sameId) {
      if (!deepEqual(sameId, operation)) throw new Error("同一稳定 operation ID 已绑定其他队列内容");
      return sameId.id;
    }
    const competing = this.operations.find((candidate) =>
      candidate.kind === operation.kind && candidate.entityId === operation.entityId);
    if (competing) throw new Error("同一远端对象已有未完成操作，本次预备写入保持阻塞");
    this.operations.push(cloneValue(operation) as SyncQueueOperation);
    return operation.id;
  }

  nextRunnable(
    predicate: (operation: SyncQueueOperation) => boolean = () => true,
  ): SyncQueueOperation | null {
    const next = this.operations.find(
      (operation) =>
        predicate(operation) &&
        (operation.status === "pending" || operation.status === "failed") &&
        operation.attempts < MAX_ATTEMPTS &&
        (!operation.nextAttemptAt || operation.nextAttemptAt <= new Date().toISOString()) &&
        !this.hasEarlierUnfinishedOperation(operation, predicate),
    );
    if (!next) return null;
    return cloneValue(next);
  }

  markRunning(operationId: string): void {
    this.update(operationId, { status: "running" });
  }

  markBlocked(operationId: string, conflictId: string): void {
    this.update(operationId, { status: "blocked", conflictId });
  }

  markFailed(operationId: string, error: unknown): void {
    const operation = this.require(operationId);
    const failure = normalizeFailure(error);
    if (failure.remoteOutcomeUnknown) {
      this.markUnknown(operationId, failure.message);
      return;
    }
    operation.status = "failed";
    operation.attempts += 1;
    operation.updatedAt = new Date().toISOString();
    operation.lastError = failure.message;
    if (
      failure.category === "authentication" ||
      failure.category === "authorization" ||
      failure.category === "permanent" ||
      failure.category === "invalid-response"
    ) {
      operation.attempts = MAX_ATTEMPTS;
      return;
    }
    const backoff = failure.retryAfterMs ?? Math.min(300_000, 1_000 * 2 ** operation.attempts);
    operation.nextAttemptAt = new Date(Date.now() + backoff).toISOString();
  }

  markUnknown(operationId: string, message: string): void {
    const operation = this.require(operationId);
    operation.status = "reconciliation";
    operation.remoteOutcomeUnknown = true;
    operation.attempts += 1;
    operation.updatedAt = new Date().toISOString();
    operation.lastError = message;
  }

  complete(operationId: string): void {
    this.operations = this.operations.filter((operation) => operation.id !== operationId);
  }

  unblockByConflict(conflictId: string): void {
    for (const operation of this.operations) {
      if (operation.conflictId !== conflictId) continue;
      operation.status = "pending";
      operation.conflictId = undefined;
      operation.updatedAt = new Date().toISOString();
    }
  }

  /** 结果未知只能采纳已验证远端事实，永远不能重置为 pending 后重发。 */
  resolveReconciliation(operationId: string, outcome: "confirmed"): void {
    const operation = this.require(operationId);
    if (operation.status !== "reconciliation") {
      throw new Error("Operation is not waiting for reconciliation");
    }
    if (outcome !== "confirmed") {
      throw new Error("远端结果未知只能由已验证快照采纳，禁止重新排队发送");
    }
    void operation;
    this.complete(operationId);
  }

  retryFailed(operationId: string): void {
    const operation = this.require(operationId);
    if (operation.status !== "failed") {
      throw new Error("Operation is not in failed state");
    }
    operation.status = "pending";
    operation.attempts = 0;
    operation.nextAttemptAt = undefined;
    operation.lastError = undefined;
    operation.updatedAt = new Date().toISOString();
  }

  resolveBlockedConflict(
    conflictId: string,
    resolved: EntitySnapshot<unknown>,
  ): void {
    const blocked = this.operations.find(
      (operation) => operation.status === "blocked" && operation.conflictId === conflictId,
    );
    if (!blocked) return;
    this.resolveOperationWithSnapshot(blocked.id, resolved);
  }

  resolveOperationWithSnapshot(
    operationId: string,
    resolved: EntitySnapshot<unknown>,
  ): void {
    const completed = this.require(operationId);
    const oldEntityId = completed.entityId;
    const kind = completed.kind;
    this.complete(completed.id);
    let causalBase = cloneValue(resolved);
    for (const operation of this.operations) {
      if (operation.kind !== kind || operation.entityId !== oldEntityId) continue;
      operation.entityId = resolved.entityId;
      const originalBase = operation.base?.value;
      operation.base = cloneValue(causalBase);
      const localValue = rebaseQueuedValue(
        originalBase,
        operation.local.value,
        causalBase.value,
      );
      if (localValue && typeof localValue === "object" && "id" in localValue) {
        (localValue as { id: string }).id = resolved.entityId;
      }
      operation.local = createSnapshot(
        operation.kind,
        resolved.entityId,
        localValue,
        { capturedAt: operation.local.capturedAt },
      );
      operation.projectId =
        projectIdOf(causalBase.value) ??
        operation.projectId ??
        projectIdOf(localValue);
      causalBase = cloneValue(operation.local);
      operation.updatedAt = new Date().toISOString();
    }
  }

  private require(operationId: string): SyncQueueOperation {
    const operation = this.operations.find((candidate) => candidate.id === operationId);
    if (!operation) throw new Error(`Unknown queue operation: ${operationId}`);
    return operation;
  }

  private update(
    operationId: string,
    values: Partial<Pick<SyncQueueOperation, "status" | "conflictId">>,
  ): void {
    const operation = this.require(operationId);
    Object.assign(operation, values, { updatedAt: new Date().toISOString() });
  }

  private hasEarlierUnfinishedOperation(
    operation: SyncQueueOperation,
    predicate: (operation: SyncQueueOperation) => boolean,
  ): boolean {
    const position = this.operations.findIndex((candidate) => candidate.id === operation.id);
    if (position <= 0) return false;
    return this.operations.slice(0, position).some(
      (candidate) =>
        predicate(candidate) &&
        candidate.kind === operation.kind &&
        candidate.entityId === operation.entityId,
    );
  }
}

function mergeWriteFields(left: string[] | undefined, right: string[] | undefined): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])])].sort();
}

function rebaseQueuedValue(
  originalBase: unknown,
  desired: unknown,
  causalBase: unknown,
): unknown {
  if (
    !originalBase ||
    !desired ||
    !causalBase ||
    typeof originalBase !== "object" ||
    typeof desired !== "object" ||
    typeof causalBase !== "object" ||
    Array.isArray(originalBase) ||
    Array.isArray(desired) ||
    Array.isArray(causalBase)
  ) {
    return cloneValue(desired);
  }
  const next = cloneValue(causalBase) as Record<string, unknown>;
  const baseRecord = originalBase as Record<string, unknown>;
  const desiredRecord = desired as Record<string, unknown>;
  const keys = new Set([...Object.keys(baseRecord), ...Object.keys(desiredRecord)]);
  for (const key of keys) {
    if (deepEqual(baseRecord[key], desiredRecord[key])) continue;
    if (key in desiredRecord) next[key] = cloneValue(desiredRecord[key]);
    else delete next[key];
  }
  return next;
}

function projectIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const projectId = (value as Record<string, unknown>).projectId;
  return typeof projectId === "string" ? projectId : undefined;
}

function normalizeFailure(error: unknown): SyncFailure {
  if (isSyncFailure(error)) return error;
  return {
    category: "transient",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isSyncFailure(error: unknown): error is SyncFailure {
  return (
    !!error &&
    typeof error === "object" &&
    "category" in error &&
    "message" in error
  );
}
