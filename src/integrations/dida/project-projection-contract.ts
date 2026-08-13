import type { DidaTask } from "../../domain/entities";
import {
  appendManagedPlanAction,
  patchManagedPlanAction,
  type DidaProjectionTarget,
} from "../../domain/dida-project-projection";
import { stableHash } from "../../domain/stable";
import {
  DidaProjectProjectionService,
  type ProjectionCatalogPort,
  type ProjectionDeleteReceipt,
  type ProjectionMarkdownPort,
  type ProjectionMarkdownRevision,
  type ProjectionPersistentState,
  type ProjectionRemoteIdentity,
  type ProjectionStatePort,
  type ProjectionTaskPipeline,
  type ProjectionWriteReceipt,
} from "../../services/dida-project-projection";
import { taskCreatePayload, taskUpdatePayload } from "./adapters";
import type { DidaProjectProjectionContractContext } from "./write-contract";
import { DidaHttpError } from "./http-contract";
import { normalizeTask } from "./normalization";

/**
 * 真实合同中的窄探针：复用正式投影编排器，仅把底层队列替换为受合同预算、
 * 唯一测试清单和可持久清理计划约束的直连管线。它不会读取或改写用户项目文件。
 */
export async function runDidaProjectProjectionContractProbe(
  context: DidaProjectProjectionContractContext,
): Promise<void> {
  const projectId = crypto.randomUUID();
  const stageId = crypto.randomUUID();
  const actionId = crypto.randomUUID();
  const schedulePoint = futurePoint(2);
  const target: DidaProjectionTarget = {
    targetProjectId: context.project.id,
    targetColumnId: context.column.id,
  };
  const projectPath = `.helix-contract/${projectId}.md`;
  const stagePath = `.helix-contract/${stageId}.md`;
  const markdown = new MemoryMarkdownPort({
    [projectPath]: projectMarkdown(projectId, context.marker),
    [stagePath]: appendManagedPlanAction(stageMarkdown(stageId, projectId), {
      uuid: actionId,
      title: `${context.marker} 投影行动`,
      state: "active",
      content: "Helix 项目投影合同备注",
      startDate: schedulePoint,
      dueDate: schedulePoint,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      priority: 3,
      tags: ["helix-contract"],
    }),
  });
  const state = new MemoryProjectionState();
  const pipeline = new ContractProjectionPipeline(context);
  const catalog: ProjectionCatalogPort = {
    read: async (projectIdToRead) => {
      if (projectIdToRead !== context.project.id) throw new Error("项目投影合同目标清单发生变化");
      return {
        projects: [{ ...context.project, viewMode: "kanban" }],
        columns: [{ ...context.column }],
        readiness: {
          writable: true,
          queueEmpty: true,
          authorizationCurrent: true,
          taskParentingVerified: true,
          itemsRoundTripVerified: false,
          itemIdStableVerified: false,
          boardPlacementVerified: true,
          boardFresh: true,
          taskReopenVerified: true,
          unknownOutcomes: 0,
        },
      };
    },
  };
  const projection = new DidaProjectProjectionService(markdown, pipeline, state, catalog);
  const input = {
    projectId,
    projectPath,
    projectTitle: `${context.marker} 投影项目`,
    projectStatus: "active" as const,
    stages: [{ path: stagePath, stageId }],
  };
  const preview = await projection.previewActivation(target, { projectCount: 1, actionCount: 1 });
  if (preview.blockers.length > 0) throw new Error("项目投影合同预览存在阻塞");
  await projection.activate(preview, preview.previewHash);

  const created = await projection.synchronizeProject(input);
  if (created.createdParents !== 1 || created.createdActions !== 1 || created.frozen.length > 0) {
    throw new Error("项目投影合同未唯一创建父任务与行动子任务");
  }
  let current = await projection.readProject(input);
  const parentId = current.project.parentTaskId;
  const action = current.stages[0]?.managed[0];
  if (!parentId || !action?.remoteId) throw new Error("项目投影合同未回填稳定远端身份");
  await assertParentAndChild(context, parentId, action.remoteId, target, projectId, actionId);

  const editedStage = await markdown.read(stagePath);
  if (!editedStage) throw new Error("项目投影合同阶段文件丢失");
  await markdown.compareAndWrite(editedStage, patchManagedPlanAction(editedStage.content, {
    uuid: actionId,
    title: `${context.marker} 投影行动已编辑`,
    state: "completed",
    content: "Helix 项目投影合同备注已编辑",
    priority: 5,
    tags: ["helix-contract", "edited"],
  }));
  const completed = await projection.synchronizeProject(input);
  if (completed.updatedActions !== 1 || completed.completedActions !== 1 || completed.frozen.length > 0) {
    throw new Error("项目投影合同未完成行动编辑与完成");
  }
  current = await projection.readProject(input);
  const completedRemoteId = current.stages[0]?.managed[0]?.remoteId;
  const completedRemote = completedRemoteId
    ? await pipeline.rereadTask(target.targetProjectId, completedRemoteId)
    : null;
  if (!completedRemote || completedRemote.status !== 2 || completedRemote.priority !== 5 ||
    completedRemote.desc !== "Helix 项目投影合同备注已编辑") {
    throw new Error("项目投影合同完成后的远端属性复读不一致");
  }

  const completedStage = await markdown.read(stagePath);
  if (!completedStage) throw new Error("项目投影合同阶段文件丢失");
  await markdown.compareAndWrite(completedStage, patchManagedPlanAction(completedStage.content, {
    uuid: actionId,
    state: "active",
  }));
  const reopened = await projection.synchronizeProject(input);
  if (reopened.completedActions !== 0 || reopened.frozen.length > 0) {
    throw new Error("项目投影合同重开阶段出现冻结");
  }
  const reopenedRemote = await pipeline.rereadTask(target.targetProjectId, action.remoteId);
  if (!reopenedRemote || reopenedRemote.status === 2) throw new Error("项目投影合同未能重开真实子任务");

  const reopenedStage = await markdown.read(stagePath);
  if (!reopenedStage) throw new Error("项目投影合同阶段文件丢失");
  const withoutAction = reopenedStage.content.split(/\r?\n/u)
    .filter((line) => !line.includes(`uuid=${encodeURIComponent(actionId)}`))
    .join(reopenedStage.content.includes("\r\n") ? "\r\n" : "\n");
  await markdown.compareAndWrite(reopenedStage, withoutAction);
  const removed = await projection.synchronizeProject(input);
  if (removed.deletedActions !== 1 || removed.frozen.length > 0) {
    throw new Error("项目投影合同未唯一删除行动子任务");
  }
  await pipeline.deleteParentTask(parentId, target, projectId);
}

class MemoryMarkdownPort implements ProjectionMarkdownPort {
  private readonly files = new Map<string, string>();
  constructor(initial: Record<string, string>) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
  }
  async read(path: string): Promise<ProjectionMarkdownRevision | null> {
    const content = this.files.get(path);
    return content === undefined ? null : { path, content, hash: stableHash(content) };
  }
  async compareAndWrite(
    revision: ProjectionMarkdownRevision,
    content: string,
  ): Promise<ProjectionMarkdownRevision> {
    const current = this.files.get(revision.path);
    if (current === undefined || stableHash(current) !== revision.hash) {
      throw new Error("项目投影合同 Markdown CAS 竞争");
    }
    this.files.set(revision.path, content);
    return { path: revision.path, content, hash: stableHash(content) };
  }
}

class MemoryProjectionState implements ProjectionStatePort {
  private value: ProjectionPersistentState = { enabled: false, ledger: [], parentCheckpoints: [] };
  async read(): Promise<ProjectionPersistentState> { return structuredClone(this.value); }
  async write(expected: ProjectionPersistentState, next: ProjectionPersistentState): Promise<void> {
    if (stableHash(expected) !== stableHash(this.value)) throw new Error("项目投影合同状态 CAS 竞争");
    this.value = structuredClone(next);
  }
}

class ContractProjectionPipeline implements ProjectionTaskPipeline {
  constructor(private readonly context: DidaProjectProjectionContractContext) {}

  async createTask(task: DidaTask, _clientIdentity: string): Promise<ProjectionWriteReceipt> {
    const operationId = `contract-projection-create-${crypto.randomUUID()}`;
    let created: DidaTask;
    try {
      created = normalizeTask(await this.context.api.createTask(taskCreatePayload(task, {
        taskCrudVerified: true,
        taskParentingVerified: true,
        boardPlacementVerified: true,
      })));
    } catch (error) {
      if (isUnknown(error)) await this.context.markUntrackedCreate();
      throw error;
    }
    try {
      await this.context.trackTask(created);
    } catch (error) {
      await this.context.markUntrackedCreate();
      throw error;
    }
    const reread = normalizeTask(await this.context.api.getTask(created.projectId, created.id));
    return { operationId, outcome: "verified", task: reread };
  }

  async recoverCreate(_clientIdentity: string, _projectId: string): Promise<ProjectionWriteReceipt | null> {
    return null;
  }

  async updateTask(
    task: DidaTask,
    writeFields: string[],
    operationId = `contract-projection-update-${crypto.randomUUID()}`,
  ): Promise<ProjectionWriteReceipt> {
    await this.context.api.updateTask(task.id, taskUpdatePayload(task, {
      taskCrudVerified: true,
      taskParentingVerified: true,
      boardPlacementVerified: true,
      taskReopenVerified: true,
    }, writeFields));
    return {
      operationId,
      outcome: "verified",
      task: normalizeTask(await this.context.api.getTask(task.projectId, task.id)),
    };
  }

  async stageTaskConflict(
    _local: DidaTask,
    _remote: DidaTask,
    _base: DidaTask,
    operationId: string,
    _writeFields: string[],
  ): Promise<ProjectionWriteReceipt> {
    return { operationId, outcome: "conflict", message: "项目投影合同不允许远端竞争" };
  }

  async stageItemsConflict(
    _local: DidaTask,
    _remote: DidaTask,
    _base: DidaTask,
    operationId: string,
  ): Promise<ProjectionWriteReceipt> {
    return { operationId, outcome: "capability", message: "项目投影合同不使用检查项" };
  }

  async completeTask(task: DidaTask): Promise<ProjectionWriteReceipt> {
    const operationId = `contract-projection-complete-${crypto.randomUUID()}`;
    await this.context.api.completeTask(task.projectId, task.id);
    return {
      operationId,
      outcome: "verified",
      task: normalizeTask(await this.context.api.getTask(task.projectId, task.id)),
    };
  }

  async reopenTask(task: DidaTask): Promise<ProjectionWriteReceipt> {
    return this.updateTask({ ...task, status: 0, completedTime: null }, ["status"],
      `contract-projection-reopen-${crypto.randomUUID()}`);
  }

  async deleteTask(expected: ProjectionRemoteIdentity): Promise<ProjectionDeleteReceipt> {
    const operationId = `contract-projection-delete-${crypto.randomUUID()}`;
    const before = await this.rereadTask(expected.targetProjectId, expected.taskId);
    if (!before || before.parentId !== expected.parentTaskId || before.columnId !== expected.targetColumnId ||
      before.content !== expected.marker) {
      return { operationId, outcome: "preflight-changed", message: "项目投影合同删除前身份不一致" };
    }
    let unknown: unknown;
    try {
      await this.context.api.deleteTask(expected.targetProjectId, expected.taskId);
    } catch (error) {
      if (!isUnknown(error)) throw error;
      unknown = error;
    }
    // 滴答的精确详情端点在删除后可能短暂返回旧对象；生产删除同样以清单开放任务
    // 集合为权威不存在性证明，避免把已成功删除误判为失败后要求人工处理。
    if (!await this.absentFromOpenCollection(expected.targetProjectId, expected.taskId)) {
      return { operationId, outcome: unknown ? "unknown" : "retryable", message: "项目投影合同删除后任务仍存在" };
    }
    await this.context.untrackTask(expected.taskId);
    return { operationId, outcome: "verified-absent" };
  }

  async rereadTask(projectId: string, taskId: string): Promise<DidaTask | null> {
    try {
      return normalizeTask(await this.context.api.getTask(projectId, taskId));
    } catch (error) {
      if (error instanceof DidaHttpError && error.statusCode === 404) return null;
      throw error;
    }
  }

  async deleteParentTask(
    taskId: string,
    target: DidaProjectionTarget,
    projectId: string,
  ): Promise<void> {
    const before = await this.rereadTask(target.targetProjectId, taskId);
    if (!before || before.parentId || before.columnId !== target.targetColumnId ||
      before.content !== `helix-project-projection:${projectId}`) {
      throw new Error("项目投影合同父任务清理前身份不一致");
    }
    let unknown: unknown;
    try {
      await this.context.api.deleteTask(target.targetProjectId, taskId);
    } catch (error) {
      if (!isUnknown(error)) throw error;
      unknown = error;
    }
    if (!await this.absentFromOpenCollection(target.targetProjectId, taskId)) {
      throw unknown ?? new Error("项目投影合同父任务删除后仍存在");
    }
    await this.context.untrackTask(taskId);
  }

  private async absentFromOpenCollection(projectId: string, taskId: string): Promise<boolean> {
    const data = await this.context.api.getProjectData(projectId);
    if (!Array.isArray(data.tasks)) throw new Error("项目投影合同任务集合返回值无效");
    return !data.tasks.map(normalizeTask).some((candidate) => candidate.id === taskId);
  }
}

async function assertParentAndChild(
  context: DidaProjectProjectionContractContext,
  parentId: string,
  childId: string,
  target: DidaProjectionTarget,
  projectId: string,
  actionId: string,
): Promise<void> {
  const parent = normalizeTask(await context.api.getTask(target.targetProjectId, parentId));
  const child = normalizeTask(await context.api.getTask(target.targetProjectId, childId));
  if (parent.projectId !== target.targetProjectId || parent.columnId !== target.targetColumnId ||
    parent.content !== `helix-project-projection:${projectId}` || parent.status === 2) {
    throw new Error("项目投影合同父任务身份不一致");
  }
  if (child.projectId !== target.targetProjectId || child.columnId !== target.targetColumnId ||
    child.parentId !== parentId || child.content !== `helix-projection:${actionId}` || child.status === 2) {
    throw new Error("项目投影合同真实子任务身份不一致");
  }
}

function projectMarkdown(projectId: string, marker: string): string {
  return `---\nhelix-kind: helix-project\nhelix-id: ${projectId}\nhelix-status: active\n---\n\n# ${marker} 投影项目\n`;
}

function stageMarkdown(stageId: string, projectId: string): string {
  return `---\nhelix-kind: helix-stage\nhelix-id: ${stageId}\nhelix-project-id: ${projectId}\nhelix-status: active\n---\n\n# 阶段 1\n\n# 计划行动\n`;
}

function futurePoint(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function isUnknown(error: unknown): boolean {
  return error instanceof DidaHttpError && error.remoteOutcomeUnknown === true;
}
