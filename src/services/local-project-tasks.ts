import {
  adoptAllPlanActions,
  appendManagedPlanAction,
  assertProjectionStageIdentity,
  parseManagedPlanActions,
  patchManagedPlanAction,
  readProjectProjectionIdentity,
  reconcileLocalPlanActionCheckboxes,
  removeManagedPlanAction,
  reorderManagedPlanChildren,
  type ProjectionActionState,
} from "../domain/dida-project-projection";
import type { DidaTask } from "../domain/entities";
import type {
  ProjectWorkspaceCycleStatus,
  ProjectWorkspaceSnapshot,
} from "./project-workspace";
import type {
  ProjectionMarkdownPort,
  ProjectionMarkdownRevision,
} from "./dida-project-projection";

export const LOCAL_PROJECT_TASK_PREFIX = "helix-local-task:";
export const LOCAL_PROJECT_STAGE_TASK_PREFIX = "helix-local-stage:";

export interface LocalProjectTask {
  id: string;
  uuid: string;
  remoteId?: string;
  title: string;
  state: ProjectionActionState;
  content?: string;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  isAllDay?: boolean;
  priority: 0 | 1 | 3 | 5;
  tags: string[];
  parentUuid?: string;
  projectId: string;
  projectTitle: string;
  projectColor?: string;
  stageId: string;
  stageTitle: string;
  stageCode: string;
  notePath: string;
  revisionHash: string;
  childCount: number;
}

export interface LocalProjectTaskSnapshot {
  tasks: LocalProjectTask[];
  roots: LocalProjectTask[];
  issues: string[];
  byId: Map<string, LocalProjectTask>;
  byUuid: Map<string, LocalProjectTask>;
  stageParents: LocalProjectStageTaskParent[];
  byStageParentTaskId: Map<string, LocalProjectStageTaskParent>;
  byRemoteParentTaskId: Map<string, LocalProjectStageTaskParent>;
  destinations: Array<{
    projectId: string;
    projectTitle: string;
    projectColor?: string;
    stages: Array<{ stageId: string; stageTitle: string; stageCode: string; status: string }>;
  }>;
}

export interface LocalProjectStageTaskParent {
  /** 任务页稳定身份；远端父任务存在时直接复用其 ID。 */
  taskId: string;
  /** 只有项目投影已创建远端父任务时才存在。 */
  remoteTaskId?: string;
  projectId: string;
  projectTitle: string;
  projectColor?: string;
  stageId: string;
  stageTitle: string;
  stageCode: string;
  stageStatus: string;
  notePath: string;
}

export interface LocalProjectTaskDraft {
  title: string;
  state: ProjectionActionState;
  content: string;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  isAllDay: boolean;
  priority: 0 | 1 | 3 | 5;
  tags: string[];
  children: Array<{
    uuid?: string;
    title: string;
    state: ProjectionActionState;
    startDate?: string;
    dueDate?: string;
    timeZone?: string;
    priority?: 0 | 1 | 3 | 5;
  }>;
}

export function localProjectTaskId(uuid: string): string {
  return `${LOCAL_PROJECT_TASK_PREFIX}${uuid}`;
}

export function localProjectStageTaskId(stageId: string): string {
  return `${LOCAL_PROJECT_STAGE_TASK_PREFIX}${stageId}`;
}

export function isLocalProjectTaskId(id: string): boolean {
  return id.startsWith(LOCAL_PROJECT_TASK_PREFIX);
}

/**
 * 把 Stage Markdown 行动投影为任务页模型。Stage 父任务始终由本地权威
 * 状态生成；远端身份存在时复用远端任务和清单，尚未验证滴答写入时也
 * 能正确展示阶段状态与本地父子关系。
 */
export function localProjectTaskPresentationTasks(
  snapshot: LocalProjectTaskSnapshot,
  remoteTasks: readonly DidaTask[],
): DidaTask[] {
  const remoteById = new Map(remoteTasks.map((task) => [task.id, task]));
  const stageParentByStageId = new Map(
    snapshot.stageParents.map((parent) => [parent.stageId, parent]),
  );
  const stageParents = snapshot.stageParents.map((parent) => {
    const remote = parent.remoteTaskId ? remoteById.get(parent.remoteTaskId) : undefined;
    return {
      ...(remote ?? {
        id: parent.taskId,
        projectId: `helix-project:${parent.projectId}`,
        title: parent.stageTitle,
        content: "",
        desc: `${parent.projectTitle} · 阶段 ${parent.stageCode}`,
        priority: 0 as const,
        kind: "CHECKLIST" as const,
      }),
      status: parent.stageStatus === "completed" || parent.stageStatus === "terminated" ? 2 : 0,
    };
  });
  const localTasks = snapshot.tasks.map((task) => {
    const localParent = task.parentUuid ? snapshot.byUuid.get(task.parentUuid) : undefined;
    const stageParent = stageParentByStageId.get(task.stageId);
    const remoteStageParent = stageParent?.remoteTaskId
      ? remoteById.get(stageParent.remoteTaskId)
      : undefined;
    return {
      id: task.id,
      projectId: remoteStageParent?.projectId ?? `helix-project:${task.projectId}`,
      ...(localParent
        ? { parentId: localParent.id }
        : stageParent ? { parentId: stageParent.taskId } : {}),
      title: task.title,
      content: task.content ?? "",
      desc: `${task.projectTitle} · 阶段 ${task.stageCode} ${task.stageTitle}`,
      startDate: task.startDate ?? null,
      dueDate: task.dueDate ?? null,
      timeZone: task.timeZone,
      isAllDay: task.isAllDay ?? false,
      status: task.state === "completed" || task.state === "terminated" ? 2 : 0,
      priority: task.priority,
      tags: [...task.tags],
      kind: task.childCount > 0 ? "CHECKLIST" : "TASK",
      ...(task.childCount > 0 ? {
        items: snapshot.tasks
          .filter((candidate) => candidate.parentUuid === task.uuid)
          .map((child) => ({
            id: child.id,
            title: child.title,
            status: child.state === "completed" || child.state === "terminated" ? 2 : 0,
          })),
      } : {}),
    };
  });
  return [...stageParents, ...localTasks];
}

function isCompletedActionState(state: ProjectionActionState): boolean {
  return state === "completed";
}

/**
 * 父行动的完成状态只由直接子任务派生。由最深层向上反复收敛，保证
 * 任意深度任务树在同一次 Stage Markdown CAS 中得到一致状态。
 */
export function reconcileLocalPlanParentCompletion(markdown: string): string {
  let next = markdown;
  const actionCount = parseManagedPlanActions(markdown).actions.length;
  for (let pass = 0; pass <= actionCount; pass += 1) {
    const parsed = parseManagedPlanActions(next);
    const childrenByParent = new Map<string, typeof parsed.actions>();
    for (const action of parsed.actions) {
      if (!action.parentUuid) continue;
      const children = childrenByParent.get(action.parentUuid) ?? [];
      children.push(action);
      childrenByParent.set(action.parentUuid, children);
    }
    let changed = false;
    for (const parent of parsed.actions) {
      const children = childrenByParent.get(parent.uuid);
      if (!children?.length || parent.state === "terminated") continue;
      const allCompleted = children.every((child) => isCompletedActionState(child.state));
      const nextState = allCompleted
        ? "completed"
        : parent.state === "completed"
          ? children.some((child) => child.state !== "idea") ? "active" : "idea"
          : parent.state;
      if (nextState === parent.state) continue;
      next = patchManagedPlanAction(next, { uuid: parent.uuid, state: nextState });
      changed = true;
    }
    if (!changed) return next;
  }
  throw new Error("本地父子任务完成状态无法稳定收敛");
}

/** Stage 父任务只在存在根行动时派生完成；暂停和终止仍由用户显式控制。 */
export function derivedLocalProjectStageStatus(
  current: ProjectWorkspaceCycleStatus,
  roots: readonly Pick<LocalProjectTask, "state">[],
): ProjectWorkspaceCycleStatus | undefined {
  if (roots.length === 0 || current === "paused" || current === "terminated") return undefined;
  if (roots.every((task) => isCompletedActionState(task.state))) {
    return current === "completed" ? undefined : "completed";
  }
  if (current !== "completed") return undefined;
  return roots.some((task) => task.state !== "idea") ? "active" : "idea";
}

export class LocalProjectTaskService {
  constructor(private readonly markdown: ProjectionMarkdownPort) {}

  async snapshot(
    workspace: ProjectWorkspaceSnapshot,
    options: { adoptUnmanaged?: boolean } = {},
  ): Promise<LocalProjectTaskSnapshot> {
    const tasks: LocalProjectTask[] = [];
    const stageParents: LocalProjectStageTaskParent[] = [];
    const issues: string[] = [];
    const globalUuids = new Map<string, string>();
    for (const project of workspace.projects) {
      for (const stage of project.cycles) {
        try {
          let revision = await this.requireStage(stage.notePath, stage.id);
          if (options.adoptUnmanaged) {
            const adopted = reconcileLocalPlanParentCompletion(adoptAllPlanActions(
              reconcileLocalPlanActionCheckboxes(revision.content),
            ));
            if (adopted !== revision.content) {
              revision = await this.markdown.compareAndWrite(revision, adopted);
            }
          }
          const parsed = parseManagedPlanActions(revision.content);
          const parentTaskId = readProjectProjectionIdentity(revision.content).parentTaskId;
          if (parentTaskId || parsed.actions.some((action) => !action.parentUuid)) {
            stageParents.push({
              taskId: parentTaskId ?? localProjectStageTaskId(stage.id),
              ...(parentTaskId ? { remoteTaskId: parentTaskId } : {}),
              projectId: project.id,
              projectTitle: project.title,
              ...(project.color ? { projectColor: project.color } : {}),
              stageId: stage.id,
              stageTitle: stage.title,
              stageCode: stage.stageCode,
              stageStatus: stage.status,
              notePath: stage.notePath,
            });
          }
          for (const action of parsed.actions) {
            const owner = globalUuids.get(action.uuid);
            if (owner) throw new Error(`任务 UUID 与 ${owner} 重复：${action.uuid}`);
            globalUuids.set(action.uuid, stage.notePath);
            tasks.push({
              id: action.remoteId ?? localProjectTaskId(action.uuid),
              uuid: action.uuid,
              ...(action.remoteId ? { remoteId: action.remoteId } : {}),
              title: action.title,
              state: action.state,
              ...(action.content ? { content: action.content } : {}),
              ...(action.startDate ? { startDate: action.startDate } : {}),
              ...(action.dueDate ? { dueDate: action.dueDate } : {}),
              ...(action.timeZone ? { timeZone: action.timeZone } : {}),
              ...(action.isAllDay ? { isAllDay: true } : {}),
              priority: action.priority ?? 0,
              tags: [...(action.tags ?? [])],
              ...(action.parentUuid ? { parentUuid: action.parentUuid } : {}),
              projectId: project.id,
              projectTitle: project.title,
              ...(project.color ? { projectColor: project.color } : {}),
              stageId: stage.id,
              stageTitle: stage.title,
              stageCode: stage.stageCode,
              notePath: stage.notePath,
              revisionHash: revision.hash,
              childCount: 0,
            });
          }
        } catch (error) {
          issues.push(`${project.title}／${stage.title}：${messageOf(error)}`);
        }
      }
    }
    const byUuid = new Map(tasks.map((task) => [task.uuid, task]));
    for (const task of tasks) {
      if (!task.parentUuid) continue;
      const parent = byUuid.get(task.parentUuid);
      if (!parent || parent.stageId !== task.stageId) {
        issues.push(`${task.projectTitle}／${task.stageTitle}：子任务“${task.title}”的父任务失联`);
        continue;
      }
      parent.childCount += 1;
    }
    return {
      tasks,
      roots: tasks.filter((task) => !task.parentUuid),
      issues,
      byId: new Map(tasks.map((task) => [task.id, task])),
      byUuid,
      stageParents,
      byStageParentTaskId: new Map(stageParents.map((parent) => [parent.taskId, parent])),
      byRemoteParentTaskId: new Map(stageParents.flatMap((parent) =>
        parent.remoteTaskId ? [[parent.remoteTaskId, parent] as const] : [])),
      destinations: workspace.projects.map((project) => ({
        projectId: project.id,
        projectTitle: project.title,
        ...(project.color ? { projectColor: project.color } : {}),
        stages: project.cycles.map((stage) => ({
          stageId: stage.id,
          stageTitle: stage.title,
          stageCode: stage.stageCode,
          status: stage.status,
        })),
      })),
    };
  }

  async createTask(workspace: ProjectWorkspaceSnapshot, input: {
    projectId: string;
    stageId: string;
    title: string;
    parentUuid?: string;
    state?: ProjectionActionState;
  }): Promise<string> {
    const stage = requireStage(workspace, input.projectId, input.stageId);
    const revision = await this.requireStage(stage.notePath, stage.id);
    const uuid = crypto.randomUUID();
    const content = reconcileLocalPlanParentCompletion(appendManagedPlanAction(revision.content, {
      uuid,
      title: input.title.trim(),
      state: input.state,
      parentUuid: input.parentUuid,
    }));
    await this.markdown.compareAndWrite(revision, content);
    return localProjectTaskId(uuid);
  }

  async updateTask(workspace: ProjectWorkspaceSnapshot, input: {
    projectId: string;
    stageId: string;
    uuid: string;
    expectedHash: string;
    title?: string;
    state?: ProjectionActionState;
  }): Promise<void> {
    const stage = requireStage(workspace, input.projectId, input.stageId);
    const revision = await this.requireExpectedStage(stage.notePath, stage.id, input.expectedHash);
    const content = reconcileLocalPlanParentCompletion(patchManagedPlanAction(revision.content, {
      uuid: input.uuid,
      title: input.title?.trim(),
      state: input.state,
    }));
    await this.markdown.compareAndWrite(revision, content);
  }

  async deleteTask(workspace: ProjectWorkspaceSnapshot, input: {
    projectId: string;
    stageId: string;
    uuid: string;
    expectedHash: string;
  }): Promise<void> {
    const stage = requireStage(workspace, input.projectId, input.stageId);
    const revision = await this.requireExpectedStage(stage.notePath, stage.id, input.expectedHash);
    await this.markdown.compareAndWrite(revision, reconcileLocalPlanParentCompletion(
      removeManagedPlanAction(revision.content, input.uuid),
    ));
  }

  async saveTask(workspace: ProjectWorkspaceSnapshot, input: {
    projectId: string;
    stageId: string;
    uuid: string;
    expectedHash: string;
    draft: LocalProjectTaskDraft;
  }): Promise<void> {
    const stage = requireStage(workspace, input.projectId, input.stageId);
    const revision = await this.requireExpectedStage(stage.notePath, stage.id, input.expectedHash);
    const parsed = parseManagedPlanActions(revision.content);
    const root = parsed.actions.find((action) => action.uuid === input.uuid);
    if (!root) throw new Error("找不到需要保存的本地任务");
    if (root.parentUuid) throw new Error("完整编辑器只能保存顶层任务");
    const existingChildren = parsed.actions.filter((action) => action.parentUuid === root.uuid);
    const existingIds = new Set(existingChildren.map((child) => child.uuid));
    const submittedIds = input.draft.children.flatMap((child) => child.uuid ? [child.uuid] : []);
    if (new Set(submittedIds).size !== submittedIds.length) throw new Error("子任务身份重复");
    if (submittedIds.some((uuid) => !existingIds.has(uuid))) throw new Error("子任务身份不属于当前任务");
    let content = patchManagedPlanAction(revision.content, {
      uuid: root.uuid,
      title: input.draft.title.trim(),
      state: input.draft.state,
      content: input.draft.content,
      startDate: input.draft.startDate ?? null,
      dueDate: input.draft.dueDate ?? null,
      timeZone: input.draft.timeZone ?? null,
      isAllDay: input.draft.isAllDay,
      priority: input.draft.priority,
      tags: [...new Set(input.draft.tags.map((tag) => tag.trim()).filter(Boolean))],
    });
    for (const child of existingChildren) {
      if (!submittedIds.includes(child.uuid)) content = removeManagedPlanAction(content, child.uuid);
    }
    const orderedChildUuids: string[] = [];
    for (const child of input.draft.children) {
      const childUuid = child.uuid ?? crypto.randomUUID();
      orderedChildUuids.push(childUuid);
      if (child.uuid) {
        content = patchManagedPlanAction(content, {
          uuid: child.uuid,
          title: child.title.trim(),
          state: child.state,
          startDate: child.startDate ?? null,
          dueDate: child.dueDate ?? null,
          timeZone: child.timeZone ?? null,
          priority: child.priority ?? 0,
        });
      } else {
        content = appendManagedPlanAction(content, {
          uuid: childUuid,
          title: child.title.trim(),
          state: child.state,
          parentUuid: root.uuid,
          startDate: child.startDate,
          dueDate: child.dueDate,
          timeZone: child.timeZone,
          priority: child.priority ?? 0,
        });
      }
    }
    content = reconcileLocalPlanParentCompletion(
      reorderManagedPlanChildren(content, root.uuid, orderedChildUuids),
    );
    await this.markdown.compareAndWrite(revision, content);
  }

  private async requireStage(path: string, expectedStageId: string): Promise<ProjectionMarkdownRevision> {
    const revision = await this.markdown.read(path);
    if (!revision) throw new Error(`阶段文件不存在：${path}`);
    assertProjectionStageIdentity(revision.content, expectedStageId);
    return revision;
  }

  private async requireExpectedStage(
    path: string,
    expectedStageId: string,
    expectedHash: string,
  ): Promise<ProjectionMarkdownRevision> {
    const revision = await this.requireStage(path, expectedStageId);
    if (revision.hash !== expectedHash) throw new Error("阶段 Markdown 已变化，请刷新后重试");
    return revision;
  }
}

function requireStage(
  workspace: ProjectWorkspaceSnapshot,
  projectId: string,
  stageId: string,
) {
  const project = workspace.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error("找不到任务所属项目");
  const stage = project.cycles.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error("找不到任务所属阶段");
  return stage;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
