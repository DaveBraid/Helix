import { normalizePath, parseYaml, type App } from "obsidian";
import { patchManagedFrontmatter } from "../storage/frontmatter";
import type {
  HelixVaultRepository,
  VaultRevision,
} from "../storage/vault-repository";
import type {
  ProjectWorkspaceProject,
  ProjectWorkspaceService,
} from "./project-workspace";

const REFERENCE_KIND = "helix-task-reference";
const BLOCK_START = "<!-- helix-task-reference:start -->";
const BLOCK_END = "<!-- helix-task-reference:end -->";

export interface TaskReference {
  refId: string;
  provider: "dida";
  taskId: string;
  projectId: string;
  stageIds: string[];
  createdAt: string;
  updatedAt: string;
  notePath: string;
  revisionHash: string;
}

export interface TaskReferenceResolved extends TaskReference {
  project?: ProjectWorkspaceProject;
  stages: Array<ProjectWorkspaceProject["cycles"][number]>;
  issues: string[];
}

export interface TaskReferenceSnapshot {
  references: TaskReferenceResolved[];
  issues: string[];
  blockingIssues: string[];
  byTaskId: Map<string, TaskReferenceResolved>;
  byProjectId: Map<string, TaskReferenceResolved[]>;
  byStageId: Map<string, TaskReferenceResolved[]>;
}

export interface TaskReferenceSelection {
  projectId?: string;
  stageIds: string[];
}

export interface TaskReferenceDidaContext {
  didaProjectId: string;
}

export function taskReferenceRuntimeIssues(
  reference: TaskReferenceResolved,
  task?: { projectId: string },
): string[] {
  return [
    ...reference.issues,
    reference.project && !reference.project.didaProjectId
      ? "Helix 项目尚未映射滴答清单"
      : undefined,
    task && reference.project?.didaProjectId &&
      task.projectId !== reference.project.didaProjectId
      ? "任务所属滴答清单与 Helix 项目映射不一致"
      : undefined,
    task ? undefined : `当前同步缓存未包含任务 ${reference.taskId}，不据此推断远端已删除`,
  ].filter((issue): issue is string => Boolean(issue));
}

export type TaskReferenceExpectedRevision = Pick<
  TaskReference,
  "refId" | "revisionHash"
> | null;

export interface TaskReferenceWriteResult {
  committed: true;
  reference?: TaskReferenceResolved;
}

export class TaskReferenceConflictError extends Error {
  constructor(message = "任务关联在编辑期间已经变化，请重新打开并逐项核对") {
    super(message);
    this.name = "TaskReferenceConflictError";
  }
}

export class TaskReferenceService {
  private readonly knownPaths = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly repository: HelixVaultRepository,
    private readonly projectWorkspace: ProjectWorkspaceService,
    private readonly rootFolder: () => string,
  ) {}

  async snapshot(): Promise<TaskReferenceSnapshot> {
    const workspace = await this.projectWorkspace.snapshot();
    const structuralIssues: string[] = [];
    const references: TaskReference[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const revision = await this.repository.read(file.path);
      if (!revision) continue;
      const frontmatter = frontmatterFromContent(revision.content);
      if (frontmatter?.["helix-kind"] !== REFERENCE_KIND) continue;
      this.knownPaths.add(normalizePath(revision.path));
      try {
        references.push(parseTaskReference(revision, frontmatter));
      } catch (error) {
        structuralIssues.push(error instanceof Error ? error.message : String(error));
      }
    }
    const duplicateRefIds = duplicateValues(references.map((reference) => reference.refId));
    const duplicateTaskIds = duplicateValues(references.map((reference) => reference.taskId));
    for (const refId of duplicateRefIds) {
      structuralIssues.push(`任务引用 ID 重复：${refId}`);
    }
    for (const taskId of duplicateTaskIds) {
      structuralIssues.push(`同一滴答任务存在多份 Helix 引用：${taskId}`);
    }
    const projectById = new Map(
      workspace.projects.map((project) => [project.id, project]),
    );
    const resolved = references.map((reference): TaskReferenceResolved => {
      const referenceIssues: string[] = [];
      const project = projectById.get(reference.projectId);
      if (!project) {
        referenceIssues.push("关联的 Helix 项目已不存在");
      }
      const stages = reference.stageIds.flatMap((stageId) => {
        const owner = workspace.projects.find((candidate) =>
          candidate.cycles.some((stage) => stage.id === stageId));
        const stage = owner?.cycles.find((candidate) => candidate.id === stageId);
        if (!owner || !stage) {
          referenceIssues.push(`关联阶段已不存在：${stageId}`);
          return [];
        }
        if (owner.id !== reference.projectId) {
          referenceIssues.push(`关联阶段不属于所选项目：${stageId}`);
        }
        return [stage];
      });
      return {
        ...reference,
        project,
        stages,
        issues: referenceIssues,
      };
    });
    return {
      references: resolved,
      issues: [
        ...structuralIssues,
        ...resolved.flatMap((reference) =>
          reference.issues.map((issue) => `${reference.notePath}：${issue}`)),
      ],
      blockingIssues: structuralIssues,
      byTaskId: new Map(resolved.map((reference) => [reference.taskId, reference])),
      byProjectId: groupReferences(resolved, (reference) => [reference.projectId]),
      byStageId: groupReferences(resolved, (reference) => reference.stageIds),
    };
  }

  async saveTaskReference(
    taskId: string,
    selection: TaskReferenceSelection,
    expected: TaskReferenceExpectedRevision,
    didaContext?: TaskReferenceDidaContext,
  ): Promise<TaskReferenceWriteResult> {
    assertRemoteIdentity(taskId, "任务 ID");
    if (taskId.startsWith("local-")) {
      throw new Error("本地临时任务尚未取得滴答远端 ID，不能建立 Helix 关联");
    }
    const current = await this.snapshot();
    this.assertWritableSnapshot(current);
    const existing = current.references.find((reference) =>
      reference.taskId === taskId);
    assertExpectedReference(existing, expected);
    if (!selection.projectId) {
      if (selection.stageIds.length > 0) {
        throw new Error("未选择 Helix 项目时不能保留阶段引用");
      }
      if (existing) await this.removeRevision(existing);
      return { committed: true };
    }
    const workspace = await this.projectWorkspace.snapshot();
    const project = workspace.projects.find((candidate) =>
      candidate.id === selection.projectId);
    if (!project) throw new Error("找不到需要关联的 Helix 项目");
    if (!didaContext) {
      throw new Error("建立 Helix 任务关联必须提供经远端复读的滴答清单上下文");
    }
    if (!project.didaProjectId) {
      throw new Error("所选 Helix 项目尚未映射滴答清单，不能建立稳定任务关联");
    }
    if (project.didaProjectId !== didaContext.didaProjectId) {
      throw new Error("任务所属滴答清单与 Helix 项目映射不一致，请先移动任务或调整项目映射");
    }
    const requestedStageIds = [...new Set(selection.stageIds)];
    if (requestedStageIds.length !== selection.stageIds.length) {
      throw new Error("阶段引用不能重复");
    }
    const stageOrder = new Map(
      project.cycles.map((stage, index) => [stage.id, index]),
    );
    if (requestedStageIds.some((stageId) => !stageOrder.has(stageId))) {
      throw new Error("只能关联所选项目内的阶段");
    }
    requestedStageIds.sort((left, right) =>
      stageOrder.get(left)! - stageOrder.get(right)!);
    const now = new Date().toISOString();
    if (existing) {
      const revision = await this.repository.read(existing.notePath);
      if (
        !revision ||
        revision.hash !== existing.revisionHash ||
        !sameTaskReferenceIdentity(revision, existing)
      ) {
        throw new Error("任务引用 Markdown 在编辑期间已经变化，请重新打开");
      }
      const next = updateTaskReferenceContent(
        revision.content,
        {
          ...existing,
          projectId: project.id,
          stageIds: requestedStageIds,
        },
        project,
        now,
      );
      const written = await this.repository.compareAndWrite(revision, next);
      return {
        committed: true,
        reference: resolvedReference(
          {
            ...existing,
            projectId: project.id,
            stageIds: requestedStageIds,
            updatedAt: now,
            revisionHash: written.hash,
          },
          project,
        ),
      };
    }
    const refId = crypto.randomUUID();
    const path = normalizePath(
      `${this.rootFolder()}/Task References/${refId}.md`,
    );
    const created = await this.repository.create(
      path,
      taskReferenceTemplate({
        refId,
        taskId,
        projectId: project.id,
        stageIds: requestedStageIds,
        project,
        createdAt: now,
      }),
    );
    return {
      committed: true,
      reference: resolvedReference(
        {
          refId,
          provider: "dida",
          taskId,
          projectId: project.id,
          stageIds: requestedStageIds,
          createdAt: now,
          updatedAt: now,
          notePath: path,
          revisionHash: created.hash,
        },
        project,
      ),
    };
  }

  async rebindTaskId(
    previousTaskId: string,
    nextTaskId: string,
    expected: TaskReferenceExpectedRevision,
    didaContext: TaskReferenceDidaContext,
  ): Promise<void> {
    assertRemoteIdentity(previousTaskId, "旧任务 ID");
    assertRemoteIdentity(nextTaskId, "新任务 ID");
    if (nextTaskId.startsWith("local-")) {
      throw new Error("不能把任务关联重新绑定到本地临时 ID");
    }
    if (previousTaskId === nextTaskId) return;
    const current = await this.snapshot();
    this.assertWritableSnapshot(current);
    const previous = current.references.find((reference) =>
      reference.taskId === previousTaskId);
    const next = current.references.find((reference) =>
      reference.taskId === nextTaskId);
    if (
      !previous &&
      expected &&
      next?.refId === expected.refId
    ) {
      return;
    }
    assertExpectedReference(previous, expected);
    if (!previous) throw new Error("找不到需要重新绑定的任务关联");
    const workspace = await this.projectWorkspace.snapshot();
    const project = workspace.projects.find((candidate) => candidate.id === previous.projectId);
    if (!project?.didaProjectId) {
      throw new Error("关联的 Helix 项目尚未映射滴答清单，不能重新绑定任务");
    }
    if (project.didaProjectId !== didaContext.didaProjectId) {
      throw new Error("新任务所属滴答清单与 Helix 项目映射不一致，拒绝重新绑定");
    }
    if (next && next.refId !== previous.refId) {
      throw new Error("新旧任务 ID 各自已有引用，禁止静默合并");
    }
    const revision = await this.repository.read(previous.notePath);
    if (
      !revision ||
      revision.hash !== previous.revisionHash ||
      !sameTaskReferenceIdentity(revision, previous)
    ) {
      throw new Error("任务引用 Markdown 在 ID 迁移期间已经变化");
    }
    const now = new Date().toISOString();
    await this.repository.compareAndWrite(
      revision,
      patchManagedFrontmatter(revision.content, {
        "helix-dida-task-id": nextTaskId,
        "helix-updated": now,
      }),
    );
  }

  async hasTaskReferenceIdentity(path: string): Promise<boolean> {
    const revision = await this.repository.read(normalizePath(path));
    if (!revision) return false;
    return frontmatterFromContent(revision.content)?.["helix-kind"] ===
      REFERENCE_KIND;
  }

  isKnownTaskReferencePath(path: string): boolean {
    const normalized = normalizePath(path);
    const defaultRoot = normalizePath(`${this.rootFolder()}/Task References`);
    return this.knownPaths.has(normalized) ||
      (normalized.startsWith(`${defaultRoot}/`) && normalized.endsWith(".md"));
  }

  private assertWritableSnapshot(snapshot: TaskReferenceSnapshot): void {
    if (snapshot.blockingIssues.length > 0) {
      throw new Error(
        `任务引用存在结构问题，已暂停写入：${snapshot.blockingIssues.join("；")}`,
      );
    }
  }

  private async removeRevision(reference: TaskReference): Promise<void> {
    const revision = await this.repository.read(reference.notePath);
    if (
      !revision ||
      revision.hash !== reference.revisionHash ||
      !sameTaskReferenceIdentity(revision, reference)
    ) {
      throw new Error("任务引用 Markdown 在移除期间已经变化");
    }
    await this.repository.trashIfUnchanged(
      revision,
      undefined,
      { requireExisting: true },
    );
  }
}

function parseTaskReference(
  revision: VaultRevision,
  frontmatter: Record<string, unknown>,
): TaskReference {
  const refId = requiredString(frontmatter["helix-id"]);
  const provider = requiredString(frontmatter["helix-provider"]);
  if (provider !== "dida") {
    throw new Error(`任务引用提供方无效：${revision.path}`);
  }
  const taskId = requiredString(frontmatter["helix-dida-task-id"]);
  if (taskId.startsWith("local-")) {
    throw new Error(`任务引用不能使用本地临时 ID：${revision.path}`);
  }
  assertSingleManagedBlock(revision);
  const projectId = requiredString(frontmatter["helix-project-id"]);
  const createdAt = requiredString(frontmatter["helix-created"]);
  const updatedAt = requiredString(frontmatter["helix-updated"]);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error(`任务引用时间戳无效：${revision.path}`);
  }
  const stageIds = frontmatter["helix-stage-ids"];
  if (
    !Array.isArray(stageIds) ||
    stageIds.some((stageId) =>
      typeof stageId !== "string" ||
      !stageId.trim() ||
      stageId !== stageId.trim()) ||
    new Set(stageIds).size !== stageIds.length
  ) {
    throw new Error(`任务引用阶段列表无效：${revision.path}`);
  }
  return {
    refId,
    provider,
    taskId,
    projectId,
    stageIds: [...stageIds],
    createdAt,
    updatedAt,
    notePath: revision.path,
    revisionHash: revision.hash,
  };
}

function taskReferenceTemplate(input: {
  refId: string;
  taskId: string;
  projectId: string;
  stageIds: string[];
  project: ProjectWorkspaceProject;
  createdAt: string;
}): string {
  return `---
helix-kind: ${REFERENCE_KIND}
helix-id: ${input.refId}
helix-provider: dida
helix-dida-task-id: ${JSON.stringify(input.taskId)}
helix-project-id: ${input.projectId}
helix-stage-ids: ${JSON.stringify(input.stageIds)}
helix-created: ${input.createdAt}
helix-updated: ${input.createdAt}
---

# 任务关联

${referenceBlock(input.project, input.stageIds)}

## 备注

`;
}

function updateTaskReferenceContent(
  content: string,
  reference: Pick<
    TaskReference,
    "taskId" | "projectId" | "stageIds"
  >,
  project: ProjectWorkspaceProject,
  updatedAt: string,
): string {
  const patched = patchManagedFrontmatter(content, {
    "helix-dida-task-id": reference.taskId,
    "helix-project-id": reference.projectId,
    "helix-stage-ids": reference.stageIds,
    "helix-updated": updatedAt,
  });
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const nextBlock = referenceBlock(project, reference.stageIds)
    .replace(/\n/g, newline);
  const start = patched.indexOf(BLOCK_START);
  const end = patched.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("任务引用 Markdown 缺少受管链接区块");
  }
  return `${patched.slice(0, start)}${nextBlock}${patched.slice(end + BLOCK_END.length)}`;
}

function referenceBlock(
  project: ProjectWorkspaceProject,
  stageIds: string[],
): string {
  const stageById = new Map(project.cycles.map((stage) => [stage.id, stage]));
  const stageLines = stageIds.map((stageId) => {
    const stage = stageById.get(stageId);
    if (!stage) throw new Error(`找不到关联阶段：${stageId}`);
    return `- 阶段：[[${withoutMarkdownExtension(stage.notePath)}]]`;
  });
  return [
    BLOCK_START,
    `- 项目：[[${withoutMarkdownExtension(project.notePath)}]]`,
    ...stageLines,
    BLOCK_END,
  ].join("\n");
}

function sameTaskReferenceIdentity(
  revision: VaultRevision,
  expected: TaskReference,
): boolean {
  const frontmatter = frontmatterFromContent(revision.content);
  return frontmatter?.["helix-kind"] === REFERENCE_KIND &&
    frontmatter["helix-id"] === expected.refId &&
    frontmatter["helix-provider"] === "dida" &&
    frontmatter["helix-dida-task-id"] === expected.taskId;
}

function assertExpectedReference(
  current: TaskReference | undefined,
  expected: TaskReferenceExpectedRevision,
): void {
  if (!expected) {
    if (current) throw new TaskReferenceConflictError();
    return;
  }
  if (
    !current ||
    current.refId !== expected.refId ||
    current.revisionHash !== expected.revisionHash
  ) {
    throw new TaskReferenceConflictError();
  }
}

function frontmatterFromContent(
  content: string,
): Record<string, unknown> | undefined {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return undefined;
  try {
    const parsed = parseYaml(match[1]!);
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("任务引用缺少必需的稳定 ID");
  }
  return value.trim();
}

function assertRemoteIdentity(value: string, label: string): void {
  if (!value.trim() || value.includes("\n") || value.length > 512) {
    throw new Error(`${label}无效`);
  }
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function assertSingleManagedBlock(revision: VaultRevision): void {
  const starts = markerPositions(revision.content, BLOCK_START);
  const ends = markerPositions(revision.content, BLOCK_END);
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    starts[0]! >= ends[0]!
  ) {
    throw new Error(`任务引用受管链接区块无效：${revision.path}`);
  }
}

function markerPositions(content: string, marker: string): number[] {
  const positions: number[] = [];
  let offset = 0;
  while (offset <= content.length - marker.length) {
    const position = content.indexOf(marker, offset);
    if (position === -1) break;
    positions.push(position);
    offset = position + marker.length;
  }
  return positions;
}

function resolvedReference(
  reference: TaskReference,
  project: ProjectWorkspaceProject,
): TaskReferenceResolved {
  const stages = reference.stageIds.flatMap((stageId) => {
    const stage = project.cycles.find((candidate) => candidate.id === stageId);
    return stage ? [stage] : [];
  });
  return {
    ...reference,
    project,
    stages,
    issues: [],
  };
}

function groupReferences(
  references: TaskReferenceResolved[],
  keys: (reference: TaskReferenceResolved) => string[],
): Map<string, TaskReferenceResolved[]> {
  const grouped = new Map<string, TaskReferenceResolved[]>();
  for (const reference of references) {
    for (const key of keys(reference)) {
      const group = grouped.get(key) ?? [];
      group.push(reference);
      grouped.set(key, group);
    }
  }
  return grouped;
}

function withoutMarkdownExtension(path: string): string {
  return normalizePath(path).replace(/\.md$/i, "");
}
