import {
  adoptAllPlanActions,
  appendManagedPlanAction,
  assertProjectionStageIdentity,
  parseManagedPlanActions,
  patchManagedPlanAction,
  reconcileLocalPlanActionCheckboxes,
  removeManagedPlanAction,
  reorderManagedPlanChildren,
  type ProjectionActionState,
} from "../domain/dida-project-projection";
import type { ProjectWorkspaceSnapshot } from "./project-workspace";
import type {
  ProjectionMarkdownPort,
  ProjectionMarkdownRevision,
} from "./dida-project-projection";

export const LOCAL_PROJECT_TASK_PREFIX = "helix-local-task:";

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
  destinations: Array<{
    projectId: string;
    projectTitle: string;
    projectColor?: string;
    stages: Array<{ stageId: string; stageTitle: string; stageCode: string; status: string }>;
  }>;
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

export function isLocalProjectTaskId(id: string): boolean {
  return id.startsWith(LOCAL_PROJECT_TASK_PREFIX);
}

export class LocalProjectTaskService {
  constructor(private readonly markdown: ProjectionMarkdownPort) {}

  async snapshot(
    workspace: ProjectWorkspaceSnapshot,
    options: { adoptUnmanaged?: boolean } = {},
  ): Promise<LocalProjectTaskSnapshot> {
    const tasks: LocalProjectTask[] = [];
    const issues: string[] = [];
    const globalUuids = new Map<string, string>();
    for (const project of workspace.projects) {
      for (const stage of project.cycles) {
        try {
          let revision = await this.requireStage(stage.notePath, stage.id);
          if (options.adoptUnmanaged) {
            const adopted = adoptAllPlanActions(
              reconcileLocalPlanActionCheckboxes(revision.content),
            );
            if (adopted !== revision.content) {
              revision = await this.markdown.compareAndWrite(revision, adopted);
            }
          }
          const parsed = parseManagedPlanActions(revision.content);
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
    const content = appendManagedPlanAction(revision.content, {
      uuid,
      title: input.title.trim(),
      state: input.state,
      parentUuid: input.parentUuid,
    });
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
    const content = patchManagedPlanAction(revision.content, {
      uuid: input.uuid,
      title: input.title?.trim(),
      state: input.state,
    });
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
    await this.markdown.compareAndWrite(
      revision,
      removeManagedPlanAction(revision.content, input.uuid),
    );
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
    content = reorderManagedPlanChildren(content, root.uuid, orderedChildUuids);
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
