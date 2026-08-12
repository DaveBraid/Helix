import type { EntityKind, EntitySnapshot } from "../domain/entities";

export type ResolutionChoice = "local" | "remote" | "custom";
export type ConflictStatus = "open" | "staged" | "applying" | "resolved" | "superseded";

export interface ConflictField {
  path: string;
  label: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  localChanged: boolean;
  remoteChanged: boolean;
  sameResult: boolean;
  group?: "scalar" | "text" | "set" | "checklist" | "schedule" | "deletion";
  choice?: ResolutionChoice;
  customValue?: unknown;
  suggestedChoice?: ResolutionChoice;
}

export interface SyncConflict<T = unknown> {
  id: string;
  kind: EntityKind;
  entityId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: ConflictStatus;
  base: EntitySnapshot<T>;
  local: EntitySnapshot<T>;
  remote: EntitySnapshot<T>;
  fields: ConflictField[];
  remoteRecheckCount: number;
  sourceDeviceId: string;
  scope?: "helix-projection-owned-items";
  ownedItemIds?: string[];
}

export type QueueOperationType = "create" | "update" | "complete" | "delete";
export type QueueOperationStatus =
  | "pending"
  | "blocked"
  | "running"
  | "failed"
  | "reconciliation";

export interface SyncQueueOperation<T = unknown> {
  id: string;
  kind: EntityKind;
  entityId: string;
  operation: QueueOperationType;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  status: QueueOperationStatus;
  nextAttemptAt?: string;
  idempotencyFingerprint?: string;
  remoteOutcomeUnknown?: boolean;
  base?: EntitySnapshot<T>;
  local: EntitySnapshot<T>;
  projectId?: string;
  conflictId?: string;
  lastError?: string;
  /** 由用户显式修改的字段；禁止通过本地/远端值差异反推。 */
  writeFields?: string[];
  conflictScope?: "helix-projection-owned-items";
  conflictOwnedItemIds?: string[];
}

export interface RemoteWriteContext {
  projectId?: string;
  writeFields?: string[];
  /** 删除请求已发送后的权威集合复核；不得依赖可能滞后的单任务详情缓存。 */
  verifyDeletion?: boolean;
}

export interface ResolutionAuditEntry {
  id: string;
  conflictId: string;
  entityId: string;
  kind: EntityKind;
  resolvedAt: string;
  sourceDeviceId: string;
  choices: Record<string, { choice: ResolutionChoice; valueHash: string }>;
  remoteBeforeHash: string;
  remoteAfterHash: string;
}

export interface SyncSummary {
  pulled: number;
  pushed: number;
  conflicts: number;
  failed: number;
  skipped: number;
}

export interface RemoteEntityAdapter<T> {
  readonly kind: EntityKind;
  get(entityId: string, context?: RemoteWriteContext): Promise<T | null>;
  create(value: T): Promise<T>;
  update(entityId: string, value: T, context?: RemoteWriteContext): Promise<T>;
  delete(entityId: string, context?: RemoteWriteContext): Promise<void>;
}

export type SyncErrorCategory =
  | "authentication"
  | "authorization"
  | "rate-limit"
  | "transient"
  | "permanent"
  | "invalid-response"
  | "unknown-outcome";

export interface SyncFailure {
  category: SyncErrorCategory;
  message: string;
  retryAfterMs?: number;
  statusCode?: number;
  remoteOutcomeUnknown?: boolean;
}

export interface SnapshotRepository {
  getBase<T>(kind: EntityKind, entityId: string): Promise<EntitySnapshot<T> | null>;
  getLocal<T>(kind: EntityKind, entityId: string): Promise<EntitySnapshot<T> | null>;
  saveBase<T>(snapshot: EntitySnapshot<T>): Promise<void>;
  saveLocal<T>(snapshot: EntitySnapshot<T>): Promise<void>;
  removeBase(kind: EntityKind, entityId: string): Promise<void>;
  removeLocal(kind: EntityKind, entityId: string): Promise<void>;
}

export interface ConflictRepository {
  list(): Promise<SyncConflict[]>;
  get(conflictId: string): Promise<SyncConflict | null>;
  save(conflict: SyncConflict): Promise<void>;
  remove(conflictId: string): Promise<void>;
  appendAudit(entry: ResolutionAuditEntry): Promise<void>;
}
