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

export class ProjectWorkspaceService {
  private disposed = false;
  private generation = 0;

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
    return this.generation;
  }

  private assertActive(generation: number): void {
    if (this.disposed || generation !== this.generation) {
      throw new Error("Helix 项目工作区已卸载，已取消迟到写入");
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
        !Number.isFinite(move.y)
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

  async deleteCycle(cycleId: string): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const snapshot = await this.ensureCanvas();
    const owner = snapshot.projects.find((project) =>
      project.cycles.some((cycle) => cycle.id === cycleId));
    const cycle = owner?.cycles.find((candidate) => candidate.id === cycleId);
    if (!owner || !cycle) throw new Error("找不到需要删除的阶段");
    if (owner.cycles.length === 1) {
      throw new Error("项目至少需要保留一个阶段，不能删除唯一阶段");
    }
    const cycleRevision = await this.repository.read(cycle.notePath);
    if (!cycleRevision) throw new Error("阶段 Markdown 已不存在");

    const removedRelations: CycleRelation[] = [];
    const mergeRelationConversions: Array<{
      relation: CycleRelation;
      kind: "inherit" | "branch";
    }> = [];
    const nextRelations = snapshot.relations.flatMap((relation) => {
      if (relation.toCycleId === cycleId) {
        removedRelations.push(relation);
        return [];
      }
      if (!relation.fromCycleIds.includes(cycleId)) return [relation];
      if (relation.kind !== "merge") {
        removedRelations.push(relation);
        return [];
      }
      const remainingSources = relation.fromCycleIds.filter(
        (sourceId) => sourceId !== cycleId,
      );
      if (remainingSources.length >= 2) {
        return [{ ...relation, fromCycleIds: remainingSources }];
      }
      if (remainingSources.length === 1) {
        const remainingSource = remainingSources[0]!;
        const hasOtherSurvivingOutgoing = snapshot.relations.some((candidate) =>
          candidate !== relation &&
          candidate.toCycleId !== cycleId &&
          candidate.fromCycleIds.includes(remainingSource));
        const nextKind: "branch" | "inherit" =
          hasOtherSurvivingOutgoing ? "branch" : "inherit";
        mergeRelationConversions.push({ relation, kind: nextKind });
        return [{
          ...relation,
          kind: nextKind,
          fromCycleIds: remainingSources,
        }];
      }
      removedRelations.push(relation);
      return [];
    });
    const normalizedRelationIds = new Set<string>();
    for (const sourceId of new Set(
      removedRelations.flatMap((relation) => relation.fromCycleIds),
    )) {
      if (sourceId === cycleId) continue;
      const outgoing = nextRelations.filter((relation) =>
        relation.fromCycleIds.includes(sourceId));
      if (outgoing.length === 1 && outgoing[0]!.kind === "branch") {
        outgoing[0]!.kind = "inherit";
        normalizedRelationIds.add(outgoing[0]!.id);
      }
    }
    validateCycleGraph(
      snapshot.projects
        .flatMap((project) => project.cycles)
        .filter((candidate) => candidate.id !== cycleId)
        .map((candidate) => candidate.id),
      nextRelations,
    );

    const canvas = await this.readCanvas(false, generation);
    if (!canvas.revision) throw new Error("项目 Canvas 不存在");
    const node = canvas.document.nodes.find((candidate) =>
      candidate.helixManaged === true && managedStageId(candidate) === cycleId);
    if (!node) throw new Error("Canvas 中找不到需要删除的阶段节点");
    const stageIdByNodeId = new Map(
      canvas.document.nodes.flatMap((candidate) => {
        const stageId = managedStageId(candidate);
        return stageId ? [[candidate.id, stageId] as const] : [];
      }),
    );
    const removedManagedEdgeIds = new Set(
      canvas.document.edges.flatMap((edge) => {
        if (edge.helixManaged !== true) return [];
        const kind = cycleRelationKindFromLabel(edge.helixRelation);
        const targetStageId = stageIdByNodeId.get(edge.toNode);
        const shouldRemove = removedRelations.some((relation) =>
          relation.kind === "merge"
            ? kind === "merge" && targetStageId === relation.toCycleId
            : edge.id === relation.id);
        return shouldRemove ? [edge.id] : [];
      }),
    );
    canvas.document.nodes = canvas.document.nodes.filter((candidate) => candidate.id !== node.id);
    canvas.document.edges = canvas.document.edges.filter((edge) =>
      edge.fromNode !== node.id &&
      edge.toNode !== node.id &&
      !removedManagedEdgeIds.has(edge.id));
    for (const conversion of mergeRelationConversions) {
      const remainingSourceId = conversion.relation.fromCycleIds.find(
        (sourceId) => sourceId !== cycleId,
      );
      const edge = canvas.document.edges.find((candidate) =>
        candidate.helixManaged === true &&
        cycleRelationKindFromLabel(candidate.helixRelation) === "merge" &&
        stageIdByNodeId.get(candidate.fromNode) === remainingSourceId &&
        stageIdByNodeId.get(candidate.toNode) === conversion.relation.toCycleId);
      if (!edge) throw new Error("Canvas 中找不到需要转换的剩余合并边");
      edge.helixRelation = conversion.kind;
      edge.label = CYCLE_RELATION_LABELS[conversion.kind];
      delete edge.helixMergeGroupId;
    }
    for (const relationId of normalizedRelationIds) {
      const edge = canvas.document.edges.find((candidate) =>
        candidate.helixManaged === true && candidate.id === relationId);
      if (!edge) throw new Error("Canvas 中找不到需要降为继承的剩余分支");
      edge.helixRelation = "inherit";
      edge.label = CYCLE_RELATION_LABELS.inherit;
      delete edge.helixMergeGroupId;
    }

    const nextCanvasContent = JSON.stringify(canvas.document, null, 2);
    this.assertActive(generation);
    const writtenCanvas = await this.repository.compareAndWrite(
      canvas.revision,
      nextCanvasContent,
      () => this.assertActive(generation),
    );
    try {
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
        throw new Error(
          `阶段删除未完成，且 Canvas 回滚遇到竞争。Markdown 仍保留，请手动检查：${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
        );
      }
      throw new Error(
        `阶段未删除，Canvas 已回滚：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.snapshot();
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
    validateCycleGraph(cycles.map((cycle) => cycle.id), nextRelations);

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
  ): Promise<ProjectWorkspaceProject> {
    const generation = this.beginOperation();
    const normalizedTitle = title.trim();
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
