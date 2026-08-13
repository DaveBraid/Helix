import type { DidaChecklistItem, DidaColumn, DidaProject, DidaTask } from "../domain/entities";
import { stableHash } from "../domain/stable";
import { isDidaChecklistClientId } from "../domain/dida-checklist-id";
import type { HelixDataStore } from "../storage/data-store";
import type { HelixVaultRepository } from "../storage/vault-repository";
import {
  adoptPlanAction,
  assertProjectionStageIdentity,
  assertProjectionActivation,
  buildProjectionActivationPreview,
  buildProjectionLedger,
  parseManagedPlanActions,
  patchManagedPlanAction,
  patchProjectParentTaskId,
  planProjectionChanges,
  projectionMarker,
  readProjectProjectionIdentity,
  restoreManagedPlanAction,
  verifyProjectedTask,
  PROJECTION_ACTION_EDITABLE_STATES,
  PROJECT_PROJECTION_ACTIVATION_VERSION,
  type DidaProjectionTarget,
  type ProjectionActivationPreview,
  type ProjectionColumnCreationCheckpoint,
  type ProjectionFreezeReason,
  type ProjectionLedgerEntry,
  type ProjectionReadiness,
  type ProjectionReceiptCleanupProof,
  type ProjectionTaskWriteField,
} from "../domain/dida-project-projection";
import type { ResolutionAuditEntry } from "../sync/types";
import { createDidaChecklistClientItem } from "../integrations/dida/serialization";

export interface ProjectionMarkdownRevision {
  path: string;
  hash: string;
  content: string;
}

export interface ProjectionMarkdownPort {
  read(path: string): Promise<ProjectionMarkdownRevision | null>;
  compareAndWrite(revision: ProjectionMarkdownRevision, content: string): Promise<ProjectionMarkdownRevision>;
}

export class VaultProjectionMarkdownAdapter implements ProjectionMarkdownPort {
  constructor(private readonly repository: Pick<HelixVaultRepository, "read" | "compareAndWrite">) {}
  read(path: string): Promise<ProjectionMarkdownRevision | null> {
    return this.repository.read(path);
  }
  compareAndWrite(
    revision: ProjectionMarkdownRevision,
    content: string,
  ): Promise<ProjectionMarkdownRevision> {
    return this.repository.compareAndWrite(revision, content);
  }
}

/** Existing Helix task pipeline adapter. Implementations must enqueue through the normal queue/contract engine. */
export interface ProjectionTaskPipeline {
  createTask(task: DidaTask, clientIdentity: string): Promise<ProjectionWriteReceipt>;
  recoverCreate(clientIdentity: string, projectId: string): Promise<ProjectionWriteReceipt | null>;
  updateTask(task: DidaTask, writeFields: string[], operationId?: string, freshBase?: DidaTask): Promise<ProjectionWriteReceipt>;
  stageTaskConflict(local: DidaTask, remote: DidaTask, base: DidaTask, operationId: string, writeFields: string[]): Promise<ProjectionWriteReceipt>;
  stageItemsConflict(local: DidaTask, remote: DidaTask, base: DidaTask, operationId: string): Promise<ProjectionWriteReceipt>;
  completeTask(task: DidaTask): Promise<ProjectionWriteReceipt>;
  reopenTask(task: DidaTask): Promise<ProjectionWriteReceipt>;
  deleteTask(expected: ProjectionRemoteIdentity): Promise<ProjectionDeleteReceipt>;
  rereadTask(projectId: string, taskId: string): Promise<DidaTask | null>;
}

/**
 * 共享层接入 HelixService 时必须实现的窄端口。四个写方法都必须持有现有
 * RemoteWriteGate 授权租约、写入现有 OfflineQueue、调用现有 drainQueue，
 * 并在返回前用现有 DidaTaskAdapter 写后复读；不得直接调用 DidaApi。
 */
export interface ExistingHelixTaskQueuePort {
  enqueueProjectionCreate(task: DidaTask, clientIdentity: string): Promise<ProjectionWriteReceipt>;
  recoverProjectionCreate(clientIdentity: string, projectId: string): Promise<ProjectionWriteReceipt | null>;
  enqueueProjectionUpdate(task: DidaTask, writeFields: string[], operationId?: string, freshBase?: DidaTask): Promise<ProjectionWriteReceipt>;
  stageProjectionTaskConflict(local: DidaTask, remote: DidaTask, base: DidaTask, operationId: string, writeFields: string[]): Promise<ProjectionWriteReceipt>;
  stageProjectionItemsConflict(local: DidaTask, remote: DidaTask, base: DidaTask, operationId: string): Promise<ProjectionWriteReceipt>;
  enqueueProjectionComplete(task: DidaTask): Promise<ProjectionWriteReceipt>;
  enqueueProjectionReopen(task: DidaTask): Promise<ProjectionWriteReceipt>;
  enqueueProjectionDelete(expected: ProjectionRemoteIdentity): Promise<ProjectionDeleteReceipt>;
  verifyRemoteTask(projectId: string, taskId: string): Promise<DidaTask>;
}

export interface ProjectionCatalogSnapshot {
  projects: DidaProject[];
  columns: DidaColumn[];
  readiness: ProjectionReadiness;
}

export interface ExistingHelixProjectionCatalogPort {
  readProjectionCatalog(projectId: string): Promise<ProjectionCatalogSnapshot>;
}

/** 唯一允许的生产适配器：投影层只翻译结果，写入仍由 HelixService/OfflineQueue 完成。 */
export class ExistingHelixTaskPipelineAdapter implements ProjectionTaskPipeline {
  constructor(private readonly operations: ExistingHelixTaskQueuePort) {}

  async createTask(task: DidaTask, clientIdentity: string): Promise<ProjectionWriteReceipt> {
    return this.operations.enqueueProjectionCreate(task, clientIdentity);
  }

  async recoverCreate(clientIdentity: string, projectId: string): Promise<ProjectionWriteReceipt | null> {
    return this.operations.recoverProjectionCreate(clientIdentity, projectId);
  }

  async updateTask(task: DidaTask, writeFields: string[], operationId?: string, freshBase?: DidaTask): Promise<ProjectionWriteReceipt> {
    return this.operations.enqueueProjectionUpdate(task, writeFields, operationId, freshBase);
  }

  stageTaskConflict(local: DidaTask, remote: DidaTask, base: DidaTask, operationId: string, writeFields: string[]): Promise<ProjectionWriteReceipt> {
    return this.operations.stageProjectionTaskConflict(local, remote, base, operationId, writeFields);
  }

  stageItemsConflict(local: DidaTask, remote: DidaTask, base: DidaTask, operationId: string): Promise<ProjectionWriteReceipt> {
    return this.operations.stageProjectionItemsConflict(local, remote, base, operationId);
  }

  async completeTask(task: DidaTask): Promise<ProjectionWriteReceipt> {
    return this.operations.enqueueProjectionComplete(task);
  }

  async reopenTask(task: DidaTask): Promise<ProjectionWriteReceipt> {
    return this.operations.enqueueProjectionReopen(task);
  }

  async deleteTask(expected: ProjectionRemoteIdentity): Promise<ProjectionDeleteReceipt> {
    return this.operations.enqueueProjectionDelete(expected);
  }

  async rereadTask(projectId: string, taskId: string): Promise<DidaTask | null> {
    try {
      return await this.operations.verifyRemoteTask(projectId, taskId);
    } catch (error) {
      if (isMissingRemote(error)) return null;
      throw error;
    }
  }

}

export class ExistingHelixProjectionCatalogAdapter implements ProjectionCatalogPort {
  constructor(private readonly source: ExistingHelixProjectionCatalogPort) {}
  read(projectId: string): Promise<ProjectionCatalogSnapshot> {
    return this.source.readProjectionCatalog(projectId);
  }
}

export type ProjectionWriteOutcome =
  | "verified"
  | "preflight-changed"
  | "unknown"
  | "conflict"
  | "retryable"
  | "authorization"
  | "capability";

export type ProjectionWriteReceipt =
  | { operationId: string; outcome: "verified"; task: DidaTask; conflictId?: string }
  | { operationId: string; outcome: "preflight-changed"; task: DidaTask; message: string; conflictId?: undefined }
  | { operationId: string; outcome: Exclude<ProjectionWriteOutcome, "verified" | "preflight-changed">; message: string; conflictId?: string };

export type ProjectionDeleteReceipt =
  | { operationId: string; outcome: "verified-absent"; conflictId?: string }
  | { operationId: string; outcome: Exclude<ProjectionWriteOutcome, "verified">; message: string; conflictId?: string };

export interface ProjectionRemoteIdentity {
  taskId: string;
  parentTaskId: string;
  targetProjectId: string;
  targetColumnId: string;
  marker: string;
}

export interface ProjectionPersistentState {
  enabled: boolean;
  activationVersion?: number;
  target?: DidaProjectionTarget;
  confirmedPreviewHash?: string;
  ledger: ProjectionLedgerEntry[];
  parentCheckpoints: Array<{
    projectId: string;
    remoteId?: string;
    marker: string;
    /** 删除项目父任务时的持久检查点；存在时绝不自动重发删除。 */
    tombstone?: boolean;
    frozen?: ProjectionFreezeReason;
    operationId?: string;
    conflictId?: string;
  }>;
  /** 经写后复读确认的同步 Base；不是父任务映射真值。 */
  parentBases?: Array<{
    projectId: string;
    remoteId: string;
    title: string;
    status: number;
  }>;
  receiptCleanupPending?: ProjectionReceiptCleanupProof[];
  columnCreation?: ProjectionColumnCreationCheckpoint;
}

export interface ProjectionStatePort {
  read(): Promise<ProjectionPersistentState>;
  write(expected: ProjectionPersistentState, next: ProjectionPersistentState): Promise<void>;
}

export class ProjectionStateConflictError extends Error {
  constructor() {
    super("滴答项目同步状态在写入前发生竞争");
    this.name = "ProjectionStateConflictError";
  }
}

export class PersistedProjectionStatePort implements ProjectionStatePort {
  constructor(private readonly store: Pick<HelixDataStore, "snapshot" | "mutate">) {}

  async read(): Promise<ProjectionPersistentState> {
    return (await this.store.snapshot()).didaProjectionState ?? {
      enabled: false,
      ledger: [],
      parentCheckpoints: [],
    };
  }

  async write(expected: ProjectionPersistentState, next: ProjectionPersistentState): Promise<void> {
    await this.store.mutate((data) => {
      const current = data.didaProjectionState ?? {
        enabled: false,
        ledger: [],
        parentCheckpoints: [],
      };
      if (stableHash(current) !== stableHash(expected)) {
        throw new ProjectionStateConflictError();
      }
      data.didaProjectionState = structuredClone(next);
    });
  }
}

export type ProjectionOperationDiagnostic = Awaited<ReturnType<HelixDataStore["snapshot"]>>["projectionOperationReceipts"][number];

export interface ProjectionDiagnosticsPort {
  list(): Promise<ProjectionOperationDiagnostic[]>;
  inspect(operationId: string, conflictId?: string): Promise<{
    receipt?: ProjectionOperationDiagnostic;
    blocked: boolean;
    resolvedTask?: DidaTask;
    resolutionAudit?: ResolutionAuditEntry;
  }>;
  removeResolved(operationId: string): Promise<void>;
  removeReconciled(operationId: string, conflictId?: string): Promise<void>;
}

export class PersistedProjectionDiagnosticsPort implements ProjectionDiagnosticsPort {
  constructor(private readonly store: Pick<HelixDataStore, "snapshot" | "mutate">) {}
  async list(): Promise<ProjectionOperationDiagnostic[]> {
    return structuredClone((await this.store.snapshot()).projectionOperationReceipts);
  }
  async inspect(operationId: string, conflictId?: string): Promise<{
    receipt?: ProjectionOperationDiagnostic;
    blocked: boolean;
    resolvedTask?: DidaTask;
    resolutionAudit?: ResolutionAuditEntry;
  }> {
    const data = await this.store.snapshot();
    const receipt = data.projectionOperationReceipts.find((item) => item.operationId === operationId);
    const effectiveConflictId = conflictId ?? receipt?.conflictId;
    const conflict = effectiveConflictId
      ? data.conflicts.find((item) => item.id === effectiveConflictId)
      : undefined;
    const blocked = data.queue.some((item) => item.id === operationId) ||
      Boolean(conflict && conflict.status !== "resolved" && conflict.status !== "superseded");
    const candidates = receipt ? Object.values(data.baseSnapshots)
      .filter((snapshot) => snapshot.kind === "task" && snapshot.value !== null)
      .map((snapshot) => snapshot.value as DidaTask)
      .filter((task) => task.projectId === receipt.projectId && task.content === receipt.marker &&
        (receipt.remoteTaskId === undefined || task.id === receipt.remoteTaskId)) : [];
    return {
      receipt: receipt ? structuredClone(receipt) : undefined,
      blocked,
      resolvedTask: candidates.length === 1 ? structuredClone(candidates[0]!) : undefined,
      resolutionAudit: effectiveConflictId
        ? structuredClone(data.resolutionAudit.find((item) => item.conflictId === effectiveConflictId))
        : undefined,
    };
  }
  async removeResolved(operationId: string): Promise<void> {
    await this.store.mutate((data) => {
      const receipt = data.projectionOperationReceipts.find((item) => item.operationId === operationId);
      if (!receipt) throw new Error("找不到同步操作收据");
      if (receipt.outcome !== "verified" && receipt.outcome !== "verified-absent") {
        throw new Error("只有已验证收口的同步收据可以安全移除");
      }
      if (data.queue.some((item) => item.id === operationId)) {
        throw new Error("同步操作仍在队列中，禁止移除收据");
      }
      const conflict = receipt.conflictId
        ? data.conflicts.find((item) => item.id === receipt.conflictId)
        : undefined;
      if (conflict && conflict.status !== "resolved" && conflict.status !== "superseded") {
        throw new Error("同步冲突仍未解决，禁止移除收据");
      }
      data.projectionOperationReceipts = data.projectionOperationReceipts
        .filter((item) => item.operationId !== operationId);
    });
  }
  async removeReconciled(operationId: string, conflictId?: string): Promise<void> {
    await this.store.mutate((data) => {
      const receipt = data.projectionOperationReceipts.find((item) => item.operationId === operationId);
      if (!receipt) throw new Error("找不到同步操作收据");
      if (data.queue.some((item) => item.id === operationId)) {
        throw new Error("同步操作仍在队列中，禁止移除收据");
      }
      const effectiveConflictId = conflictId ?? receipt.conflictId;
      const conflict = effectiveConflictId
        ? data.conflicts.find((item) => item.id === effectiveConflictId)
        : undefined;
      if (conflict && conflict.status !== "resolved" && conflict.status !== "superseded") {
        throw new Error("同步冲突仍未解决，禁止移除收据");
      }
      data.projectionOperationReceipts = data.projectionOperationReceipts
        .filter((item) => item.operationId !== operationId);
    });
  }
}

export interface ProjectionCatalogPort {
  read(projectId: string): Promise<ProjectionCatalogSnapshot>;
}

export interface ProjectionProjectInput {
  projectId: string;
  projectPath: string;
  projectTitle: string;
  projectStatus: "planned" | "active" | "paused" | "completed" | "terminated";
  stages: Array<{ path: string; stageId: string }>;
}

export interface ProjectionSyncSummary {
  createdParents: number;
  updatedParents: number;
  completedParents: number;
  createdActions: number;
  updatedActions: number;
  completedActions: number;
  deletedActions: number;
  frozen: Array<{ uuid: string; reason: ProjectionFreezeReason; message: string }>;
}

export interface ProjectionProjectDeleteSummary {
  deletedActions: number;
  deletedParent: boolean;
}

export interface ProjectionProjectReadModel {
  enabled: boolean;
  target?: DidaProjectionTarget;
  columnCreation?: ProjectionColumnCreationCheckpoint;
  project: { id: string; path: string; title: string; status: ProjectionProjectInput["projectStatus"]; parentTaskId?: string };
  stages: Array<{
    id: string;
    path: string;
    revisionHash: string;
    managed: Array<{
      uuid: string;
      line: number;
      title: string;
      state: ProjectionLedgerEntry["state"];
      remoteId?: string;
      frozen?: ProjectionFreezeReason;
      operationId?: string;
      conflictId?: string;
    }>;
    unmanaged: Array<{ line: number; title: string; completed: boolean }>;
  }>;
  parentDiagnostic?: ProjectionPersistentState["parentCheckpoints"][number];
  receipts: ProjectionOperationDiagnostic[];
  receiptCleanupPending: ProjectionReceiptCleanupProof[];
  orphanDiagnostics: Array<{
    uuid: string;
    stageId: string;
    state: ProjectionLedgerEntry["state"];
    frozen?: ProjectionFreezeReason;
    operationId?: string;
    conflictId?: string;
    remoteId?: string;
    tombstone: boolean;
  }>;
}

export class DidaProjectProjectionService {
  constructor(
    private readonly markdown: ProjectionMarkdownPort,
    private readonly pipeline: ProjectionTaskPipeline,
    private readonly state: ProjectionStatePort,
    private readonly catalog: ProjectionCatalogPort,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly diagnostics?: ProjectionDiagnosticsPort,
  ) {}

  async readConfiguration(): Promise<ProjectionPersistentState> {
    return this.state.read();
  }

  async readProject(input: ProjectionProjectInput): Promise<ProjectionProjectReadModel> {
    const state = await this.state.read();
    const projectRevision = await this.requireRevision(input.projectPath);
    const identity = readProjectProjectionIdentity(projectRevision.content);
    if (identity.projectId !== input.projectId) throw new Error("项目 Markdown 身份与稳定工作区不一致");
    const stages: ProjectionProjectReadModel["stages"] = [];
    for (const stage of input.stages) {
      const revision = await this.requireRevision(stage.path);
      assertProjectionStageIdentity(revision.content, stage.stageId);
      const parsed = parseManagedPlanActions(revision.content);
      stages.push({
        id: stage.stageId,
        path: stage.path,
        revisionHash: revision.hash,
        managed: parsed.actions.map((action) => {
          const persisted = state.ledger.find((entry) => entry.uuid === action.uuid &&
            entry.projectId === input.projectId && entry.stageId === stage.stageId);
          return {
            uuid: action.uuid,
            line: action.line,
            title: action.title,
            state: action.state,
            remoteId: action.remoteId,
            frozen: persisted?.frozen,
            operationId: persisted?.operationId,
            conflictId: persisted?.conflictId,
          };
        }),
        unmanaged: parsed.unmanagedChecklistLines.map((line) => unmanagedAction(revision.content, line)),
      });
    }
    const managedIdentities = new Set(stages.flatMap((stage) => stage.managed.map((action) =>
      projectionLedgerIdentity({ projectId: identity.projectId, stageId: stage.id, uuid: action.uuid }))));
    const orphanEntries = state.ledger.filter((entry) => entry.projectId === identity.projectId &&
      !managedIdentities.has(projectionLedgerIdentity(entry)));
    const receipts = (await this.diagnostics?.list() ?? []).filter((receipt) =>
      receipt.marker === `helix-project-projection:${identity.projectId}` ||
      stages.some((stage) => stage.managed.some((action) =>
        receipt.marker === projectionMarker(action.uuid))) ||
      orphanEntries.some((entry) => receipt.marker === projectionMarker(entry.uuid)));
    return {
      enabled: state.enabled,
      target: state.target ? { ...state.target } : undefined,
      columnCreation: state.columnCreation ? structuredClone(state.columnCreation) : undefined,
      project: {
        id: identity.projectId,
        path: input.projectPath,
        title: input.projectTitle,
        status: input.projectStatus,
        parentTaskId: identity.parentTaskId,
      },
      stages,
      parentDiagnostic: state.parentCheckpoints.find((item) => item.projectId === identity.projectId),
      receipts,
      receiptCleanupPending: (state.receiptCleanupPending ?? [])
        .filter((proof) => proof.projectId === identity.projectId)
        .map((proof) => ({ ...proof })),
      orphanDiagnostics: orphanEntries.map((entry) => ({
        uuid: entry.uuid,
        stageId: entry.stageId,
        state: entry.state,
        frozen: entry.frozen,
        operationId: entry.operationId,
        conflictId: entry.conflictId,
        remoteId: entry.remoteId,
        tombstone: entry.tombstone === true,
      })),
    };
  }

  async adoptAction(input: { stagePath: string; expectedStageId: string; expectedHash: string; line: number }): Promise<ProjectionMarkdownRevision> {
    const revision = await this.requireRevision(input.stagePath);
    if (revision.hash !== input.expectedHash) throw new Error("阶段 Markdown 在加入同步前发生变化");
    assertProjectionStageIdentity(revision.content, input.expectedStageId);
    return this.markdown.compareAndWrite(
      revision,
      adoptPlanAction(revision.content, input.line, crypto.randomUUID()),
    );
  }

  async editAction(input: {
    stagePath: string;
    expectedStageId: string;
    expectedHash: string;
    uuid: string;
    title?: string;
    state?: ProjectionLedgerEntry["state"];
  }): Promise<ProjectionMarkdownRevision> {
    if (input.state !== undefined && !PROJECTION_ACTION_EDITABLE_STATES.includes(input.state)) {
      throw new Error("计划行动状态无效");
    }
    const revision = await this.requireRevision(input.stagePath);
    if (revision.hash !== input.expectedHash) throw new Error("阶段 Markdown 在编辑前发生变化");
    assertProjectionStageIdentity(revision.content, input.expectedStageId);
    return this.markdown.compareAndWrite(revision, patchManagedPlanAction(revision.content, {
      uuid: input.uuid,
      title: input.title,
      state: input.state,
    }));
  }

  async disable(): Promise<void> {
    const current = await this.state.read();
    if (!current.enabled) return;
    await this.state.write(current, { ...current, enabled: false });
  }

  /**
   * 远端目标已由用户删除后清理停用配置。只允许在所有恢复身份均为空时执行，
   * 避免清掉仍用于安全删除、结果未知或分栏恢复的唯一目标 ID。
   */
  async clearDisabledConfiguration(): Promise<void> {
    const current = await this.state.read();
    if (current.enabled) throw new Error("请先停用滴答项目同步");
    if (current.ledger.length > 0 || current.parentCheckpoints.length > 0 ||
      (current.parentBases?.length ?? 0) > 0 ||
      (current.receiptCleanupPending?.length ?? 0) > 0 || current.columnCreation) {
      throw new Error("滴答项目同步仍有恢复身份，禁止清除目标配置");
    }
    await this.state.write(current, {
      enabled: false,
      ledger: [],
      parentCheckpoints: [],
    });
  }

  /**
   * 在本地项目进入废纸篓前，精确删除 Helix 拥有的远端子任务与父任务。
   * 每个删除都先持久化 tombstone；结果未知时保留检查点且禁止重发。
   */
  async deleteProject(input: ProjectionProjectInput): Promise<ProjectionProjectDeleteSummary> {
    let state = await this.state.read();
    const projectRevision = await this.requireRevision(input.projectPath);
    const identity = readProjectProjectionIdentity(projectRevision.content);
    if (identity.projectId !== input.projectId) throw new Error("项目 Markdown 身份与稳定工作区不一致");
    const owned = state.ledger.filter((entry) => entry.projectId === input.projectId);
    const existingParentCheckpoint = state.parentCheckpoints.find((item) => item.projectId === input.projectId);
    const parentId = identity.parentTaskId ?? state.parentBases?.find((item) => item.projectId === input.projectId)?.remoteId ??
      existingParentCheckpoint?.remoteId;
    if (existingParentCheckpoint?.tombstone && !existingParentCheckpoint.frozen) {
      return { deletedActions: 0, deletedParent: true };
    }
    if (!parentId && owned.length === 0) return { deletedActions: 0, deletedParent: false };
    if (!state.enabled || state.activationVersion !== PROJECT_PROJECTION_ACTIVATION_VERSION || !state.target) {
      throw new Error("该项目仍绑定滴答任务；请先启用项目同步并完成远端清理，再删除本地项目");
    }
    if (!parentId) throw new Error("项目同步账本存在，但父任务身份缺失；已拒绝删除");
    let deletedActions = 0;
    for (const entry of owned) {
      if (!entry.remoteId || entry.remoteEntity !== "task") {
        throw new Error("项目含无法精确验证的旧版行动绑定；已拒绝删除");
      }
      const remote = await this.pipeline.rereadTask(entry.targetProjectId, entry.remoteId);
      if (entry.tombstone) {
        if (remote) throw new Error("行动删除结果未知且远端对象仍存在；禁止自动重发");
        await this.settleDeletedAction(entry);
        deletedActions += 1;
        continue;
      }
      if (entry.frozen) throw new Error("项目含尚未解决的冻结行动；请先在冲突中心处理");
      if (!remote) {
        await this.removeProjectLedgerEntry(entry);
        continue;
      }
      verifyProjectedTask(remote, entry, projectionMarker(entry.uuid), { title: false, state: false, attributes: false });
      const checkpoint: ProjectionLedgerEntry = {
        ...entry,
        tombstone: true,
        frozen: "unknown-outcome",
        operationId: `op-projection-task-delete-${crypto.randomUUID()}`,
      };
      await this.replaceProjectLedgerEntry(checkpoint);
      const result = await this.pipeline.deleteTask({
        taskId: entry.remoteId,
        parentTaskId: entry.parentTaskId,
        targetProjectId: entry.targetProjectId,
        targetColumnId: entry.targetColumnId,
        marker: projectionMarker(entry.uuid),
      });
      if (result.outcome !== "verified-absent") {
        await this.replaceProjectLedgerEntry({
          ...checkpoint,
          frozen: resultReason(result),
          operationId: result.operationId,
          conflictId: result.conflictId,
        });
        throw new Error(`行动远端删除未安全收口：${result.message}`);
      }
      await this.settleDeletedAction({ ...checkpoint, operationId: result.operationId, conflictId: result.conflictId });
      deletedActions += 1;
    }
    state = await this.state.read();
    const parentCheckpoint = state.parentCheckpoints.find((item) => item.projectId === input.projectId);
    const remoteParent = await this.pipeline.rereadTask(state.target!.targetProjectId, parentId);
    if (parentCheckpoint?.tombstone) {
      if (remoteParent) throw new Error("项目父任务删除结果未知且远端对象仍存在；禁止自动重发");
      await this.settleDeletedParent(state, input.projectId, parentId, parentCheckpoint);
      return { deletedActions, deletedParent: true };
    }
    if (parentCheckpoint?.frozen) throw new Error("项目父任务仍处于冻结状态；请先在冲突中心处理");
    if (!remoteParent) {
      await this.clearDeletedProjectState(state, input.projectId);
      return { deletedActions, deletedParent: false };
    }
    if (!this.sameParentIdentity(remoteParent, input.projectId, parentId, state.target!)) {
      throw new Error("项目父任务身份与远端不一致；已拒绝删除");
    }
    const marker = `helix-project-projection:${input.projectId}`;
    const prepared = {
      projectId: input.projectId,
      remoteId: parentId,
      marker,
      tombstone: true,
      frozen: "unknown-outcome" as const,
      operationId: `op-projection-parent-delete-${crypto.randomUUID()}`,
    };
    await this.state.write(state, {
      ...state,
      parentCheckpoints: [...state.parentCheckpoints.filter((item) => item.projectId !== input.projectId), prepared],
    });
    const result = await this.pipeline.deleteTask({
      taskId: parentId,
      parentTaskId: "",
      targetProjectId: state.target!.targetProjectId,
      targetColumnId: state.target!.targetColumnId,
      marker,
    });
    if (result.outcome !== "verified-absent") {
      const latest = await this.state.read();
      await this.state.write(latest, {
        ...latest,
        parentCheckpoints: [
          ...latest.parentCheckpoints.filter((item) => item.projectId !== input.projectId),
          { ...prepared, frozen: resultReason(result), operationId: result.operationId, conflictId: result.conflictId },
        ],
      });
      throw new Error(`项目父任务远端删除未安全收口：${result.message}`);
    }
    await this.settleDeletedParent(await this.state.read(), input.projectId, parentId, {
      ...prepared,
      operationId: result.operationId,
      conflictId: result.conflictId,
    });
    return { deletedActions, deletedParent: true };
  }

  /** 本地 Project/Stage/Canvas 已成功移入废纸篓后，才释放删除 tombstone。 */
  async finalizeProjectDeletion(projectId: string): Promise<void> {
    const state = await this.state.read();
    const checkpoint = state.parentCheckpoints.find((item) => item.projectId === projectId);
    if (!checkpoint?.tombstone || checkpoint.frozen || state.ledger.some((entry) => entry.projectId === projectId)) {
      if (!checkpoint && !state.ledger.some((entry) => entry.projectId === projectId)) return;
      throw new Error("项目远端删除尚未安全收口，禁止结束删除事务");
    }
    await this.state.write(state, {
      ...state,
      parentCheckpoints: state.parentCheckpoints.filter((item) => item.projectId !== projectId),
      parentBases: state.parentBases?.filter((item) => item.projectId !== projectId),
    });
  }

  async reconcileFrozen(input:
    | { kind: "action"; projectId: string; stageId: string; stagePath: string; uuid: string }
    | { kind: "parent"; projectId: string; projectPath: string; title: string; status: ProjectionProjectInput["projectStatus"] }): Promise<void> {
    let current = await this.state.read();
    if (!current.target) throw new Error("滴答项目同步尚无已确认目标");
    if (input.kind === "action") {
      const foundEntry = current.ledger.find((item) => item.uuid === input.uuid &&
        item.projectId === input.projectId && item.stageId === input.stageId);
      if (!foundEntry?.frozen) throw new Error("行动没有待复核的冻结状态");
      if (foundEntry.remoteEntity === "task") {
        return this.reconcileFrozenTaskAction(input, current, foundEntry);
      }
      throw new Error("旧版项目同步记录仅供查看；请移除旧绑定后重新纳入真实子任务同步");
    }
    const checkpoint = current.parentCheckpoints.find((item) => item.projectId === input.projectId);
    if (!checkpoint?.frozen) throw new Error("父任务没有待复核的冻结状态");
    const inspection = checkpoint.operationId && this.diagnostics
      ? await this.diagnostics.inspect(checkpoint.operationId, checkpoint.conflictId)
      : undefined;
    if (inspection?.blocked) {
      throw new Error("该父任务冻结仍由队列或逐字段冲突持有，必须先在冲突中心解决");
    }
    if (checkpoint.operationId && !inspection?.receipt) {
      throw new Error("冻结父任务缺少既有操作收据，禁止旁路收口");
    }
    if (!inspection && checkpoint.frozen !== "identity-mismatch" && checkpoint.frozen !== "markdown-race") {
      throw new Error("父任务冻结缺少可证明已由既有冲突流程收口的操作诊断");
    }
    const remoteId = checkpoint.remoteId ?? inspection?.resolvedTask?.id;
    if (!remoteId) throw new Error("冻结父任务没有可精确复读的远端 ID");
    const cleanupProof: ProjectionReceiptCleanupProof | undefined = checkpoint.operationId ? {
      kind: "parent",
      operationId: checkpoint.operationId,
      conflictId: checkpoint.conflictId ?? inspection?.receipt?.conflictId,
      projectId: input.projectId,
      targetProjectId: current.target.targetProjectId,
      marker: `helix-project-projection:${input.projectId}`,
      remoteTaskId: remoteId,
    } : undefined;
    if (cleanupProof && inspection?.receipt) {
      assertReceiptMatchesProof(inspection.receipt, cleanupProof);
    }
    const remote = await this.pipeline.rereadTask(current.target.targetProjectId, remoteId);
    const desiredStatus = input.status === "completed" ? 2 : 0;
    if (!remote || !this.sameParentIdentity(remote, input.projectId, remoteId, current.target) ||
      remote.title !== input.title || remote.status !== desiredStatus) {
      throw new Error("父任务精确复读身份仍不一致，保持冻结");
    }
    const projectRevision = await this.requireRevision(input.projectPath);
    const projectIdentity = readProjectProjectionIdentity(projectRevision.content);
    if (projectIdentity.projectId !== input.projectId) {
      throw new Error("项目 Markdown 身份与稳定工作区不一致");
    }
    if (projectIdentity.parentTaskId !== remoteId) {
      await this.markdown.compareAndWrite(
        projectRevision,
        patchProjectParentTaskId(projectRevision.content, remoteId),
      );
    }
    await this.settleReconciliation(current, {
      ...current,
      parentCheckpoints: current.parentCheckpoints.filter((item) => item.projectId !== input.projectId),
    }, cleanupProof);
  }

  private async settleReconciliation(
    current: ProjectionPersistentState,
    next: ProjectionPersistentState,
    proof?: ProjectionReceiptCleanupProof,
  ): Promise<void> {
    if (!proof) {
      await this.state.write(current, next);
      return;
    }
    const pending = [
      ...(next.receiptCleanupPending ?? []).filter((item) => item.operationId !== proof.operationId),
      proof,
    ];
    await this.state.write(current, { ...next, receiptCleanupPending: pending });
    await this.retryReceiptCleanup(proof.operationId);
  }

  /**
   * 投影账本与普通同步诊断共用 data.json；收据清理等并发状态提交可能令一次
   * CAS 失效。只对明确的状态 CAS 竞争重读并重算，Markdown CAS 绝不重试。
   */
  private async writeLatestState(
    update: (current: ProjectionPersistentState) => ProjectionPersistentState,
    proof?: ProjectionReceiptCleanupProof,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.state.read();
      try {
        await this.settleReconciliation(current, update(current), proof);
        return;
      } catch (error) {
        if (!(error instanceof ProjectionStateConflictError) || attempt === 2) throw error;
      }
    }
  }

  private async reconcileFrozenTaskAction(
    input: { kind: "action"; projectId: string; stageId: string; stagePath: string; uuid: string },
    current: ProjectionPersistentState,
    entry: ProjectionLedgerEntry,
  ): Promise<void> {
    const inspection = entry.operationId && this.diagnostics
      ? await this.diagnostics.inspect(entry.operationId, entry.conflictId)
      : undefined;
    if (inspection?.blocked) {
      throw new Error("该冻结仍由队列或逐字段冲突持有，必须先在冲突中心解决");
    }
    if (entry.operationId && !inspection?.receipt) {
      throw new Error("真实子任务冻结缺少既有操作收据，禁止旁路收口或重发");
    }
    let remote = entry.remoteId
      ? await this.pipeline.rereadTask(entry.targetProjectId, entry.remoteId)
      : inspection?.resolvedTask;
    if (remote && remote.projectId !== entry.targetProjectId) remote = undefined;
    const proof = entry.operationId && remote ? {
      kind: "action" as const,
      operationId: entry.operationId,
      conflictId: entry.conflictId ?? inspection?.receipt?.conflictId,
      projectId: entry.projectId,
      stageId: entry.stageId,
      uuid: entry.uuid,
      targetProjectId: entry.targetProjectId,
      marker: projectionMarker(entry.uuid),
      remoteTaskId: remote.id,
    } : undefined;
    if (proof && inspection?.receipt) assertReceiptMatchesProof(inspection.receipt, proof);

    if (entry.tombstone) {
      if (remote) throw new Error("远端子任务仍存在，删除结果尚未得到证明");
      if (!entry.remoteId) throw new Error("删除冻结缺少远端子任务 ID");
      const deletionProof = entry.operationId ? {
        kind: "action" as const,
        operationId: entry.operationId,
        conflictId: entry.conflictId ?? inspection?.receipt?.conflictId,
        projectId: entry.projectId,
        stageId: entry.stageId,
        uuid: entry.uuid,
        targetProjectId: entry.targetProjectId,
        marker: projectionMarker(entry.uuid),
        remoteTaskId: entry.remoteId,
      } : undefined;
      if (deletionProof && inspection?.receipt) assertReceiptMatchesProof(inspection.receipt, deletionProof);
      await this.settleReconciliation(current, {
        ...current,
        ledger: current.ledger.filter((candidate) =>
          projectionLedgerIdentity(candidate) !== projectionLedgerIdentity(entry)),
      }, deletionProof);
      return;
    }
    if (!remote) throw new Error("无法精确复读真实子任务，保持冻结且不按标题领养");
    const recovered = { ...entry, remoteId: remote.id };
    // 结果未知的领养入口已通过远端详情精确核验目标分栏；普通同步快照有意不持久化
    // 服务端派生的 columnId，因此冻结收口只复核其余身份与属性。
    verifyProjectedTask(remote, recovered, projectionMarker(entry.uuid), {
      title: false,
      state: false,
      column: false,
    });
    const conflictResolved = Boolean(entry.conflictId && inspection?.resolutionAudit &&
      inspection.resolutionAudit.conflictId === entry.conflictId && inspection.resolvedTask &&
      stableHash(inspection.resolvedTask) === stableHash(remote));
    const desiredStatus = entry.state === "completed" ? 2 : 0;
    if (!conflictResolved && (remote.title !== entry.title || remote.status !== desiredStatus)) {
      throw new Error("远端真实子任务尚未与冻结目标一致，保持冻结");
    }
    const resolvedState: ProjectionLedgerEntry["state"] = remote.status === 2
      ? "completed"
      : entry.state === "completed" ? "active" : entry.state;
    const revision = await this.requireRevision(input.stagePath);
    assertProjectionStageIdentity(revision.content, input.stageId);
    const action = parseManagedPlanActions(revision.content).actions
      .find((candidate) => candidate.uuid === entry.uuid);
    if (!action || (action.remoteId && action.remoteId !== entry.remoteId && action.remoteId !== remote.id)) {
      throw new Error("真实子任务收口前 Stage 行动身份发生竞争");
    }
    const content = patchManagedPlanAction(revision.content, {
      uuid: entry.uuid,
      remoteId: remote.id,
      title: conflictResolved ? remote.title : entry.title,
      state: conflictResolved ? resolvedState : entry.state,
      ...(conflictResolved ? {
        content: remote.desc ?? null,
        startDate: remote.startDate ?? null,
        dueDate: remote.dueDate ?? null,
        timeZone: remote.timeZone ?? null,
        isAllDay: remote.isAllDay ?? false,
        priority: projectionPriority(remote.priority),
        tags: remote.tags ?? [],
      } : {}),
    });
    const after = content === revision.content
      ? revision
      : await this.markdown.compareAndWrite(revision, content);
    const resolvedAction = parseManagedPlanActions(after.content).actions
      .find((candidate) => candidate.uuid === entry.uuid)!;
    const settled = buildProjectionLedger({
      projectId: entry.projectId,
      stageId: entry.stageId,
      stagePath: input.stagePath,
      parentTaskId: entry.parentTaskId,
      target: { targetProjectId: entry.targetProjectId, targetColumnId: entry.targetColumnId },
      actions: [resolvedAction],
    })[0]!;
    await this.settleReconciliation(current, {
      ...current,
      ledger: replaceEntry(current.ledger, settled),
    }, proof);
  }

  async retryReceiptCleanup(operationId?: string): Promise<void> {
    if (!this.diagnostics) return;
    const initial = await this.state.read();
    const pending = (initial.receiptCleanupPending ?? [])
      .filter((proof) => operationId === undefined || proof.operationId === operationId);
    for (const proof of pending) {
      try {
        const inspection = await this.diagnostics.inspect(proof.operationId, proof.conflictId);
        if (inspection.blocked) continue;
        if (inspection.receipt) {
          assertReceiptMatchesProof(inspection.receipt, proof);
          await this.diagnostics.removeReconciled(proof.operationId, proof.conflictId);
        }
        const latest = await this.state.read();
        if (!(latest.receiptCleanupPending ?? []).some((item) => item.operationId === proof.operationId)) continue;
        await this.state.write(latest, {
          ...latest,
          receiptCleanupPending: (latest.receiptCleanupPending ?? [])
            .filter((item) => item.operationId !== proof.operationId),
        });
      } catch {
        // 保留完整 proof，供重启或下一次读取幂等重试并向 UI 暴露。
      }
    }
  }

  async removeResolvedReceipt(operationId: string): Promise<void> {
    if (!this.diagnostics) throw new Error("同步诊断存储未配置");
    const current = await this.state.read();
    if (current.ledger.some((entry) => entry.operationId === operationId) ||
      current.parentCheckpoints.some((entry) => entry.operationId === operationId) ||
      (current.receiptCleanupPending ?? []).some((entry) => entry.operationId === operationId)) {
      throw new Error("该收据仍被冻结对象引用，禁止移除");
    }
    await this.diagnostics.removeResolved(operationId);
  }

  async previewActivation(target: DidaProjectionTarget, counts: {
    projectCount: number;
    actionCount: number;
  }): Promise<ProjectionActivationPreview> {
    const { projects, columns, readiness } = await this.catalog.read(target.targetProjectId);
    return buildProjectionActivationPreview({ target, projects, columns, readiness, ...counts });
  }

  async activate(preview: ProjectionActivationPreview, confirmedHash: string): Promise<void> {
    const fresh = await this.previewActivation(preview.target, {
      projectCount: preview.projectCount,
      actionCount: preview.actionCount,
    });
    await this.activateVerifiedPreview(fresh, confirmedHash);
  }

  /** 调用方已在同一排他租约内完成远端复读时，避免再次申请共享租约造成自锁。 */
  async activateVerifiedPreview(
    fresh: ProjectionActivationPreview,
    confirmedHash: string,
  ): Promise<void> {
    assertProjectionActivation(fresh, confirmedHash);
    const current = await this.state.read();
    if (current.target && (current.target.targetProjectId !== fresh.target.targetProjectId ||
      current.target.targetColumnId !== fresh.target.targetColumnId) &&
      (current.ledger.length > 0 || current.parentCheckpoints.length > 0 || (current.parentBases?.length ?? 0) > 0)) {
      throw new Error("已有同步身份时禁止切换目标清单或分栏");
    }
    if (current.ledger.some((entry) => entry.frozen) || current.parentCheckpoints.some((item) => item.frozen)) {
      throw new Error("滴答项目同步仍有冻结对象，禁止启用");
    }
    await this.state.write(current, {
      ...current,
      enabled: true,
      activationVersion: PROJECT_PROJECTION_ACTIVATION_VERSION,
      target: { ...fresh.target },
      confirmedPreviewHash: fresh.previewHash,
    });
  }

  async synchronizeProject(input: ProjectionProjectInput): Promise<ProjectionSyncSummary> {
    const initialState = await this.state.read();
    if (!initialState.enabled ||
      initialState.activationVersion !== PROJECT_PROJECTION_ACTIVATION_VERSION ||
      !initialState.target || !initialState.confirmedPreviewHash) {
      throw new Error("Helix→滴答同步尚未显式预览并启用");
    }
    if (initialState.parentCheckpoints.some((item) => item.projectId === input.projectId && item.tombstone)) {
      throw new Error("项目正在执行安全删除，禁止后台同步重新创建远端对象");
    }
    const catalog = await this.catalog.read(initialState.target.targetProjectId);
    const readiness = catalog.readiness;
    const currentPreview = buildProjectionActivationPreview({
      target: initialState.target,
      projects: catalog.projects,
      columns: catalog.columns,
      readiness,
      projectCount: 1,
      actionCount: await this.countActions(input.stages),
    });
    if (readiness.queueEmpty === false || currentPreview.blockers.length > 0) {
      throw new Error(`同步写入条件不满足：${currentPreview.blockers.join("；")}`);
    }
    const projectRevision = await this.requireRevision(input.projectPath);
    const projectIdentity = readProjectProjectionIdentity(projectRevision.content);
    if (projectIdentity.projectId !== input.projectId) throw new Error("项目 Markdown 身份与稳定工作区不一致");
    const preflightState = await this.state.read();
    if (stableHash(preflightState) !== stableHash(initialState)) {
      throw new Error("同步状态在远端写入前发生变化");
    }
    const preflightStages: Array<{
      stageId: string;
      revision: ProjectionMarkdownRevision;
      actions: ReturnType<typeof parseManagedPlanActions>["actions"];
    }> = [];
    for (const stage of input.stages) {
      const revision = await this.requireRevision(stage.path);
      assertProjectionStageIdentity(revision.content, stage.stageId);
      preflightStages.push({
        stageId: stage.stageId,
        revision,
        actions: parseManagedPlanActions(revision.content).actions,
      });
    }
    assertProjectionUuidOwnership(preflightState, projectIdentity.projectId, preflightStages);
    const summary: ProjectionSyncSummary = {
      createdParents: 0,
      updatedParents: 0,
      completedParents: 0,
      createdActions: 0,
      updatedActions: 0,
      completedActions: 0,
      deletedActions: 0,
      frozen: [],
    };
    const storedParent = initialState.parentCheckpoints.find((item) => item.projectId === projectIdentity.projectId);
    if (projectIdentity.parentTaskId && storedParent?.frozen) {
      summary.frozen.push({
        uuid: `project:${projectIdentity.projectId}`,
        reason: storedParent.frozen,
        message: "父任务同步已冻结，必须先核对远端结果或竞争",
      });
      return summary;
    }
    if (projectIdentity.parentTaskId && storedParent && !storedParent.frozen) {
      if (storedParent.remoteId !== projectIdentity.parentTaskId) {
        throw new Error("Project Markdown 与临时父任务回填检查点竞争，已拒绝同步");
      }
      await this.clearParentCheckpoint(initialState, projectIdentity.projectId);
    }
    const parentTaskId = projectIdentity.parentTaskId ?? await this.ensureParent(
      await this.state.read(),
      projectRevision,
      projectIdentity.projectId,
      input.projectTitle,
      summary,
    );
    if (!parentTaskId) return summary;
    if (!await this.synchronizeParent(
      await this.state.read(),
      projectIdentity.projectId,
      parentTaskId,
      input.projectTitle,
      input.projectStatus,
      readiness.taskReopenVerified,
      summary,
    )) return summary;

    const freshState = await this.state.read();
    assertProjectionUuidOwnership(freshState, projectIdentity.projectId, preflightStages);
    const currentEntries: ProjectionLedgerEntry[] = [];
    const stageRevisions = new Map(preflightStages.map((stage) => [stage.stageId, stage.revision]));
    for (const stage of preflightStages) {
      currentEntries.push(...buildProjectionLedger({
        projectId: projectIdentity.projectId,
        stageId: stage.stageId,
        stagePath: input.stages.find((candidate) => candidate.stageId === stage.stageId)!.path,
        parentTaskId,
        target: initialState.target,
        actions: stage.actions,
      }));
    }
    const previous = freshState.ledger.filter((entry) => entry.projectId === projectIdentity.projectId);
    const presentStageIds = new Set(input.stages.map((stage) => stage.stageId));
    const managedPrevious = previous.filter((entry) => presentStageIds.has(entry.stageId));
    const retainedMissingStages = previous.filter((entry) => !presentStageIds.has(entry.stageId));
    const previousByIdentity = new Map(previous.map((entry) => [projectionLedgerIdentity(entry), entry]));
    let working = currentEntries.map((entry) => {
      const old = previousByIdentity.get(projectionLedgerIdentity(entry));
      return old?.frozen
        ? {
            ...entry,
            remoteId: old.remoteId ?? entry.remoteId,
            remoteEntity: old.remoteEntity,
            tombstone: old.tombstone,
            frozen: old.frozen,
            operationId: old.operationId,
            conflictId: old.conflictId,
            createBaselineItemIds: old.createBaselineItemIds,
            createBaselineItemsHash: old.createBaselineItemsHash,
            createBaselineItemHashes: old.createBaselineItemHashes,
            createBaselineSemanticHashes: old.createBaselineSemanticHashes,
            createItemId: old.createItemId,
            createItemSortOrder: old.createItemSortOrder,
            updateExpectedTitle: old.updateExpectedTitle,
            updateExpectedStatus: old.updateExpectedStatus,
            updateStageRevisionHash: old.updateStageRevisionHash,
            mutationKind: old.mutationKind,
            mutationBaselineItemIds: old.mutationBaselineItemIds,
            mutationBaselineItemsHash: old.mutationBaselineItemsHash,
            mutationBaselineItemHashes: old.mutationBaselineItemHashes,
            mutationOrdinarySemanticHashes: old.mutationOrdinarySemanticHashes,
            mutationOwnedInvariantHash: old.mutationOwnedInvariantHash,
            mutationBaselineOwnedStatus: old.mutationBaselineOwnedStatus,
            mutationBaselineOwnedCompletedTimeHash: old.mutationBaselineOwnedCompletedTimeHash,
            remapStagePaths: old.remapStagePaths,
          }
        : entry;
    });
    working.push(...retainedMissingStages);
    working.push(...previous.filter((entry) => entry.frozen &&
      !working.some((item) => projectionLedgerIdentity(item) === projectionLedgerIdentity(entry))));
    const managedWorking = working.filter((entry) => presentStageIds.has(entry.stageId));
    return this.synchronizeTaskActions({
      input,
      initialState,
      projectId: projectIdentity.projectId,
      parentTaskId,
      stageRevisions,
      managedPrevious,
      managedWorking,
      working,
      summary,
      taskReopenVerified: readiness.taskReopenVerified,
    });
  }

  private async synchronizeTaskActions(params: {
    input: ProjectionProjectInput;
    initialState: ProjectionPersistentState;
    projectId: string;
    parentTaskId: string;
    stageRevisions: Map<string, ProjectionMarkdownRevision>;
    managedPrevious: ProjectionLedgerEntry[];
    managedWorking: ProjectionLedgerEntry[];
    working: ProjectionLedgerEntry[];
    summary: ProjectionSyncSummary;
    taskReopenVerified: boolean;
  }): Promise<ProjectionSyncSummary> {
    let working = params.working;
    const markerFor = (entry: ProjectionLedgerEntry) => projectionMarker(entry.uuid);
    const replace = (entry: ProjectionLedgerEntry) => {
      const identity = projectionLedgerIdentity(entry);
      working = working.some((candidate) => projectionLedgerIdentity(candidate) === identity)
        ? working.map((candidate) => projectionLedgerIdentity(candidate) === identity ? entry : candidate)
        : [...working, entry];
    };
    const ledgerState = (current: ProjectionPersistentState): ProjectionPersistentState => ({
      ...current,
      ledger: [
        ...current.ledger.filter((entry) => entry.projectId !== params.projectId),
        ...working.filter((entry) => entry.projectId === params.projectId),
      ],
    });
    const persist = async () => {
      await this.writeLatestState((current) => ledgerState(current));
    };
    const settle = async (
      entry: ProjectionLedgerEntry | undefined,
      receipt: { operationId: string; conflictId?: string },
      remove = false,
    ) => {
      if (remove && entry) working = working.filter((candidate) => candidate.uuid !== entry.uuid);
      else if (entry) replace(entry);
      const proof: ProjectionReceiptCleanupProof = {
        kind: "action",
        operationId: receipt.operationId,
        conflictId: receipt.conflictId,
        projectId: params.projectId,
        stageId: entry!.stageId,
        uuid: entry!.uuid,
        targetProjectId: entry!.targetProjectId,
        marker: markerFor(entry!),
        remoteTaskId: entry!.remoteId!,
      };
      await this.writeLatestState((current) => ledgerState(current), proof);
    };

    for (const intent of planProjectionChanges(params.managedPrevious, params.managedWorking, {
      taskReopenVerified: params.taskReopenVerified,
    })) {
      const entry = intent.entry;
      if (working.find((item) => projectionLedgerIdentity(item) === projectionLedgerIdentity(entry))?.frozen) continue;
      const stageRevision = params.stageRevisions.get(entry.stageId);
      if (!stageRevision && intent.kind !== "delete-action" && intent.kind !== "reconcile-delete") {
        throw new Error(`找不到行动所属阶段：${entry.stageId}`);
      }
      if (intent.kind === "freeze-action") {
        working = freezeEntry(working, entry, intent.reason, params.summary, "投影身份发生竞争，已持久冻结");
        continue;
      }
      if (intent.kind === "recover-action") {
        const remote = entry.remoteId
          ? await this.pipeline.rereadTask(entry.targetProjectId, entry.remoteId)
          : null;
        try {
          if (!remote) throw new Error("Markdown 已绑定的远端子任务不存在");
          verifyProjectedTask(remote, entry, markerFor(entry));
          replace(entry);
        } catch (error) {
          working = freezeEntry(working, entry, "identity-mismatch", params.summary, message(error));
        }
        continue;
      }
      if (intent.kind === "reconcile-delete") {
        const remote = entry.remoteId
          ? await this.pipeline.rereadTask(entry.targetProjectId, entry.remoteId)
          : null;
        if (!remote) working = working.filter((item) => item.uuid !== entry.uuid);
        else working = freezeEntry(working, entry, "unknown-outcome", params.summary,
          "删除结果仍未证明子任务不存在；禁止重发删除");
        continue;
      }
      if (intent.kind === "create-action") {
        const parent = await this.pipeline.rereadTask(entry.targetProjectId, entry.parentTaskId);
        if (!parent || !this.sameParentIdentity(
          parent, params.projectId, params.parentTaskId, params.initialState.target!,
        )) {
          working = freezeEntry(working, entry, "identity-mismatch", params.summary,
            "真实子任务创建前父任务身份不一致");
          continue;
        }
        const clientIdentity = actionCreateClientIdentity(entry);
        const desired: DidaTask = {
          id: `local-helix-action-${stableHash(clientIdentity).slice(0, 24)}`,
          projectId: entry.targetProjectId,
          parentId: entry.parentTaskId,
          columnId: entry.targetColumnId,
          title: entry.title,
          content: markerFor(entry),
          desc: entry.content,
          startDate: entry.startDate,
          dueDate: entry.dueDate,
          timeZone: entry.timeZone,
          isAllDay: entry.isAllDay,
          priority: entry.priority,
          tags: entry.tags ? [...entry.tags] : undefined,
          status: 0,
        };
        const result = await this.pipeline.recoverCreate(clientIdentity, entry.targetProjectId) ??
          await this.pipeline.createTask(desired, clientIdentity);
        if (result.outcome !== "verified") {
          if (result.outcome === "capability" && !result.conflictId) {
            // 请求未发送即可确定的不兼容输入不形成持久身份冻结；用户修正 Markdown 后自然重试。
            working = working.filter((candidate) =>
              projectionLedgerIdentity(candidate) !== projectionLedgerIdentity(entry));
            params.summary.frozen.push({ uuid: entry.uuid, reason: "capability", message: result.message });
            continue;
          }
          working = freezeEntry(working, entry, resultReason(result), params.summary, result.message, result);
          continue;
        }
        const createdTask = await this.exactVerifiedTask(result, entry.targetProjectId);
        const createdEntry: ProjectionLedgerEntry = {
          ...entry,
          remoteId: createdTask.id,
          state: entry.state === "completed" ? "active" : entry.state,
          frozen: "markdown-race",
          operationId: result.operationId,
          conflictId: result.conflictId,
        };
        verifyProjectedTask(createdTask, createdEntry, markerFor(entry), { state: false });
        replace(createdEntry);
        await persist();
        try {
          const latestStage = await this.requireRevision(stageRevision!.path);
          assertProjectionStageIdentity(latestStage.content, entry.stageId);
          const latestAction = parseManagedPlanActions(latestStage.content).actions
            .find((candidate) => candidate.uuid === entry.uuid);
          if (!latestAction || latestAction.remoteId || latestAction.title !== entry.title ||
            latestAction.state !== entry.state) {
            throw new Error("真实子任务创建后 Stage 行动发生竞争");
          }
          const after = await this.markdown.compareAndWrite(
            latestStage,
            patchManagedPlanAction(latestStage.content, { uuid: entry.uuid, remoteId: createdTask.id }),
          );
          params.stageRevisions.set(entry.stageId, after);
        } catch (error) {
          working = freezeEntry(working, createdEntry, "markdown-race", params.summary, message(error), result);
          continue;
        }
        const adopted = { ...createdEntry, frozen: undefined, operationId: undefined, conflictId: undefined };
        await settle(adopted, result);
        params.summary.createdActions += 1;
        if (entry.state === "completed") {
          const completeResult = await this.pipeline.completeTask({ ...createdTask, status: 2 });
          if (completeResult.outcome !== "verified") {
            const frozen = { ...adopted, frozen: resultReason(completeResult), operationId: completeResult.operationId,
              conflictId: completeResult.conflictId };
            replace(frozen);
            params.summary.frozen.push({ uuid: entry.uuid, reason: frozen.frozen!, message: completeResult.message });
            continue;
          }
          const completedTask = await this.exactVerifiedTask(completeResult, entry.targetProjectId);
          const completed = { ...adopted, state: "completed" as const, remoteId: completedTask.id };
          verifyProjectedTask(completedTask, completed, markerFor(entry));
          await settle(completed, completeResult);
          params.summary.completedActions += 1;
        }
        continue;
      }
      if (!entry.remoteId) {
        working = freezeEntry(working, entry, "identity-mismatch", params.summary,
          "既有投影行动缺少远端子任务 ID");
        continue;
      }
      if (intent.kind === "delete-action") {
        const checkpoint: ProjectionLedgerEntry = {
          ...entry,
          tombstone: true,
          frozen: "unknown-outcome",
          operationId: `op-projection-task-delete-${crypto.randomUUID()}`,
        };
        replace(checkpoint);
        await persist();
        const result = await this.pipeline.deleteTask({
          taskId: entry.remoteId,
          parentTaskId: entry.parentTaskId,
          targetProjectId: entry.targetProjectId,
          targetColumnId: entry.targetColumnId,
          marker: markerFor(entry),
        });
        if (result.outcome === "verified-absent") {
          await settle({ ...checkpoint, operationId: result.operationId }, result, true);
          params.summary.deletedActions += 1;
        } else {
          const frozen = { ...checkpoint, frozen: resultReason(result), operationId: result.operationId,
            conflictId: result.conflictId };
          replace(frozen);
          params.summary.frozen.push({ uuid: entry.uuid, reason: frozen.frozen!, message: result.message });
        }
        continue;
      }

      const previous = params.managedPrevious.find((candidate) =>
        projectionLedgerIdentity(candidate) === projectionLedgerIdentity(entry));
      const remote = await this.pipeline.rereadTask(entry.targetProjectId, entry.remoteId);
      if (!previous || !remote) {
        working = freezeEntry(working, entry, "identity-mismatch", params.summary,
          "真实子任务更新缺少同步 Base 或远端对象");
        continue;
      }
      try {
        verifyProjectedTask(remote, entry, markerFor(entry), { title: false, state: false, attributes: false });
      } catch (error) {
        working = freezeEntry(working, entry, "identity-mismatch", params.summary, message(error));
        continue;
      }
      const desiredStatus = entry.state === "completed" ? 2 : 0;
      const baseStatus = previous.state === "completed" ? 2 : 0;
      const fields: ProjectionTaskWriteField[] = intent.kind === "update-action" ? intent.writeFields :
        intent.kind === "complete-action" || intent.kind === "reopen-action" ? ["status"] : [];
      const operationId = `op-projection-task-update-${crypto.randomUUID()}`;
      const desired = { ...remote, title: entry.title, desc: entry.content,
        startDate: entry.startDate, dueDate: entry.dueDate, timeZone: entry.timeZone,
        isAllDay: entry.isAllDay, priority: entry.priority,
        tags: entry.tags ? [...entry.tags] : undefined,
        status: desiredStatus,
        completedTime: desiredStatus === 0 ? null : remote.completedTime };
      const base = projectionTaskFromEntry(remote, previous, baseStatus);
      const hasCompetition = fields.some((field) =>
        stableHash(projectionTaskField(remote, field)) !== stableHash(projectionTaskField(base, field)) &&
        stableHash(projectionTaskField(remote, field)) !== stableHash(projectionTaskField(desired, field)) &&
        stableHash(projectionTaskField(base, field)) !== stableHash(projectionTaskField(desired, field)));
      const checkpoint = { ...entry, frozen: "unknown-outcome" as const, operationId };
      replace(checkpoint);
      await persist();
      let result: ProjectionWriteReceipt;
      if (hasCompetition) {
        result = await this.pipeline.stageTaskConflict(desired, remote, base, operationId, fields);
      } else if (fields.every((field) =>
        stableHash(projectionTaskField(remote, field)) === stableHash(projectionTaskField(desired, field)))) {
        const settled = { ...entry, frozen: undefined, operationId: undefined, conflictId: undefined };
        replace(settled);
        await persist();
        continue;
      } else {
        result = intent.kind === "complete-action"
          ? await this.pipeline.completeTask(desired)
          : intent.kind === "reopen-action"
            ? await this.pipeline.reopenTask(desired)
            : await this.pipeline.updateTask(desired, fields, operationId, remote);
      }
      if (result.outcome !== "verified") {
        const frozen = { ...checkpoint, frozen: resultReason(result), operationId: result.operationId,
          conflictId: result.conflictId };
        replace(frozen);
        params.summary.frozen.push({ uuid: entry.uuid, reason: frozen.frozen!, message: result.message });
        continue;
      }
      const verifiedTask = await this.exactVerifiedTask(result, entry.targetProjectId);
      const latestStage = await this.requireRevision(stageRevision!.path);
      if (latestStage.hash !== stageRevision!.hash) {
        working = freezeEntry(working, checkpoint, "markdown-race", params.summary,
          "真实子任务写入后 Stage Markdown 已变化", result);
        continue;
      }
      const settled = { ...entry, remoteId: verifiedTask.id, frozen: undefined,
        operationId: undefined, conflictId: undefined };
      verifyProjectedTask(verifiedTask, settled, markerFor(entry));
      await settle(settled, result);
      params.summary.updatedActions += fields.some((field) => field !== "status") ? 1 : 0;
      params.summary.completedActions += previous.state !== "completed" && entry.state === "completed" ? 1 : 0;
    }
    await persist();
    return params.summary;
  }

  private async replaceProjectLedgerEntry(entry: ProjectionLedgerEntry): Promise<void> {
    const current = await this.state.read();
    await this.state.write(current, {
      ...current,
      ledger: replaceEntry(current.ledger, entry),
    });
  }

  private async removeProjectLedgerEntry(entry: ProjectionLedgerEntry): Promise<void> {
    const current = await this.state.read();
    await this.state.write(current, {
      ...current,
      ledger: current.ledger.filter((candidate) =>
        projectionLedgerIdentity(candidate) !== projectionLedgerIdentity(entry)),
    });
  }

  private async settleDeletedAction(entry: ProjectionLedgerEntry): Promise<void> {
    const current = await this.state.read();
    const proof = entry.operationId && entry.remoteId ? {
      kind: "action" as const,
      operationId: entry.operationId,
      conflictId: entry.conflictId,
      projectId: entry.projectId,
      stageId: entry.stageId,
      uuid: entry.uuid,
      targetProjectId: entry.targetProjectId,
      marker: projectionMarker(entry.uuid),
      remoteTaskId: entry.remoteId,
    } : undefined;
    await this.settleReconciliation(current, {
      ...current,
      ledger: current.ledger.filter((candidate) =>
        projectionLedgerIdentity(candidate) !== projectionLedgerIdentity(entry)),
    }, proof);
  }

  private async settleDeletedParent(
    state: ProjectionPersistentState,
    projectId: string,
    remoteId: string,
    checkpoint: ProjectionPersistentState["parentCheckpoints"][number],
  ): Promise<void> {
    const proof = checkpoint.operationId ? {
      kind: "parent" as const,
      operationId: checkpoint.operationId,
      conflictId: checkpoint.conflictId,
      projectId,
      targetProjectId: state.target!.targetProjectId,
      marker: `helix-project-projection:${projectId}`,
      remoteTaskId: remoteId,
    } : undefined;
    await this.settleReconciliation(state, {
      ...state,
      ledger: state.ledger.filter((entry) => entry.projectId !== projectId),
      parentCheckpoints: [
        ...state.parentCheckpoints.filter((item) => item.projectId !== projectId),
        {
          projectId,
          remoteId,
          marker: `helix-project-projection:${projectId}`,
          tombstone: true,
        },
      ],
      parentBases: state.parentBases?.filter((item) => item.projectId !== projectId),
    }, proof);
  }

  private async clearDeletedProjectState(state: ProjectionPersistentState, projectId: string): Promise<void> {
    await this.state.write(state, {
      ...state,
      ledger: state.ledger.filter((entry) => entry.projectId !== projectId),
      parentCheckpoints: state.parentCheckpoints.filter((item) => item.projectId !== projectId),
      parentBases: state.parentBases?.filter((item) => item.projectId !== projectId),
    });
  }

  private async ensureParent(
    state: ProjectionPersistentState,
    revision: ProjectionMarkdownRevision,
    projectId: string,
    title: string,
    summary: ProjectionSyncSummary,
  ): Promise<string | undefined> {
    const checkpoint = state.parentCheckpoints.find((item) => item.projectId === projectId);
    if (checkpoint?.frozen) {
      summary.frozen.push({ uuid: `project:${projectId}`, reason: checkpoint.frozen, message: "父任务同步已冻结" });
      return undefined;
    }
    if (checkpoint?.remoteId) {
      try {
        await this.markdown.compareAndWrite(revision, patchProjectParentTaskId(revision.content, checkpoint.remoteId));
      } catch {
        await this.freezeParent(state, projectId, checkpoint.marker, checkpoint.remoteId, "markdown-race");
        summary.frozen.push({ uuid: `project:${projectId}`, reason: "markdown-race", message: "父任务已创建但 Markdown 回填竞争" });
        return undefined;
      }
      await this.clearParentCheckpoint(await this.state.read(), projectId);
      const remote = await this.pipeline.rereadTask(state.target!.targetProjectId, checkpoint.remoteId);
      if (!remote || !this.sameParentIdentity(remote, projectId, checkpoint.remoteId, state.target!)) {
        const latest = await this.state.read();
        await this.freezeParent(latest, projectId, checkpoint.marker, checkpoint.remoteId, "identity-mismatch");
        summary.frozen.push({ uuid: `project:${projectId}`, reason: "identity-mismatch", message: "父任务回填后精确复读身份不一致" });
        return undefined;
      }
      await this.saveParentBase(await this.state.read(), projectId, remote);
      return checkpoint.remoteId;
    }
    const marker = `helix-project-projection:${projectId}`;
    const target = state.target!;
    const parentClientIdentity = parentCreateClientIdentity(projectId);
    const recovered = await this.pipeline.recoverCreate(parentClientIdentity, target.targetProjectId);
    const result = recovered ?? await this.pipeline.createTask({
      id: `local-helix-project-${projectId}`,
      projectId: target.targetProjectId,
      columnId: target.targetColumnId,
      title,
      content: marker,
      status: 0,
    }, parentClientIdentity);
    if (result.outcome !== "verified") {
      const reason = resultReason(result);
      await this.freezeParent(state, projectId, marker, undefined, reason, result);
      summary.frozen.push({ uuid: `project:${projectId}`, reason, message: result.message });
      return undefined;
    }
    const createdTask = await this.exactVerifiedTask(result, target.targetProjectId);
    if (!createdTask.id || createdTask.id.startsWith("local-") ||
      createdTask.projectId !== target.targetProjectId || createdTask.columnId !== target.targetColumnId ||
      createdTask.content !== marker || createdTask.title !== title || createdTask.status === 2) {
      await this.freezeParent(state, projectId, marker, createdTask.id, "identity-mismatch");
      summary.frozen.push({ uuid: `project:${projectId}`, reason: "identity-mismatch", message: "父任务写后复读身份不一致" });
      return undefined;
    }
    const latest = await this.state.read();
    const nextCheckpoint = {
      projectId,
      remoteId: createdTask.id,
      marker,
      operationId: result.operationId,
      conflictId: result.conflictId,
    };
    await this.state.write(latest, {
      ...latest,
      parentCheckpoints: [...latest.parentCheckpoints.filter((item) => item.projectId !== projectId), nextCheckpoint],
    });
    try {
      await this.markdown.compareAndWrite(revision, patchProjectParentTaskId(revision.content, createdTask.id));
    } catch {
      const after = await this.state.read();
      await this.freezeParent(after, projectId, marker, createdTask.id, "markdown-race");
      summary.frozen.push({ uuid: `project:${projectId}`, reason: "markdown-race", message: "父任务已创建但 Markdown 回填竞争" });
      return undefined;
    }
    await this.clearParentCheckpoint(await this.state.read(), projectId);
    await this.saveParentBase(await this.state.read(), projectId, createdTask);
    summary.createdParents += 1;
    return createdTask.id;
  }

  private async freezeParent(
    _state: ProjectionPersistentState,
    projectId: string,
    marker: string,
    remoteId: string | undefined,
    frozen: ProjectionFreezeReason,
    receipt?: { operationId: string; conflictId?: string },
  ): Promise<void> {
    const latest = await this.state.read();
    await this.state.write(latest, {
      ...latest,
      parentCheckpoints: [
        ...latest.parentCheckpoints.filter((item) => item.projectId !== projectId),
        { projectId, remoteId, marker, frozen, operationId: receipt?.operationId, conflictId: receipt?.conflictId },
      ],
    });
  }

  private async clearParentCheckpoint(state: ProjectionPersistentState, projectId: string): Promise<void> {
    const next = state.parentCheckpoints.filter((item) => item.projectId !== projectId);
    if (next.length === state.parentCheckpoints.length) return;
    await this.state.write(state, { ...state, parentCheckpoints: next });
  }

  private async synchronizeParent(
    state: ProjectionPersistentState,
    projectId: string,
    remoteId: string,
    title: string,
    projectStatus: ProjectionProjectInput["projectStatus"],
    taskReopenVerified: boolean,
    summary: ProjectionSyncSummary,
  ): Promise<boolean> {
    const target = state.target!;
    const marker = `helix-project-projection:${projectId}`;
    const desiredStatus = projectStatus === "completed" ? 2 : 0;
    const remote = await this.pipeline.rereadTask(target.targetProjectId, remoteId);
    if (!remote || !this.sameParentIdentity(remote, projectId, remoteId, target)) {
      await this.freezeParent(state, projectId, marker, remoteId, "identity-mismatch");
      summary.frozen.push({ uuid: `project:${projectId}`, reason: "identity-mismatch", message: "父任务精确复读身份不一致；未按标题领养" });
      return false;
    }
    const base = state.parentBases?.find((item) => item.projectId === projectId);
    if (base && (base.remoteId !== remoteId ||
      ((remote.title !== base.title || remote.status !== base.status) &&
        (remote.title !== title || remote.status !== desiredStatus)))) {
      await this.freezeParent(state, projectId, marker, remoteId, "conflict");
      summary.frozen.push({ uuid: `project:${projectId}`, reason: "conflict", message: "父任务在 Helix 写入前已被远端修改" });
      return false;
    }
    if (!base && (remote.title !== title || remote.status !== desiredStatus)) {
      await this.freezeParent(state, projectId, marker, remoteId, "conflict");
      summary.frozen.push({ uuid: `project:${projectId}`, reason: "conflict", message: "父任务缺少可验证 Base 且远端值不同" });
      return false;
    }
    let verified = remote;
    if (remote.status === 2 && desiredStatus === 0) {
      if (!taskReopenVerified) {
        await this.freezeParent(state, projectId, marker, remoteId, "capability");
        summary.frozen.push({ uuid: `project:${projectId}`, reason: "capability", message: "父任务重开能力尚无真实合同，已冻结等待人工处理" });
        return false;
      }
      const result = await this.pipeline.reopenTask({ ...remote, status: 0, completedTime: null });
      if (result.outcome !== "verified") {
        await this.freezeParent(state, projectId, marker, remoteId, resultReason(result), result);
        summary.frozen.push({ uuid: `project:${projectId}`, reason: resultReason(result), message: result.message });
        return false;
      }
      const reopenedTask = await this.exactVerifiedTask(result, target.targetProjectId);
      if (!this.sameParentIdentity(reopenedTask, projectId, remoteId, target) || reopenedTask.status === 2) {
        await this.freezeParent(await this.state.read(), projectId, marker, remoteId, "identity-mismatch", result);
        summary.frozen.push({ uuid: `project:${projectId}`, reason: "identity-mismatch", message: "父任务重开写后复读不一致" });
        return false;
      }
      verified = reopenedTask;
    }
    if (verified.title !== title) {
      const fields = [verified.title !== title ? "title" : undefined]
        .filter((item): item is string => Boolean(item));
      const result = await this.pipeline.updateTask({
        ...verified,
        title,
        status: desiredStatus,
        completedTime: desiredStatus === 0 ? null : remote.completedTime,
      }, fields, undefined, verified);
      if (result.outcome !== "verified") {
        await this.freezeParent(state, projectId, marker, remoteId, resultReason(result), result);
        summary.frozen.push({ uuid: `project:${projectId}`, reason: resultReason(result), message: result.message });
        return false;
      }
      verified = await this.exactVerifiedTask(result, target.targetProjectId);
      if (fields.includes("title")) summary.updatedParents += 1;
    }
    if (verified.status !== 2 && desiredStatus === 2) {
      const result = await this.pipeline.completeTask({ ...verified, status: 2, completedTime: this.now() });
      if (result.outcome !== "verified") {
        await this.freezeParent(state, projectId, marker, remoteId, resultReason(result), result);
        summary.frozen.push({ uuid: `project:${projectId}`, reason: resultReason(result), message: result.message });
        return false;
      }
      verified = await this.exactVerifiedTask(result, target.targetProjectId);
      summary.completedParents += 1;
    }
    if (!this.sameParentIdentity(verified, projectId, remoteId, target) ||
      verified.title !== title || verified.status !== desiredStatus) {
      await this.freezeParent(await this.state.read(), projectId, marker, remoteId, "identity-mismatch");
      summary.frozen.push({ uuid: `project:${projectId}`, reason: "identity-mismatch", message: "父任务写后复读字段不一致" });
      return false;
    }
    await this.saveParentBase(await this.state.read(), projectId, verified);
    return true;
  }

  private sameParentIdentity(task: DidaTask, projectId: string, remoteId: string, target: DidaProjectionTarget): boolean {
    return task.id === remoteId && task.projectId === target.targetProjectId &&
      task.columnId === target.targetColumnId && task.content === `helix-project-projection:${projectId}` &&
      !task.parentId;
  }

  private async saveParentBase(state: ProjectionPersistentState, projectId: string, task: DidaTask): Promise<void> {
    const next = {
      projectId,
      remoteId: task.id,
      title: task.title,
      status: task.status,
    };
    const bases = [...(state.parentBases ?? []).filter((item) => item.projectId !== projectId), next];
    if (stableStateParentBase(state.parentBases, bases)) return;
    await this.state.write(state, { ...state, parentBases: bases });
  }

  private async persistProjectLedger(projectId: string, entries: ProjectionLedgerEntry[]): Promise<void> {
    const latest = await this.state.read();
    await this.state.write(latest, {
      ...latest,
      ledger: [
        ...latest.ledger.filter((entry) => entry.projectId !== projectId),
        ...entries.filter((entry) => entry.projectId === projectId),
      ],
    });
  }

  private async buildVerifiedRemapStagePaths(
    entries: ProjectionLedgerEntry[],
    parentTaskId: string,
    stageRevisions?: Map<string, ProjectionMarkdownRevision>,
  ): Promise<Record<string, string>> {
    const relevant = [...new Map(entries
      .filter((entry) => entry.parentTaskId === parentTaskId)
      .map((entry) => [projectionLedgerIdentity(entry), entry])).values()];
    const paths: Record<string, string> = {};
    const revisions = new Map<string, ProjectionMarkdownRevision>();
    for (const entry of relevant) {
      if (!entry.stagePath?.trim()) {
        throw new Error("同一父任务存在缺少 Stage 路径的账本项，已在远端写入前阻断完整 ID 重映");
      }
      paths[entry.uuid] = entry.stagePath;
      if (entry.tombstone) continue;
      let revision = revisions.get(entry.stagePath) ?? stageRevisions?.get(entry.stageId);
      if (!revision || revision.path !== entry.stagePath) revision = await this.requireRevision(entry.stagePath);
      revisions.set(entry.stagePath, revision);
      assertProjectionStageIdentity(revision.content, entry.stageId);
      const actions = parseManagedPlanActions(revision.content).actions.filter((action) => action.uuid === entry.uuid);
      if (actions.length !== 1 || actions[0]!.remoteId !== entry.remoteId) {
        throw new Error("同一父任务的 Stage 行动 UUID 或旧 remoteId 与账本不一致，已在远端写入前阻断");
      }
    }
    return paths;
  }

  private async commitChecklistIdRemap(input: {
    projectId: string;
    parentTaskId: string;
    entries: ProjectionLedgerEntry[];
    remap: Map<string, string>;
    current?: ProjectionLedgerEntry;
    removeUuid?: string;
    stagePaths: Record<string, string>;
    stageRevisions?: Map<string, ProjectionMarkdownRevision>;
  }): Promise<ProjectionLedgerEntry[]> {
    let nextEntries = input.entries
      .filter((entry) => entry.uuid !== input.removeUuid)
      .map((entry) => entry.parentTaskId === input.parentTaskId && entry.remoteId && input.remap.has(entry.remoteId)
        ? { ...entry, remoteId: input.remap.get(entry.remoteId)! }
        : entry);
    if (input.current) nextEntries = replaceEntry(nextEntries, input.current);
    const beforeByUuid = new Map(input.entries.map((entry) => [entry.uuid, entry]));
    const affected = nextEntries.filter((entry) => {
      const before = beforeByUuid.get(entry.uuid);
      return !entry.tombstone && entry.parentTaskId === input.parentTaskId && entry.remoteId !== before?.remoteId;
    });
    const plans = new Map<string, { before: ProjectionMarkdownRevision; content: string; stageId: string }>();
    for (const entry of affected) {
      const path = input.stagePaths[entry.uuid];
      if (!path) throw new Error("完整 ID 重映检查点缺少受影响行动的 Stage 路径");
      const beforeEntry = beforeByUuid.get(entry.uuid);
      const existingPlan = plans.get(path);
      const revision = existingPlan?.before ?? input.stageRevisions?.get(entry.stageId) ?? await this.requireRevision(path);
      assertProjectionStageIdentity(revision.content, entry.stageId);
      const content = existingPlan?.content ?? revision.content;
      const action = parseManagedPlanActions(content).actions.find((candidate) => candidate.uuid === entry.uuid);
      if (!action || (action.remoteId !== beforeEntry?.remoteId && action.remoteId !== entry.remoteId)) {
        throw new Error("完整 ID 重映时 Stage Markdown 身份或旧 ID 已竞争");
      }
      plans.set(path, {
        before: revision,
        stageId: entry.stageId,
        content: action.remoteId === entry.remoteId
          ? content
          : patchManagedPlanAction(content, { uuid: entry.uuid, remoteId: entry.remoteId }),
      });
    }
    const written: Array<{ before: ProjectionMarkdownRevision; after: ProjectionMarkdownRevision }> = [];
    try {
      for (const plan of plans.values()) {
        if (plan.content === plan.before.content) continue;
        const after = await this.markdown.compareAndWrite(plan.before, plan.content);
        written.push({ before: plan.before, after });
        input.stageRevisions?.set(plan.stageId, after);
      }
      await this.persistProjectLedger(input.projectId, nextEntries);
      return nextEntries;
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const item of written.reverse()) {
        try {
          const restored = await this.markdown.compareAndWrite(item.after, item.before.content);
          const stageId = [...plans.values()].find((plan) => plan.before.path === item.before.path)?.stageId;
          if (stageId) input.stageRevisions?.set(stageId, restored);
        } catch (rollbackError) {
          rollbackErrors.push(message(rollbackError));
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`完整 ID 重映失败且部分 Markdown 回滚失败：${rollbackErrors.join("；")}`, { cause: error });
      }
      throw error;
    }
  }

  private async requireRevision(path: string): Promise<ProjectionMarkdownRevision> {
    const revision = await this.markdown.read(path);
    if (!revision) throw new Error(`找不到同步所需的 Markdown：${path}`);
    return revision;
  }

  private async exactVerifiedTask(
    receipt: Extract<ProjectionWriteReceipt, { outcome: "verified" }>,
    projectId: string,
  ): Promise<DidaTask> {
    const remote = await this.pipeline.rereadTask(projectId, receipt.task.id);
    if (!remote || remote.id !== receipt.task.id || remote.projectId !== projectId) {
      throw new Error("任务写入返回成功，但按精确 ID 写后复读失败");
    }
    return remote;
  }

  private async countActions(stages: ProjectionProjectInput["stages"]): Promise<number> {
    let count = 0;
    for (const stage of stages) count += parseManagedPlanActions((await this.requireRevision(stage.path)).content).actions.length;
    return count;
  }
}

export function actionCreateClientIdentity(
  entry: Pick<ProjectionLedgerEntry, "projectId" | "stageId" | "uuid">,
): string {
  return `helix-action:${encodeURIComponent(entry.projectId)}:${encodeURIComponent(entry.stageId)}:${encodeURIComponent(entry.uuid)}`;
}

export function parentCreateClientIdentity(projectId: string): string {
  return `helix-parent:${encodeURIComponent(projectId)}`;
}

function replaceEntry(entries: ProjectionLedgerEntry[], next: ProjectionLedgerEntry): ProjectionLedgerEntry[] {
  return entries.map((entry) => entry.uuid === next.uuid ? next : entry);
}

function projectionTaskFromEntry(
  remote: DidaTask,
  entry: ProjectionLedgerEntry,
  status: number,
): DidaTask {
  return {
    ...remote,
    title: entry.title,
    desc: entry.content,
    startDate: entry.startDate,
    dueDate: entry.dueDate,
    timeZone: entry.timeZone,
    isAllDay: entry.isAllDay,
    priority: entry.priority,
    tags: entry.tags ? [...entry.tags] : undefined,
    status,
  };
}

function projectionTaskField(task: DidaTask, field: ProjectionTaskWriteField): unknown {
  switch (field) {
    case "desc": return task.desc;
    case "title": return task.title;
    case "status": return task.status;
    case "startDate": return task.startDate;
    case "dueDate": return task.dueDate;
    case "timeZone": return task.timeZone;
    case "isAllDay": return task.isAllDay;
    case "priority": return task.priority ?? 0;
    case "tags": return task.tags ?? [];
  }
}

function projectionPriority(value: number | undefined): 0 | 1 | 3 | 5 {
  return value === 1 || value === 3 || value === 5 ? value : 0;
}

function checklistStatus(state: ProjectionLedgerEntry["state"]): number {
  return state === "completed" ? 2 : 0;
}

function projectionStateForRemoteStatus(
  localState: ProjectionLedgerEntry["state"],
  remoteStatus: number,
): ProjectionLedgerEntry["state"] {
  if (remoteStatus === 2) return "completed";
  return localState === "completed" ? "active" : localState;
}

/**
 * 上游 DidaSync 以 13 位毫秒时间戳作为新 item ID。Helix 在发送前生成并持久化，
 * 之后只允许复用；若 Base 无法给出无损 sortOrder，则宁可冻结。
 */
export function createClientOwnedChecklistItem(
  baseline: DidaChecklistItem[],
  entry: Pick<ProjectionLedgerEntry, "title" | "state">,
  now: string,
  persistedId?: string,
): DidaChecklistItem {
  return createDidaChecklistClientItem(
    baseline, entry.title, checklistStatus(entry.state), now, persistedId,
  );
}

function checkpointChecklistItem(entry: ProjectionLedgerEntry): DidaChecklistItem {
  if (!entry.createItemId || entry.createItemSortOrder === undefined) {
    throw new Error("旧版无 ID 新建 checkpoint 只允许复读，禁止续发");
  }
  if (!isDidaChecklistClientId(entry.createItemId) || !Number.isSafeInteger(entry.createItemSortOrder)) {
    throw new Error("新建检查项 checkpoint 身份或排序损坏");
  }
  return {
    id: entry.createItemId,
    title: entry.title,
    status: checklistStatus(entry.state),
    sortOrder: entry.createItemSortOrder,
  };
}

function findChecklistItem(task: DidaTask, itemId: string): DidaChecklistItem | undefined {
  const matches = (task.items ?? []).filter((item) => item.id === itemId);
  if (matches.length > 1) throw new Error("父任务中出现重复检查项 ID，已冻结同步");
  return matches[0];
}

function requireOwnedChecklistItem(task: DidaTask, itemId: string): DidaChecklistItem {
  const item = findChecklistItem(task, itemId);
  if (!item) throw new Error("owned 检查项不存在，拒绝按标题重建或领养");
  return item;
}

function verifyOwnedChecklistItem(task: DidaTask, entry: ProjectionLedgerEntry): DidaChecklistItem {
  if (!entry.remoteId) throw new Error("owned 检查项缺少远端 ID");
  const item = requireOwnedChecklistItem(task, entry.remoteId);
  if (item.title !== entry.title || item.status !== checklistStatus(entry.state)) {
    throw new Error("owned 检查项标题或状态复读不一致");
  }
  return item;
}

function mergeOwnedChecklistFields(
  base: ProjectionLedgerEntry,
  local: ProjectionLedgerEntry,
  remote: DidaChecklistItem,
): { item: DidaChecklistItem; competitions: Array<"title" | "status"> } {
  const baseStatus = checklistStatus(base.state);
  const localStatus = checklistStatus(local.state);
  const competitions: Array<"title" | "status"> = [];
  const localTitleChanged = local.title !== base.title;
  const remoteTitleChanged = remote.title !== base.title;
  if (localTitleChanged && remoteTitleChanged && local.title !== remote.title) competitions.push("title");
  const localStatusChanged = localStatus !== baseStatus;
  const remoteStatusChanged = remote.status !== baseStatus;
  if (localStatusChanged && remoteStatusChanged && localStatus !== remote.status) competitions.push("status");
  return {
    item: {
      ...remote,
      title: localTitleChanged ? local.title : remote.title,
      status: localStatusChanged ? localStatus : remote.status,
    },
    competitions,
  };
}

function verifyClientOwnedCreatedChecklistItem(
  baseline: DidaChecklistItem[],
  reread: DidaChecklistItem[],
  entry: ProjectionLedgerEntry,
): { ownedId: string; remap: Map<string, string> } {
  strictChecklistMap(baseline, "写前基线");
  strictChecklistMap(reread, "写后复读");
  if (reread.length !== baseline.length + 1) {
    throw new Error("服务端未返回唯一新增检查项，已冻结同步");
  }
  const ordinary = matchUniqueChecklistSubsequence(baseline, reread, "创建检查项既有 items");
  const ordinaryIds = new Set(ordinary.map((item) => item.id));
  const expected = checkpointChecklistItem(entry);
  const added = reread.filter((item) => !ordinaryIds.has(item.id));
  const created = added[0];
  if (added.length !== 1 || !created || created.title !== expected.title ||
    created.status !== expected.status || created.sortOrder !== expected.sortOrder) {
    throw new Error("服务端未返回唯一且语义正确的正式检查项，已冻结同步");
  }
  return {
    ownedId: created.id,
    remap: new Map([
      ...baseline.map((item, index) => [item.id, ordinary[index]!.id] as const),
      [expected.id, created.id] as const,
    ]),
  };
}

function assertOnlyOwnedChecklistItemDeleted(
  baseline: DidaChecklistItem[],
  reread: DidaChecklistItem[],
  ownedId: string,
): Map<string, string> {
  strictChecklistMap(baseline, "删除前基线");
  strictChecklistMap(reread, "删除后复读");
  const ordinary = baseline.filter((item) => item.id !== ownedId);
  if (ordinary.length !== baseline.length - 1 || reread.length !== ordinary.length) {
    throw new Error("owned 检查项删除结果无法证明");
  }
  const mapped = matchUniqueChecklistSubsequence(ordinary, reread, "删除后的普通 items");
  return new Map(ordinary.map((item, index) => [item.id, mapped[index]!.id]));
}

function assertOnlyOwnedChecklistItemChanged(
  baseline: DidaChecklistItem[],
  reread: DidaChecklistItem[],
  ownedId: string,
  expectedOwned: DidaChecklistItem,
  beforeOwned: DidaChecklistItem,
): { ownedId: string; remap: Map<string, string> } {
  strictChecklistMap(baseline, "更新前基线");
  strictChecklistMap(reread, "更新后复读");
  if (reread.length !== baseline.length) throw new Error("更新 owned 检查项后数量变化");
  const expectedOwnedForCompare = { ...expectedOwned };
  const ownedCandidates = reread.filter((candidate) =>
    sameOwnedTargetExceptIdAndDerivedTime(beforeOwned, expectedOwnedForCompare, candidate));
  if (ownedCandidates.length !== 1) throw new Error("更新 owned 检查项后无法唯一复读受管目标");
  const actualOwned = ownedCandidates[0]!;
  if (beforeOwned.status !== expectedOwned.status) {
    if (beforeOwned.status === 0 && expectedOwned.status === 2) {
      if (actualOwned.completedTime === undefined || actualOwned.completedTime === null) {
        throw new Error("完成 owned 检查项后服务端未生成 completedTime");
      }
      if (!Number.isFinite(new Date(actualOwned.completedTime).getTime())) {
        throw new Error("完成 owned 检查项后服务端 completedTime 无效");
      }
      expectedOwnedForCompare.completedTime = actualOwned.completedTime;
    } else if (beforeOwned.status === 2 && expectedOwned.status !== 2) {
      if (actualOwned.completedTime !== undefined && actualOwned.completedTime !== null) {
        throw new Error("重开 owned 检查项后服务端未移除 completedTime");
      }
      delete expectedOwnedForCompare.completedTime;
    } else {
      throw new Error("owned 检查项 status 发生不受支持的转换");
    }
  }
  const ordinary = baseline.filter((item) => item.id !== ownedId);
  const actualOrdinary = reread.filter((item) => item.id !== actualOwned.id);
  if (actualOrdinary.length !== ordinary.length) throw new Error("更新 owned 检查项时普通 items 数量变化");
  const mapped = matchUniqueChecklistSubsequence(ordinary, actualOrdinary, "更新后的普通 items");
  return {
    ownedId: actualOwned.id,
    remap: new Map([
      ...ordinary.map((item, index) => [item.id, mapped[index]!.id] as const),
      [ownedId, actualOwned.id] as const,
    ]),
  };
}

function sameOwnedTargetExceptIdAndDerivedTime(
  before: DidaChecklistItem,
  expected: DidaChecklistItem,
  actual: DidaChecklistItem,
): boolean {
  const expectedCopy = { ...expected } as Record<string, unknown>;
  const actualCopy = { ...actual } as Record<string, unknown>;
  delete expectedCopy.id;
  delete actualCopy.id;
  if (before.status === expected.status) return stableHash(actualCopy) === stableHash(expectedCopy);
  if (before.status === 0 && expected.status === 2) {
    if (typeof actual.completedTime !== "string" || !Number.isFinite(new Date(actual.completedTime).getTime())) return false;
    delete expectedCopy.completedTime;
    delete actualCopy.completedTime;
    return stableHash(actualCopy) === stableHash(expectedCopy);
  }
  if (before.status === 2 && expected.status === 0) {
    if (actual.completedTime !== undefined && actual.completedTime !== null) return false;
    delete expectedCopy.completedTime;
    delete actualCopy.completedTime;
    return stableHash(actualCopy) === stableHash(expectedCopy);
  }
  return false;
}

function checklistSemanticHash(item: DidaChecklistItem): string {
  const { id: _id, ...semantic } = item;
  return stableHash(semantic);
}

function matchUniqueChecklistSubsequence(
  expected: DidaChecklistItem[],
  actual: DidaChecklistItem[],
  label: string,
): DidaChecklistItem[] {
  return matchUniqueChecklistSemanticHashes(expected.map(checklistSemanticHash), actual, label);
}

function matchUniqueChecklistSemanticHashes(
  expectedHashes: string[],
  actual: DidaChecklistItem[],
  label: string,
): DidaChecklistItem[] {
  const matched = expectedHashes.map((hash) => {
    const candidates = actual.filter((candidate) => checklistSemanticHash(candidate) === hash);
    if (candidates.length !== 1) throw new Error(`${label} 无法按除 ID 外完整语义唯一匹配`);
    return candidates[0]!;
  });
  if (new Set(matched.map((item) => item.id)).size !== matched.length) {
    throw new Error(`${label} 映射不是唯一双射`);
  }
  const indices = matched.map((item) => actual.findIndex((candidate) => candidate.id === item.id));
  if (indices.some((index, offset) => offset > 0 && index <= indices[offset - 1]!)) {
    throw new Error(`${label} 相对顺序发生变化`);
  }
  return matched;
}

function strictChecklistMap(items: DidaChecklistItem[], label: string): Map<string, DidaChecklistItem> {
  const map = new Map<string, DidaChecklistItem>();
  for (const item of items) {
    if (!item.id?.trim() || map.has(item.id)) throw new Error(`${label}存在缺失或重复的检查项 ID`);
    map.set(item.id, item);
  }
  return map;
}

function strictChecklistIds(items: DidaChecklistItem[], label: string): string[] {
  return [...strictChecklistMap(items, label).keys()];
}

function mutationBaselineCheckpoint(
  items: DidaChecklistItem[],
  ownedId: string,
  mutationKind: "update" | "delete",
): Pick<ProjectionLedgerEntry,
  "mutationKind" | "mutationBaselineItemIds" | "mutationBaselineItemsHash" |
  "mutationBaselineItemHashes" | "mutationOrdinarySemanticHashes" | "mutationOwnedInvariantHash" |
  "mutationBaselineOwnedStatus" | "mutationBaselineOwnedCompletedTimeHash"> {
  const ids = strictChecklistIds(items, "投影写入基线");
  const owned = items.find((item) => item.id === ownedId);
  if (!owned) throw new Error("同步写入基线缺少目标检查项");
  return {
    mutationKind,
    mutationBaselineItemIds: ids,
    mutationBaselineItemsHash: stableHash(items),
    mutationBaselineItemHashes: Object.fromEntries(items.map((item) => [item.id, stableHash(item)])),
    mutationOrdinarySemanticHashes: items.filter((item) => item.id !== ownedId).map(checklistSemanticHash),
    mutationOwnedInvariantHash: stableHash(checklistOwnedInvariant(owned)),
    mutationBaselineOwnedStatus: owned.status,
    mutationBaselineOwnedCompletedTimeHash: stableHash(owned.completedTime),
  };
}

function checklistOwnedInvariant(item: DidaChecklistItem): Record<string, unknown> {
  const copy = { ...item } as Record<string, unknown>;
  delete copy.id;
  delete copy.title;
  delete copy.status;
  delete copy.completedTime;
  return copy;
}

function assertExactMutationBaseline(entry: ProjectionLedgerEntry, items: DidaChecklistItem[]): void {
  const ids = entry.mutationBaselineItemIds;
  const hashes = entry.mutationBaselineItemHashes;
  if (!ids || !hashes || !entry.mutationBaselineItemsHash || !entry.mutationOwnedInvariantHash) {
    throw new Error("prepared 写入缺少完整 items 基线");
  }
  const map = strictChecklistMap(items, "prepared 续发复读");
  if (stableHash(items) !== entry.mutationBaselineItemsHash || items.length !== ids.length ||
    ids.some((id, index) => items[index]?.id !== id || stableHash(map.get(id)) !== hashes[id])) {
    throw new Error("prepared 续发前 items 字段或顺序已变化");
  }
}

function assertFrozenMutationOutcome(
  entry: ProjectionLedgerEntry,
  items: DidaChecklistItem[],
  acceptResolvedChoice = false,
): void {
  if (acceptResolvedChoice) {
    const owned = items.find((item) => item.id === entry.remoteId);
    if (entry.mutationKind === "delete") {
      if (owned) throw new Error("人工删除结果仍保留目标检查项");
      strictChecklistMap(items, "人工删除最终复读");
      return;
    }
    if (!owned || typeof owned.title !== "string" || !owned.title.trim() || owned.title !== owned.title.trim() ||
      /[\r\n]/u.test(owned.title) ||
      owned.title.includes("<!-- helix-dida-action:") || (owned.status !== 0 && owned.status !== 2)) {
      throw new Error("人工合并后的 owned title/status 无效");
    }
    assertOwnedCompletedTimeTransition(entry, owned);
    strictChecklistMap(items, "人工更新最终复读");
    return;
  }
  const ids = entry.mutationBaselineItemIds;
  const hashes = entry.mutationBaselineItemHashes;
  if (!entry.remoteId || !ids || !hashes || !entry.mutationOwnedInvariantHash || !entry.mutationKind) {
    throw new Error("冻结写入缺少完整 items 证明");
  }
  const map = strictChecklistMap(items, "冻结写入复读");
  const expectedIds = entry.mutationKind === "delete" ? ids.filter((id) => id !== entry.remoteId) : ids;
  if (items.length !== expectedIds.length || expectedIds.some((id, index) => items[index]?.id !== id)) {
    throw new Error("冻结写入后普通 items 数量或顺序发生变化");
  }
  for (const id of expectedIds) {
    const item = map.get(id)!;
    if (id === entry.remoteId && entry.mutationKind === "update") {
      if (stableHash(checklistOwnedInvariant(item)) !== entry.mutationOwnedInvariantHash ||
        (item.title !== entry.updateExpectedTitle || item.status !== entry.updateExpectedStatus)) {
        throw new Error("冻结更新除 owned title/status 外发生变化");
      }
      assertOwnedCompletedTimeTransition(entry, item);
    } else if (stableHash(item) !== hashes[id]) {
      throw new Error("冻结写入修改了普通 item 字段");
    }
  }
}

function verifyKnownSuccessfulMutationFromSemanticHashes(
  entry: ProjectionLedgerEntry,
  items: DidaChecklistItem[],
): { ownedId?: string; remap: Map<string, string> } {
  const ordinaryHashes = entry.mutationOrdinarySemanticHashes;
  if (!entry.mutationKind || !ordinaryHashes || !entry.mutationOwnedInvariantHash ||
    !entry.mutationBaselineItemIds) {
    throw new Error("明确成功的检查项写入缺少重启语义证明，保持冻结");
  }
  strictChecklistMap(items, "明确成功写后复读");
  if (entry.mutationKind === "delete") {
    if (items.length !== ordinaryHashes.length) throw new Error("明确成功删除后的普通 items 数量变化");
    const mapped = matchUniqueChecklistSemanticHashes(ordinaryHashes, items, "明确成功删除后的普通 items");
    const ordinaryIds = entry.mutationBaselineItemIds!.filter((id) => id !== entry.remoteId);
    return { remap: new Map(ordinaryIds.map((id, index) => [id, mapped[index]!.id])) };
  }
  if (items.length !== ordinaryHashes.length + 1 || entry.updateExpectedTitle === undefined ||
    entry.updateExpectedStatus === undefined) {
    throw new Error("明确成功更新后的 items 数量或目标语义不完整");
  }
  const candidates = items.filter((item) =>
    stableHash(checklistOwnedInvariant(item)) === entry.mutationOwnedInvariantHash &&
    item.title === entry.updateExpectedTitle && item.status === entry.updateExpectedStatus);
  if (candidates.length !== 1) throw new Error("明确成功更新后的 owned item 无法唯一重映");
  const owned = candidates[0]!;
  assertOwnedCompletedTimeTransition(entry, owned);
  const ordinary = items.filter((item) => item.id !== owned.id);
  const mapped = matchUniqueChecklistSemanticHashes(ordinaryHashes, ordinary, "明确成功更新后的普通 items");
  const ordinaryIds = entry.mutationBaselineItemIds!.filter((id) => id !== entry.remoteId);
  return {
    ownedId: owned.id,
    remap: new Map([
      ...ordinaryIds.map((id, index) => [id, mapped[index]!.id] as const),
      [entry.remoteId!, owned.id] as const,
    ]),
  };
}

function assertOwnedCompletedTimeTransition(
  entry: ProjectionLedgerEntry,
  item: DidaChecklistItem,
): void {
  const beforeStatus = entry.mutationBaselineOwnedStatus;
  if (beforeStatus === item.status) {
    if (stableHash(item.completedTime) !== entry.mutationBaselineOwnedCompletedTimeHash) {
      throw new Error("status 未变时 completedTime 发生变化");
    }
  } else if (beforeStatus === 0 && item.status === 2) {
    if (item.completedTime === undefined || !Number.isFinite(new Date(item.completedTime).getTime())) {
      throw new Error("0→2 后缺少合法 completedTime");
    }
  } else if (beforeStatus === 2 && item.status === 0) {
    if (item.completedTime !== undefined && item.completedTime !== null) {
      throw new Error("2→0 后 completedTime 未清除");
    }
  } else {
    throw new Error("冻结更新出现不支持的 status 转换");
  }
}

function assertSafeProjectionActionTitle(title: unknown): asserts title is string {
  if (typeof title !== "string" || !title.trim() || title !== title.trim() || /[\r\n]/u.test(title) ||
    title.includes("<!-- helix-dida-action:")) {
    throw new Error("同步行动标题不能有首尾空格，必须是安全单行文本");
  }
}


function adoptCreatedChecklistItemFromIds(
  baselineIds: string[] | undefined,
  reread: DidaChecklistItem[],
  entry: ProjectionLedgerEntry,
  allowClientIdReplacement = false,
): { ownedId: string; remap: Map<string, string> } {
  if (!baselineIds) throw new Error("冻结的新建检查项缺少可证明的写前 items 基线，禁止自动领养或重发");
  if (new Set(baselineIds).size !== baselineIds.length) throw new Error("新建检查项写前 ID 基线损坏");
  const current = strictChecklistMap(reread, "冻结复读");
  if (allowClientIdReplacement) {
    const hashes = entry.createBaselineSemanticHashes;
    if (!hashes || hashes.length !== baselineIds.length || reread.length !== hashes.length + 1) {
      throw new Error("明确成功的新建检查项缺少完整语义基线，保持冻结");
    }
    const ordinary = matchUniqueChecklistSemanticHashes(hashes, reread, "明确成功的新建普通 items");
    const ordinaryIds = new Set(ordinary.map((item) => item.id));
    const created = reread.filter((item) => !ordinaryIds.has(item.id));
    const expected = checkpointChecklistItem(entry);
    if (created.length !== 1 || created[0]!.title !== expected.title ||
      created[0]!.status !== expected.status || created[0]!.sortOrder !== expected.sortOrder) {
      throw new Error("明确成功的新建检查项无法唯一领养正式 ID，保持冻结");
    }
    return {
      ownedId: created[0]!.id,
      remap: new Map([
        ...baselineIds.map((id, index) => [id, ordinary[index]!.id] as const),
        [entry.createItemId!, created[0]!.id] as const,
      ]),
    };
  }
  if (baselineIds.some((id) => !current.has(id))) throw new Error("新建检查项期间既有 item ID 发生竞争");
  if (!entry.createBaselineItemsHash || !entry.createBaselineItemHashes) {
    throw new Error("冻结的新建检查项缺少有序基线哈希，禁止自动领养");
  }
  const preserved = reread.filter((item) => baselineIds.includes(item.id));
  if (stableHash(preserved) !== entry.createBaselineItemsHash ||
    baselineIds.some((id) => stableHash(current.get(id)) !== entry.createBaselineItemHashes?.[id])) {
    throw new Error("新建检查项期间既有 items 字段或顺序发生竞争");
  }
  const added = [...current.entries()].filter(([id]) => !baselineIds.includes(id));
  if (entry.createItemId !== undefined) {
    const expected = checkpointChecklistItem(entry);
    const created = current.get(expected.id);
    if (added.length !== 1 || !created || created.title !== expected.title ||
      created.status !== expected.status || created.sortOrder !== expected.sortOrder) {
      throw new Error("冻结复读未证明服务端稳定保留客户端检查项身份，保持冻结");
    }
    if (created.id !== expected.id) {
      throw new Error("结果未知时服务端未保留临时客户端 ID，必须人工确认");
    }
    return { ownedId: created.id, remap: new Map([[expected.id, created.id]]) };
  }
  // 旧版无 ID checkpoint 永不续发；仅在现有远端结果可由原基线唯一证明时只读收口。
  const matches = added.filter(([, item]) =>
    item.title === entry.title && item.status === checklistStatus(entry.state));
  if (added.length !== 1 || matches.length !== 1) {
    throw new Error("冻结复读无法唯一证明新建检查项身份，保持冻结");
  }
  return { ownedId: matches[0]![0], remap: new Map() };
}

function assertExactCreateBaseline(entry: ProjectionLedgerEntry, items: DidaChecklistItem[]): void {
  const ids = entry.createBaselineItemIds;
  if (!ids || !entry.createBaselineItemsHash || !entry.createBaselineItemHashes) {
    throw new Error("新建检查项 checkpoint 基线不完整");
  }
  const current = strictChecklistMap(items, "恢复写前复读");
  if (items.length !== ids.length || ids.some((id, index) => items[index]?.id !== id) ||
    stableHash(items) !== entry.createBaselineItemsHash ||
    ids.some((id) => stableHash(current.get(id)) !== entry.createBaselineItemHashes?.[id])) {
    throw new Error("恢复写入前父任务 items 字段或顺序已变化，禁止续发");
  }
}

function freezeEntry(
  entries: ProjectionLedgerEntry[],
  entry: ProjectionLedgerEntry,
  reason: ProjectionFreezeReason,
  summary: ProjectionSyncSummary,
  detail: string,
  receipt?: { operationId: string; conflictId?: string },
): ProjectionLedgerEntry[] {
  summary.frozen.push({ uuid: entry.uuid, reason, message: detail });
  const frozen = {
    ...entry,
    frozen: reason,
    operationId: receipt?.operationId ?? entry.operationId,
    conflictId: receipt?.conflictId ?? entry.conflictId,
  };
  return entries.some((item) => item.uuid === entry.uuid) ? replaceEntry(entries, frozen) : [...entries, frozen];
}

function resultReason(result: { outcome: string }): ProjectionFreezeReason {
  if (result.outcome === "unknown") return "unknown-outcome";
  if (result.outcome === "retryable") return "retryable";
  if (result.outcome === "authorization") return "authorization";
  if (result.outcome === "capability") return "capability";
  return "conflict";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unmanagedAction(markdown: string, lineNumber: number): {
  line: number;
  title: string;
  completed: boolean;
} {
  const line = markdown.split(/\r?\n/)[lineNumber - 1] ?? "";
  const match = /^\s*[-*+] \[([ xX])\]\s+(.+?)\s*$/.exec(line);
  if (!match) throw new Error(`未加入同步的行动行已变化：第 ${lineNumber} 行`);
  return {
    line: lineNumber,
    title: match[2]!.trim(),
    completed: match[1]!.toLowerCase() === "x",
  };
}

function projectionLedgerIdentity(entry: Pick<ProjectionLedgerEntry, "projectId" | "stageId" | "uuid">): string {
  return `${entry.projectId}\u0000${entry.stageId}\u0000${entry.uuid}`;
}

function assertProjectionUuidOwnership(
  state: ProjectionPersistentState,
  projectId: string,
  stages: Array<{ stageId: string; actions: Array<{ uuid: string }> }>,
): void {
  const ledgerOwners = new Map<string, string>();
  for (const entry of state.ledger) {
    const identity = projectionLedgerIdentity(entry);
    const existing = ledgerOwners.get(entry.uuid);
    if (existing !== undefined) {
      throw new Error("同步账本 UUID 在多个项目或阶段中重复，已拒绝远端写入");
    }
    ledgerOwners.set(entry.uuid, identity);
  }
  const markdownOwners = new Map<string, string>();
  for (const stage of stages) {
    for (const action of stage.actions) {
      const identity = projectionLedgerIdentity({ projectId, stageId: stage.stageId, uuid: action.uuid });
      const markdownOwner = markdownOwners.get(action.uuid);
      if (markdownOwner !== undefined && markdownOwner !== identity) {
        throw new Error("计划行动 UUID 在多个阶段 Markdown 中重复，已拒绝远端写入");
      }
      const ledgerOwner = ledgerOwners.get(action.uuid);
      if (ledgerOwner !== undefined && ledgerOwner !== identity) {
        throw new Error("计划行动 UUID 与同步账本归属不一致，已拒绝远端写入");
      }
      markdownOwners.set(action.uuid, identity);
    }
  }
}

function assertReceiptMatchesProof(
  receipt: ProjectionOperationDiagnostic,
  proof: ProjectionReceiptCleanupProof,
): void {
  if (receipt.operationId !== proof.operationId || receipt.projectId !== proof.targetProjectId ||
    receipt.marker !== proof.marker ||
    (receipt.remoteTaskId !== undefined && receipt.remoteTaskId !== proof.remoteTaskId) ||
    receipt.conflictId !== proof.conflictId) {
    throw new Error("同步操作收据与冻结对象身份不一致，禁止收口");
  }
}

function stableStateParentBase(
  left: ProjectionPersistentState["parentBases"],
  right: NonNullable<ProjectionPersistentState["parentBases"]>,
): boolean {
  return stableHash(left ?? []) === stableHash(right);
}

function isMissingRemote(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  return record?.statusCode === 404 || record?.category === "not-found";
}
