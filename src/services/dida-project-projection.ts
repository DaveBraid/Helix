import type { DidaChecklistItem, DidaColumn, DidaProject, DidaTask } from "../domain/entities";
import { stableHash } from "../domain/stable";
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
  type DidaProjectionTarget,
  type ProjectionActivationPreview,
  type ProjectionColumnCreationCheckpoint,
  type ProjectionFreezeReason,
  type ProjectionLedgerEntry,
  type ProjectionReadiness,
  type ProjectionReceiptCleanupProof,
} from "../domain/dida-project-projection";
import type { ResolutionAuditEntry } from "../sync/types";

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
        throw new Error("滴答项目同步状态在写入前发生竞争");
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

  async reconcileFrozen(input:
    | { kind: "action"; projectId: string; stageId: string; stagePath: string; uuid: string }
    | { kind: "parent"; projectId: string; projectPath: string; title: string; status: ProjectionProjectInput["projectStatus"] }): Promise<void> {
    let current = await this.state.read();
    if (!current.target) throw new Error("滴答项目同步尚无已确认目标");
    if (input.kind === "action") {
      const entry = current.ledger.find((item) => item.uuid === input.uuid &&
        item.projectId === input.projectId && item.stageId === input.stageId);
      if (!entry?.frozen) throw new Error("行动没有待复核的冻结状态");
      const inspection = entry.operationId && this.diagnostics
        ? await this.diagnostics.inspect(entry.operationId, entry.conflictId)
        : undefined;
      if (inspection?.blocked) {
        throw new Error("该冻结仍由队列或逐字段冲突持有，必须先在冲突中心解决");
      }
      const resumableUnqueuedCreate = Boolean(entry.operationId && !entry.remoteId && inspection &&
        !inspection.receipt && entry.createBaselineItemIds && entry.createBaselineItemsHash &&
        entry.createBaselineItemHashes);
      const resumableUnsentCreate = Boolean(entry.operationId && !entry.remoteId && inspection &&
        inspection.receipt?.outcome === "preflight-changed" &&
        entry.createBaselineItemIds && entry.createBaselineItemsHash && entry.createBaselineItemHashes);
      const resumablePreparedMutation = Boolean(entry.operationId && entry.remoteId && inspection &&
        !inspection.receipt && entry.mutationKind && entry.mutationBaselineItemIds &&
        entry.mutationBaselineItemsHash && entry.mutationBaselineItemHashes);
      if (entry.operationId && !inspection?.receipt && !resumableUnqueuedCreate && !resumablePreparedMutation) {
        throw new Error("冻结行动缺少既有操作收据，禁止旁路收口");
      }
      if (!inspection && entry.frozen !== "identity-mismatch" && entry.frozen !== "markdown-race") {
        throw new Error("冻结缺少可证明已由既有冲突流程收口的操作诊断");
      }
      const cleanupProof: ProjectionReceiptCleanupProof | undefined = entry.operationId ? {
        kind: "action",
        operationId: entry.operationId,
        conflictId: entry.conflictId ?? inspection?.receipt?.conflictId,
        projectId: entry.projectId,
        stageId: entry.stageId,
        uuid: entry.uuid,
        targetProjectId: entry.targetProjectId,
        marker: `helix-project-projection:${entry.projectId}`,
        remoteTaskId: entry.parentTaskId,
      } : undefined;
      if (cleanupProof && inspection?.receipt) {
        assertReceiptMatchesProof(inspection.receipt, cleanupProof);
      }
      let recoveredParent = await this.pipeline.rereadTask(entry.targetProjectId, entry.parentTaskId);
      if (!recoveredParent) throw new Error("远端父任务不存在，保持冻结");
      let resumeEntry = entry;
      if (resumableUnsentCreate) {
        if (!this.sameParentIdentity(
          recoveredParent, entry.projectId, entry.parentTaskId, current.target,
        )) {
          throw new Error("未发送恢复前父任务身份变化，保持冻结");
        }
        // 先把消费收据前的精确复读持久化为新 Base；因此即使出现第 4 次
        // 远端变化或随后中断，仍保留可证明未发送的恢复起点。
        const latestItems = recoveredParent.items ?? [];
        const latestIds = strictChecklistIds(latestItems, "未发送恢复前重基线");
        const latest = await this.state.read();
        const latestEntry = latest.ledger.find((item) => projectionLedgerIdentity(item) === projectionLedgerIdentity(entry));
        if (!latestEntry || latestEntry.operationId !== entry.operationId || latestEntry.remoteId) {
          throw new Error("未发送恢复前同步账本发生竞争");
        }
        resumeEntry = {
          ...latestEntry,
          createBaselineItemIds: latestIds,
          createBaselineItemsHash: stableHash(latestItems),
          createBaselineItemHashes: Object.fromEntries(latestItems.map((item) => [item.id, stableHash(item)])),
        };
        const rebasedState = {
          ...latest,
          ledger: replaceEntry(latest.ledger, resumeEntry),
        };
        await this.state.write(latest, rebasedState);
        current = rebasedState;
        await this.diagnostics!.removeReconciled(entry.operationId!);
      }
      if (resumableUnqueuedCreate || resumableUnsentCreate) {
        assertExactCreateBaseline(resumeEntry, recoveredParent.items ?? []);
        const resumed = await this.pipeline.updateTask({
          ...recoveredParent,
          items: [...(recoveredParent.items ?? []), newChecklistItem(resumeEntry)],
        }, ["items"], entry.operationId, recoveredParent);
        if (resumed.outcome === "preflight-changed") {
          const rebased = resumed.task.items ?? [];
          const rebasedIds = strictChecklistIds(rebased, "恢复时未发送重基线");
          const latest = await this.state.read();
          const latestEntry = latest.ledger.find((item) => projectionLedgerIdentity(item) === projectionLedgerIdentity(entry));
          if (!latestEntry || latestEntry.operationId !== entry.operationId) {
            throw new Error("恢复时重基线账本发生竞争");
          }
          await this.state.write(latest, {
            ...latest,
            ledger: replaceEntry(latest.ledger, {
              ...latestEntry,
              createBaselineItemIds: rebasedIds,
              createBaselineItemsHash: stableHash(rebased),
              createBaselineItemHashes: Object.fromEntries(rebased.map((item) => [item.id, stableHash(item)])),
            }),
          });
          throw new Error("恢复续发仍在请求发送前发生竞争；最新 Base 已持久化，可安全再次恢复");
        }
        if (resumed.outcome !== "verified" || resumed.operationId !== entry.operationId) {
          throw new Error(resumed.outcome === "verified"
            ? "恢复写入返回了其他 operation ID，保持冻结"
            : `恢复写入尚未得到精确结果：${resumed.message}`);
        }
        recoveredParent = resumed.task;
      }
      if (resumablePreparedMutation) {
        assertExactMutationBaseline(entry, recoveredParent.items ?? []);
        const resumedItems = entry.mutationKind === "delete"
          ? (recoveredParent.items ?? []).filter((item) => item.id !== entry.remoteId)
          : (recoveredParent.items ?? []).map((item) => item.id === entry.remoteId
            ? { ...item, title: entry.updateExpectedTitle!, status: entry.updateExpectedStatus! }
            : item);
        const resumed = await this.pipeline.updateTask(
          { ...recoveredParent, items: resumedItems },
          ["items"],
          entry.operationId,
          recoveredParent,
        );
        if (resumed.outcome !== "verified" || resumed.operationId !== entry.operationId) {
          throw new Error("prepared 写入续发未取得同 operation ID 的精确结果");
        }
        recoveredParent = resumed.task;
      }
      const recoveredItemId = entry.remoteId ?? adoptCreatedChecklistItemFromIds(
        resumeEntry.createBaselineItemIds,
        recoveredParent.items ?? [],
        resumeEntry,
      );
      const stageRevision = await this.requireRevision(input.stagePath);
      assertProjectionStageIdentity(stageRevision.content, input.stageId);
      const remote = recoveredParent;
      const remoteItem = findChecklistItem(remote, recoveredItemId);
      if (entry.conflictId) {
        if (!inspection?.resolutionAudit || inspection.resolutionAudit.conflictId !== entry.conflictId ||
          inspection.resolutionAudit.remoteAfterHash !== stableHash(remote)) {
          throw new Error("人工冲突结果缺少匹配的审计与最终快照证明");
        }
      }
      if (entry.tombstone && entry.mutationKind === "delete" && remoteItem && entry.conflictId) {
        if (typeof remoteItem.title !== "string" || !remoteItem.title.trim() ||
          remoteItem.title !== remoteItem.title.trim() || /[\r\n]/u.test(remoteItem.title) ||
          remoteItem.title.includes("<!-- helix-dida-action:") ||
          (remoteItem.status !== 0 && remoteItem.status !== 2)) {
          throw new Error("人工保留的检查项标题或状态无效");
        }
        const restoredEntry: ProjectionLedgerEntry = {
          ...entry,
          title: remoteItem.title,
          state: projectionStateForRemoteStatus(entry.state, remoteItem.status),
          tombstone: undefined,
          frozen: undefined,
          operationId: undefined,
          conflictId: undefined,
          mutationKind: undefined,
          mutationBaselineItemIds: undefined,
          mutationBaselineItemsHash: undefined,
          mutationBaselineItemHashes: undefined,
          mutationOwnedInvariantHash: undefined,
          mutationBaselineOwnedStatus: undefined,
          mutationBaselineOwnedCompletedTimeHash: undefined,
        };
        await this.markdown.compareAndWrite(stageRevision, restoreManagedPlanAction(stageRevision.content, {
          uuid: entry.uuid,
          remoteId: recoveredItemId,
          title: restoredEntry.title,
          state: restoredEntry.state,
        }));
        await this.settleReconciliation(current, {
          ...current,
          ledger: current.ledger.map((item) => projectionLedgerIdentity(item) === projectionLedgerIdentity(entry)
            ? restoredEntry : item),
        }, cleanupProof);
        return;
      }
      if (entry.mutationKind) {
        assertFrozenMutationOutcome(entry, remote.items ?? [], Boolean(entry.conflictId));
      }
      if (entry.tombstone) {
        if (remoteItem) throw new Error("远端 owned 检查项仍存在，删除冻结保持不变");
        await this.settleReconciliation(current, {
          ...current,
          ledger: current.ledger.filter((item) => !(item.uuid === entry.uuid &&
            item.projectId === entry.projectId && item.stageId === entry.stageId)),
        }, cleanupProof);
        return;
      }
      const hasUpdateCheckpoint = entry.updateExpectedTitle !== undefined &&
        entry.updateExpectedStatus !== undefined && entry.updateStageRevisionHash !== undefined;
      if (hasUpdateCheckpoint) {
        if (!remoteItem) throw new Error("更新冻结的 owned 检查项不存在，保持冻结");
        if (stageRevision.hash !== entry.updateStageRevisionHash) {
          throw new Error("阶段 Markdown 在更新冻结期间发生变化，保持冻结");
        }
        // 普通 unknown 只接受原期望结果；人工冲突解决则以已精确复读的最终远端值为准。
        if (!entry.conflictId && (remoteItem.title !== entry.updateExpectedTitle ||
          remoteItem.status !== entry.updateExpectedStatus)) {
          throw new Error("更新冻结的远端结果与持久期望不一致，保持冻结");
        }
        const finalEntry: ProjectionLedgerEntry = {
          ...entry,
          remoteId: recoveredItemId,
          title: remoteItem.title,
          state: projectionStateForRemoteStatus(entry.state, remoteItem.status),
        };
        const markdownAction = parseManagedPlanActions(stageRevision.content).actions
          .find((action) => action.uuid === entry.uuid);
        if (!markdownAction || markdownAction.title !== entry.title || markdownAction.state !== entry.state ||
          markdownAction.remoteId !== recoveredItemId) {
          throw new Error("阶段 Markdown 行动在更新冻结期间发生变化，保持冻结");
        }
        await this.markdown.compareAndWrite(stageRevision, patchManagedPlanAction(stageRevision.content, {
          uuid: entry.uuid,
          title: finalEntry.title,
          state: finalEntry.state,
          remoteId: recoveredItemId,
        }));
        await this.settleReconciliation(current, {
          ...current,
          ledger: current.ledger.map((item) => item.uuid === entry.uuid &&
            item.projectId === entry.projectId && item.stageId === entry.stageId
            ? {
                ...finalEntry,
                frozen: undefined,
                operationId: undefined,
                conflictId: undefined,
                updateExpectedTitle: undefined,
                updateExpectedStatus: undefined,
                updateStageRevisionHash: undefined,
                mutationKind: undefined,
                mutationBaselineItemIds: undefined,
                mutationBaselineItemsHash: undefined,
                mutationBaselineItemHashes: undefined,
                mutationOwnedInvariantHash: undefined,
                mutationBaselineOwnedStatus: undefined,
                mutationBaselineOwnedCompletedTimeHash: undefined,
              }
            : item),
        }, cleanupProof);
        return;
      }
      const verifiedEntry = { ...entry, remoteId: recoveredItemId };
      verifyOwnedChecklistItem(remote, verifiedEntry);
      const markdownAction = parseManagedPlanActions(stageRevision.content).actions
        .find((action) => action.uuid === entry.uuid);
      if (!markdownAction || markdownAction.title !== entry.title || markdownAction.state !== entry.state ||
        (markdownAction.remoteId !== undefined && markdownAction.remoteId !== recoveredItemId)) {
        throw new Error("阶段 Markdown 行动在冻结期间发生变化，保持冻结");
      }
      if (markdownAction.remoteId !== recoveredItemId) {
        await this.markdown.compareAndWrite(stageRevision, patchManagedPlanAction(stageRevision.content, {
          uuid: entry.uuid,
          remoteId: recoveredItemId,
        }));
      }
      await this.settleReconciliation(current, {
        ...current,
        ledger: current.ledger.map((item) => item.uuid === entry.uuid &&
          item.projectId === entry.projectId && item.stageId === entry.stageId
          ? {
              ...item,
              remoteId: recoveredItemId,
              frozen: undefined,
              operationId: undefined,
              conflictId: undefined,
              createBaselineItemIds: undefined,
              createBaselineItemsHash: undefined,
              createBaselineItemHashes: undefined,
            }
          : item),
      }, cleanupProof);
      return;
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
      target: { ...fresh.target },
      confirmedPreviewHash: fresh.previewHash,
    });
  }

  async synchronizeProject(input: ProjectionProjectInput): Promise<ProjectionSyncSummary> {
    const initialState = await this.state.read();
    if (!initialState.enabled || !initialState.target || !initialState.confirmedPreviewHash) {
      throw new Error("Helix→滴答同步尚未显式预览并启用");
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
            tombstone: old.tombstone,
            frozen: old.frozen,
            operationId: old.operationId,
            conflictId: old.conflictId,
            createBaselineItemIds: old.createBaselineItemIds,
            createBaselineItemsHash: old.createBaselineItemsHash,
            createBaselineItemHashes: old.createBaselineItemHashes,
            updateExpectedTitle: old.updateExpectedTitle,
            updateExpectedStatus: old.updateExpectedStatus,
            updateStageRevisionHash: old.updateStageRevisionHash,
            mutationKind: old.mutationKind,
            mutationBaselineItemIds: old.mutationBaselineItemIds,
            mutationBaselineItemsHash: old.mutationBaselineItemsHash,
            mutationBaselineItemHashes: old.mutationBaselineItemHashes,
            mutationOwnedInvariantHash: old.mutationOwnedInvariantHash,
            mutationBaselineOwnedStatus: old.mutationBaselineOwnedStatus,
            mutationBaselineOwnedCompletedTimeHash: old.mutationBaselineOwnedCompletedTimeHash,
          }
        : entry;
    });
    working.push(...retainedMissingStages);
    working.push(...previous.filter((entry) => entry.frozen &&
      !working.some((item) => projectionLedgerIdentity(item) === projectionLedgerIdentity(entry))));
    const managedWorking = working.filter((entry) => presentStageIds.has(entry.stageId));
    for (const intent of planProjectionChanges(managedPrevious, managedWorking, {
      taskReopenVerified: readiness.taskReopenVerified,
    })) {
      const entry = intent.entry;
      if (working.find((item) => projectionLedgerIdentity(item) === projectionLedgerIdentity(entry))?.frozen) continue;
      const stageRevision = stageRevisions.get(entry.stageId);
      if (!stageRevision && intent.kind !== "delete-action") throw new Error(`找不到行动所属阶段：${entry.stageId}`);
      if (intent.kind === "freeze-action") {
        working = freezeEntry(working, entry, intent.reason, summary, "投影身份发生竞争，已持久冻结");
        continue;
      }
      if (intent.kind === "recover-action") {
        const parent = await this.pipeline.rereadTask(entry.targetProjectId, entry.parentTaskId);
        try {
          if (!parent || !this.sameParentIdentity(parent, projectIdentity.projectId, entry.parentTaskId, initialState.target)) {
            throw new Error("Markdown 已有检查项 ID，但父任务精确复读不一致");
          }
          verifyOwnedChecklistItem(parent, entry);
        } catch (error) {
          working = freezeEntry(working, entry, "identity-mismatch", summary, message(error));
        }
        continue;
      }
      if (intent.kind === "reconcile-delete") {
        const parent = await this.pipeline.rereadTask(entry.targetProjectId, entry.parentTaskId);
        if (parent && !findChecklistItem(parent, entry.remoteId!)) {
          working = working.filter((item) => item.uuid !== entry.uuid);
        } else {
          working = freezeEntry(working, entry, "unknown-outcome", summary, "删除 tombstone 的检查项结果无法证明；禁止重发删除");
        }
        continue;
      }
      if (intent.kind === "create-action") {
        let parent = await this.pipeline.rereadTask(entry.targetProjectId, entry.parentTaskId);
        if (!parent || !this.sameParentIdentity(parent, projectIdentity.projectId, entry.parentTaskId, initialState.target) ||
          parent.title !== input.projectTitle || parent.status !== (input.projectStatus === "completed" ? 2 : 0)) {
          working = freezeEntry(working, entry, "identity-mismatch", summary, "子任务创建前父任务精确复读不一致");
          continue;
        }
        // 无远端 ID 的追加在持久 prepared 检查点前再做一次专用预检复读；
        // 预检期间新增的普通 item 会进入新基线，而不是落入通用 items 冲突。
        const preflightParent = await this.pipeline.rereadTask(entry.targetProjectId, entry.parentTaskId);
        if (!preflightParent || !this.sameParentIdentity(
          preflightParent, projectIdentity.projectId, entry.parentTaskId, initialState.target,
        )) {
          working = freezeEntry(working, entry, "identity-mismatch", summary, "检查项追加预检时父任务身份变化");
          continue;
        }
        parent = preflightParent;
        let baseline = structuredClone(parent.items ?? []);
        // 写前先落盘“结果未知”检查点；即使进程在远端接受写入后崩溃，下一轮也不会重复追加。
        const createBaselineItemIds = strictChecklistIds(baseline, "写前基线");
        const operationId = entry.operationId ?? `op-projection-item-create-${crypto.randomUUID()}`;
        let checkpointEntry: ProjectionLedgerEntry = {
          ...entry,
          frozen: "unknown-outcome",
          operationId,
          createBaselineItemIds,
          createBaselineItemsHash: stableHash(baseline),
          createBaselineItemHashes: Object.fromEntries(baseline.map((item) => [item.id, stableHash(item)])),
        };
        working = replaceEntry(working, checkpointEntry);
        await this.persistProjectLedger(projectIdentity.projectId, working);
        let created: ProjectionWriteReceipt | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            created = await this.pipeline.updateTask({
              ...parent,
              items: [...baseline, newChecklistItem(entry)],
            }, ["items"], operationId, parent);
          } catch (error) {
            working = freezeEntry(working, checkpointEntry, "unknown-outcome", summary, message(error));
            break;
          }
          if (created.outcome !== "preflight-changed") break;
          const nextParent = created.task;
          if (!this.sameParentIdentity(
            nextParent, projectIdentity.projectId, entry.parentTaskId, initialState.target,
          ) || nextParent.title !== input.projectTitle ||
            nextParent.status !== (input.projectStatus === "completed" ? 2 : 0)) {
            working = freezeEntry(working, checkpointEntry, "identity-mismatch", summary,
              "检查项追加重基线时父任务身份或受管字段变化");
            created = undefined;
            break;
          }
          parent = nextParent;
          baseline = structuredClone(parent.items ?? []);
          const rebasedIds = strictChecklistIds(baseline, "未发送重基线");
          checkpointEntry = {
            ...checkpointEntry,
            createBaselineItemIds: rebasedIds,
            createBaselineItemsHash: stableHash(baseline),
            createBaselineItemHashes: Object.fromEntries(baseline.map((item) => [item.id, stableHash(item)])),
          };
          working = replaceEntry(working, checkpointEntry);
          await this.persistProjectLedger(projectIdentity.projectId, working);
          created = undefined;
        }
        if (!created) {
          if (working.find((candidate) => candidate.uuid === entry.uuid)?.frozen === "unknown-outcome") {
            working = freezeEntry(working, checkpointEntry, "retryable", summary,
              "检查项追加连续发生未发送预检竞争，请稍后基于最新父任务重试");
          }
          continue;
        }
        if (created.outcome !== "verified") {
          working = freezeEntry(working, checkpointEntry, resultReason(created), summary, created.message, created);
          continue;
        }
        if (created.operationId !== operationId) {
          working = freezeEntry(
            working,
            checkpointEntry,
            "identity-mismatch",
            summary,
            "检查项创建返回了其他 operation ID，保持冻结",
            created,
          );
          continue;
        }
        let adoptedId: string;
        try {
          adoptedId = adoptUniqueCreatedChecklistItem(baseline, created.task.items ?? [], entry);
        } catch (error) {
          working = freezeEntry(working, checkpointEntry, "identity-mismatch", summary, message(error), created);
          continue;
        }
        const verifiedEntry = {
          ...entry,
          remoteId: adoptedId,
          operationId: undefined,
          conflictId: undefined,
          createBaselineItemIds: undefined,
          createBaselineItemsHash: undefined,
          createBaselineItemHashes: undefined,
        };
        try {
          const next = patchManagedPlanAction(stageRevision!.content, { uuid: entry.uuid, remoteId: adoptedId });
          const written = await this.markdown.compareAndWrite(stageRevision!, next);
          stageRevisions.set(entry.stageId, written);
          working = replaceEntry(working, verifiedEntry);
          summary.createdActions += 1;
          if (verifiedEntry.state === "completed") summary.completedActions += 1;
        } catch (error) {
          working = freezeEntry(working, { ...checkpointEntry, remoteId: adoptedId }, "markdown-race", summary, message(error), created);
        }
        continue;
      }
      if (!entry.remoteId) {
        working = freezeEntry(working, entry, "identity-mismatch", summary, "既有投影行动缺少远端 ID");
        continue;
      }
      if (intent.kind === "update-action" || intent.kind === "complete-action" || intent.kind === "reopen-action") {
        const parent = await this.pipeline.rereadTask(entry.targetProjectId, entry.parentTaskId);
        const base = previousByIdentity.get(projectionLedgerIdentity(entry));
        let updateCheckpoint: ProjectionLedgerEntry | undefined;
        try {
          if (!parent || !base) throw new Error("检查项更新缺少父任务或同步 Base");
          const remoteOwned = requireOwnedChecklistItem(parent, entry.remoteId!);
          const mergedOwned = mergeOwnedChecklistFields(base, entry, remoteOwned);
          assertSafeProjectionActionTitle(mergedOwned.item.title);
          const items = (parent.items ?? []).map((item) => item.id === entry.remoteId
            ? mergedOwned.item
            : item);
          const operationId = entry.operationId ?? `op-projection-item-update-${crypto.randomUUID()}`;
          updateCheckpoint = {
            ...entry,
            frozen: "unknown-outcome",
            operationId,
            updateExpectedTitle: mergedOwned.item.title,
            updateExpectedStatus: mergedOwned.item.status,
            updateStageRevisionHash: stageRevision!.hash,
            ...mutationBaselineCheckpoint(parent.items ?? [], entry.remoteId!, "update"),
          };
          working = replaceEntry(working, updateCheckpoint);
          await this.persistProjectLedger(projectIdentity.projectId, working);
          if (mergedOwned.competitions.length > 0) {
            const baseItems = (parent.items ?? []).map((item) => item.id === entry.remoteId
              ? { ...item, title: base.title, status: checklistStatus(base.state) }
              : item);
            const conflict = await this.pipeline.stageItemsConflict(
              { ...parent, items },
              parent,
              { ...parent, items: baseItems },
              operationId,
            );
            working = freezeEntry(
              working,
              updateCheckpoint,
              resultReason(conflict),
              summary,
              conflict.outcome === "verified" ? "竞争未形成冲突" : conflict.message,
              conflict,
            );
            continue;
          }
          const result = await this.pipeline.updateTask({ ...parent, items }, ["items"], operationId, parent);
          if (result.outcome !== "verified") {
            working = freezeEntry(working, updateCheckpoint, resultReason(result), summary, result.message, result);
            continue;
          }
          if (result.operationId !== operationId) {
            working = freezeEntry(working, updateCheckpoint, "identity-mismatch", summary,
              "检查项更新返回了其他 operation ID，保持冻结", result);
            continue;
          }
          assertOnlyOwnedChecklistItemChanged(
            parent.items ?? [],
            result.task.items ?? [],
            entry.remoteId!,
            mergedOwned.item,
            remoteOwned,
          );
          const reconciledEntry: ProjectionLedgerEntry = {
            ...entry,
            title: mergedOwned.item.title,
            state: projectionStateForRemoteStatus(entry.state, mergedOwned.item.status),
            operationId: undefined,
            conflictId: undefined,
            updateExpectedTitle: undefined,
            updateExpectedStatus: undefined,
            updateStageRevisionHash: undefined,
            mutationKind: undefined,
            mutationBaselineItemIds: undefined,
            mutationBaselineItemsHash: undefined,
            mutationBaselineItemHashes: undefined,
            mutationOwnedInvariantHash: undefined,
            mutationBaselineOwnedStatus: undefined,
            mutationBaselineOwnedCompletedTimeHash: undefined,
          };
          verifyOwnedChecklistItem(result.task, reconciledEntry);
          if (reconciledEntry.title !== entry.title || reconciledEntry.state !== entry.state) {
            const next = patchManagedPlanAction(stageRevision!.content, {
              uuid: entry.uuid,
              title: reconciledEntry.title,
              state: reconciledEntry.state,
            });
            const written = await this.markdown.compareAndWrite(stageRevision!, next);
            stageRevisions.set(entry.stageId, written);
          }
          working = replaceEntry(working, reconciledEntry);
          if (intent.kind === "update-action") summary.updatedActions += 1;
          if (intent.kind === "complete-action" || (base.state !== "completed" && entry.state === "completed")) {
            summary.completedActions += 1;
          }
        } catch (error) {
          working = freezeEntry(
            working,
            updateCheckpoint ?? entry,
            message(error).includes("竞争") ? "conflict" : "identity-mismatch",
            summary,
            message(error),
          );
        }
      } else {
        const parent = await this.pipeline.rereadTask(entry.targetProjectId, entry.parentTaskId);
        const owned = parent && findChecklistItem(parent, entry.remoteId!);
        if (!parent || !owned || owned.title !== entry.title || owned.status !== checklistStatus(entry.state)) {
          working = freezeEntry(working, entry, "conflict", summary, "删除前 owned 检查项相对 Base 已竞争；未执行删除");
          continue;
        }
        const baseline = structuredClone(parent.items ?? []);
        const operationId = entry.operationId ?? `op-projection-item-delete-${crypto.randomUUID()}`;
        const deleteCheckpoint: ProjectionLedgerEntry = {
          ...entry,
          tombstone: true,
          frozen: "unknown-outcome",
          operationId,
          ...mutationBaselineCheckpoint(baseline, entry.remoteId, "delete"),
        };
        working = working.some((item) => item.uuid === entry.uuid)
          ? replaceEntry(working, deleteCheckpoint)
          : [...working, deleteCheckpoint];
        await this.persistProjectLedger(projectIdentity.projectId, working);
        let deletion: ProjectionWriteReceipt;
        try {
          deletion = await this.pipeline.updateTask({
            ...parent,
            items: baseline.filter((item) => item.id !== entry.remoteId),
          }, ["items"], operationId, parent);
        } catch (error) {
          working = freezeEntry(working, deleteCheckpoint, "unknown-outcome", summary, message(error));
          continue;
        }
        if (deletion.outcome !== "verified") {
          const frozen = {
            ...deleteCheckpoint,
            frozen: resultReason(deletion),
            conflictId: deletion.conflictId,
          };
          working = replaceEntry(working, frozen);
          summary.frozen.push({ uuid: entry.uuid, reason: frozen.frozen!, message: deletion.message });
        } else if (deletion.operationId !== operationId) {
          working = freezeEntry(working, deleteCheckpoint, "identity-mismatch", summary,
            "检查项删除返回了其他 operation ID，保持冻结", deletion);
        } else {
          try {
            assertOnlyOwnedChecklistItemDeleted(baseline, deletion.task.items ?? [], entry.remoteId);
            working = working.filter((item) => item.uuid !== entry.uuid);
            summary.deletedActions += 1;
          } catch (error) {
            working = freezeEntry(working, deleteCheckpoint, "identity-mismatch", summary, message(error), deletion);
          }
        }
      }
    }
    const latest = await this.state.read();
    await this.state.write(latest, {
      ...latest,
      ledger: [
        ...latest.ledger.filter((entry) => entry.projectId !== projectIdentity.projectId),
        ...working,
      ],
    });
    return summary;
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
    if (!result.task.id || result.task.id.startsWith("local-") ||
      result.task.projectId !== target.targetProjectId || result.task.columnId !== target.targetColumnId ||
      result.task.content !== marker || result.task.title !== title || result.task.status === 2) {
      await this.freezeParent(state, projectId, marker, result.task.id, "identity-mismatch");
      summary.frozen.push({ uuid: `project:${projectId}`, reason: "identity-mismatch", message: "父任务写后复读身份不一致" });
      return undefined;
    }
    const latest = await this.state.read();
    const nextCheckpoint = {
      projectId,
      remoteId: result.task.id,
      marker,
      operationId: result.operationId,
      conflictId: result.conflictId,
    };
    await this.state.write(latest, {
      ...latest,
      parentCheckpoints: [...latest.parentCheckpoints.filter((item) => item.projectId !== projectId), nextCheckpoint],
    });
    try {
      await this.markdown.compareAndWrite(revision, patchProjectParentTaskId(revision.content, result.task.id));
    } catch {
      const after = await this.state.read();
      await this.freezeParent(after, projectId, marker, result.task.id, "markdown-race");
      summary.frozen.push({ uuid: `project:${projectId}`, reason: "markdown-race", message: "父任务已创建但 Markdown 回填竞争" });
      return undefined;
    }
    await this.clearParentCheckpoint(await this.state.read(), projectId);
    await this.saveParentBase(await this.state.read(), projectId, result.task);
    summary.createdParents += 1;
    return result.task.id;
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
      if (!this.sameParentIdentity(result.task, projectId, remoteId, target) || result.task.status === 2) {
        await this.freezeParent(await this.state.read(), projectId, marker, remoteId, "identity-mismatch", result);
        summary.frozen.push({ uuid: `project:${projectId}`, reason: "identity-mismatch", message: "父任务重开写后复读不一致" });
        return false;
      }
      verified = result.task;
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
      verified = result.task;
      if (fields.includes("title")) summary.updatedParents += 1;
    }
    if (verified.status !== 2 && desiredStatus === 2) {
      const result = await this.pipeline.completeTask({ ...verified, status: 2, completedTime: this.now() });
      if (result.outcome !== "verified") {
        await this.freezeParent(state, projectId, marker, remoteId, resultReason(result), result);
        summary.frozen.push({ uuid: `project:${projectId}`, reason: resultReason(result), message: result.message });
        return false;
      }
      verified = result.task;
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

  private async requireRevision(path: string): Promise<ProjectionMarkdownRevision> {
    const revision = await this.markdown.read(path);
    if (!revision) throw new Error(`找不到同步所需的 Markdown：${path}`);
    return revision;
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

/** 新检查项不携带用户可见 marker；ID 必须由写后精确复读的差集领养。 */
function newChecklistItem(entry: ProjectionLedgerEntry): DidaChecklistItem {
  return {
    id: undefined as unknown as string,
    title: entry.title,
    status: checklistStatus(entry.state),
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

function adoptUniqueCreatedChecklistItem(
  baseline: DidaChecklistItem[],
  reread: DidaChecklistItem[],
  entry: ProjectionLedgerEntry,
): string {
  const baselineById = strictChecklistMap(baseline, "写前基线");
  const rereadById = strictChecklistMap(reread, "写后复读");
  for (const [id, item] of baselineById) {
    const current = rereadById.get(id);
    if (!current || stableHash(current) !== stableHash(item)) {
      throw new Error("创建检查项期间父任务既有 items 发生竞争，已冻结同步");
    }
  }
  const preservedInOrder = reread.filter((item) => baselineById.has(item.id));
  if (stableHash(preservedInOrder) !== stableHash(baseline)) {
    throw new Error("创建检查项期间父任务既有 items 顺序发生竞争，已冻结同步");
  }
  const added = [...rereadById.entries()].filter(([id]) => !baselineById.has(id));
  const matching = added.filter(([, item]) =>
    item.title === entry.title && item.status === checklistStatus(entry.state));
  if (added.length !== 1 || matching.length !== 1) {
    throw new Error("写后无法唯一证明新建检查项身份，已冻结同步");
  }
  return matching[0]![0];
}

function assertOnlyOwnedChecklistItemDeleted(
  baseline: DidaChecklistItem[],
  reread: DidaChecklistItem[],
  ownedId: string,
): void {
  const before = strictChecklistMap(baseline, "删除前基线");
  const after = strictChecklistMap(reread, "删除后复读");
  if (!before.has(ownedId) || after.has(ownedId)) throw new Error("owned 检查项删除结果无法证明");
  before.delete(ownedId);
  if (before.size !== after.size) throw new Error("删除 owned 检查项时其他 items 数量发生变化");
  for (const [id, item] of before) {
    const current = after.get(id);
    if (!current || stableHash(current) !== stableHash(item)) {
      throw new Error("删除 owned 检查项时其他 items 被修改");
    }
  }
  if (stableHash(reread) !== stableHash(baseline.filter((item) => item.id !== ownedId))) {
    throw new Error("删除 owned 检查项时其他 items 顺序被修改");
  }
}

function assertOnlyOwnedChecklistItemChanged(
  baseline: DidaChecklistItem[],
  reread: DidaChecklistItem[],
  ownedId: string,
  expectedOwned: DidaChecklistItem,
  beforeOwned: DidaChecklistItem,
): void {
  const actualOwned = reread.find((candidate) => candidate.id === ownedId);
  if (!actualOwned) throw new Error("更新 owned 检查项后无法精确复读");
  const expectedOwnedForCompare = { ...expectedOwned };
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
  const expected = baseline.map((item) => item.id === ownedId
    // status 完成／重开时 completedTime 由服务端合法生成或移除。
    ? expectedOwnedForCompare
    : item);
  if (stableHash(reread) !== stableHash(expected)) {
    throw new Error("更新 owned 检查项时其他 items 字段或顺序被修改");
  }
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
  "mutationBaselineItemHashes" | "mutationOwnedInvariantHash" |
  "mutationBaselineOwnedStatus" | "mutationBaselineOwnedCompletedTimeHash"> {
  const ids = strictChecklistIds(items, "投影写入基线");
  const owned = items.find((item) => item.id === ownedId);
  if (!owned) throw new Error("同步写入基线缺少目标检查项");
  return {
    mutationKind,
    mutationBaselineItemIds: ids,
    mutationBaselineItemsHash: stableHash(items),
    mutationBaselineItemHashes: Object.fromEntries(items.map((item) => [item.id, stableHash(item)])),
    mutationOwnedInvariantHash: stableHash(checklistOwnedInvariant(owned)),
    mutationBaselineOwnedStatus: owned.status,
    mutationBaselineOwnedCompletedTimeHash: stableHash(owned.completedTime),
  };
}

function checklistOwnedInvariant(item: DidaChecklistItem): Record<string, unknown> {
  const copy = { ...item } as Record<string, unknown>;
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
): string {
  if (!baselineIds) throw new Error("冻结的新建检查项缺少可证明的写前 items 基线，禁止自动领养或重发");
  if (new Set(baselineIds).size !== baselineIds.length) throw new Error("新建检查项写前 ID 基线损坏");
  const current = strictChecklistMap(reread, "冻结复读");
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
  const matches = added.filter(([, item]) =>
    item.title === entry.title && item.status === checklistStatus(entry.state));
  if (added.length !== 1 || matches.length !== 1) {
    throw new Error("冻结复读无法唯一证明新建检查项身份，保持冻结");
  }
  return matches[0]![0];
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
