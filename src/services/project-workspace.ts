import { normalizePath, parseYaml, TFile, type App } from "obsidian";
import {
  CYCLE_RELATION_LABELS,
  assertCycleRelationInput,
  cycleRelationKindFromLabel,
  stageCreationIntent,
  validateCycleGraph,
  type CycleRelation,
  type CycleRelationKind,
} from "../domain/cycle-graph";
import { cycleTemplate, projectTemplate } from "../domain/projects";
import {
  affectedWeakComponent,
  normalizeProjectGraph,
  planDeletionBridges,
  planProjectGraphLayout,
  type ProjectGraphEdge,
} from "../domain/project-graph";
import { assertProjectMappingsUnique } from "../domain/project-mapping";
import { stableHash } from "../domain/stable";
import { patchManagedFrontmatter } from "../storage/frontmatter";
import type { HelixVaultRepository, VaultRevision } from "../storage/vault-repository";

interface CanvasNode {
  id: string;
  type: string;
  file?: string;
  text?: string;
  helixFilePath?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
  helixRelation?: string;
  helixManaged?: boolean;
  helixMergeGroupId?: string;
  [key: string]: unknown;
}

interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  helixStageSequences?: Record<string, number>;
  helixCompletedCollapse?: {
    version: 1;
    projectIds: string[];
  };
  helixMigration?: {
    version: 2;
    legacyPreserved: true;
    acknowledgedAt: string;
    acknowledgedItemIds?: string[];
  };
  [key: string]: unknown;
}

export interface ProjectWorkspaceMigrationItem {
  id: string;
  sourcePath: string;
  title: string;
  action: "preserve" | "assign-owner" | "upgrade-node";
  detail: string;
}

export interface ProjectWorkspaceCycle {
  id: string;
  title: string;
  notePath: string;
  sequence: number;
  status: "planned" | "active" | "closed";
}

export interface ProjectWorkspaceProject {
  id: string;
  title: string;
  status: "planned" | "active" | "paused" | "completed" | "archived";
  notePath: string;
  didaProjectId?: string;
  color?: string;
  cycles: ProjectWorkspaceCycle[];
}

export interface ProjectWorkspaceCanvasNode {
  nodeId: string;
  entityId: string;
  projectId: string;
  kind: "project" | "cycle";
  notePath: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectWorkspaceNodeMove {
  nodeId: string;
  x: number;
  y: number;
}

export interface ProjectWorkspaceSnapshot {
  canvasPath: string;
  canvasRevisionHash: string | null;
  projects: ProjectWorkspaceProject[];
  nextStageSequenceByProject: Record<string, number>;
  relations: CycleRelation[];
  migrationWarnings: string[];
  migrationItems: ProjectWorkspaceMigrationItem[];
  migrationRequired: boolean;
  canvasNodes: ProjectWorkspaceCanvasNode[];
  collapsedCompletedProjectIds: string[];
}

export interface ProjectConnectionPlan {
  canvasRevisionHash: string;
  sourceCycleId: string;
  targetCycleId: string;
  source: {
    projectId: string;
    projectTitle: string;
    cycleTitle: string;
    sequence: number;
  };
  target: {
    projectId: string;
    projectTitle: string;
    cycleTitle: string;
    sequence: number;
  };
  crossProject: boolean;
  affectedNodeCount: number;
  relabeledEdgeCount: number;
}

export interface StageDeletionPlan {
  canvasRevisionHash: string;
  cycleId: string;
  bridgeCandidates: Array<{
    fromCycleId: string;
    toCycleId: string;
    existing: boolean;
    crossProject: boolean;
  }>;
  impacts: {
    bridge: StageDeletionImpact;
    noBridge: StageDeletionImpact;
  };
  bridgeLimitExceeded: boolean;
}

export interface StageDeletionImpact {
  affectedNodeCount: number;
  affectedCycleIds: string[];
  relabeledEdges: Array<{
    edgeId: string;
    fromCycleId: string;
    toCycleId: string;
    before: CycleRelationKind;
    after: CycleRelationKind;
  }>;
}

interface CycleCreationOptions {
  confirmBranchConversion?: boolean;
  confirmCrossProject?: boolean;
  stageTitle?: string;
  secondaryStageTitle?: string;
}

interface ExpectedAutoStageIntent {
  relation: CycleRelationKind;
  convertedInheritanceRelationIds: string[];
}

interface StageDeletionJournal {
  version: 1;
  operation: "delete-stage";
  createdAt: string;
  stageId: string;
  stagePath: string;
  stageHash: string;
  canvasPath: string;
  canvasBeforeHash: string;
  canvasBeforeContent: string;
  canvasAfterHash: string;
  canvasAfterContent: string;
}

export type StageDeletionRecoveryResult =
  | "none"
  | "aborted"
  | "completed"
  | "rolled-back";

export class ProjectWorkspaceService {
  private disposed = false;
  private generation = 0;
  private recoveryIssue: string | null = null;

  constructor(
    private readonly app: App,
    private readonly repository: HelixVaultRepository,
    private readonly rootFolder: () => string,
    private readonly canvasPath: () => string,
  ) {}

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
  }

  private beginOperation(): number {
    if (this.disposed) throw new Error("Helix 项目工作区已卸载");
    if (this.recoveryIssue) throw new Error(this.recoveryIssue);
    return this.generation;
  }

  freezePendingStageDeletion(message: string): void {
    this.recoveryIssue = message;
    this.generation += 1;
  }

  private assertActive(generation: number): void {
    if (this.disposed || this.recoveryIssue || generation !== this.generation) {
      throw new Error("Helix 项目工作区已卸载，已取消迟到写入");
    }
  }

  async recoverPendingStageDeletion(): Promise<StageDeletionRecoveryResult> {
    const generation = this.beginOperation();
    try {
      const journalRevision = await this.repository.read(this.stageDeletionJournalPath());
      if (!journalRevision) return "none";
      const journal = this.parseStageDeletionJournal(journalRevision.content);
      const canvasRevision = await this.repository.read(journal.canvasPath);
      if (!canvasRevision) {
        throw new Error("阶段删除事务无法恢复：项目 Canvas 已不存在");
      }
      const matchingStages = await this.findStageRevisions(journal.stageId);
      if (matchingStages.length > 1) {
        throw new Error("阶段删除事务无法恢复：发现重复的阶段身份");
      }
      const matchingStage = matchingStages[0];
      const originalPathRevision = await this.repository.read(journal.stagePath);
      if (!matchingStage && originalPathRevision) {
        throw new Error(
          "阶段删除事务无法恢复：原路径已被无关 Markdown 占用，已保留日志并冻结项目写入",
        );
      }

      if (canvasRevision.hash === journal.canvasBeforeHash) {
        if (!matchingStage) {
          await this.assertStageDeletionJournalCurrent(journalRevision);
          this.assertActive(generation);
          await this.repository.compareAndWrite(
            canvasRevision,
            journal.canvasAfterContent,
            () => this.assertActive(generation),
          );
          await this.finishStageDeletionJournal(journalRevision, generation);
          return "completed";
        }
        await this.finishStageDeletionJournal(journalRevision, generation);
        return "aborted";
      }

      if (canvasRevision.hash !== journal.canvasAfterHash) {
        throw new Error("阶段删除事务无法恢复：Canvas 已被其他修改覆盖，请手动检查");
      }

      if (
        matchingStage?.path === journal.stagePath &&
        matchingStage.hash === journal.stageHash
      ) {
        await this.assertStageDeletionJournalCurrent(journalRevision);
        await this.repository.trashIfUnchanged(
          matchingStage,
          () => this.assertActive(generation),
          { requireExisting: true },
        );
        await this.finishStageDeletionJournal(journalRevision, generation);
        return "completed";
      }

      if (!matchingStage) {
        await this.finishStageDeletionJournal(journalRevision, generation);
        return "completed";
      }

      await this.assertStageDeletionJournalCurrent(journalRevision);
      this.assertActive(generation);
      await this.repository.compareAndWrite(
        canvasRevision,
        journal.canvasBeforeContent,
        () => this.assertActive(generation),
      );
      await this.finishStageDeletionJournal(journalRevision, generation);
      return "rolled-back";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.freezePendingStageDeletion(`阶段删除事务需要人工检查：${message}`);
      throw error;
    }
  }

  async snapshot(): Promise<ProjectWorkspaceSnapshot> {
    this.beginOperation();
    const projectFiles = (await Promise.all(this.app.vault.getMarkdownFiles().map(async (file) => {
      const revision = await this.repository.read(file.path);
      const frontmatter = revision
        ? frontmatterFromContent(revision.content)
        : undefined;
      if (frontmatter?.["helix-kind"] !== "helix-project") return [];
      const id = frontmatter["helix-id"];
      const status = frontmatter["helix-status"];
      if (
        typeof id !== "string" ||
        !id.trim() ||
        !["planned", "active", "paused", "completed", "archived"].includes(String(status))
      ) {
        throw new Error(`项目元数据不完整：${file.path}`);
      }
      const heading = revision
        ? /^#\s+(.+?)\s*$/m.exec(revision.content)?.[1]?.trim()
        : undefined;
      return [{
        id,
        title: heading || file.parent?.name || file.basename,
        status: status as ProjectWorkspaceProject["status"],
        notePath: file.path,
        color: parseProjectColor(frontmatter["helix-color"], file.path),
        didaProjectId:
          typeof frontmatter["helix-dida-project-id"] === "string" &&
          frontmatter["helix-dida-project-id"].trim()
            ? frontmatter["helix-dida-project-id"].trim()
            : undefined,
        legacyParents: Array.isArray(frontmatter["helix-parents"])
          ? frontmatter["helix-parents"].filter(Boolean)
          : [],
        legacyActiveCycle: frontmatter["helix-active-cycle"],
        folder: file.parent?.path ?? "",
      }];
    }))).flat();
    assertProjectMappingsUnique(projectFiles.map((project) => ({
      id: project.id,
      path: project.notePath,
      didaProjectId: project.didaProjectId,
    })));
    const seenEntityIds = new Set(projectFiles.map((project) => project.id));
    const projectByFolder = new Map<string, typeof projectFiles[number]>();
    for (const project of projectFiles) {
      if (projectByFolder.has(project.folder)) {
        throw new Error(`同一文件夹存在多个 Helix 项目：${project.folder}`);
      }
      projectByFolder.set(project.folder, project);
    }
    const cyclesByProject = new Map<string, ProjectWorkspaceCycle[]>();
    const migrationWarnings: string[] = [];
    const migrationItems: ProjectWorkspaceMigrationItem[] = [];
    for (const project of projectFiles) {
      if (project.legacyParents.length > 0) {
        const warning =
          `${project.title} 仍含旧 helix-parents；不会把项目级父子关系猜成阶段关系。`;
        migrationWarnings.push(warning);
        migrationItems.push({
          id: `parents:${project.id}:${migrationFingerprint(project.legacyParents)}`,
          sourcePath: project.notePath,
          title: "保留旧项目父级字段",
          action: "preserve",
          detail: warning,
        });
      }
      if (project.legacyActiveCycle) {
        const warning =
          `${project.title} 仍含旧 helix-active-cycle；当前活动阶段将改由各阶段的状态决定。`;
        migrationWarnings.push(warning);
        migrationItems.push({
          id: `active:${project.id}:${migrationFingerprint(project.legacyActiveCycle)}`,
          sourcePath: project.notePath,
          title: "保留旧活动阶段指针",
          action: "preserve",
          detail: warning,
        });
      }
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      const revision = await this.repository.read(file.path);
      const frontmatter = revision
        ? frontmatterFromContent(revision.content)
        : undefined;
      if (
        frontmatter?.["helix-kind"] !== "helix-stage" &&
        frontmatter?.["helix-kind"] !== "helix-cycle"
      ) continue;
      const id = frontmatter["helix-id"];
      const sequence = Number(frontmatter["helix-sequence"]);
      const status = frontmatter["helix-status"];
      if (
        typeof id !== "string" ||
        !id.trim() ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        !["planned", "active", "closed"].includes(String(status))
      ) {
        throw new Error(`阶段元数据不完整：${file.path}`);
      }
      if (seenEntityIds.has(id)) {
        throw new Error(`项目或阶段 ID 重复：${id}`);
      }
      seenEntityIds.add(id);
      const explicitProjectId =
        typeof frontmatter["helix-project-id"] === "string"
          ? frontmatter["helix-project-id"]
          : undefined;
      const project = explicitProjectId
        ? projectFiles.find((candidate) => candidate.id === explicitProjectId)
        : projectByFolder.get(file.parent?.path ?? "");
      if (!project) {
        throw new Error(`无法确定阶段所属项目：${file.path}`);
      }
      if (!explicitProjectId) {
        migrationItems.push({
          id: `owner:${id}:${migrationFingerprint(project.id)}`,
          sourcePath: file.path,
          title: `确认 ${file.basename} 的所属项目`,
          action: "assign-owner",
          detail: `根据同文件夹的 Project.md 写入 helix-project-id：${project.id}`,
        });
      }
      if (frontmatter["helix-predecessor"]) {
        const warning =
          `${file.basename} 仍含旧 helix-predecessor；不会自动转换为继承、分支或合并。`;
        migrationWarnings.push(warning);
        migrationItems.push({
          id: `predecessor:${id}:${migrationFingerprint(
            frontmatter["helix-predecessor"],
          )}`,
          sourcePath: file.path,
          title: "保留旧前置阶段字段",
          action: "preserve",
          detail: warning,
        });
      }
      const cycles = cyclesByProject.get(project.id) ?? [];
      if (cycles.some((cycle) => cycle.sequence === sequence)) {
        throw new Error(`同一项目的阶段编号重复：${project.title} / 阶段 ${sequence}`);
      }
      const heading = revision
        ? /^#\s+(.+?)\s*$/m.exec(revision.content)?.[1]?.trim()
        : undefined;
      cycles.push({
        id,
        title: stageTitleFromHeading(heading, sequence),
        notePath: file.path,
        sequence,
        status: status as ProjectWorkspaceCycle["status"],
      });
      cyclesByProject.set(project.id, cycles);
    }
    const projects = projectFiles
      .map(({
        legacyParents: _legacyParents,
        legacyActiveCycle: _legacyActiveCycle,
        folder: _folder,
        ...project
      }) => ({
        ...project,
        cycles: (cyclesByProject.get(project.id) ?? [])
          .sort((left, right) => left.sequence - right.sequence),
      }))
      .sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
    const canvas = await this.readCanvas();
    validatedStageSequenceLedger(canvas.document);
    assertUniqueCanvasIds(canvas.document);
    const cycles = projects.flatMap((project) => project.cycles);
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const cycleById = new Map(cycles.map((cycle) => [cycle.id, cycle]));
    const cycleOwner = new Map(
      projects.flatMap((project) =>
        project.cycles.map((cycle) => [cycle.id, project.id] as const)),
    );
    const cycleByNode = new Map<string, ProjectWorkspaceCycle>();
    const canvasNodes: ProjectWorkspaceCanvasNode[] = [];
    const managedProjectIds = new Set<string>();
    const managedCycleIds = new Set<string>();
    for (const node of canvas.document.nodes) {
      if (node.helixManaged !== true) continue;
      assertManagedNodeGeometry(node);
      if (
        node.helixNodeKind === undefined &&
        typeof node.helixProjectId === "string"
      ) {
        const project = projectById.get(node.helixProjectId);
        if (!project) {
          throw new Error(`旧项目 Canvas 节点引用不存在的项目：${node.id}`);
        }
        migrationItems.push({
          id: `node:${node.id}:${migrationFingerprint({
            helixProjectId: node.helixProjectId,
            helixFilePath: node.helixFilePath,
            type: node.type,
            file: node.file,
            text: node.text,
          })}`,
          sourcePath: canvas.revision?.path ?? normalizePath(this.canvasPath()),
          title: `升级 ${project.title} 的 Canvas 节点标记`,
          action: "upgrade-node",
          detail: "补充 helixNodeKind=project；保留节点位置、尺寸和未知字段。",
        });
        continue;
      }
      if (node.helixNodeKind === "project") {
        if (typeof node.helixProjectId !== "string") {
          throw new Error(`项目 Canvas 节点缺少 helixProjectId：${node.id}`);
        }
        const project = projectById.get(node.helixProjectId);
        if (
          !project ||
          managedProjectIds.has(project.id)
        ) {
          throw new Error(`项目 Canvas 节点身份不一致或重复：${node.id}`);
        }
        assertManagedTextLink(node, project.notePath);
        managedProjectIds.add(project.id);
        canvasNodes.push(canvasNodeView(node, {
          entityId: project.id,
          projectId: project.id,
          kind: "project",
          notePath: project.notePath,
          title: project.title,
        }));
        continue;
      }
      if (node.helixNodeKind !== "stage" && node.helixNodeKind !== "cycle") {
        throw new Error(`Helix 托管节点类型无效：${node.id}`);
      }
      const stageId = managedStageId(node);
      if (!stageId) {
        throw new Error(`阶段 Canvas 节点缺少阶段 ID：${node.id}`);
      }
      const cycle = cycleById.get(stageId);
      if (
        !cycle ||
        node.helixProjectId !== cycleOwner.get(cycle.id) ||
        managedCycleIds.has(cycle.id)
      ) {
        throw new Error(`阶段 Canvas 节点身份不一致或重复：${node.id}`);
      }
      assertManagedTextLink(node, cycle.notePath);
      managedCycleIds.add(cycle.id);
      cycleByNode.set(node.id, cycle);
      canvasNodes.push(canvasNodeView(node, {
        entityId: cycle.id,
        projectId: cycleOwner.get(cycle.id)!,
        kind: "cycle",
        notePath: cycle.notePath,
        title: cycle.title,
      }));
    }
    const recognizedEdges = canvas.document.edges.flatMap((edge) => {
      if (edge.helixManaged !== true) return [];
      const kind = cycleRelationKindFromLabel(edge.helixRelation);
      const from = cycleByNode.get(edge.fromNode);
      const to = cycleByNode.get(edge.toNode);
      const isLegacy = edge.label === "derives-from" ||
        edge.helixRelation === "derives-from";
      if (isLegacy) return [];
      if (!kind) throw new Error(`Helix 托管边关系类型无效：${edge.id}`);
      if (!from || !to) throw new Error(`Helix 托管边引用缺失或非阶段节点：${edge.id}`);
      return [{ edge, kind, from, to }];
    });
    if (
      canvas.document.edges.some(
        (edge) => edge.label === "derives-from" || edge.helixRelation === "derives-from",
      )
    ) {
      migrationWarnings.push(
        "Canvas 仍含旧 derives-from 项目边；Helix 会原样保留，但不会把它猜成阶段关系。",
      );
      migrationItems.push({
        id: `canvas:derives-from:${migrationFingerprint(
          canvas.document.edges
            .filter((edge) =>
              edge.label === "derives-from" ||
              edge.helixRelation === "derives-from")
            .map((edge) => ({
              id: edge.id,
              fromNode: edge.fromNode,
              toNode: edge.toNode,
              label: edge.label,
              helixRelation: edge.helixRelation,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        )}`,
        sourcePath: canvas.revision?.path ?? normalizePath(this.canvasPath()),
        title: "保留旧项目谱系边",
        action: "preserve",
        detail: "旧 derives-from 边继续保留为非阶段关系，不自动转换。",
      });
    }
    const relations: CycleRelation[] = [];
    const groupedMerge = new Map<string, typeof recognizedEdges>();
    for (const item of recognizedEdges) {
      if (item.kind !== "merge") {
        relations.push({
          id: item.edge.id,
          kind: item.kind,
          fromCycleIds: [item.from.id],
          toCycleId: item.to.id,
        });
        continue;
      }
      const group = groupedMerge.get(item.to.id) ?? [];
      group.push(item);
      groupedMerge.set(item.to.id, group);
    }
    for (const [toCycleId, items] of groupedMerge) {
      const mergeGroups = new Set(items.map((item) => item.edge.helixMergeGroupId));
      if (
        mergeGroups.size !== 1 ||
        [...mergeGroups][0] === undefined ||
        items.some((item) => item.edge.helixManaged !== true)
      ) {
        throw new Error(`合并边缺少一致的 helixMergeGroupId：${toCycleId}`);
      }
      relations.push({
        id: `merge:${toCycleId}`,
        kind: "merge",
        fromCycleIds: items.map((item) => item.from.id),
        toCycleId,
      });
    }
    validateCycleGraph(cycles.map((cycle) => cycle.id), relations);
    const acknowledgedMigrationItems = new Set(
      canvas.document.helixMigration?.acknowledgedItemIds ?? [],
    );
    const pendingMigrationItems = deduplicateMigrationItems(migrationItems).filter(
      (item) => !acknowledgedMigrationItems.has(item.id),
    );
    const nextStageSequenceByProject = Object.fromEntries(
      projects.map((project) => [
        project.id,
        nextStageSequence(canvas.document, project),
      ]),
    );
    return {
      canvasPath: normalizePath(this.canvasPath()),
      canvasRevisionHash: canvas.revision?.hash ?? null,
      projects,
      nextStageSequenceByProject,
      relations,
      migrationWarnings: [...new Set(migrationWarnings)],
      migrationItems: pendingMigrationItems,
      migrationRequired: pendingMigrationItems.length > 0,
      canvasNodes,
      collapsedCompletedProjectIds: validatedCompletedCollapse(
        canvas.document,
        new Set(projects.map((project) => project.id)),
      ),
    };
  }

  async ensureCanvas(): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const snapshot = await this.snapshot();
    if (snapshot.migrationRequired) {
      throw new Error("检测到旧项目数据。请先在项目页预览并确认迁移，不会自动改写。");
    }
    const canvas = await this.readCanvas(true, generation);
    let changed = false;
    const entityById = new Map<string, { path: string; title: string; status: string }>([
      ...snapshot.projects.map((project) => [
        `project:${project.id}`,
        {
          path: project.notePath,
          title: project.title,
          status: projectStatusText(project.status),
        },
      ] as const),
      ...snapshot.projects.flatMap((project) =>
        project.cycles.map((cycle) => [
          `cycle:${cycle.id}`,
          {
            path: cycle.notePath,
            title: cycle.title,
            status: cycle.status === "active"
              ? "进行中"
              : cycle.status === "closed"
                ? "已关闭"
                : "计划中",
          },
        ] as const)),
    ]);
    for (const node of canvas.document.nodes) {
      if (node.helixManaged !== true) continue;
      const identity = node.helixNodeKind === "project" && typeof node.helixProjectId === "string"
        ? `project:${node.helixProjectId}`
        : managedStageId(node)
          ? `cycle:${managedStageId(node)}`
          : undefined;
      const entity = identity ? entityById.get(identity) : undefined;
      if (!entity) throw new Error(`无法修复 Helix 托管节点：${node.id}`);
      const path = normalizePath(entity.path);
      const nextText = canvasCardText(path, entity.title, entity.status);
      if (
        node.type !== "text" ||
        node.helixFilePath !== normalizePath(path) ||
        node.text !== nextText
      ) {
        node.type = "text";
        node.helixFilePath = normalizePath(path);
        node.text = nextText;
        delete node.file;
        changed = true;
      }
    }
    const existingProjects = new Set(
      canvas.document.nodes.flatMap((node) =>
        node.helixManaged === true &&
        node.helixNodeKind === "project" &&
        typeof node.helixProjectId === "string"
          ? [node.helixProjectId]
          : []),
    );
    const existingCycles = new Set(
      canvas.document.nodes.flatMap((node) =>
        node.helixManaged === true && managedStageId(node)
          ? [managedStageId(node)!]
          : []),
    );
    snapshot.projects.forEach((project, projectIndex) => {
      if (!existingProjects.has(project.id)) {
        canvas.document.nodes.push(cardNode(
          `helix-project-${project.id}`,
          project.notePath,
          project.title,
          projectStatusText(project.status),
          projectIndex * 520,
          0,
          360,
          220,
          {
            helixNodeKind: "project",
            helixProjectId: project.id,
          },
        ));
        existingProjects.add(project.id);
        changed = true;
      }
      project.cycles.forEach((cycle, cycleIndex) => {
        if (existingCycles.has(cycle.id)) return;
        canvas.document.nodes.push(cardNode(
          `helix-stage-${cycle.id}`,
          cycle.notePath,
          cycle.title,
          cycle.status === "active"
            ? "进行中"
            : cycle.status === "closed"
              ? "已关闭"
              : "计划中",
          projectIndex * 520,
          300 + cycleIndex * 260,
          360,
          220,
          {
            helixNodeKind: "stage",
            helixProjectId: project.id,
            helixStageId: cycle.id,
          },
        ));
        existingCycles.add(cycle.id);
        changed = true;
      });
    });
    if (ensureStageSequenceLedger(canvas.document, snapshot)) {
      changed = true;
    }
    if (changed) {
      this.assertActive(generation);
      await this.writeCanvas(canvas, generation);
    }
    return this.snapshot();
  }

  async moveCanvasNode(
    nodeId: string,
    x: number,
    y: number,
  ): Promise<ProjectWorkspaceSnapshot> {
    return this.moveCanvasNodes([{ nodeId, x, y }]);
  }

  async updateProjectColor(
    projectId: string,
    color?: string,
  ): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const snapshot = await this.snapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("找不到需要设置颜色的项目");
    const normalizedColor = normalizeProjectColor(color);
    const revision = await this.repository.read(project.notePath);
    if (!revision) throw new Error("项目 Markdown 已不存在");
    this.assertActive(generation);
    await this.repository.compareAndWrite(
      revision,
      patchManagedFrontmatter(revision.content, {
        "helix-color": normalizedColor,
        "helix-updated": new Date().toISOString(),
      }),
      () => this.assertActive(generation),
    );
    return this.snapshot();
  }

  async setCompletedProjectCollapsed(
    projectId: string,
    collapsed: boolean,
  ): Promise<ProjectWorkspaceSnapshot> {
    return this.setCompletedProjectsCollapsed([projectId], collapsed);
  }

  async setCompletedProjectsCollapsed(
    projectIds: string[],
    collapsed: boolean,
  ): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const snapshot = await this.snapshot();
    const requested = [...new Set(projectIds)];
    const known = new Set(snapshot.projects.map((project) => project.id));
    if (requested.length === 0 || requested.some((projectId) => !known.has(projectId))) {
      throw new Error("找不到需要折叠的项目");
    }
    const canvas = await this.readCanvas(false, generation);
    if (!canvas.revision) throw new Error("项目 Canvas 不存在");
    if (canvas.revision.hash !== snapshot.canvasRevisionHash) {
      throw new Error("Canvas 在折叠确认期间已经变化，请重试");
    }
    const current = new Set(snapshot.collapsedCompletedProjectIds);
    for (const projectId of requested) {
      if (collapsed) current.add(projectId);
      else current.delete(projectId);
    }
    canvas.document.helixCompletedCollapse = {
      version: 1,
      projectIds: [...current].sort(),
    };
    this.assertActive(generation);
    await this.writeCanvas(canvas, generation);
    return this.snapshot();
  }

  async planConnection(
    sourceCycleId: string,
    targetCycleId: string,
  ): Promise<ProjectConnectionPlan> {
    const snapshot = await this.ensureCanvas();
    const cycleIds = snapshot.projects.flatMap((project) =>
      project.cycles.map((cycle) => cycle.id));
    if (!cycleIds.includes(sourceCycleId) || !cycleIds.includes(targetCycleId)) {
      throw new Error("只能连接两个阶段节点");
    }
    if (sourceCycleId === targetCycleId) throw new Error("阶段不能连接到自身");
    const canvas = await this.readCanvas();
    const physical = physicalManagedEdges(canvas.document);
    if (physical.some((edge) =>
      edge.fromCycleId === sourceCycleId && edge.toCycleId === targetCycleId)) {
      throw new Error("这两个阶段已经连接");
    }
    const before = normalizeProjectGraph(cycleIds, physical);
    const candidate = [
      ...physical,
      {
        id: `helix-stage-edge-${crypto.randomUUID()}`,
        fromCycleId: sourceCycleId,
        toCycleId: targetCycleId,
      },
    ];
    const after = normalizeProjectGraph(cycleIds, candidate);
    const owner = cycleOwnerMap(snapshot.projects);
    const source = stageDescriptor(snapshot.projects, sourceCycleId);
    const target = stageDescriptor(snapshot.projects, targetCycleId);
    return {
      canvasRevisionHash: snapshot.canvasRevisionHash ?? "",
      sourceCycleId,
      targetCycleId,
      source,
      target,
      crossProject: owner.get(sourceCycleId) !== owner.get(targetCycleId),
      affectedNodeCount: affectedWeakComponent(
        [sourceCycleId, targetCycleId],
        candidate,
      ).size,
      relabeledEdgeCount: countRelabeledEdges(before, after),
    };
  }

  async connectCycles(
    plan: ProjectConnectionPlan,
    options: { confirmCrossProject?: boolean } = {},
  ): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const current = await this.snapshot();
    if (current.canvasRevisionHash !== plan.canvasRevisionHash) {
      throw new Error("Canvas 在连接确认期间已经变化，本次操作未写入");
    }
    const canonicalPlan = await this.planConnection(
      plan.sourceCycleId,
      plan.targetCycleId,
    );
    if (!sameConnectionPlan(plan, canonicalPlan)) {
      throw new Error("阶段连接计划已经变化，本次操作未写入");
    }
    if (canonicalPlan.crossProject && !options.confirmCrossProject) {
      throw new Error("跨项目阶段关系必须明确确认");
    }
    const snapshot = await this.snapshot();
    const canvas = await this.readCanvas(false, generation);
    if (!canvas.revision || canvas.revision.hash !== canonicalPlan.canvasRevisionHash ||
      snapshot.canvasRevisionHash !== canonicalPlan.canvasRevisionHash) {
      throw new Error("Canvas 在连接确认期间已经变化，本次操作未写入");
    }
    const cycleIds = snapshot.projects.flatMap((project) =>
      project.cycles.map((cycle) => cycle.id));
    const physical = physicalManagedEdges(canvas.document);
    if (physical.some((edge) =>
      edge.fromCycleId === canonicalPlan.sourceCycleId &&
      edge.toCycleId === canonicalPlan.targetCycleId)) {
      return snapshot;
    }
    physical.push({
      id: `helix-stage-edge-${crypto.randomUUID()}`,
      fromCycleId: canonicalPlan.sourceCycleId,
      toCycleId: canonicalPlan.targetCycleId,
    });
    const normalized = normalizeProjectGraph(cycleIds, physical);
    applyNormalizedManagedEdges(canvas.document, normalized.edges);
    const affected = affectedWeakComponent(
      [canonicalPlan.sourceCycleId, canonicalPlan.targetCycleId],
      physical,
    );
    applyManagedLayout(canvas.document, snapshot, physical, affected);
    this.assertActive(generation);
    await this.writeCanvas(canvas, generation);
    return this.snapshot();
  }

  async autoLayoutCanvas(): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const snapshot = await this.ensureCanvas();
    const canvas = await this.readCanvas(false, generation);
    if (!canvas.revision || canvas.revision.hash !== snapshot.canvasRevisionHash) {
      throw new Error("Canvas 在整理前已经变化，请重试");
    }
    const physical = physicalManagedEdges(canvas.document);
    applyManagedLayout(canvas.document, snapshot, physical);
    this.assertActive(generation);
    await this.writeCanvas(canvas, generation);
    return this.snapshot();
  }

  async planCycleDeletion(cycleId: string): Promise<StageDeletionPlan> {
    const snapshot = await this.ensureCanvas();
    const owner = snapshot.projects.find((project) =>
      project.cycles.some((cycle) => cycle.id === cycleId));
    if (!owner) throw new Error("找不到需要删除的阶段");
    if (owner.cycles.length === 1) throw new Error("项目至少需要保留一个阶段");
    const canvas = await this.readCanvas();
    const physical = physicalManagedEdges(canvas.document);
    const predecessors = physical
      .filter((edge) => edge.toCycleId === cycleId)
      .map((edge) => edge.fromCycleId);
    const successors = physical
      .filter((edge) => edge.fromCycleId === cycleId)
      .map((edge) => edge.toCycleId);
    const ownerByCycle = cycleOwnerMap(snapshot.projects);
    const bridgeCandidates = planDeletionBridges(cycleId, physical, ownerByCycle);
    const remainingIds = snapshot.projects.flatMap((project) =>
      project.cycles.filter((cycle) => cycle.id !== cycleId).map((cycle) => cycle.id));
    const before = normalizeProjectGraph(
      snapshot.projects.flatMap((project) => project.cycles.map((cycle) => cycle.id)),
      physical,
    );
    const remainingPhysical = physical.filter((edge) =>
      edge.fromCycleId !== cycleId && edge.toCycleId !== cycleId);
    const impact = (bridge: boolean): StageDeletionImpact => {
      const nextPhysical = remainingPhysical.map((edge) => ({ ...edge }));
      if (bridge) {
        for (const candidate of bridgeCandidates) {
          if (!candidate.existing) {
            nextPhysical.push({
              id: `preview:${candidate.fromCycleId}:${candidate.toCycleId}`,
              fromCycleId: candidate.fromCycleId,
              toCycleId: candidate.toCycleId,
            });
          }
        }
      }
      const after = normalizeProjectGraph(remainingIds, nextPhysical);
      const affected = affectedWeakComponent(
        [...predecessors, ...successors],
        nextPhysical,
      );
      return {
        affectedNodeCount: affected.size,
        affectedCycleIds: [...affected].sort(),
        relabeledEdges: relabeledEdges(before, after),
      };
    };
    return {
      canvasRevisionHash: snapshot.canvasRevisionHash ?? "",
      cycleId,
      bridgeCandidates,
      impacts: {
        bridge: impact(true),
        noBridge: impact(false),
      },
      bridgeLimitExceeded: bridgeCandidates.filter((candidate) => !candidate.existing).length > 24,
    };
  }

  async moveCanvasNodes(
    moves: ProjectWorkspaceNodeMove[],
  ): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    if (moves.length === 0) return this.snapshot();
    const nodeIds = new Set<string>();
    for (const move of moves) {
      if (
        !move.nodeId ||
        nodeIds.has(move.nodeId) ||
        !Number.isFinite(move.x) ||
        !Number.isFinite(move.y) ||
        Math.abs(move.x) > 1_000_000 ||
        Math.abs(move.y) > 1_000_000
      ) {
        throw new Error("Canvas 卡片移动计划无效");
      }
      nodeIds.add(move.nodeId);
    }
    const canvas = await this.readCanvas();
    if (!canvas.revision) throw new Error("项目 Canvas 不存在");
    const managedNodes = new Map(
      canvas.document.nodes
        .filter((node) => node.helixManaged === true)
        .map((node) => [node.id, node]),
    );
    for (const move of moves) {
      const node = managedNodes.get(move.nodeId);
      if (!node) throw new Error(`找不到 Canvas 卡片：${move.nodeId}`);
      node.x = Math.round(move.x);
      node.y = Math.round(move.y);
    }
    this.assertActive(generation);
    await this.writeCanvas(canvas, generation);
    return this.snapshot();
  }

  async replaceRelation(
    relationId: string,
    kind: CycleRelationKind,
    predecessorIds: string[],
    options: { confirmCrossProject?: boolean } = {},
  ): Promise<ProjectWorkspaceSnapshot> {
    return this.mutateRelation(
      relationId,
      {
        kind,
        fromCycleIds: assertCycleRelationInput(kind, predecessorIds),
      },
      options,
    );
  }

  async deleteRelation(relationId: string): Promise<ProjectWorkspaceSnapshot> {
    return this.mutateRelation(relationId, null);
  }

  async deleteCycle(
    planOrCycleId: StageDeletionPlan | string,
    options: { bridge?: boolean; confirmCrossProject?: boolean } = {},
  ): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const plan = typeof planOrCycleId === "string"
      ? await this.planCycleDeletion(planOrCycleId)
      : planOrCycleId;
    const cycleId = plan.cycleId;
    const current = await this.snapshot();
    if (current.canvasRevisionHash !== plan.canvasRevisionHash) {
      throw new Error("Canvas 在删除确认期间已经变化，本次操作未写入");
    }
    const canonicalPlan = await this.planCycleDeletion(cycleId);
    if (!sameDeletionPlan(plan, canonicalPlan)) {
      throw new Error("阶段删除计划已经变化，本次操作未写入");
    }
    const bridge = options.bridge ?? true;
    if (bridge && canonicalPlan.bridgeLimitExceeded) {
      throw new Error("桥接关系超过 24 条，请选择不桥接后再手动连线");
    }
    if (
      bridge &&
      canonicalPlan.bridgeCandidates.some((candidate) => candidate.crossProject) &&
      !options.confirmCrossProject
    ) {
      throw new Error("删除后的跨项目桥接必须明确确认");
    }
    const snapshot = await this.ensureCanvas();
    if (snapshot.canvasRevisionHash !== canonicalPlan.canvasRevisionHash) {
      throw new Error("Canvas 在删除确认期间已经变化，本次操作未写入");
    }
    const owner = snapshot.projects.find((project) =>
      project.cycles.some((cycle) => cycle.id === cycleId));
    const cycle = owner?.cycles.find((candidate) => candidate.id === cycleId);
    if (!owner || !cycle) throw new Error("找不到需要删除的阶段");
    if (owner.cycles.length === 1) {
      throw new Error("项目至少需要保留一个阶段，不能删除唯一阶段");
    }
    const cycleRevision = await this.repository.read(cycle.notePath);
    if (!cycleRevision) throw new Error("阶段 Markdown 已不存在");

    const canvas = await this.readCanvas(false, generation);
    if (!canvas.revision || canvas.revision.hash !== canonicalPlan.canvasRevisionHash) {
      throw new Error("Canvas 在删除确认期间已经变化，本次操作未写入");
    }
    const node = canvas.document.nodes.find((candidate) =>
      candidate.helixManaged === true && managedStageId(candidate) === cycleId);
    if (!node) throw new Error("Canvas 中找不到需要删除的阶段节点");
    const physical = physicalManagedEdges(canvas.document).filter((edge) =>
      edge.fromCycleId !== cycleId && edge.toCycleId !== cycleId);
    if (bridge) {
      for (const candidate of canonicalPlan.bridgeCandidates) {
        if (candidate.existing || physical.some((edge) =>
          edge.fromCycleId === candidate.fromCycleId &&
          edge.toCycleId === candidate.toCycleId)) continue;
        physical.push({
          id: `helix-stage-edge-${crypto.randomUUID()}`,
          fromCycleId: candidate.fromCycleId,
          toCycleId: candidate.toCycleId,
        });
      }
    }
    const remainingCycleIds = snapshot.projects.flatMap((project) =>
      project.cycles.filter((candidate) => candidate.id !== cycleId)
        .map((candidate) => candidate.id));
    const normalized = normalizeProjectGraph(remainingCycleIds, physical);
    canvas.document.nodes = canvas.document.nodes.filter((candidate) => candidate.id !== node.id);
    canvas.document.edges = canvas.document.edges.filter((edge) =>
      edge.fromNode !== node.id && edge.toNode !== node.id);
    applyNormalizedManagedEdges(canvas.document, normalized.edges);
    const selectedImpact = bridge
      ? canonicalPlan.impacts.bridge
      : canonicalPlan.impacts.noBridge;
    const affected = affectedWeakComponent(selectedImpact.affectedCycleIds, physical);
    const layoutSnapshot: ProjectWorkspaceSnapshot = {
      ...snapshot,
      projects: snapshot.projects.map((project) =>
        project.id === owner.id
          ? {
              ...project,
              cycles: project.cycles.filter((candidate) => candidate.id !== cycleId),
            }
          : project),
      canvasNodes: snapshot.canvasNodes.filter((candidate) =>
        candidate.entityId !== cycleId),
    };
    applyManagedLayout(canvas.document, layoutSnapshot, physical, affected);

    const nextCanvasContent = JSON.stringify(canvas.document, null, 2);
    const journal: StageDeletionJournal = {
      version: 1,
      operation: "delete-stage",
      createdAt: new Date().toISOString(),
      stageId: cycleId,
      stagePath: cycleRevision.path,
      stageHash: cycleRevision.hash,
      canvasPath: canvas.revision.path,
      canvasBeforeHash: canvas.revision.hash,
      canvasBeforeContent: canvas.revision.content,
      canvasAfterHash: stableHash(nextCanvasContent),
      canvasAfterContent: nextCanvasContent,
    };
    this.assertActive(generation);
    const journalRevision = await this.repository.create(
      this.stageDeletionJournalPath(),
      JSON.stringify(journal, null, 2),
      () => this.assertActive(generation),
    );
    let writtenCanvas: VaultRevision;
    try {
      await this.assertStageDeletionJournalCurrent(journalRevision);
      writtenCanvas = await this.repository.compareAndWrite(
        canvas.revision,
        nextCanvasContent,
        () => this.assertActive(generation),
      );
    } catch (error) {
      await this.finishStageDeletionJournal(journalRevision, generation);
      throw error;
    }
    try {
      await this.assertStageDeletionJournalCurrent(journalRevision);
      await this.repository.trashIfUnchanged(
        cycleRevision,
        () => this.assertActive(generation),
        { requireExisting: true },
      );
    } catch (error) {
      try {
        await this.repository.compareAndWrite(
          writtenCanvas,
          canvas.revision.content,
          () => this.assertActive(generation),
        );
      } catch (rollbackError) {
        const message =
          `阶段删除未完成，且 Canvas 回滚遇到竞争。事务日志已保留，重启时会冻结或恢复；Markdown 仍保留，请手动检查：${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`;
        this.freezePendingStageDeletion(message);
        throw new Error(message);
      }
      await this.finishStageDeletionJournal(journalRevision, generation);
      throw new Error(
        `阶段未删除，Canvas 已回滚：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.finishStageDeletionJournal(journalRevision, generation);
    return this.snapshot();
  }

  private stageDeletionJournalPath(): string {
    return normalizePath(`${this.rootFolder()}/.transactions/stage-delete.json`);
  }

  private parseStageDeletionJournal(content: string): StageDeletionJournal {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error("阶段删除事务日志损坏：不是有效 JSON");
    }
    if (!value || typeof value !== "object") {
      throw new Error("阶段删除事务日志损坏：根结构无效");
    }
    const journal = value as Partial<StageDeletionJournal>;
    const strings = [
      journal.createdAt,
      journal.stageId,
      journal.stagePath,
      journal.stageHash,
      journal.canvasPath,
      journal.canvasBeforeHash,
      journal.canvasBeforeContent,
      journal.canvasAfterHash,
      journal.canvasAfterContent,
    ];
    if (
      journal.version !== 1 ||
      journal.operation !== "delete-stage" ||
      strings.some((entry) => typeof entry !== "string" || !entry)
    ) {
      throw new Error("阶段删除事务日志损坏：字段不完整");
    }
    const parsed = journal as StageDeletionJournal;
    const root = `${normalizePath(this.rootFolder())}/`;
    if (
      normalizePath(parsed.stagePath) !== parsed.stagePath ||
      !parsed.stagePath.startsWith(root) ||
      !parsed.stagePath.endsWith(".md") ||
      parsed.canvasPath !== normalizePath(this.canvasPath()) ||
      stableHash(parsed.canvasBeforeContent) !== parsed.canvasBeforeHash ||
      stableHash(parsed.canvasAfterContent) !== parsed.canvasAfterHash
    ) {
      throw new Error("阶段删除事务日志损坏：路径或内容哈希无效");
    }
    return parsed;
  }

  private async findStageRevisions(stageId: string): Promise<VaultRevision[]> {
    const revisions: VaultRevision[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const revision = await this.repository.read(file.path);
      if (!revision) continue;
      const frontmatter = frontmatterFromContent(revision.content);
      if (
        (frontmatter?.["helix-kind"] === "helix-stage" ||
          frontmatter?.["helix-kind"] === "helix-cycle") &&
        frontmatter["helix-id"] === stageId
      ) {
        revisions.push(revision);
      }
    }
    return revisions;
  }

  private async finishStageDeletionJournal(
    revision: VaultRevision,
    generation: number,
  ): Promise<void> {
    try {
      await this.repository.trashIfUnchanged(
        revision,
        () => this.assertActive(generation),
        { requireExisting: true },
      );
    } catch (error) {
      const message =
        `阶段删除事务日志清理失败，项目写入已冻结：${
          error instanceof Error ? error.message : String(error)
        }`;
      this.freezePendingStageDeletion(message);
      throw new Error(message);
    }
  }

  private async assertStageDeletionJournalCurrent(
    revision: VaultRevision,
  ): Promise<void> {
    const current = await this.repository.read(revision.path);
    if (!current || current.hash !== revision.hash) {
      const message =
        "阶段删除事务日志在破坏性写入前发生变化，项目写入已冻结";
      this.freezePendingStageDeletion(message);
      throw new Error(message);
    }
  }

  private async mutateRelation(
    relationId: string,
    replacement: {
      kind: CycleRelationKind;
      fromCycleIds: string[];
    } | null,
    options: { confirmCrossProject?: boolean } = {},
  ): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const snapshot = await this.ensureCanvas();
    const current = snapshot.relations.find((relation) => relation.id === relationId);
    if (!current) throw new Error("找不到需要修改的阶段关系");
    const cycles = snapshot.projects.flatMap((project) => project.cycles);
    const knownCycles = new Set(cycles.map((cycle) => cycle.id));
    const ownerByCycle = new Map(
      snapshot.projects.flatMap((project) =>
        project.cycles.map((cycle) => [cycle.id, project.id] as const)),
    );
    if (replacement) {
      for (const predecessor of replacement.fromCycleIds) {
        if (!knownCycles.has(predecessor)) throw new Error("找不到前置阶段");
      }
      const targetOwner = ownerByCycle.get(current.toCycleId);
      if (
        replacement.fromCycleIds.some(
          (predecessor) => ownerByCycle.get(predecessor) !== targetOwner,
        ) &&
        !options.confirmCrossProject
      ) {
        throw new Error("跨项目阶段关系必须明确确认");
      }
    }

    const nextRelations = snapshot.relations.flatMap((relation) =>
      relation.id !== relationId
        ? [relation]
        : replacement
          ? [{
              id: relation.id,
              kind: replacement.kind,
              fromCycleIds: replacement.fromCycleIds,
              toCycleId: relation.toCycleId,
            }]
          : []);

    // 删除或改走一条分支后，原来源若只剩一个分支目标，就显式降为继承。
    // 这只修复由本次删除造成的悬空分支，不会猜测新关系的含义。
    const nextSources = new Set(replacement?.fromCycleIds ?? []);
    const normalizedRelationIds = new Set<string>();
    for (const sourceId of current.fromCycleIds) {
      if (nextSources.has(sourceId)) continue;
      const outgoing = nextRelations.filter((relation) =>
        relation.fromCycleIds.includes(sourceId));
      if (outgoing.length === 1 && outgoing[0]!.kind === "branch") {
        outgoing[0]!.kind = "inherit";
        normalizedRelationIds.add(outgoing[0]!.id);
      }
    }
    const canvas = await this.readCanvas(false, generation);
    if (!canvas.revision) throw new Error("项目 Canvas 不存在");
    const nodeByCycle = new Map(
      canvas.document.nodes.flatMap((node) => {
        const id = managedStageId(node);
        return id ? [[id, node] as const] : [];
      }),
    );
    const targetNode = nodeByCycle.get(current.toCycleId);
    if (!targetNode) throw new Error("Canvas 中缺少关系目标阶段");
    if (current.kind === "merge") {
      canvas.document.edges = canvas.document.edges.filter((edge) =>
        !(
          edge.helixManaged === true &&
          cycleRelationKindFromLabel(edge.helixRelation) === "merge" &&
          edge.toNode === targetNode.id
        ));
    } else {
      const beforeCount = canvas.document.edges.length;
      canvas.document.edges = canvas.document.edges.filter((edge) =>
        !(edge.helixManaged === true && edge.id === current.id));
      if (canvas.document.edges.length === beforeCount) {
        throw new Error("Canvas 中找不到需要修改的关系边");
      }
    }

    for (const normalizedId of normalizedRelationIds) {
      const edge = canvas.document.edges.find((candidate) =>
        candidate.helixManaged === true && candidate.id === normalizedId);
      if (!edge) throw new Error("Canvas 中找不到需要降为继承的剩余分支");
      edge.helixRelation = "inherit";
      edge.label = CYCLE_RELATION_LABELS.inherit;
      delete edge.helixMergeGroupId;
    }

    if (replacement) {
      const mergeGroupId = replacement.kind === "merge"
        ? `merge-${crypto.randomUUID()}`
        : undefined;
      for (const predecessorId of replacement.fromCycleIds) {
        const sourceNode = nodeByCycle.get(predecessorId);
        if (!sourceNode) throw new Error("Canvas 中缺少前置阶段");
        canvas.document.edges.push({
          id: `helix-stage-edge-${crypto.randomUUID()}`,
          fromNode: sourceNode.id,
          toNode: targetNode.id,
          label: CYCLE_RELATION_LABELS[replacement.kind],
          helixManaged: true,
          helixRelation: replacement.kind,
          ...(mergeGroupId ? { helixMergeGroupId: mergeGroupId } : {}),
        });
      }
    }
    const normalized = normalizeProjectGraph(
      cycles.map((cycle) => cycle.id),
      physicalManagedEdges(canvas.document),
    );
    applyNormalizedManagedEdges(canvas.document, normalized.edges);
    this.assertActive(generation);
    await this.writeCanvas(canvas, generation);
    return this.snapshot();
  }

  async acknowledgeLegacyMigration(
    confirmedItemIds: string[],
  ): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const snapshot = await this.snapshot();
    if (!snapshot.migrationRequired) return this.ensureCanvas();
    const confirmed = new Set(confirmedItemIds);
    const missing = snapshot.migrationItems.filter((item) => !confirmed.has(item.id));
    if (missing.length > 0) {
      throw new Error(`还有 ${missing.length} 项旧数据未确认`);
    }
    const canvas = await this.readCanvas(true, generation);
    const writtenMarkdown: Array<{ before: VaultRevision; after: VaultRevision }> = [];
    try {
      for (const project of snapshot.projects) {
        for (const cycle of project.cycles) {
          const before = await this.repository.read(cycle.notePath);
          if (!before) throw new Error(`迁移时阶段已被删除：${cycle.notePath}`);
          const frontmatter = frontmatterFromContent(before.content);
          if (typeof frontmatter?.["helix-project-id"] === "string") continue;
          const after = await this.repository.compareAndWrite(
            before,
            patchManagedFrontmatter(before.content, {
              "helix-project-id": project.id,
            }),
            () => this.assertActive(generation),
          );
          writtenMarkdown.push({ before, after });
        }
      }
      const projectById = new Map(
        snapshot.projects.map((project) => [project.id, project]),
      );
      for (const node of canvas.document.nodes) {
        if (
          node.helixManaged !== true ||
          node.helixNodeKind !== undefined ||
          typeof node.helixProjectId !== "string"
        ) continue;
        const project = projectById.get(node.helixProjectId);
        if (!project) continue;
        node.helixNodeKind = "project";
        node.helixFilePath = normalizePath(project.notePath);
        node.type = "text";
        node.text = canvasCardText(
          project.notePath,
          project.title,
          projectStatusText(project.status),
        );
        delete node.file;
      }
      addMissingManagedNodes(canvas.document, snapshot);
      canvas.document.helixMigration = {
        version: 2,
        legacyPreserved: true,
        acknowledgedAt: new Date().toISOString(),
        acknowledgedItemIds: [
          ...new Set([
            ...(canvas.document.helixMigration?.acknowledgedItemIds ?? []),
            ...confirmedItemIds,
          ]),
        ].sort(),
      };
      this.assertActive(generation);
      await this.writeCanvas(canvas, generation);
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const write of writtenMarkdown.reverse()) {
        try {
          await this.repository.compareAndWrite(write.after, write.before.content);
        } catch (rollbackError) {
          rollbackErrors.push(
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          );
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(
          `迁移失败且回滚遇到竞争，已冻结后续写入：${rollbackErrors.join("；")}`,
        );
      }
      throw error;
    }
    return this.snapshot();
  }

  async createProject(
    title: string,
    didaProjectId?: string,
    color?: string,
  ): Promise<ProjectWorkspaceProject> {
    const generation = this.beginOperation();
    const normalizedTitle = title.trim();
    const normalizedColor = normalizeProjectColor(color);
    if (!normalizedTitle) throw new Error("请输入项目名称");
    assertSingleLineTitle(normalizedTitle, "项目名称");
    const folderName = sanitizeFileName(normalizedTitle);
    const folder = normalizePath(`${this.rootFolder()}/Projects/${folderName}`);
    const projectPath = normalizePath(`${folder}/Project.md`);
    const cyclePath = normalizePath(`${folder}/Stage-01.md`);
    if (await this.repository.read(projectPath)) {
      throw new Error(`项目已经存在：${projectPath}`);
    }
    if (await this.repository.read(cyclePath)) {
      throw new Error(`阶段文件已经存在：${cyclePath}`);
    }
    const before = await this.ensureCanvas();
    if (
      didaProjectId &&
      before.projects.some((project) => project.didaProjectId === didaProjectId)
    ) {
      throw new Error("该滴答清单已映射到另一个 Helix 项目");
    }
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const cycleId = crypto.randomUUID();
    const canvas = await this.readCanvas(true, generation);
    const createdRevisions: VaultRevision[] = [];
    let canvasWritten = false;
    try {
      createdRevisions.push(await this.repository.create(
        projectPath,
        projectTemplate({
          id: projectId,
          title: normalizedTitle,
          createdAt: now,
          didaProjectId,
          color: normalizedColor,
        }),
        () => this.assertActive(generation),
      ));
      createdRevisions.push(await this.repository.create(
        cyclePath,
        cycleTemplate({
          id: cycleId,
          projectId,
          projectLink: "[[Project]]",
          sequence: 1,
          startedAt: now,
          stageTitle: "项目启动",
        }),
        () => this.assertActive(generation),
      ));
      const plannedProject: ProjectWorkspaceProject = {
        id: projectId,
        title: normalizedTitle,
        status: "active",
        notePath: projectPath,
        didaProjectId,
        color: normalizedColor,
        cycles: [{
          id: cycleId,
          title: "项目启动",
          notePath: cyclePath,
          sequence: 1,
          status: "active",
        }],
      };
      addMissingManagedNodes(canvas.document, {
        ...before,
        projects: [...before.projects, plannedProject],
      });
      const plannedProjects = [...before.projects, plannedProject];
      const plannedSnapshot: ProjectWorkspaceSnapshot = {
        ...before,
        projects: plannedProjects,
        canvasNodes: managedCanvasNodeViews(canvas.document, plannedProjects),
      };
      applyManagedLayout(
        canvas.document,
        plannedSnapshot,
        physicalManagedEdges(canvas.document),
        new Set([cycleId]),
      );
      canvas.document.helixStageSequences = {
        ...validatedStageSequenceLedger(canvas.document),
        [projectId]: 1,
      };
      this.assertActive(generation);
      await this.writeCanvas(canvas, generation);
      canvasWritten = true;
    } catch (error) {
      if (!canvasWritten) await this.rollbackCreatedFiles(createdRevisions, error);
      throw error;
    }
    const created = (await this.snapshot()).projects.find((project) => project.id === projectId);
    if (!created) throw new Error("项目已写入，但重新扫描未找到，请检查 Markdown 元数据");
    return created;
  }

  async createCycle(
    projectId: string,
    kind: "auto",
    predecessorIds: string[],
    options: CycleCreationOptions & {
      expectedAutoIntent: ExpectedAutoStageIntent;
    },
  ): Promise<ProjectWorkspaceCycle>;
  async createCycle(
    projectId: string,
    kind: CycleRelationKind,
    predecessorIds: string[],
    options?: CycleCreationOptions,
  ): Promise<ProjectWorkspaceCycle>;
  async createCycle(
    projectId: string,
    kind: CycleRelationKind | "auto",
    predecessorIds: string[],
    options: CycleCreationOptions & {
      expectedAutoIntent?: ExpectedAutoStageIntent;
    } = {},
  ): Promise<ProjectWorkspaceCycle> {
    const generation = this.beginOperation();
    const snapshot = await this.ensureCanvas();
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("找不到项目");
    const stageTitle = options.stageTitle?.trim();
    if (!stageTitle) throw new Error("请输入阶段标题");
    assertSingleLineTitle(stageTitle, "阶段标题");
    const secondaryStageTitle = options.secondaryStageTitle?.trim();
    if (secondaryStageTitle) {
      assertSingleLineTitle(secondaryStageTitle, "第二分支阶段标题");
    }
    const autoIntent = kind === "auto"
      ? stageCreationIntent(predecessorIds, snapshot.relations)
      : null;
    if (kind === "auto" && !options.expectedAutoIntent) {
      throw new Error("自动创建阶段必须携带用户确认的完整关系意图");
    }
    if (autoIntent && options.expectedAutoIntent && (
      options.expectedAutoIntent.relation !== autoIntent.relation ||
      !sameStringSet(
        options.expectedAutoIntent.convertedInheritanceRelationIds,
        autoIntent.convertedInheritanceRelationIds,
      )
    )) {
      throw new Error("来源阶段关系已经变化，请关闭弹窗后重新点击加号");
    }
    const relationKind: CycleRelationKind = autoIntent
      ? autoIntent.relation
      : kind as CycleRelationKind;
    const predecessors = assertCycleRelationInput(relationKind, predecessorIds);
    const allCycles = snapshot.projects.flatMap((candidate) => candidate.cycles);
    const knownCycles = new Set(allCycles.map((cycle) => cycle.id));
    for (const predecessor of predecessors) {
      if (!knownCycles.has(predecessor)) {
        throw new Error("找不到前置阶段");
      }
    }
    const cycleOwners = new Map(
      snapshot.projects.flatMap((candidate) =>
        candidate.cycles.map((cycle) => [cycle.id, candidate.id] as const)),
    );
    if (
      predecessors.some((predecessor) => cycleOwners.get(predecessor) !== projectId) &&
      !options.confirmCrossProject
    ) {
      throw new Error("跨项目阶段关系必须明确确认");
    }
    let createCount = 1;
    let convertedInheritances = autoIntent
      ? snapshot.relations.filter((relation) =>
          autoIntent.convertedInheritanceRelationIds.includes(relation.id))
      : [];
    if (relationKind === "branch") {
      if (kind !== "auto" && !options.confirmBranchConversion) {
        throw new Error("创建分支前必须确认分支计划");
      }
      const source = predecessors[0]!;
      const outgoing = snapshot.relations.filter((relation) =>
        relation.fromCycleIds.includes(source));
      if (outgoing.length === 0) {
        createCount = 2;
        if (!secondaryStageTitle) {
          throw new Error("首次创建分支时，请分别填写两个分支阶段标题");
        }
      } else if (outgoing.length === 1 && outgoing[0]!.kind === "inherit") {
        convertedInheritances = [outgoing[0]!];
      } else if (outgoing.some((relation) => relation.kind === "inherit")) {
        throw new Error("该前置阶段的后继关系无法直接扩展为分支");
      }
    }
    const canvas = await this.readCanvas(false, generation);
    if (!canvas.revision) throw new Error("项目 Canvas 不存在");
    if (canvas.revision.hash !== snapshot.canvasRevisionHash) {
      throw new Error("项目 Canvas 已变化，请重新点击加号后再创建阶段");
    }
    const firstSequence = snapshot.nextStageSequenceByProject[projectId];
    if (
      firstSequence === undefined ||
      !Number.isSafeInteger(firstSequence) ||
      !Number.isSafeInteger(firstSequence + createCount - 1)
    ) {
      throw new Error("阶段编号已达到安全上限，无法继续创建阶段");
    }
    const folder = parentPath(project.notePath);
    const specs = Array.from({ length: createCount }, (_, index) => {
      const sequence = firstSequence + index;
      const name = `Stage-${String(sequence).padStart(2, "0")}`;
      return {
        id: crypto.randomUUID(),
        sequence,
        name,
        path: normalizePath(`${folder}/${name}.md`),
        stageTitle: index === 1 ? secondaryStageTitle! : stageTitle,
      };
    });
    for (const spec of specs) {
      if (await this.repository.read(spec.path)) {
        throw new Error(`阶段已经存在：${spec.path}`);
      }
    }
    const createdRevisions: VaultRevision[] = [];
    try {
      for (const spec of specs) {
        const revision = await this.repository.create(
          spec.path,
          cycleTemplate({
            id: spec.id,
            projectId,
            projectLink: "[[Project]]",
            sequence: spec.sequence,
            startedAt: new Date().toISOString(),
            stageTitle: spec.stageTitle,
          }),
          () => this.assertActive(generation),
        );
        createdRevisions.push(revision);
      }
    } catch (error) {
      await this.rollbackCreatedFiles(createdRevisions, error);
    }
    let canvasWritten = false;
    try {
      const plannedCycles = specs.map((spec) => ({
      id: spec.id,
      title: spec.stageTitle,
      notePath: spec.path,
      sequence: spec.sequence,
      status: "active" as const,
    }));
      const plannedSnapshot: ProjectWorkspaceSnapshot = {
      ...snapshot,
      projects: snapshot.projects.map((candidate) =>
        candidate.id === projectId
          ? { ...candidate, cycles: [...candidate.cycles, ...plannedCycles] }
          : candidate),
    };
      addMissingManagedNodes(canvas.document, plannedSnapshot);
      const nodeByPath = new Map(
      canvas.document.nodes
        .map((node) => [managedNodePath(node), node] as const)
        .filter((entry): entry is [string, CanvasNode] => typeof entry[0] === "string")
        .map(([path, node]) => [normalizePath(path), node]),
    );
      const canvasNodeByCycle = new Map(
      canvas.document.nodes.flatMap((node) => {
        const id = managedStageId(node);
        return id ? [[id, node] as const] : [];
      }),
    );
      const canvasNumber = (value: unknown, fallback: number): number =>
        Number.isFinite(value) ? Number(value) : fallback;
      const targetNodes = specs.map((spec) => {
      const node = nodeByPath.get(spec.path);
      if (!node) throw new Error("阶段已创建，但 Canvas 节点补齐失败");
      return node;
    });
      if (relationKind === "merge") {
      const sourceNodes = predecessors.map((id) => canvasNodeByCycle.get(id));
      if (sourceNodes.some((node) => !node)) {
        throw new Error("Canvas 中缺少合并关系的前置阶段");
      }
      const right = Math.max(...sourceNodes.map((node) =>
        canvasNumber(node!.x, 0) + canvasNumber(node!.width, 360)));
      const centers = sourceNodes.map((node) =>
        canvasNumber(node!.y, 0) + canvasNumber(node!.height, 220) / 2);
      const target = targetNodes[0]!;
      target.x = Math.round(right + 160);
      target.y = Math.round(
        centers.reduce((sum, value) => sum + value, 0) / centers.length -
        canvasNumber(target.height, 220) / 2,
      );
      } else {
      const sourceId = predecessors[0]!;
      const source = canvasNodeByCycle.get(sourceId);
      if (!source) throw new Error("Canvas 中缺少前置阶段");
      const sourceX = canvasNumber(source.x, 0);
      const sourceY = canvasNumber(source.y, 0);
      const sourceWidth = canvasNumber(source.width, 360);
      const sourceHeight = canvasNumber(source.height, 220);
      const targetX = sourceX + sourceWidth + 160;
      if (relationKind === "inherit") {
        targetNodes[0]!.x = Math.round(targetX);
        targetNodes[0]!.y = Math.round(sourceY);
      } else {
        const existingTargets = snapshot.relations
          .filter((relation) => relation.fromCycleIds.includes(sourceId))
          .map((relation) => canvasNodeByCycle.get(relation.toCycleId))
          .filter((node): node is CanvasNode => Boolean(node));
        const nextBranchY = existingTargets.length === 0
          ? sourceY
          : Math.max(...existingTargets.map((node) =>
              canvasNumber(node.y, sourceY) + canvasNumber(node.height, 220))) + 80;
        targetNodes.forEach((target, index) => {
          target.x = Math.round(targetX);
          target.y = Math.round(
            nextBranchY + index * (canvasNumber(target.height, sourceHeight) + 80),
          );
        });
      }
      }
      const relationPlan = [...snapshot.relations];
      for (const convertedInheritance of convertedInheritances) {
        const relationIndex = relationPlan.findIndex(
          (relation) => relation.id === convertedInheritance.id,
        );
        if (relationIndex < 0) throw new Error("找不到需要转换的继承关系");
        relationPlan.splice(relationIndex, 1, {
          ...convertedInheritance,
          kind: "branch",
        });
        const fromCycle = allCycles.find(
          (cycle) => cycle.id === convertedInheritance.fromCycleIds[0],
        )!;
        const toCycle = allCycles.find(
          (cycle) => cycle.id === convertedInheritance.toCycleId,
        )!;
        const fromNode = nodeByPath.get(normalizePath(fromCycle.notePath));
        const toNode = nodeByPath.get(normalizePath(toCycle.notePath));
        const edge = canvas.document.edges.find(
          (candidate) =>
            candidate.id === convertedInheritance.id &&
            candidate.helixManaged === true &&
            candidate.fromNode === fromNode?.id &&
            candidate.toNode === toNode?.id,
        );
        if (!edge) throw new Error("找不到需要转换为分支的继承边");
        edge.helixManaged = true;
        edge.helixRelation = "branch";
        edge.label = CYCLE_RELATION_LABELS.branch;
      }
      const mergeGroupId = relationKind === "merge"
      ? `merge-${crypto.randomUUID()}`
      : undefined;
      for (const spec of specs) {
      const target = nodeByPath.get(spec.path);
      if (!target) throw new Error("阶段已创建，但 Canvas 节点补齐失败");
      for (const predecessorId of predecessors) {
        const predecessor = allCycles.find((cycle) => cycle.id === predecessorId)!;
        const source = nodeByPath.get(normalizePath(predecessor.notePath));
        if (!source) throw new Error(`Canvas 中缺少前置阶段：${predecessor.title}`);
        canvas.document.edges.push({
          id: `helix-stage-edge-${crypto.randomUUID()}`,
          fromNode: source.id,
          toNode: target.id,
          label: CYCLE_RELATION_LABELS[relationKind],
          helixManaged: true,
          helixRelation: relationKind,
          ...(mergeGroupId ? { helixMergeGroupId: mergeGroupId } : {}),
        });
      }
      relationPlan.push({
        id: `pending:${spec.id}`,
        kind: relationKind,
        fromCycleIds: predecessors,
        toCycleId: spec.id,
      });
      }
      validateCycleGraph(
        [...allCycles.map((cycle) => cycle.id), ...specs.map((spec) => spec.id)],
        relationPlan,
      );
      canvas.document.helixStageSequences = {
        ...validatedStageSequenceLedger(canvas.document),
        [projectId]: specs.at(-1)!.sequence,
      };
      const physical = physicalManagedEdges(canvas.document);
      const normalized = normalizeProjectGraph(
        [...allCycles.map((cycle) => cycle.id), ...specs.map((spec) => spec.id)],
        physical,
      );
      applyNormalizedManagedEdges(canvas.document, normalized.edges);
      const plannedProjects = snapshot.projects.map((candidate) =>
        candidate.id !== projectId
          ? candidate
          : {
              ...candidate,
              cycles: [
                ...candidate.cycles,
                ...specs.map((spec) => ({
                  id: spec.id,
                  title: spec.stageTitle,
                  notePath: spec.path,
                  sequence: spec.sequence,
                  status: "active" as const,
                })),
              ],
            });
      const plannedNodes = [
        ...snapshot.canvasNodes,
        ...specs.map((spec) => {
          const node = canvas.document.nodes.find((candidate) =>
            managedStageId(candidate) === spec.id);
          if (!node) throw new Error("Canvas 中缺少新建阶段节点");
          return canvasNodeView(node, {
            entityId: spec.id,
            projectId,
            kind: "cycle",
            notePath: spec.path,
            title: spec.stageTitle,
          });
        }),
      ];
      const layoutSnapshot: ProjectWorkspaceSnapshot = {
        ...snapshot,
        projects: plannedProjects,
        canvasNodes: plannedNodes,
        relations: normalized.relations,
      };
      applyManagedLayout(
        canvas.document,
        layoutSnapshot,
        physical,
        affectedWeakComponent([...predecessors, ...specs.map((spec) => spec.id)], physical),
      );
      this.assertActive(generation);
      await this.writeCanvas(canvas, generation);
      canvasWritten = true;
    } catch (error) {
      if (!canvasWritten) {
        await this.rollbackCreatedFiles(createdRevisions, error);
      }
      throw error;
    }
    const created = (await this.snapshot()).projects
      .find((candidate) => candidate.id === projectId)
      ?.cycles.find((cycle) => cycle.id === specs[0]!.id);
    if (!created) throw new Error("阶段已写入，但重新扫描未找到");
    return created;
  }

  private async rollbackCreatedFiles(
    revisions: VaultRevision[],
    cause: unknown,
  ): Promise<never> {
    const rollbackErrors: string[] = [];
    for (const revision of [...revisions].reverse()) {
      try {
        await this.repository.trashIfUnchanged(revision);
      } catch (error) {
        rollbackErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    if (rollbackErrors.length > 0) {
      throw new Error(
        `阶段操作失败且回滚遇到竞争，已停止后续写入：${message}；${rollbackErrors.join("；")}`,
      );
    }
    throw new Error(`阶段操作失败，已将新建文件移入废纸篓：${message}`);
  }

  private async readCanvas(
    createIfMissing = false,
    generation?: number,
  ): Promise<{
    revision: VaultRevision | null;
    document: CanvasDocument;
  }> {
    const path = normalizePath(this.canvasPath());
    let revision = await this.repository.read(path);
    if (!revision && createIfMissing) {
      revision = await this.repository.create(
        path,
        JSON.stringify({ nodes: [], edges: [] }, null, 2),
        generation === undefined
          ? undefined
          : () => this.assertActive(generation),
      );
    }
    if (!revision) return { revision: null, document: { nodes: [], edges: [] } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(revision.content);
    } catch {
      throw new Error(`项目 Canvas 不是有效 JSON：${path}`);
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as Partial<CanvasDocument>).nodes) ||
      !Array.isArray((parsed as Partial<CanvasDocument>).edges)
    ) {
      throw new Error(`项目 Canvas 缺少 nodes 或 edges：${path}`);
    }
    return { revision, document: parsed as CanvasDocument };
  }

  private async writeCanvas(canvas: {
    revision: VaultRevision | null;
    document: CanvasDocument;
  }, generation?: number): Promise<void> {
    const content = JSON.stringify(canvas.document, null, 2);
    const fence = generation === undefined
      ? undefined
      : () => this.assertActive(generation);
    if (canvas.revision) {
      await this.repository.compareAndWrite(canvas.revision, content, fence);
    } else {
      await this.repository.create(normalizePath(this.canvasPath()), content, fence);
    }
  }
}

function cardNode(
  id: string,
  file: string,
  title: string,
  status: string,
  x: number,
  y: number,
  width: number,
  height: number,
  metadata: Record<string, unknown>,
): CanvasNode {
  return {
    id,
    type: "text",
    text: canvasCardText(file, title, status),
    helixFilePath: normalizePath(file),
    x,
    y,
    width,
    height,
    helixManaged: true,
    ...metadata,
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function normalizeProjectColor(value?: string): string | undefined {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return undefined;
  if (!/^#[0-9A-F]{6}$/.test(normalized)) {
    throw new Error("项目颜色必须是 #RRGGBB 格式");
  }
  return normalized;
}

function parseProjectColor(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`项目颜色格式无效：${path}`);
  try {
    return normalizeProjectColor(value);
  } catch {
    throw new Error(`项目颜色格式无效：${path}`);
  }
}

function validatedCompletedCollapse(
  document: CanvasDocument,
  projectIds: ReadonlySet<string>,
): string[] {
  const value = document.helixCompletedCollapse;
  if (value === undefined) return [];
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.projectIds) ||
    value.projectIds.some((id) => typeof id !== "string" || !projectIds.has(id))
  ) {
    throw new Error("Canvas 已完成阶段折叠状态无效");
  }
  return [...new Set(value.projectIds)].sort();
}

function cycleOwnerMap(
  projects: ProjectWorkspaceProject[],
): Map<string, string> {
  return new Map(projects.flatMap((project) =>
    project.cycles.map((cycle) => [cycle.id, project.id] as const)));
}

function physicalManagedEdges(document: CanvasDocument): ProjectGraphEdge[] {
  const stageByNode = new Map(document.nodes.flatMap((node) => {
    const stageId = managedStageId(node);
    return stageId ? [[node.id, stageId] as const] : [];
  }));
  return document.edges.flatMap((edge) => {
    if (edge.helixManaged !== true || isLegacyDerivesEdge(edge)) return [];
    const fromCycleId = stageByNode.get(edge.fromNode);
    const toCycleId = stageByNode.get(edge.toNode);
    return fromCycleId && toCycleId
      ? [{ id: edge.id, fromCycleId, toCycleId }]
      : [];
  });
}

function applyNormalizedManagedEdges(
  document: CanvasDocument,
  normalized: ReturnType<typeof normalizeProjectGraph>["edges"],
): void {
  const nodeByStage = new Map(document.nodes.flatMap((node) => {
    const stageId = managedStageId(node);
    return stageId ? [[stageId, node] as const] : [];
  }));
  const stageNodeIds = new Set([...nodeByStage.values()].map((node) => node.id));
  const existing = new Map(document.edges
    .filter((edge) => edge.helixManaged === true)
    .map((edge) => [edge.id, edge]));
  const next = normalized.map((edge) => {
    const source = nodeByStage.get(edge.fromCycleId);
    const target = nodeByStage.get(edge.toCycleId);
    if (!source || !target) throw new Error("Canvas 中缺少关系阶段节点");
    const preserved = existing.get(edge.id) ?? {
      id: edge.id,
      fromNode: source.id,
      toNode: target.id,
    };
    preserved.fromNode = source.id;
    preserved.toNode = target.id;
    preserved.helixManaged = true;
    preserved.helixRelation = edge.kind;
    preserved.label = CYCLE_RELATION_LABELS[edge.kind];
    if (edge.mergeGroupId) preserved.helixMergeGroupId = edge.mergeGroupId;
    else delete preserved.helixMergeGroupId;
    return preserved;
  });
  document.edges = [
    ...document.edges.filter((edge) =>
      edge.helixManaged !== true ||
      isLegacyDerivesEdge(edge) ||
      !stageNodeIds.has(edge.fromNode) ||
      !stageNodeIds.has(edge.toNode)),
    ...next,
  ];
}

function isLegacyDerivesEdge(edge: CanvasEdge): boolean {
  return edge.label === "derives-from" || edge.helixRelation === "derives-from";
}

function countRelabeledEdges(
  before: ReturnType<typeof normalizeProjectGraph>,
  after: ReturnType<typeof normalizeProjectGraph>,
): number {
  const beforeKind = new Map(before.edges.map((edge) => [edge.id, edge.kind]));
  return after.edges.filter((edge) =>
    beforeKind.has(edge.id) && beforeKind.get(edge.id) !== edge.kind).length;
}

function relabeledEdges(
  before: ReturnType<typeof normalizeProjectGraph>,
  after: ReturnType<typeof normalizeProjectGraph>,
): StageDeletionImpact["relabeledEdges"] {
  const beforeKind = new Map(before.edges.map((edge) => [edge.id, edge.kind]));
  return after.edges.flatMap((edge) => {
    const previous = beforeKind.get(edge.id);
    return previous && previous !== edge.kind
      ? [{
          edgeId: edge.id,
          fromCycleId: edge.fromCycleId,
          toCycleId: edge.toCycleId,
          before: previous,
          after: edge.kind,
        }]
      : [];
  }).sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

function sameConnectionPlan(
  left: ProjectConnectionPlan,
  right: ProjectConnectionPlan,
): boolean {
  return left.canvasRevisionHash === right.canvasRevisionHash &&
    left.sourceCycleId === right.sourceCycleId &&
    left.targetCycleId === right.targetCycleId &&
    JSON.stringify(left.source) === JSON.stringify(right.source) &&
    JSON.stringify(left.target) === JSON.stringify(right.target) &&
    left.crossProject === right.crossProject &&
    left.affectedNodeCount === right.affectedNodeCount &&
    left.relabeledEdgeCount === right.relabeledEdgeCount;
}

function stageDescriptor(
  projects: ProjectWorkspaceProject[],
  stageId: string,
): ProjectConnectionPlan["source"] {
  for (const project of projects) {
    const cycle = project.cycles.find((candidate) => candidate.id === stageId);
    if (!cycle) continue;
    return {
      projectId: project.id,
      projectTitle: project.title,
      cycleTitle: cycle.title,
      sequence: cycle.sequence,
    };
  }
  throw new Error("找不到阶段说明");
}

function managedCanvasNodeViews(
  document: CanvasDocument,
  projects: ProjectWorkspaceProject[],
): ProjectWorkspaceCanvasNode[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const stageById = new Map(projects.flatMap((project) =>
    project.cycles.map((cycle) => [
      cycle.id,
      { cycle, projectId: project.id },
    ] as const)));
  return document.nodes.flatMap((node) => {
    if (node.helixManaged !== true) return [];
    if (
      node.helixNodeKind === "project" &&
      typeof node.helixProjectId === "string"
    ) {
      const project = projectById.get(node.helixProjectId);
      return project
        ? [canvasNodeView(node, {
            entityId: project.id,
            projectId: project.id,
            kind: "project",
            notePath: project.notePath,
            title: project.title,
          })]
        : [];
    }
    const stageId = managedStageId(node);
    const stage = stageId ? stageById.get(stageId) : undefined;
    return stage
      ? [canvasNodeView(node, {
          entityId: stage.cycle.id,
          projectId: stage.projectId,
          kind: "cycle",
          notePath: stage.cycle.notePath,
          title: stage.cycle.title,
        })]
      : [];
  });
}

function sameDeletionPlan(
  left: StageDeletionPlan,
  right: StageDeletionPlan,
): boolean {
  return left.canvasRevisionHash === right.canvasRevisionHash &&
    left.cycleId === right.cycleId &&
    left.bridgeLimitExceeded === right.bridgeLimitExceeded &&
    JSON.stringify(left.impacts) === JSON.stringify(right.impacts) &&
    JSON.stringify(left.bridgeCandidates) === JSON.stringify(right.bridgeCandidates);
}

function applyManagedLayout(
  document: CanvasDocument,
  snapshot: ProjectWorkspaceSnapshot,
  edges: ProjectGraphEdge[],
  scope?: ReadonlySet<string>,
): void {
  const viewByEntity = new Map(snapshot.canvasNodes.map((node) => [node.entityId, node]));
  const layout = planProjectGraphLayout(
    snapshot.projects.map((project) => {
      const node = viewByEntity.get(project.id);
      return { id: project.id, x: node?.x ?? 0, y: node?.y ?? 0 };
    }),
    snapshot.projects.flatMap((project) =>
      project.cycles.map((cycle) => {
        const node = viewByEntity.get(cycle.id);
        return {
          id: cycle.id,
          projectId: project.id,
          sequence: cycle.sequence,
          x: node?.x ?? 0,
          y: node?.y ?? 0,
        };
      })),
    edges,
    scope,
  );
  const position = new Map([
    ...layout.projects.map((node) => [node.id, node] as const),
    ...layout.stages.map((node) => [node.id, node] as const),
  ]);
  if ([...position.values()].some((node) =>
    !Number.isFinite(node.x) ||
    !Number.isFinite(node.y) ||
    Math.abs(node.x) > 1_000_000 ||
    Math.abs(node.y) > 1_000_000)) {
    throw new Error("自动布局超出 Canvas 安全坐标范围，本次操作未写入");
  }
  for (const node of document.nodes) {
    if (node.helixManaged !== true) continue;
    const entityId = node.helixNodeKind === "project" &&
      typeof node.helixProjectId === "string"
      ? node.helixProjectId
      : managedStageId(node);
    const next = entityId ? position.get(entityId) : undefined;
    if (!next) continue;
    node.x = Math.round(next.x);
    node.y = Math.round(next.y);
  }
}

function projectStatusText(status: ProjectWorkspaceProject["status"]): string {
  return {
    planned: "计划中",
    active: "进行中",
    paused: "已暂停",
    completed: "已完成",
    archived: "已归档",
  }[status];
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "未命名项目";
}

function assertSingleLineTitle(value: string, label: string): void {
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) {
    throw new Error(`${label}只能使用单行可见文字`);
  }
  if (value.length > 160) throw new Error(`${label}不能超过 160 个字符`);
}

function parentPath(path: string): string {
  const segments = normalizePath(path).split("/");
  segments.pop();
  return segments.join("/");
}

function deduplicateMigrationItems(
  items: ProjectWorkspaceMigrationItem[],
): ProjectWorkspaceMigrationItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function migrationFingerprint(value: unknown): string {
  return stableHash(JSON.stringify(value) ?? "undefined").slice(0, 16);
}

function addMissingManagedNodes(
  document: CanvasDocument,
  snapshot: ProjectWorkspaceSnapshot,
): void {
  const existingProjects = new Set(
    document.nodes.flatMap((node) =>
      node.helixManaged === true &&
      node.helixNodeKind === "project" &&
      typeof node.helixProjectId === "string"
        ? [node.helixProjectId]
        : []),
  );
  const existingCycles = new Set(
    document.nodes.flatMap((node) =>
      node.helixManaged === true && managedStageId(node)
        ? [managedStageId(node)!]
        : []),
  );
  snapshot.projects.forEach((project, projectIndex) => {
    if (!existingProjects.has(project.id)) {
      document.nodes.push(cardNode(
        `helix-project-${project.id}`,
        project.notePath,
        project.title,
        projectStatusText(project.status),
        projectIndex * 520,
        0,
        360,
        220,
        {
          helixNodeKind: "project",
          helixProjectId: project.id,
        },
      ));
      existingProjects.add(project.id);
    }
    project.cycles.forEach((cycle, cycleIndex) => {
      if (existingCycles.has(cycle.id)) return;
      document.nodes.push(cardNode(
        `helix-stage-${cycle.id}`,
        cycle.notePath,
        cycle.title,
        cycle.status === "active"
          ? "进行中"
          : cycle.status === "closed"
            ? "已关闭"
            : "计划中",
        projectIndex * 520,
        300 + cycleIndex * 260,
        360,
        220,
        {
          helixNodeKind: "stage",
          helixProjectId: project.id,
          helixStageId: cycle.id,
        },
      ));
      existingCycles.add(cycle.id);
    });
  });
}

function ensureStageSequenceLedger(
  document: CanvasDocument,
  snapshot: ProjectWorkspaceSnapshot,
): boolean {
  const current = validatedStageSequenceLedger(document);
  const next = { ...current };
  let changed = document.helixStageSequences === undefined;
  for (const project of snapshot.projects) {
    const liveMaximum = Math.max(
      0,
      ...project.cycles.map((cycle) => cycle.sequence),
    );
    const rawRecorded = current[project.id];
    if (
      rawRecorded !== undefined &&
      (!Number.isSafeInteger(rawRecorded) || Number(rawRecorded) < 0)
    ) {
      throw new Error(`Canvas 阶段编号高水位无效：${project.title}`);
    }
    const recorded = rawRecorded === undefined ? 0 : Number(rawRecorded);
    if (recorded < liveMaximum || current[project.id] === undefined) {
      next[project.id] = Math.max(recorded, liveMaximum);
      changed = true;
    }
  }
  if (changed) document.helixStageSequences = next;
  return changed;
}

function nextStageSequence(
  document: CanvasDocument,
  project: ProjectWorkspaceProject,
): number {
  const liveMaximum = Math.max(
    0,
    ...project.cycles.map((cycle) => cycle.sequence),
  );
  const rawRecorded = validatedStageSequenceLedger(document)[project.id];
  const maximum = Math.max(
    liveMaximum,
    rawRecorded === undefined ? 0 : Number(rawRecorded),
  );
  if (maximum >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`阶段编号已达到安全上限：${project.title}`);
  }
  return maximum + 1;
}

function validatedStageSequenceLedger(
  document: CanvasDocument,
): Record<string, number> {
  const raw = (document as Record<string, unknown>).helixStageSequences;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Canvas 阶段编号高水位必须是对象");
  }
  const ledger = raw as Record<string, unknown>;
  for (const [projectId, value] of Object.entries(ledger)) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`Canvas 阶段编号高水位无效：${projectId}`);
    }
  }
  return ledger as Record<string, number>;
}

function managedNodePath(node: CanvasNode): string | undefined {
  if (node.type === "file" && typeof node.file === "string") return node.file;
  if (node.type === "text" && typeof node.helixFilePath === "string") {
    return node.helixFilePath;
  }
  return undefined;
}

function canvasCardText(path: string, title: string, status: string): string {
  const target = normalizePath(path).replace(/\.md$/i, "");
  return `[[${target}|${title}]]${status ? `\n\n${status}` : ""}`;
}

function stageTitleFromHeading(
  heading: string | undefined,
  sequence: number,
): string {
  if (!heading || /^Cycle\s+\d+$/i.test(heading)) return `阶段 ${sequence}`;
  const modern = /^阶段\s+\d+\s*[·:：-]\s*(.+)$/.exec(heading);
  return modern?.[1]?.trim() || heading;
}

function managedStageId(node: CanvasNode): string | undefined {
  if (
    node.helixNodeKind === "stage" &&
    typeof node.helixStageId === "string" &&
    node.helixStageId
  ) return node.helixStageId;
  if (
    node.helixNodeKind === "cycle" &&
    typeof node.helixCycleId === "string" &&
    node.helixCycleId
  ) return node.helixCycleId;
  return undefined;
}

function canvasNodeView(
  node: CanvasNode,
  entity: Omit<ProjectWorkspaceCanvasNode, "nodeId" | "x" | "y" | "width" | "height">,
): ProjectWorkspaceCanvasNode {
  return {
    nodeId: node.id,
    ...entity,
    x: Number.isFinite(node.x) ? Number(node.x) : 0,
    y: Number.isFinite(node.y) ? Number(node.y) : 0,
    width: Number.isFinite(node.width) ? Number(node.width) : 240,
    height: Number.isFinite(node.height) ? Number(node.height) : 120,
  };
}

function frontmatterFromContent(
  content: string,
): Record<string, unknown> | undefined {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return undefined;
  const parsed = parseYaml(match[1] ?? "");
  return parsed && typeof parsed === "object"
    ? parsed as Record<string, unknown>
    : undefined;
}

function assertUniqueCanvasIds(document: CanvasDocument): void {
  const nodeIds = new Set<string>();
  for (const node of document.nodes) {
    if (typeof node.id !== "string" || !node.id.trim()) {
      throw new Error("Canvas 节点缺少有效 ID");
    }
    if (nodeIds.has(node.id)) throw new Error(`Canvas 节点 ID 重复：${node.id}`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    if (typeof edge.id !== "string" || !edge.id.trim()) {
      throw new Error("Canvas 边缺少有效 ID");
    }
    if (edgeIds.has(edge.id)) throw new Error(`Canvas 边 ID 重复：${edge.id}`);
    edgeIds.add(edge.id);
  }
}

function assertManagedNodeGeometry(node: CanvasNode): void {
  for (const [key, value] of [
    ["x", node.x],
    ["y", node.y],
    ["width", node.width],
    ["height", node.height],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || Math.abs(Number(value)) > 1_000_000)) {
      throw new Error(`Canvas 节点 ${node.id} 的 ${key} 无效`);
    }
  }
  if (
    (node.width !== undefined && Number(node.width) <= 0) ||
    (node.height !== undefined && Number(node.height) <= 0)
  ) {
    throw new Error(`Canvas 节点 ${node.id} 的尺寸必须为正数`);
  }
}

function assertManagedTextLink(node: CanvasNode, currentPath: string): void {
  const storedPath = managedNodePath(node);
  if (
    node.type !== "text" ||
    typeof node.text !== "string" ||
    !storedPath ||
    normalizePath(storedPath) !== normalizePath(currentPath)
  ) return;
  const target = /^\[\[([^|\]]+)/.exec(node.text)?.[1];
  const expected = normalizePath(currentPath).replace(/\.md$/i, "");
  if (!target || normalizePath(target).replace(/\.md$/i, "") !== expected) {
    throw new Error(`Canvas 摘要卡片链接与 helixFilePath 不一致：${node.id}`);
  }
}
