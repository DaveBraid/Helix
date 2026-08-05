import type { DidaColumn, DidaProject, DidaTask } from "../domain/entities";
import { stableHash } from "../domain/stable";
import {
  assertProjectionActivation,
  buildProjectionActivationPreview,
  buildProjectionLedger,
  parseManagedPlanActions,
  patchManagedPlanAction,
  patchProjectParentTaskId,
  planProjectionChanges,
  projectionMarker,
  readProjectProjectionIdentity,
  verifyProjectedTask,
  type DidaProjectionTarget,
  type ProjectionActivationPreview,
  type ProjectionFreezeReason,
  type ProjectionLedgerEntry,
  type ProjectionReadiness,
} from "../domain/dida-project-projection";

export interface ProjectionMarkdownRevision {
  path: string;
  hash: string;
  content: string;
}

export interface ProjectionMarkdownPort {
  read(path: string): Promise<ProjectionMarkdownRevision | null>;
  compareAndWrite(revision: ProjectionMarkdownRevision, content: string): Promise<ProjectionMarkdownRevision>;
}

/** Existing Helix task pipeline adapter. Implementations must enqueue through the normal queue/contract engine. */
export interface ProjectionTaskPipeline {
  createTask(task: DidaTask, clientIdentity: string): Promise<ProjectionWriteReceipt>;
  recoverCreate(clientIdentity: string, projectId: string): Promise<ProjectionWriteReceipt | null>;
  updateTask(task: DidaTask, writeFields: string[]): Promise<ProjectionWriteReceipt>;
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
  enqueueProjectionUpdate(task: DidaTask, writeFields: string[]): Promise<ProjectionWriteReceipt>;
  enqueueProjectionComplete(task: DidaTask): Promise<ProjectionWriteReceipt>;
  enqueueProjectionReopen(task: DidaTask): Promise<ProjectionWriteReceipt>;
  enqueueProjectionDelete(expected: ProjectionRemoteIdentity): Promise<ProjectionDeleteReceipt>;
  verifyRemoteTask(projectId: string, taskId: string): Promise<DidaTask>;
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

  async updateTask(task: DidaTask, writeFields: string[]): Promise<ProjectionWriteReceipt> {
    return this.operations.enqueueProjectionUpdate(task, writeFields);
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

export type ProjectionWriteOutcome =
  | "verified"
  | "unknown"
  | "conflict"
  | "retryable"
  | "authorization"
  | "capability";

export type ProjectionWriteReceipt =
  | { operationId: string; outcome: "verified"; task: DidaTask; conflictId?: string }
  | { operationId: string; outcome: Exclude<ProjectionWriteOutcome, "verified">; message: string; conflictId?: string };

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
}

export interface ProjectionStatePort {
  read(): Promise<ProjectionPersistentState>;
  write(expected: ProjectionPersistentState, next: ProjectionPersistentState): Promise<void>;
}

export interface ProjectionCatalogPort {
  projects(): Promise<DidaProject[]>;
  columns(projectId: string): Promise<DidaColumn[]>;
  readiness(projectId: string): Promise<ProjectionReadiness>;
}

export interface ProjectionProjectInput {
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

export class DidaProjectProjectionService {
  constructor(
    private readonly markdown: ProjectionMarkdownPort,
    private readonly pipeline: ProjectionTaskPipeline,
    private readonly state: ProjectionStatePort,
    private readonly catalog: ProjectionCatalogPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async previewActivation(target: DidaProjectionTarget, counts: {
    projectCount: number;
    actionCount: number;
  }): Promise<ProjectionActivationPreview> {
    const [projects, columns, readiness] = await Promise.all([
      this.catalog.projects(),
      this.catalog.columns(target.targetProjectId),
      this.catalog.readiness(target.targetProjectId),
    ]);
    return buildProjectionActivationPreview({ target, projects, columns, readiness, ...counts });
  }

  async activate(preview: ProjectionActivationPreview, confirmedHash: string): Promise<void> {
    const fresh = await this.previewActivation(preview.target, {
      projectCount: preview.projectCount,
      actionCount: preview.actionCount,
    });
    assertProjectionActivation(fresh, confirmedHash);
    const current = await this.state.read();
    if (current.ledger.some((entry) => entry.frozen) || current.parentCheckpoints.some((item) => item.frozen)) {
      throw new Error("投影仍有冻结对象，禁止激活");
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
      throw new Error("Helix→滴答投影尚未显式预览并激活");
    }
    const readiness = await this.catalog.readiness(initialState.target.targetProjectId);
    const currentPreview = await this.previewActivation(initialState.target, {
      projectCount: 1,
      actionCount: await this.countActions(input.stages),
    });
    if (readiness.queueEmpty === false || currentPreview.blockers.length > 0) {
      throw new Error(`投影写入条件不满足：${currentPreview.blockers.join("；")}`);
    }
    const projectRevision = await this.requireRevision(input.projectPath);
    const projectIdentity = readProjectProjectionIdentity(projectRevision.content);
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
        throw new Error("Project Markdown 与临时父任务回填检查点竞争，已拒绝投影");
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
    const currentEntries: ProjectionLedgerEntry[] = [];
    const stageRevisions = new Map<string, ProjectionMarkdownRevision>();
    for (const stage of input.stages) {
      const revision = await this.requireRevision(stage.path);
      stageRevisions.set(stage.stageId, revision);
      const parsed = parseManagedPlanActions(revision.content);
      currentEntries.push(...buildProjectionLedger({
        projectId: projectIdentity.projectId,
        stageId: stage.stageId,
        parentTaskId,
        target: initialState.target,
        actions: parsed.actions,
      }));
    }
    const previous = freshState.ledger.filter((entry) => entry.projectId === projectIdentity.projectId);
    const presentStageIds = new Set(input.stages.map((stage) => stage.stageId));
    const managedPrevious = previous.filter((entry) => presentStageIds.has(entry.stageId));
    const retainedMissingStages = previous.filter((entry) => !presentStageIds.has(entry.stageId));
    const previousByUuid = new Map(previous.map((entry) => [entry.uuid, entry]));
    let working = currentEntries.map((entry) => {
      const old = previousByUuid.get(entry.uuid);
      return old?.frozen
        ? {
            ...entry,
            remoteId: old.remoteId ?? entry.remoteId,
            tombstone: old.tombstone,
            frozen: old.frozen,
            operationId: old.operationId,
            conflictId: old.conflictId,
          }
        : entry;
    });
    working.push(...retainedMissingStages);
    working.push(...previous.filter((entry) => entry.frozen && !working.some((item) => item.uuid === entry.uuid)));
    const managedWorking = working.filter((entry) => presentStageIds.has(entry.stageId));
    for (const intent of planProjectionChanges(managedPrevious, managedWorking, {
      taskReopenVerified: readiness.taskReopenVerified,
    })) {
      const entry = intent.entry;
      if (working.find((item) => item.uuid === entry.uuid)?.frozen) continue;
      const stageRevision = stageRevisions.get(entry.stageId);
      if (!stageRevision && intent.kind !== "delete-action") throw new Error(`找不到行动所属阶段：${entry.stageId}`);
      if (intent.kind === "freeze-action") {
        working = freezeEntry(working, entry, intent.reason, summary, "投影身份发生竞争，已持久冻结");
        continue;
      }
      if (intent.kind === "recover-action") {
        const remote = await this.pipeline.rereadTask(entry.targetProjectId, entry.remoteId!);
        try {
          if (!remote) throw new Error("Markdown 已有远端 ID，但精确复读不存在");
          verifyProjectedTask(remote, entry, projectionMarker(entry.uuid));
        } catch (error) {
          working = freezeEntry(working, entry, "identity-mismatch", summary, message(error));
        }
        continue;
      }
      if (intent.kind === "reconcile-delete") {
        const remote = await this.pipeline.rereadTask(entry.targetProjectId, entry.remoteId!);
        if (!remote) {
          working = working.filter((item) => item.uuid !== entry.uuid);
        } else {
          working = freezeEntry(working, entry, "unknown-outcome", summary, "删除 tombstone 的远端结果无法证明；禁止重发删除");
        }
        continue;
      }
      if (intent.kind === "create-action") {
        const parent = await this.pipeline.rereadTask(entry.targetProjectId, entry.parentTaskId);
        if (!parent || !this.sameParentIdentity(parent, projectIdentity.projectId, entry.parentTaskId, initialState.target) ||
          parent.title !== input.projectTitle || parent.status !== (input.projectStatus === "completed" ? 2 : 0)) {
          working = freezeEntry(working, entry, "identity-mismatch", summary, "子任务创建前父任务精确复读不一致");
          continue;
        }
        const clientIdentity = actionCreateClientIdentity(entry);
        const durable = await this.pipeline.recoverCreate(clientIdentity, entry.targetProjectId);
        const created = durable ?? await this.pipeline.createTask(this.taskFromEntry(entry), clientIdentity);
        if (created.outcome !== "verified") {
          working = freezeEntry(working, entry, resultReason(created), summary, created.message, created);
          continue;
        }
        const verifiedEntry = {
          ...entry,
          remoteId: created.task.id,
          operationId: created.operationId,
          conflictId: created.conflictId,
        };
        try {
          verifyProjectedTask(created.task, verifiedEntry, projectionMarker(entry.uuid), { state: false });
        } catch (error) {
          working = freezeEntry(working, verifiedEntry, "identity-mismatch", summary, message(error));
          continue;
        }
        try {
          const next = patchManagedPlanAction(stageRevision!.content, { uuid: entry.uuid, remoteId: created.task.id });
          const written = await this.markdown.compareAndWrite(stageRevision!, next);
          stageRevisions.set(entry.stageId, written);
          working = replaceEntry(working, verifiedEntry);
          if (!durable) summary.createdActions += 1;
          if (verifiedEntry.state === "completed") {
            const completed = await this.pipeline.completeTask({
              ...created.task,
              status: 2,
              completedTime: this.now(),
            });
            if (completed.outcome !== "verified") {
              working = freezeEntry(working, verifiedEntry, resultReason(completed), summary, completed.message, completed);
            } else {
              try {
                verifyProjectedTask(completed.task, verifiedEntry, projectionMarker(entry.uuid));
                summary.completedActions += 1;
              } catch (error) {
                working = freezeEntry(working, verifiedEntry, "identity-mismatch", summary, message(error));
              }
            }
          }
        } catch (error) {
          working = freezeEntry(working, verifiedEntry, "markdown-race", summary, message(error));
        }
        continue;
      }
      if (!entry.remoteId) {
        working = freezeEntry(working, entry, "identity-mismatch", summary, "既有投影行动缺少远端 ID");
        continue;
      }
      if (intent.kind === "update-action") {
        let before: DidaTask;
        try {
          before = await this.requireRemote(entry);
        } catch (error) {
          working = freezeEntry(working, entry, "identity-mismatch", summary, message(error));
          continue;
        }
        const result = await this.pipeline.updateTask({
          ...before,
          title: entry.title,
          status: entry.state === "completed" ? before.status : 0,
          completedTime: entry.state === "completed" ? before.completedTime : null,
        }, intent.writeFields);
        if (result.outcome !== "verified") working = freezeEntry(working, entry, resultReason(result), summary, result.message, result);
        else {
          try {
            verifyProjectedTask(result.task, entry, projectionMarker(entry.uuid), {
              state: entry.state !== "completed",
            });
            summary.updatedActions += 1;
          } catch (error) {
            working = freezeEntry(working, entry, "identity-mismatch", summary, message(error));
          }
        }
      } else if (intent.kind === "complete-action" || intent.kind === "reopen-action") {
        let before: DidaTask;
        try {
          before = await this.requireRemote(entry);
        } catch (error) {
          working = freezeEntry(working, entry, "identity-mismatch", summary, message(error));
          continue;
        }
        const result = intent.kind === "complete-action"
          ? await this.pipeline.completeTask({ ...before, status: 2, completedTime: this.now() })
          : await this.pipeline.reopenTask({ ...before, status: 0, completedTime: null });
        if (result.outcome !== "verified") working = freezeEntry(working, entry, resultReason(result), summary, result.message, result);
        else {
          try {
            let verified = result.task;
            let finalReceipt = result;
            if (intent.kind === "reopen-action") {
              verifyProjectedTask(verified, entry, projectionMarker(entry.uuid), { title: false });
              if (verified.title !== entry.title) {
                const titleReceipt = await this.pipeline.updateTask({ ...verified, title: entry.title }, ["title"]);
                if (titleReceipt.outcome !== "verified") {
                  working = freezeEntry(
                    working,
                    entry,
                    resultReason(titleReceipt),
                    summary,
                    titleReceipt.message,
                    titleReceipt,
                  );
                  continue;
                }
                verified = titleReceipt.task;
                finalReceipt = titleReceipt;
                summary.updatedActions += 1;
              }
            }
            verifyProjectedTask(verified, entry, projectionMarker(entry.uuid));
            working = replaceEntry(working, {
              ...entry,
              operationId: finalReceipt.operationId,
              conflictId: finalReceipt.conflictId,
            });
            if (intent.kind === "complete-action") summary.completedActions += 1;
          } catch (error) {
            working = freezeEntry(working, entry, "identity-mismatch", summary, message(error));
          }
        }
      } else {
        working = working.some((item) => item.uuid === entry.uuid)
          ? replaceEntry(working, { ...entry, tombstone: true })
          : [...working, { ...entry, tombstone: true }];
        await this.persistProjectLedger(projectIdentity.projectId, working);
        const deletion = await this.pipeline.deleteTask(remoteIdentity(entry));
        if (deletion.outcome !== "verified-absent") {
          const frozen = {
            ...entry,
            tombstone: true,
            frozen: resultReason(deletion),
            operationId: deletion.operationId,
            conflictId: deletion.conflictId,
          };
          working = replaceEntry(working, frozen);
          summary.frozen.push({ uuid: entry.uuid, reason: frozen.frozen!, message: deletion.message });
        } else {
          working = working.filter((item) => item.uuid !== entry.uuid);
          summary.deletedActions += 1;
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
      summary.frozen.push({ uuid: `project:${projectId}`, reason: checkpoint.frozen, message: "父任务投影已冻结" });
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
      }, fields);
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

  private taskFromEntry(entry: ProjectionLedgerEntry): DidaTask {
    return {
      id: `local-helix-action-${entry.uuid}`,
      projectId: entry.targetProjectId,
      columnId: entry.targetColumnId,
      parentId: entry.parentTaskId,
      title: entry.title,
      content: projectionMarker(entry.uuid),
      status: 0,
    };
  }

  private async requireRemote(entry: ProjectionLedgerEntry): Promise<DidaTask> {
    const remote = await this.pipeline.rereadTask(entry.targetProjectId, entry.remoteId!);
    if (!remote) throw new Error("远端投影任务不存在，拒绝按标题重建或领养");
    verifyProjectedTask(remote, entry, projectionMarker(entry.uuid), { title: false, state: false });
    return remote;
  }

  private async requireRevision(path: string): Promise<ProjectionMarkdownRevision> {
    const revision = await this.markdown.read(path);
    if (!revision) throw new Error(`找不到投影 Markdown：${path}`);
    return revision;
  }

  private async countActions(stages: ProjectionProjectInput["stages"]): Promise<number> {
    let count = 0;
    for (const stage of stages) count += parseManagedPlanActions((await this.requireRevision(stage.path)).content).actions.length;
    return count;
  }
}

function remoteIdentity(entry: ProjectionLedgerEntry): ProjectionRemoteIdentity {
  return {
    taskId: entry.remoteId!,
    parentTaskId: entry.parentTaskId,
    targetProjectId: entry.targetProjectId,
    targetColumnId: entry.targetColumnId,
    marker: projectionMarker(entry.uuid),
  };
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
