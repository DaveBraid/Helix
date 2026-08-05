import type {
  DidaBoardSnapshot,
  EntityKind,
  EntitySnapshot,
  InProgressEntry,
} from "../domain/entities";
import type {
  ResolutionAuditEntry,
  SyncConflict,
  SyncQueueOperation,
} from "../sync/types";
import { deterministicEventId, isHelixEvent, type HelixEvent } from "../domain/events";
import { cloneValue, deepEqual, stableHash, stableStringify } from "../domain/stable";
import { buildConflictFields, unresolvedFields } from "../sync/three-way-merge";
import { rotatingChallenges } from "../domain/gamification";
import {
  DIDA_CONTRACT_PROBE_VERSION,
  type TaskScheduleMode,
} from "../domain/task-schedule";
import {
  DEFAULT_TASK_MATRIX_RULES,
  type TaskMatrixRules,
} from "../domain/task-views";
import { normalizeTemplateFolder } from "../domain/template-path";
import type {
  DidaProjectionTarget,
  ProjectionFreezeReason,
  ProjectionLedgerEntry,
  ProjectionReceiptCleanupProof,
} from "../domain/dida-project-projection";

export interface HelixSettings {
  rootFolder: string;
  /** 模板根目录；实际 Helix 文件位于 <templateFolder>/Helix/。 */
  templateFolder: string;
  /** false 仅用于真正首次安装，要求用户先确认模板目录。 */
  templateSetupCompleted: boolean;
  autoSync: boolean;
  syncIntervalMinutes: number;
  showSampleDataWhenDisconnected: boolean;
  lineageCanvasPath: string;
  taskMatrixRules: TaskMatrixRules;
}

export const DEFAULT_SETTINGS: HelixSettings = {
  rootFolder: "Helix",
  templateFolder: "Template",
  templateSetupCompleted: false,
  autoSync: true,
  syncIntervalMinutes: 10,
  showSampleDataWhenDisconnected: true,
  lineageCanvasPath: "Helix/Project Lineage.canvas",
  taskMatrixRules: { ...DEFAULT_TASK_MATRIX_RULES },
};

export interface HelixPersistedData {
  schemaVersion: number;
  deviceId: string;
  settings: HelixSettings;
  baseSnapshots: Record<string, EntitySnapshot<unknown>>;
  localSnapshots: Record<string, EntitySnapshot<unknown>>;
  boardSnapshots: Record<string, DidaBoardSnapshot>;
  queue: SyncQueueOperation[];
  conflicts: SyncConflict[];
  resolutionAudit: ResolutionAuditEntry[];
  inProgress: InProgressEntry[];
  events: unknown[];
  recoveryIssues: string[];
  projectionOperationReceipts: Array<{
    clientIdentity: string;
    projectId: string;
    operationId: string;
    marker: string;
    outcome: "verified" | "verified-absent" | "unknown" | "conflict" | "retryable" | "authorization" | "capability";
    remoteTaskId?: string;
    message?: string;
    conflictId?: string;
  }>;
  didaProjectionState?: {
    enabled: boolean;
    target?: DidaProjectionTarget;
    confirmedPreviewHash?: string;
    ledger: ProjectionLedgerEntry[];
    parentCheckpoints: Array<{
      projectId: string;
      remoteId?: string;
      marker: string;
      frozen?: ProjectionFreezeReason;
      operationId?: string;
      conflictId?: string;
    }>;
    parentBases?: Array<{
      projectId: string;
      remoteId: string;
      title: string;
      status: number;
    }>;
    receiptCleanupPending?: ProjectionReceiptCleanupProof[];
  };
  didaContractCapabilities?: {
    probeVersion: number;
    authorizationBinding?: string;
    taskScheduleMode: Exclude<TaskScheduleMode, "unknown">;
    boardPlacementVerified?: boolean;
    taskCrudVerified?: boolean;
    reminderWriteVerified?: boolean;
    repeatWriteVerified?: boolean;
    parentTaskVerified?: boolean;
    taskReopenVerified?: boolean;
    verifiedAt: string;
  };
  lineageConflict?: {
    detectedAt: string;
    canvasPath: string;
    kind?: "lineage-concurrent" | "project-integrity" | "lineage-write";
    message?: string;
  };
  lastSyncAt?: string;
}

export function createDefaultData(deviceId?: string): HelixPersistedData {
  return {
    schemaVersion: 2,
    deviceId: deviceId ?? crypto.randomUUID(),
    settings: {
      ...DEFAULT_SETTINGS,
      taskMatrixRules: { ...DEFAULT_TASK_MATRIX_RULES },
    },
    baseSnapshots: {},
    localSnapshots: {},
    boardSnapshots: {},
    queue: [],
    conflicts: [],
    resolutionAudit: [],
    inProgress: [],
    events: [],
    recoveryIssues: [],
    projectionOperationReceipts: [],
  };
}

export function hydrateData(value: unknown): HelixPersistedData {
  if (value !== null && value !== undefined && (typeof value !== "object" || Array.isArray(value))) {
    throw new Error("Helix data.json 格式损坏：根节点必须是对象");
  }
  const source = (value ?? {}) as Partial<HelixPersistedData>;
  if (
    source.schemaVersion !== undefined &&
    (!Number.isInteger(source.schemaVersion) || Number(source.schemaVersion) < 1)
  ) {
    throw new Error(`Helix data.json 的 schemaVersion 无效：${String(source.schemaVersion)}`);
  }
  const schemaVersion = source.schemaVersion ?? 1;
  if (schemaVersion > 2) {
    throw new Error(`Helix data.json 来自更高版本（schema ${schemaVersion}），已拒绝降级写入`);
  }
  const raw = schemaVersion === 1 ? migrateV1Data(source) : source;
  const deviceId = typeof raw.deviceId === "string" && raw.deviceId
    ? raw.deviceId
    : undefined;
  const defaults = createDefaultData(deviceId);
  const recoveryIssues = arrayOrEmpty<string>(raw.recoveryIssues)
    .filter((value): value is string => typeof value === "string");
  const rawSettings =
    raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)
      ? raw.settings
      : {};
  const baseSnapshots = validRecord(
    raw.baseSnapshots,
    (entry, key): entry is EntitySnapshot<unknown> =>
      isSnapshot(entry, false, false) &&
      key === `${entry.kind}:${entry.entityId}`,
    "Base 快照",
    recoveryIssues,
  );
  const localSnapshots = validRecord(
    raw.localSnapshots,
    (entry, key): entry is EntitySnapshot<unknown> =>
      isSnapshot(entry, false, false) &&
      key === `${entry.kind}:${entry.entityId}`,
    "Local 快照",
    recoveryIssues,
  );
  const boardSnapshots = hydrateBoardSnapshots(raw.boardSnapshots);
  const migratedConflicts = migrateConflictBoardProjection(raw.conflicts);
  const queue = uniqueArray(
    validArray(raw.queue, isQueueOperation, "队列操作", recoveryIssues),
    (entry) => entry.id,
    "队列操作 ID",
    recoveryIssues,
  );
  const conflicts = uniqueArray(
    validArray(migratedConflicts, isConflict, "冲突记录", recoveryIssues),
    (entry) => entry.id,
    "冲突记录 ID",
    recoveryIssues,
  );
  stripTaskBoardProjection(baseSnapshots, localSnapshots, boardSnapshots, queue, conflicts);
  restoreMigratedConflictPlacement(raw.conflicts, conflicts, boardSnapshots);
  const resolutionAudit = uniqueArray(
    validArray(raw.resolutionAudit, isAudit, "冲突审计", recoveryIssues),
    (entry) => entry.id,
    "冲突审计 ID",
    recoveryIssues,
  );
  const inProgress = uniqueArray(
    validArray(raw.inProgress, isInProgress, "正在进行标记", recoveryIssues),
    (entry) => entry.taskId,
    "正在进行任务 ID",
    recoveryIssues,
  );
  const events = uniqueArray(
    validArray(raw.events, isPersistedEvent, "事件账本", recoveryIssues),
    (entry) => deterministicEventId(entry),
    "事件语义标识",
    recoveryIssues,
  );
  validateQueueConflictReferences(queue, conflicts, recoveryIssues);
  const lineageConflict = validateLineageConflict(raw.lineageConflict, recoveryIssues);
  const didaContractCapabilities = validateDidaContractCapabilities(
    raw.didaContractCapabilities,
    recoveryIssues,
  );
  const didaProjectionState = validateDidaProjectionState(
    raw.didaProjectionState,
    recoveryIssues,
  );
  const projectionReceiptsByOperation = uniqueArray(
    validArray(
    raw.projectionOperationReceipts,
    isProjectionCreateReceipt,
    "滴答项目投影创建收据",
    recoveryIssues,
    ),
    (entry) => entry.operationId,
    "滴答项目投影操作收据 ID",
    recoveryIssues,
  );
  const projectionOperationReceipts = uniqueArray(
    projectionReceiptsByOperation,
    (entry) => entry.clientIdentity,
    "滴答项目投影 client identity",
    recoveryIssues,
  );
  return {
    ...defaults,
    schemaVersion: 2,
    settings: hydrateSettings(rawSettings as Partial<HelixSettings>, recoveryIssues),
    baseSnapshots,
    localSnapshots,
    boardSnapshots,
    queue,
    conflicts,
    resolutionAudit,
    inProgress,
    events,
    recoveryIssues,
    didaContractCapabilities,
    didaProjectionState,
    projectionOperationReceipts,
    lineageConflict,
    lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : undefined,
  };
}

function validateDidaContractCapabilities(
  value: unknown,
  issues: string[],
): HelixPersistedData["didaContractCapabilities"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push("滴答合同能力缓存无效，已忽略并进入只读恢复模式");
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.probeVersion !== DIDA_CONTRACT_PROBE_VERSION) return undefined;
  if (
    (record.taskScheduleMode !== "point" && record.taskScheduleMode !== "duration") ||
    typeof record.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(record.verifiedAt)) ||
    typeof record.authorizationBinding !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.authorizationBinding) ||
    [
      "boardPlacementVerified",
      "taskCrudVerified",
      "reminderWriteVerified",
      "repeatWriteVerified",
      "parentTaskVerified",
      "taskReopenVerified",
    ].some((key) => record[key] !== undefined && typeof record[key] !== "boolean")
  ) {
    issues.push("滴答合同能力缓存字段无效，已忽略并进入只读恢复模式");
    return undefined;
  }
  return {
    probeVersion: DIDA_CONTRACT_PROBE_VERSION,
    authorizationBinding: record.authorizationBinding,
    taskScheduleMode: record.taskScheduleMode,
    boardPlacementVerified: record.boardPlacementVerified === true,
    taskCrudVerified: record.taskCrudVerified === true,
    reminderWriteVerified: record.reminderWriteVerified === true,
    repeatWriteVerified: record.repeatWriteVerified === true,
    parentTaskVerified: record.parentTaskVerified === true,
    taskReopenVerified: record.taskReopenVerified === true,
    verifiedAt: record.verifiedAt,
  };
}

const PROJECTION_FREEZE_REASONS = new Set<ProjectionFreezeReason>([
  "conflict", "unknown-outcome", "retryable", "authorization", "capability",
  "markdown-race", "identity-mismatch",
]);

function isProjectionCreateReceipt(
  value: unknown,
): value is HelixPersistedData["projectionOperationReceipts"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "clientIdentity", "projectId", "operationId", "marker", "outcome",
    "remoteTaskId", "message", "conflictId",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  const id = (candidate: unknown) => typeof candidate === "string" && candidate.length > 0 &&
    candidate === candidate.trim() && candidate.length <= 512 && !/[\r\n]/u.test(candidate);
  const outcomes = ["verified", "verified-absent", "unknown", "conflict", "retryable", "authorization", "capability"];
  return id(record.clientIdentity) && id(record.projectId) && id(record.operationId) && id(record.marker) &&
    outcomes.includes(String(record.outcome)) &&
    (record.message === undefined || typeof record.message === "string") &&
    (record.conflictId === undefined || id(record.conflictId)) &&
    (record.remoteTaskId === undefined || id(record.remoteTaskId));
}

function validateDidaProjectionState(
  value: unknown,
  issues: string[],
): HelixPersistedData["didaProjectionState"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push("滴答项目投影状态无效，已忽略并进入只读恢复模式");
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const stableId = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && candidate === candidate.trim() &&
    candidate.length > 0 && candidate.length <= 512 && !/[\r\n]/u.test(candidate);
  const onlyKeys = (candidate: Record<string, unknown>, allowed: readonly string[]) =>
    Object.keys(candidate).every((key) => allowed.includes(key));
  if (!onlyKeys(record, [
    "enabled", "target", "confirmedPreviewHash", "ledger", "parentCheckpoints", "parentBases",
    "receiptCleanupPending",
  ])) {
    issues.push("滴答项目投影状态含未知字段，已忽略并进入只读恢复模式");
    return undefined;
  }
  const target = record.target;
  const validTarget = target === undefined || (!!target && typeof target === "object" &&
    !Array.isArray(target) &&
    onlyKeys(target as Record<string, unknown>, ["targetProjectId", "targetColumnId"]) &&
    stableId((target as Record<string, unknown>).targetProjectId) &&
    stableId((target as Record<string, unknown>).targetColumnId));
  const validFreeze = (candidate: unknown) =>
    candidate === undefined || PROJECTION_FREEZE_REASONS.has(candidate as ProjectionFreezeReason);
  const ledger = record.ledger;
  const checkpoints = record.parentCheckpoints;
  const bases = record.parentBases;
  const cleanupPending = record.receiptCleanupPending;
  const validLedger = Array.isArray(ledger) && ledger.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    if (!onlyKeys(row, [
      "uuid", "projectId", "stageId", "parentTaskId", "targetProjectId", "targetColumnId",
      "remoteId", "title", "state", "sourceHash", "tombstone", "frozen", "operationId", "conflictId",
    ])) return false;
    return ["uuid", "projectId", "stageId", "parentTaskId", "targetProjectId", "targetColumnId", "title", "sourceHash"]
      .every((key) => stableId(row[key])) &&
      /^[a-f0-9]{64}$/u.test(String(row.sourceHash)) &&
      ["idea", "active", "completed", "paused", "terminated"].includes(String(row.state)) &&
      (row.remoteId === undefined || stableId(row.remoteId)) && validFreeze(row.frozen) &&
      (row.operationId === undefined || stableId(row.operationId)) &&
      (row.conflictId === undefined || stableId(row.conflictId)) &&
      (row.tombstone === undefined || typeof row.tombstone === "boolean");
  });
  const validCheckpoints = Array.isArray(checkpoints) && checkpoints.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    if (!onlyKeys(row, ["projectId", "remoteId", "marker", "frozen", "operationId", "conflictId"])) {
      return false;
    }
    return stableId(row.projectId) && row.marker === `helix-project-projection:${row.projectId}` &&
      (row.remoteId === undefined || stableId(row.remoteId)) && validFreeze(row.frozen) &&
      (row.operationId === undefined || stableId(row.operationId)) &&
      (row.conflictId === undefined || stableId(row.conflictId));
  });
  const validBases = bases === undefined || (Array.isArray(bases) && bases.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    if (!onlyKeys(row, ["projectId", "remoteId", "title", "status"])) return false;
    return stableId(row.projectId) && stableId(row.remoteId) && stableId(row.title) &&
      (row.status === 0 || row.status === 2);
  }));
  const validCleanupPending = cleanupPending === undefined || (Array.isArray(cleanupPending) &&
    cleanupPending.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const row = item as Record<string, unknown>;
      const common = ["kind", "operationId", "conflictId", "targetProjectId", "marker", "remoteTaskId", "projectId"];
      const allowed = row.kind === "action" ? [...common, "stageId", "uuid"] : common;
      if (!onlyKeys(row, allowed) || (row.kind !== "action" && row.kind !== "parent")) return false;
      if (!["operationId", "targetProjectId", "marker", "remoteTaskId", "projectId"].every((key) => stableId(row[key])) ||
        (row.conflictId !== undefined && !stableId(row.conflictId))) return false;
      if (row.kind === "parent") return row.marker === `helix-project-projection:${row.projectId}`;
      return stableId(row.stageId) && stableId(row.uuid) && row.marker === `helix-projection:${row.uuid}`;
    }));
  if (typeof record.enabled !== "boolean" || !validTarget || !validLedger || !validCheckpoints || !validBases ||
    !validCleanupPending ||
    (record.enabled === true && (target === undefined || record.confirmedPreviewHash === undefined)) ||
    (record.confirmedPreviewHash !== undefined &&
      (typeof record.confirmedPreviewHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.confirmedPreviewHash)))) {
    issues.push("滴答项目投影状态含损坏字段，已忽略并进入只读恢复模式");
    return undefined;
  }
  const uuids = (ledger as ProjectionLedgerEntry[]).map((entry) => entry.uuid);
  const remoteIds = (ledger as ProjectionLedgerEntry[])
    .map((entry) => entry.remoteId)
    .filter((id): id is string => id !== undefined);
  const checkpointProjectIds = (checkpoints as Array<{ projectId: string }>).map((entry) => entry.projectId);
  const baseRows = (bases ?? []) as Array<{ projectId: string; remoteId: string }>;
  const baseProjectIds = baseRows.map((entry) => entry.projectId);
  const baseRemoteIds = baseRows.map((entry) => entry.remoteId);
  const cleanupRows = (cleanupPending ?? []) as ProjectionReceiptCleanupProof[];
  const cleanupOperationIds = cleanupRows.map((entry) => entry.operationId);
  if (new Set(uuids).size !== uuids.length || new Set(remoteIds).size !== remoteIds.length ||
    new Set(checkpointProjectIds).size !== checkpointProjectIds.length ||
    new Set(baseProjectIds).size !== baseProjectIds.length ||
    new Set(baseRemoteIds).size !== baseRemoteIds.length ||
    new Set(cleanupOperationIds).size !== cleanupOperationIds.length) {
    issues.push("滴答项目投影状态含重复身份，已忽略并进入只读恢复模式");
    return undefined;
  }
  const normalizedTarget = target as DidaProjectionTarget | undefined;
  const normalizedLedger = ledger as ProjectionLedgerEntry[];
  if ((!normalizedTarget && (normalizedLedger.length > 0 || checkpointProjectIds.length > 0 || baseRows.length > 0)) ||
    (normalizedTarget && normalizedLedger.some((entry) =>
      entry.targetProjectId !== normalizedTarget.targetProjectId ||
      entry.targetColumnId !== normalizedTarget.targetColumnId)) ||
    (!normalizedTarget && cleanupRows.length > 0) ||
    (normalizedTarget && cleanupRows.some((entry) =>
      entry.targetProjectId !== normalizedTarget.targetProjectId))) {
    issues.push("滴答项目投影目标归属不一致，已忽略并进入只读恢复模式");
    return undefined;
  }
  const baseByProject = new Map(baseRows.map((entry) => [entry.projectId, entry.remoteId]));
  const parentByProject = new Map<string, string>();
  for (const entry of normalizedLedger) {
    const existingParent = parentByProject.get(entry.projectId);
    if ((existingParent && existingParent !== entry.parentTaskId) ||
      (baseByProject.has(entry.projectId) && baseByProject.get(entry.projectId) !== entry.parentTaskId)) {
      issues.push("滴答项目投影父任务归属不一致，已忽略并进入只读恢复模式");
      return undefined;
    }
    parentByProject.set(entry.projectId, entry.parentTaskId);
  }
  for (const checkpoint of checkpoints as Array<{ projectId: string; remoteId?: string }>) {
    if (checkpoint.remoteId &&
      ((baseByProject.has(checkpoint.projectId) &&
        baseByProject.get(checkpoint.projectId) !== checkpoint.remoteId) ||
        (parentByProject.has(checkpoint.projectId) &&
          parentByProject.get(checkpoint.projectId) !== checkpoint.remoteId))) {
      issues.push("滴答项目投影父任务检查点不一致，已忽略并进入只读恢复模式");
      return undefined;
    }
  }
  const normalized: NonNullable<HelixPersistedData["didaProjectionState"]> = {
    enabled: record.enabled as boolean,
    ledger: normalizedLedger.map((entry) => ({ ...entry })),
    parentCheckpoints: (checkpoints as NonNullable<HelixPersistedData["didaProjectionState"]>["parentCheckpoints"])
      .map((entry) => ({ ...entry })),
  };
  if (normalizedTarget) normalized.target = { ...normalizedTarget };
  if (typeof record.confirmedPreviewHash === "string") {
    normalized.confirmedPreviewHash = record.confirmedPreviewHash;
  }
  if (bases !== undefined) {
    normalized.parentBases = (bases as NonNullable<HelixPersistedData["didaProjectionState"]>["parentBases"])
      ?.map((entry) => ({ ...entry }));
  }
  if (cleanupPending !== undefined) {
    normalized.receiptCleanupPending = cleanupRows.map((entry) => ({ ...entry }));
  }
  return normalized;
}

function hydrateSettings(
  raw: Partial<HelixSettings>,
  issues: string[],
): HelixSettings {
  const settings = {
    ...DEFAULT_SETTINGS,
    taskMatrixRules: { ...DEFAULT_TASK_MATRIX_RULES },
  };
  if (raw.rootFolder !== undefined) {
    if (isSafeVaultPath(raw.rootFolder, false)) settings.rootFolder = raw.rootFolder.trim();
    else issues.push("rootFolder 设置无效，已恢复默认值并进入只读恢复模式");
  }
  if (raw.templateFolder !== undefined) {
    try {
      settings.templateFolder = normalizeTemplateFolder(raw.templateFolder);
    } catch {
      issues.push("templateFolder 设置无效，已恢复默认值并进入只读恢复模式");
    }
  }
  if (raw.templateSetupCompleted !== undefined) {
    if (typeof raw.templateSetupCompleted === "boolean") {
      settings.templateSetupCompleted = raw.templateSetupCompleted;
    } else {
      issues.push("templateSetupCompleted 设置无效，已恢复默认值并进入只读恢复模式");
    }
  } else if (Object.keys(raw).length > 0) {
    // 已有安装缺少该字段按既有授权迁移至 Template，避免首次安装弹窗重复出现。
    settings.templateSetupCompleted = true;
  }
  if (raw.lineageCanvasPath !== undefined) {
    if (isSafeVaultPath(raw.lineageCanvasPath, true)) {
      settings.lineageCanvasPath = raw.lineageCanvasPath.trim();
    } else {
      issues.push("lineageCanvasPath 设置无效，已恢复默认值并进入只读恢复模式");
    }
  }
  if (raw.autoSync !== undefined) {
    if (typeof raw.autoSync === "boolean") settings.autoSync = raw.autoSync;
    else issues.push("autoSync 设置无效，已恢复默认值并进入只读恢复模式");
  }
  if (raw.showSampleDataWhenDisconnected !== undefined) {
    if (typeof raw.showSampleDataWhenDisconnected === "boolean") {
      settings.showSampleDataWhenDisconnected = raw.showSampleDataWhenDisconnected;
    } else {
      issues.push("showSampleDataWhenDisconnected 设置无效，已恢复默认值并进入只读恢复模式");
    }
  }
  if (raw.syncIntervalMinutes !== undefined) {
    if (
      Number.isInteger(raw.syncIntervalMinutes) &&
      raw.syncIntervalMinutes >= 5 &&
      raw.syncIntervalMinutes <= 1_440
    ) {
      settings.syncIntervalMinutes = raw.syncIntervalMinutes;
    } else {
      issues.push("syncIntervalMinutes 设置无效，已恢复默认值并进入只读恢复模式");
    }
  }
  if (raw.taskMatrixRules !== undefined) {
    const rules = raw.taskMatrixRules;
    if (
      rules &&
      typeof rules === "object" &&
      !Array.isArray(rules) &&
      (rules.importantPriorityThreshold === 1 ||
        rules.importantPriorityThreshold === 3 ||
        rules.importantPriorityThreshold === 5) &&
      (rules.urgentWithinDays === 0 ||
        rules.urgentWithinDays === 1 ||
        rules.urgentWithinDays === 3 ||
        rules.urgentWithinDays === 7)
    ) {
      settings.taskMatrixRules = {
        importantPriorityThreshold: rules.importantPriorityThreshold,
        urgentWithinDays: rules.urgentWithinDays,
      };
    } else {
      issues.push("taskMatrixRules 设置无效，已恢复默认值并进入只读恢复模式");
    }
  }
  return settings;
}

function isSafeVaultPath(value: unknown, requireCanvas: boolean): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\0")) return false;
  if (trimmed.split(/[\\/]/).some((segment) => segment === "..")) return false;
  return !requireCanvas || trimmed.toLowerCase().endsWith(".canvas");
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function validArray<T>(
  value: unknown,
  validator: (entry: unknown) => entry is T,
  label: string,
  issues: string[],
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${label}不是数组，已进入只读恢复模式并忽略该字段`);
    return [];
  }
  const valid = value.filter(validator);
  if (valid.length !== value.length) issues.push(`${label}含损坏条目，已忽略 ${value.length - valid.length} 项`);
  return valid;
}

function validRecord<T>(
  value: unknown,
  validator: (entry: unknown, key: string) => entry is T,
  label: string,
  issues: string[],
): Record<string, T> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${label}不是对象，已进入只读恢复模式并忽略该字段`);
    return {};
  }
  const entries = Object.entries(value).filter(([key, entry]) => validator(entry, key));
  if (entries.length !== Object.keys(value).length) {
    issues.push(`${label}含损坏条目，已忽略 ${Object.keys(value).length - entries.length} 项`);
  }
  return Object.fromEntries(entries);
}

function uniqueArray<T>(
  values: T[],
  keyOf: (value: T) => string,
  label: string,
  issues: string[],
): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(value);
  }
  if (duplicates > 0) {
    issues.push(`${label}重复，已忽略 ${duplicates} 项并进入只读恢复模式`);
  }
  return unique;
}

function validateQueueConflictReferences(
  queue: SyncQueueOperation[],
  conflicts: SyncConflict[],
  issues: string[],
): void {
  const byId = new Map(conflicts.map((conflict) => [conflict.id, conflict]));
  for (const operation of queue) {
    if (operation.status !== "blocked") continue;
    const conflict = operation.conflictId ? byId.get(operation.conflictId) : undefined;
    if (
      !conflict ||
      conflict.kind !== operation.kind ||
      conflict.entityId !== operation.entityId
    ) {
      issues.push(`阻塞队列 ${operation.id} 的冲突引用缺失或对象不一致，已进入只读恢复模式`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSnapshot(
  value: unknown,
  allowNull: boolean,
  allowEmptySentinel: boolean,
): value is EntitySnapshot<unknown> {
  if (!(isRecord(value) && isEntityKind(value.kind) && typeof value.entityId === "string" &&
    typeof value.capturedAt === "string" && Number.isFinite(Date.parse(value.capturedAt)) &&
    isRecord(value.stamp) && typeof value.stamp.hash === "string" &&
    optionalString(value.stamp.etag) && optionalString(value.stamp.modifiedAt))) {
    return false;
  }
  return value.stamp.hash === stableHash(value.value) &&
    isEntityValue(value.kind, value.entityId, value.value, allowNull, allowEmptySentinel);
}

function isQueueOperation(value: unknown): value is SyncQueueOperation {
  if (!(isRecord(value) && typeof value.id === "string" &&
    (value.kind === "task" || value.kind === "project") &&
    typeof value.entityId === "string" &&
    ["create", "update", "complete", "delete"].includes(String(value.operation)) &&
    ["pending", "blocked", "running", "failed", "reconciliation"].includes(String(value.status)) &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts >= 0 &&
    isSnapshot(value.local, false, false))) return false;
  if (!Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !optionalString(value.projectId) || !optionalString(value.conflictId) ||
    !optionalString(value.lastError) || !optionalString(value.idempotencyFingerprint) ||
    !optionalDate(value.nextAttemptAt) ||
    (value.writeFields !== undefined && (
      !Array.isArray(value.writeFields) ||
      value.writeFields.some((field) => typeof field !== "string" || !field.trim()) ||
      new Set(value.writeFields).size !== value.writeFields.length
    )) ||
    (value.remoteOutcomeUnknown !== undefined && typeof value.remoteOutcomeUnknown !== "boolean")) {
    return false;
  }
  if (value.operation === "complete" && value.kind !== "task") return false;
  if (value.local.kind !== value.kind || value.local.entityId !== value.entityId) return false;
  if (value.base !== undefined) {
    if (!isSnapshot(value.base, true, false)) return false;
    if (value.base.kind !== value.kind || value.base.entityId !== value.entityId) return false;
  }
  return true;
}

function migrateV1Data(
  source: Partial<HelixPersistedData>,
): Partial<HelixPersistedData> {
  const migrated = structuredClone(source) as Partial<HelixPersistedData>;
  const rehash = (value: unknown): void => {
    if (!isRecord(value) || !isRecord(value.stamp) || !("value" in value)) return;
    const current = value.stamp.hash;
    if (
      typeof current === "string" &&
      (current === stableHash(value.value) || legacyHashes(value.value).has(current))
    ) {
      value.stamp.hash = stableHash(value.value);
    }
  };
  for (const collection of [migrated.baseSnapshots, migrated.localSnapshots]) {
    if (!isRecord(collection)) continue;
    for (const snapshot of Object.values(collection)) rehash(snapshot);
  }
  if (Array.isArray(migrated.queue)) {
    for (const operation of migrated.queue) {
      if (!isRecord(operation)) continue;
      rehash(operation.base);
      rehash(operation.local);
    }
  }
  if (Array.isArray(migrated.conflicts)) {
    for (const conflict of migrated.conflicts) {
      if (!isRecord(conflict)) continue;
      rehash(conflict.base);
      rehash(conflict.local);
      rehash(conflict.remote);
    }
  }
  if (Array.isArray(migrated.events)) {
    const migratedEvents = migrated.events
      .map((event): unknown => {
        if (!isHelixEvent(event)) return event;
        if (event.type !== "challenge-completed") {
          return { ...event, id: deterministicEventId(event) };
        }
        const definition = legacyChallengeDefinition(event.entityId);
        return {
          ...event,
          id: deterministicEventId(event),
          metadata: definition
            ? {
                rewardXp: definition.rewardXp,
                ruleVersion: 1,
                title: definition.title,
                metric: definition.metric,
                target: definition.target,
                period: definition.period,
                startsAt: definition.startsAt,
                endsAt: definition.endsAt,
              }
            : event.metadata,
        };
      });
    let invalidIndex = 0;
    migrated.events = uniqueByKey(
      migratedEvents,
      (event) => isHelixEvent(event) ? event.id : `invalid:${invalidIndex++}`,
    );
  }
  migrated.schemaVersion = 2;
  return migrated;
}

function legacyChallengeDefinition(entityId: string) {
  const weekly = /^weekly-(\d{4})-(\d{2})-(\d{2})-(\d+)$/.exec(entityId);
  if (weekly) {
    const date = new Date(
      Number(weekly[1]),
      Number(weekly[2]) - 1,
      Number(weekly[3]),
      12,
    );
    return rotatingChallenges(date).find((challenge) => challenge.id === entityId);
  }
  const monthly = /^monthly-(\d{4})-(\d{2})-(\d+)$/.exec(entityId);
  if (monthly) {
    const year = Number(monthly[1]);
    const month = Number(monthly[2]) - 1;
    const expectedIndex = monthly[3];
    for (const candidate of [
      new Date(year, month, 15, 12),
      new Date(year, month + 1, 15, 12),
    ]) {
      const definition = rotatingChallenges(candidate)[1];
      if (!definition) continue;
      const exact = definition.id === entityId;
      const legacyPrefix = new Date(
        candidate.getFullYear(),
        candidate.getMonth(),
        1,
      ).toISOString().slice(0, 7);
      const legacyId = `monthly-${legacyPrefix}-${expectedIndex}`;
      const samePoolIndex = definition.id.endsWith(`-${expectedIndex}`);
      if (!exact && !(legacyId === entityId && samePoolIndex)) continue;
      if (definition) return definition;
    }
  }
  return undefined;
}

function legacyHashes(value: unknown): Set<string> {
  const input = stableStringify(value);
  let java = 0;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    java = (Math.imul(java, 31) + code) | 0;
  }
  return new Set([Math.abs(java).toString(36)]);
}

function uniqueByKey<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPersistedEvent(value: unknown): value is HelixEvent {
  if (!isHelixEvent(value) || value.id !== deterministicEventId(value)) return false;
  if (
    (value.type === "focus-completed" || value.type === "focus-deleted") &&
    (typeof value.minutes !== "number" || !Number.isFinite(value.minutes))
  ) {
    return false;
  }
  if (value.type !== "challenge-completed") return true;
  const metadata = value.metadata;
  return metadata?.ruleVersion === 1 &&
    typeof metadata.title === "string" &&
    ["focus-sessions", "focus-minutes", "tasks", "reviews", "active-days"].includes(
      String(metadata.metric),
    ) &&
    typeof metadata.target === "number" &&
    Number.isFinite(metadata.target) &&
    metadata.target > 0 &&
    typeof metadata.rewardXp === "number" &&
    Number.isFinite(metadata.rewardXp) &&
    metadata.rewardXp >= 0 &&
    ["weekly", "monthly"].includes(String(metadata.period)) &&
    typeof metadata.startsAt === "string" &&
    Number.isFinite(Date.parse(metadata.startsAt)) &&
    typeof metadata.endsAt === "string" &&
    Number.isFinite(Date.parse(metadata.endsAt)) &&
    metadata.startsAt <= metadata.endsAt;
}

function isConflict(value: unknown): value is SyncConflict {
  if (!(isRecord(value) && typeof value.id === "string" &&
    (value.kind === "task" || value.kind === "project") &&
    typeof value.entityId === "string" &&
    typeof value.title === "string" && typeof value.sourceDeviceId === "string" &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) &&
    ["open", "staged", "applying", "resolved", "superseded"].includes(String(value.status)) &&
    Number.isInteger(value.remoteRecheckCount) && Number(value.remoteRecheckCount) >= 0 &&
    Array.isArray(value.fields) &&
    value.fields.every(isConflictField) &&
    isSnapshot(value.base, true, true) &&
    isSnapshot(value.local, true, false) &&
    isSnapshot(value.remote, true, false) &&
    value.base.kind === value.kind && value.local.kind === value.kind && value.remote.kind === value.kind &&
    value.base.entityId === value.entityId && value.local.entityId === value.entityId &&
    value.remote.entityId === value.entityId)) {
    return false;
  }
  const expected = buildConflictFields(value.base.value, value.local.value, value.remote.value);
  if (expected.length !== value.fields.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const actual = value.fields[index]!;
    const rebuilt = expected[index]!;
    if (!matchesRebuiltConflictField(actual, rebuilt)) return false;
  }
  return !(
    (value.status === "staged" || value.status === "applying") &&
    unresolvedFields(value as unknown as SyncConflict).length > 0
  );
}

function isAudit(value: unknown): value is ResolutionAuditEntry {
  return isRecord(value) && typeof value.id === "string" &&
    typeof value.conflictId === "string" && typeof value.entityId === "string" &&
    isEntityKind(value.kind) && typeof value.resolvedAt === "string" &&
    Number.isFinite(Date.parse(value.resolvedAt)) && isRecord(value.choices) &&
    Object.values(value.choices).every((choice) =>
      isRecord(choice) &&
      ["local", "remote", "custom"].includes(String(choice.choice)) &&
      typeof choice.valueHash === "string"
    ) &&
    typeof value.sourceDeviceId === "string" &&
    typeof value.remoteBeforeHash === "string" && typeof value.remoteAfterHash === "string";
}

function isInProgress(value: unknown): value is InProgressEntry {
  return isRecord(value) && typeof value.taskId === "string" &&
    typeof value.projectId === "string" &&
    typeof value.markedAt === "string" && Number.isFinite(Date.parse(value.markedAt)) &&
    typeof value.lastTouchedAt === "string" && Number.isFinite(Date.parse(value.lastTouchedAt)) &&
    typeof value.activeFocus === "boolean" && optionalString(value.cycleId);
}

function isEntityKind(value: unknown): value is EntityKind {
  return ["task", "project", "habit", "habit-checkin", "focus"].includes(String(value));
}

function isBoardSnapshot(value: unknown): value is DidaBoardSnapshot {
  if (!isRecord(value) || typeof value.projectId !== "string" || !value.projectId) return false;
  if (typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) return false;
  if (typeof value.stale !== "boolean" || !Array.isArray(value.columns)) return false;
  const ids = new Set<string>();
  for (const column of value.columns) {
    if (!isRecord(column) || typeof column.id !== "string" || !column.id || ids.has(column.id)) {
      return false;
    }
    if (
      column.projectId !== value.projectId ||
      typeof column.name !== "string" ||
      !column.name.trim() ||
      (column.sortOrder !== undefined &&
        (typeof column.sortOrder !== "number" || !Number.isSafeInteger(column.sortOrder))) ||
      (column.sortOrderUnsafe !== undefined && column.sortOrderUnsafe !== true)
    ) {
      return false;
    }
    ids.add(column.id);
  }
  if (value.taskColumnIds !== undefined) {
    if (!isRecord(value.taskColumnIds)) return false;
    for (const [taskId, columnId] of Object.entries(value.taskColumnIds)) {
      if (!taskId || (columnId !== null && (typeof columnId !== "string" || !columnId))) {
        return false;
      }
    }
  }
  return true;
}

function hydrateBoardSnapshots(value: unknown): Record<string, DidaBoardSnapshot> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, DidaBoardSnapshot] =>
          isBoardSnapshot(entry[1]) && entry[0] === entry[1].projectId,
      )
      .map(([key, snapshot]) => [key, {
        ...snapshot,
        taskColumnIds: { ...(snapshot.taskColumnIds ?? {}) },
      }]),
  );
}

function migrateConflictBoardProjection(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      !Array.isArray(entry.fields) ||
      !entry.fields.every(isConflictField) ||
      !isSnapshot(entry.base, true, true) ||
      !isSnapshot(entry.local, true, false) ||
      !isSnapshot(entry.remote, true, false)
    ) {
      return entry;
    }
    const rawFields = entry.fields;
    const snapshots = [entry.base, entry.local, entry.remote];
    const hasLegacyProjection = entry.kind === "task" && snapshots.some(
      (snapshot) => isRecord(snapshot.value) &&
        Object.prototype.hasOwnProperty.call(snapshot.value, "columnId"),
    );
    const hasUnsafeProjectOrder = entry.kind === "project" && snapshots.some(
      (snapshot) => isRecord(snapshot.value) &&
        typeof snapshot.value.sortOrder === "number" &&
        !Number.isSafeInteger(snapshot.value.sortOrder),
    );
    if (!hasLegacyProjection && !hasUnsafeProjectOrder) return entry;
    const legacyExpected = buildLegacyConflictFields(entry, hasLegacyProjection);
    if (
      legacyExpected.length !== rawFields.length ||
      legacyExpected.some((field, index) =>
        !matchesRebuiltConflictField(rawFields[index], field)
      )
    ) {
      return entry;
    }
    const migrated = cloneValue(entry) as unknown as SyncConflict;
    const previousFields = migrated.fields;
    stripTaskBoardProjection({}, {}, {}, [], [migrated]);
    const rebuilt = buildConflictFields(
      migrated.base.value,
      migrated.local.value,
      migrated.remote.value,
    );
    for (const field of rebuilt) {
      const previous = previousFields.find((candidate) => candidate.path === field.path);
      if (!previous?.choice) continue;
      field.choice = previous.choice;
      if (previous.choice === "custom") field.customValue = cloneValue(previous.customValue);
    }
    migrated.fields = rebuilt;
    return migrated;
  });
}

function buildLegacyConflictFields(
  entry: Record<string, unknown>,
  includeColumnId: boolean,
): ReturnType<typeof buildConflictFields> {
  const base = (entry.base as EntitySnapshot<unknown>).value;
  const local = (entry.local as EntitySnapshot<unknown>).value;
  const remote = (entry.remote as EntitySnapshot<unknown>).value;
  const fields = buildConflictFields(base, local, remote);
  if (!includeColumnId) return fields;
  const values = [base, local, remote].map((value) =>
    isRecord(value) ? value.columnId : undefined
  );
  const [baseValue, localValue, remoteValue] = values;
  const localChanged = !deepEqual(localValue, baseValue);
  const remoteChanged = !deepEqual(remoteValue, baseValue);
  if (!localChanged && !remoteChanged) return fields;
  const sameResult = deepEqual(localValue, remoteValue);
  const suggestedChoice = sameResult || (localChanged && !remoteChanged)
    ? "local" as const
    : remoteChanged && !localChanged
      ? "remote" as const
      : undefined;
  fields.push({
    path: "columnId",
    // 冻结迁移窗口内曾写入 data.json 的历史界面标签，不能随当前字段表改名。
    label: "看板列",
    baseValue: cloneValue(baseValue),
    localValue: cloneValue(localValue),
    remoteValue: cloneValue(remoteValue),
    localChanged,
    remoteChanged,
    sameResult,
    group: "scalar",
    suggestedChoice,
  });
  return fields.sort((left, right) => left.path.localeCompare(right.path));
}

function matchesRebuiltConflictField(
  actual: unknown,
  rebuilt: ReturnType<typeof buildConflictFields>[number],
): boolean {
  return isRecord(actual) &&
    actual.path === rebuilt.path &&
    actual.label === rebuilt.label &&
    actual.group === rebuilt.group &&
    actual.localChanged === rebuilt.localChanged &&
    actual.remoteChanged === rebuilt.remoteChanged &&
    actual.sameResult === rebuilt.sameResult &&
    actual.suggestedChoice === rebuilt.suggestedChoice &&
    deepEqual(actual.baseValue, rebuilt.baseValue) &&
    deepEqual(actual.localValue, rebuilt.localValue) &&
    deepEqual(actual.remoteValue, rebuilt.remoteValue);
}

function restoreMigratedConflictPlacement(
  rawConflicts: unknown,
  conflicts: SyncConflict[],
  boardSnapshots: Record<string, DidaBoardSnapshot>,
): void {
  if (!Array.isArray(rawConflicts)) return;
  const retainedIds = new Set(conflicts.map((conflict) => conflict.id));
  for (const entry of rawConflicts) {
    if (
      !isRecord(entry) ||
      entry.kind !== "task" ||
      typeof entry.id !== "string" ||
      !retainedIds.has(entry.id) ||
      !isSnapshot(entry.remote, true, false) ||
      !isRecord(entry.remote.value)
    ) {
      continue;
    }
    const taskId = typeof entry.remote.value.id === "string"
      ? entry.remote.value.id
      : entry.remote.entityId;
    const projectId = entry.remote.value.projectId;
    const columnId = entry.remote.value.columnId;
    if (
      typeof projectId === "string" &&
      boardSnapshots[projectId] &&
      (columnId === null || (typeof columnId === "string" && columnId))
    ) {
      boardSnapshots[projectId].taskColumnIds[taskId] = columnId;
    }
  }
}

function stripTaskBoardProjection(
  baseSnapshots: Record<string, EntitySnapshot<unknown>>,
  localSnapshots: Record<string, EntitySnapshot<unknown>>,
  boardSnapshots: Record<string, DidaBoardSnapshot>,
  queue: SyncQueueOperation[],
  conflicts: SyncConflict[],
): void {
  const stripSnapshot = (snapshot: EntitySnapshot<unknown> | undefined): void => {
    if (!snapshot || !isRecord(snapshot.value)) return;
    const value = snapshot.value;
    if (
      snapshot.kind === "project" &&
      typeof value.sortOrder === "number" &&
      !Number.isSafeInteger(value.sortOrder)
    ) {
      delete value.sortOrder;
      value.sortOrderUnsafe = true;
      snapshot.stamp.hash = stableHash(value);
      return;
    }
    if (snapshot.kind !== "task") return;
    const taskId = typeof value.id === "string" ? value.id : snapshot.entityId;
    const projectId = typeof value.projectId === "string" ? value.projectId : undefined;
    if (Object.prototype.hasOwnProperty.call(value, "columnId") && projectId) {
      const columnId = value.columnId;
      const board = boardSnapshots[projectId];
      if (board && (columnId === null || (typeof columnId === "string" && columnId))) {
        board.taskColumnIds[taskId] = columnId;
      }
      delete value.columnId;
      snapshot.stamp.hash = stableHash(value);
    }
  };
  for (const snapshot of Object.values(baseSnapshots)) stripSnapshot(snapshot);
  for (const snapshot of Object.values(localSnapshots)) stripSnapshot(snapshot);
  for (const operation of queue) {
    stripSnapshot(operation.base);
    stripSnapshot(operation.local);
  }
  for (const conflict of conflicts) {
    stripSnapshot(conflict.base);
    stripSnapshot(conflict.local);
    stripSnapshot(conflict.remote);
    const unsafeProjectOrder = conflict.kind === "project" &&
      [conflict.base.value, conflict.local.value, conflict.remote.value].some(
        (value) => isRecord(value) && value.sortOrderUnsafe === true,
      );
    conflict.fields = conflict.fields.filter(
      (field) => field.path !== "columnId" && !(unsafeProjectOrder && field.path === "sortOrder"),
    );
  }
}

function isEntityValue(
  kind: EntityKind,
  entityId: string,
  value: unknown,
  allowNull: boolean,
  allowEmptySentinel: boolean,
): boolean {
  if (value === null) return allowNull;
  if (!isRecord(value)) return false;
  if (allowEmptySentinel && Object.keys(value).length === 0) return true;
  if (kind === "task") {
    return value.id === entityId && typeof value.projectId === "string" &&
      typeof value.title === "string" && typeof value.status === "number";
  }
  if (kind === "project") {
    return value.id === entityId && typeof value.name === "string";
  }
  if (kind === "habit") {
    return value.id === entityId && typeof value.name === "string";
  }
  if (kind === "habit-checkin") {
    if (!(typeof value.habitId === "string" &&
      (typeof value.checkinTime === "string" || typeof value.checkinTime === "number"))) {
      return false;
    }
    return typeof value.id !== "string" || value.id === entityId;
  }
  return value.id === entityId && typeof value.type === "number";
}

function isConflictField(value: unknown): boolean {
  if (!isRecord(value) || typeof value.path !== "string" ||
    typeof value.label !== "string" || typeof value.localChanged !== "boolean" ||
    typeof value.remoteChanged !== "boolean" || typeof value.sameResult !== "boolean" ||
    !["scalar", "text", "schedule", "set", "checklist", "deletion"].includes(String(value.group))) {
    return false;
  }
  if (value.choice !== undefined &&
    !["local", "remote", "custom"].includes(String(value.choice))) return false;
  if (value.suggestedChoice !== undefined &&
    !["local", "remote", "custom"].includes(String(value.suggestedChoice))) return false;
  return value.choice === "custom" ? "customValue" in value : value.customValue === undefined;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalDate(value: unknown): boolean {
  return value === undefined ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function validateLineageConflict(
  value: unknown,
  issues: string[],
): HelixPersistedData["lineageConflict"] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.detectedAt !== "string" ||
    !Number.isFinite(Date.parse(value.detectedAt)) ||
    typeof value.canvasPath !== "string"
  ) {
    issues.push("项目谱系冲突记录损坏，已进入只读恢复模式并忽略该字段");
    return undefined;
  }
  if (
    value.kind !== undefined &&
    !["lineage-concurrent", "project-integrity", "lineage-write"].includes(String(value.kind))
  ) {
    issues.push("项目谱系冲突类型无效，已进入只读恢复模式并忽略该字段");
    return undefined;
  }
  if (!optionalString(value.message)) {
    issues.push("项目谱系冲突说明无效，已进入只读恢复模式并忽略该字段");
    return undefined;
  }
  return {
    detectedAt: value.detectedAt,
    canvasPath: value.canvasPath,
    kind: value.kind as
      | "lineage-concurrent"
      | "project-integrity"
      | "lineage-write"
      | undefined,
    message: value.message as string | undefined,
  };
}
