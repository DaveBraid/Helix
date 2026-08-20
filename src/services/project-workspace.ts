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
  isProjectStatus,
  isStageStatus,
  isTerminalStageStatus,
  projectStatusFromFrontmatter,
  stageStatusFromFrontmatter,
  type HelixProjectStatus,
  type HelixStageStatus,
} from "../domain/project-status";
import {
  maintainedStageCodes,
  nextBranchStageCodes,
  nextMajorStageCode,
  nextUnusedMajorStageCode,
  parseStageCode,
} from "../domain/stage-numbering";
import type {
  HelixTemplateRenderRequest,
} from "./template-manager";
import {
  affectedWeakComponent,
  normalizeProjectGraph,
  planDeletionBridges,
  planProjectGraphLayout,
  type ProjectGraphEdge,
} from "../domain/project-graph";
import { assertProjectMappingsUnique } from "../domain/project-mapping";
import { stableHash } from "../domain/stable";
import {
  coordinateStageFocusBridge,
  focusContentHash,
  parseFocusBridgeEnvelope,
  planStageFocusBridge,
  resolveStageFocusBridge,
  scanFocusSection,
  FOCUS_SOURCE_HEADING,
  FocusBridgeError,
  type FocusSource,
} from "../domain/stage-focus-bridge";
import { SerializedRunner } from "./serialized-runner";
import { patchManagedFrontmatter } from "../storage/frontmatter";
import {
  VaultDeletionClaimError,
  type HelixVaultRepository,
  type VaultRevision,
} from "../storage/vault-repository";

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
  /** 当前阶段展示编号索引；可由 Markdown 与关系图重建，不承载真值。 */
  helixStageCodes?: Record<string, string[]>;
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
  stageCode: string;
  status: ProjectWorkspaceCycleStatus;
}

export type ProjectWorkspaceCycleStatus = HelixStageStatus;
export type ProjectWorkspaceProjectStatus = HelixProjectStatus;

export interface ProjectWorkspaceProjectStatusUpdatePlan {
  kind: "project";
  entityId: string;
  notePath: string;
  revisionHash: string;
  currentStatus: ProjectWorkspaceProjectStatus;
  currentStoredStatus: string;
}

export interface ProjectWorkspaceDidaMappingUpdatePlan {
  kind: "project-dida-mapping";
  entityId: string;
  notePath: string;
  revisionHash: string;
  currentDidaProjectId?: string;
}

export interface ProjectWorkspaceCycleStatusUpdatePlan {
  kind: "cycle";
  entityId: string;
  projectId: string;
  notePath: string;
  revisionHash: string;
  currentStatus: ProjectWorkspaceCycleStatus;
  currentStoredStatus: string;
}

export interface ProjectWorkspaceProject {
  id: string;
  title: string;
  status: ProjectWorkspaceProjectStatus;
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
  /** 仅用于写前竞争检测；不向 UI 暴露正文。 */
  managedMarkdownRevisionHashes: Record<string, string>;
  projects: ProjectWorkspaceProject[];
  nextStageSequenceByProject: Record<string, number>;
  relations: CycleRelation[];
  migrationWarnings: string[];
  migrationItems: ProjectWorkspaceMigrationItem[];
  migrationRequired: boolean;
  canvasRepairRequired?: boolean;
  canvasRepairReasons?: string[];
  canvasNodes: ProjectWorkspaceCanvasNode[];
  collapsedCompletedProjectIds: string[];
  nativeRelationCandidates: ProjectWorkspaceNativeRelationCandidate[];
}

const SILENT_CANVAS_REPAIR_REASONS = new Set([
  "Helix 管理节点摘要需要更新",
  "阶段编号高水位需要补齐",
]);

/** 仅派生摘要与内部编号账本可静默更新；节点、边和迁移始终保留人工确认。 */
export function canSilentlyRepairProjectCanvas(
  snapshot: ProjectWorkspaceSnapshot,
): boolean {
  const reasons = snapshot.canvasRepairReasons ?? [];
  return snapshot.canvasRepairRequired === true && reasons.length > 0 &&
    reasons.every((reason) => SILENT_CANVAS_REPAIR_REASONS.has(reason));
}

export interface ProjectWorkspaceNativeRelationCandidate {
  edgeId: string;
  canvasRevisionHash: string;
  fromCycleId: string;
  toCycleId: string;
  fromTitle: string;
  toTitle: string;
  crossProject: boolean;
}

export interface ProjectWorkspaceNativeRelationAdoptionPlan
  extends ProjectWorkspaceNativeRelationCandidate {
  affectedNodeCount: number;
  relabeledEdgeCount: number;
  resultKind: CycleRelationKind;
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
  targetInboundCount: number;
  resultKind: CycleRelationKind;
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

interface ProjectWorkspaceHistoryFileTransition {
  path: string;
  kind: "project" | "stage";
  entityId: string;
  projectId: string;
  fromContent: string | null;
  toContent: string | null;
}

export interface ProjectWorkspaceMarkdownUpdate {
  path: string;
  kind: "project" | "stage";
  entityId: string;
  projectId: string;
  beforeHash: string;
  afterContent: string;
}

export interface ProjectWorkspaceMarkdownCreation {
  path: string;
  kind: "project" | "stage";
  entityId: string;
  projectId: string;
  content: string;
}

export interface ProjectWorkspaceMarkdownDeletion {
  path: string;
  kind: "project" | "stage";
  entityId: string;
  projectId: string;
  beforeHash: string;
}

export interface ProjectWorkspaceAtomicChange {
  label: string;
  canvasBeforeHash: string;
  canvasAfterContent: string;
  markdownCreations?: readonly ProjectWorkspaceMarkdownCreation[];
  markdownDeletions?: readonly ProjectWorkspaceMarkdownDeletion[];
  markdownUpdates: readonly ProjectWorkspaceMarkdownUpdate[];
  /** 自动派生事务需要崩溃恢复，但不进入用户可见撤销栈。 */
  recordHistory?: boolean;
}

interface ProjectWorkspaceHistoryEntry {
  id: string;
  label: string;
  canvasPath: string;
  canvasBeforeContent: string;
  canvasAfterContent: string;
  markdownTransitions: ProjectWorkspaceHistoryFileTransition[];
}

interface ProjectWorkspaceHistoryJournal {
  version: 1 | 2;
  operation: "apply-workspace-history";
  phase?: "prepared" | "markdown-applied" | "canvas-applied";
  createdAt: string;
  entryId: string;
  direction: "undo" | "redo";
  canvasPath: string;
  canvasFromContent: string;
  canvasToContent: string;
  markdownTransitions: ProjectWorkspaceHistoryFileTransition[];
}

export interface ProjectWorkspaceHistoryState {
  undoCount: number;
  redoCount: number;
  undoLabel?: string;
  redoLabel?: string;
}

export type ProjectWorkspaceFocusConflictChoice = "source" | "derived" | "custom";

export interface ProjectWorkspaceFocusConflict {
  id: string;
  key: string;
  sourceId: string;
  targetId: string;
  sourcePath: string;
  targetPath: string;
  createdAt: string;
  reason: "simultaneous-edit" | "derived-structure-changed" | "checkpoint-missing";
  baseContent: string | null;
  sourceContent: string;
  derivedContent: string;
  sourceRevisionHash: string;
  targetRevisionHash: string;
}

interface ProjectWorkspaceFocusCheckpoint {
  key: string;
  sourceId: string;
  targetId: string;
  sourcePath: string;
  targetPath: string;
  baseContent: string;
  baseHash: string;
}

interface ProjectWorkspaceFocusState {
  version: 1;
  checkpoints: Record<string, ProjectWorkspaceFocusCheckpoint>;
  conflicts: ProjectWorkspaceFocusConflict[];
  pendingResolution?: ProjectWorkspacePendingFocusResolution;
}

interface ProjectWorkspacePendingFocusResolution {
  id: string;
  conflictId: string;
  createdAt: string;
  transitions: Array<{
    path: string;
    beforeHash: string;
    afterHash: string;
  }>;
  finalCheckpoints: Record<string, ProjectWorkspaceFocusCheckpoint>;
  finalConflicts: ProjectWorkspaceFocusConflict[];
}

interface ProjectWorkspaceFocusPair {
  key: string;
  source: FocusSource;
  sourcePath: string;
  targetId: string;
  targetPath: string;
  sourceProjectId: string;
  projectId: string;
}

interface LoadedProjectWorkspaceFocusState {
  state: ProjectWorkspaceFocusState;
  revision: VaultRevision | null;
}

export type StageDeletionRecoveryResult =
  | "none"
  | "aborted"
  | "completed"
  | "rolled-back";

export class ProjectWorkspaceService {
  private static readonly HISTORY_ENTRY_LIMIT = 50;
  private static readonly HISTORY_BYTE_LIMIT = 5 * 1024 * 1024;
  private disposed = false;
  private generation = 0;
  private recoveryIssue: string | null = null;
  private readonly undoStack: ProjectWorkspaceHistoryEntry[] = [];
  private readonly redoStack: ProjectWorkspaceHistoryEntry[] = [];
  private applyingHistory = false;
  private knownMarkdownPaths = new Set<string>();
  private readonly focusBridgeRunner = new SerializedRunner();

  constructor(
    private readonly app: App,
    private readonly repository: HelixVaultRepository,
    private readonly rootFolder: () => string,
    private readonly canvasPath: () => string,
    private readonly templateBodies?: (
      requests: readonly HelixTemplateRenderRequest[],
    ) => Promise<string[]>,
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

  recoveryIssueMessage(): string | null {
    return this.recoveryIssue;
  }

  private assertActive(generation: number): void {
    if (this.disposed || this.recoveryIssue || generation !== this.generation) {
      throw new Error("Helix 项目工作区已卸载，已取消迟到写入");
    }
  }

  historyState(): ProjectWorkspaceHistoryState {
    return {
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      undoLabel: this.undoStack.at(-1)?.label,
      redoLabel: this.redoStack.at(-1)?.label,
    };
  }

  invalidateHistory(): void {
    if (this.applyingHistory) return;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  async applyAtomicWorkspaceChange(
    change: ProjectWorkspaceAtomicChange,
  ): Promise<ProjectWorkspaceSnapshot> {
    if (!change.label.trim()) throw new Error("项目图谱事务缺少操作名称");
    const canvas = await this.repository.read(normalizePath(this.canvasPath()));
    if (!canvas || canvas.hash !== change.canvasBeforeHash) {
      throw new Error("Canvas 在跨文件事务开始前已变化");
    }
    let canvasDocument: unknown;
    try {
      canvasDocument = JSON.parse(change.canvasAfterContent);
    } catch {
      throw new Error("跨文件事务的目标 Canvas 不是有效 JSON");
    }
    if (
      !canvasDocument ||
      typeof canvasDocument !== "object" ||
      !Array.isArray((canvasDocument as Partial<CanvasDocument>).nodes) ||
      !Array.isArray((canvasDocument as Partial<CanvasDocument>).edges)
    ) {
      throw new Error("跨文件事务的目标 Canvas 缺少 nodes 或 edges");
    }
    const seen = new Set<string>();
    const projectRoot = `${normalizePath(this.rootFolder())}/Projects/`;
    const transitions: ProjectWorkspaceHistoryFileTransition[] = [];
    for (const creation of change.markdownCreations ?? []) {
      const path = normalizePath(creation.path);
      if (
        path !== creation.path ||
        seen.has(path) ||
        !path.startsWith(projectRoot) ||
        !path.endsWith(".md") ||
        !creation.entityId ||
        !creation.projectId ||
        await this.repository.read(path)
      ) {
        throw new Error(`跨文件事务包含无效或已占用的新建路径：${creation.path}`);
      }
      seen.add(path);
      const transition: ProjectWorkspaceHistoryFileTransition = {
        path,
        kind: creation.kind,
        entityId: creation.entityId,
        projectId: creation.projectId,
        fromContent: null,
        toContent: creation.content,
      };
      this.assertHistoryStageIdentity(creation.content, transition);
      transitions.push(transition);
    }
    for (const update of change.markdownUpdates) {
      const path = normalizePath(update.path);
      if (
        path !== update.path ||
        seen.has(path) ||
        !path.startsWith(projectRoot) ||
        !path.endsWith(".md") ||
        !update.entityId ||
        !update.projectId
      ) {
        throw new Error(`跨文件事务包含重复或未规范化路径：${update.path}`);
      }
      seen.add(path);
      const current = await this.repository.read(path);
      if (!current || current.hash !== update.beforeHash) {
        throw new Error(`阶段 Markdown 在跨文件事务开始前已变化：${path}`);
      }
      const transition: ProjectWorkspaceHistoryFileTransition = {
        path,
        kind: update.kind,
        entityId: update.entityId,
        projectId: update.projectId,
        fromContent: current.content,
        toContent: update.afterContent,
      };
      this.assertHistoryStageIdentity(current.content, transition);
      this.assertHistoryStageIdentity(update.afterContent, transition);
      if (current.content !== update.afterContent) transitions.push(transition);
    }
    for (const deletion of change.markdownDeletions ?? []) {
      const path = normalizePath(deletion.path);
      if (
        path !== deletion.path ||
        seen.has(path) ||
        !path.startsWith(projectRoot) ||
        !path.endsWith(".md") ||
        !deletion.entityId ||
        !deletion.projectId
      ) {
        throw new Error(`跨文件事务包含重复或无效的删除路径：${deletion.path}`);
      }
      seen.add(path);
      const current = await this.repository.read(path);
      if (!current || current.hash !== deletion.beforeHash) {
        throw new Error(`待删除 Markdown 在跨文件事务开始前已变化：${path}`);
      }
      const transition: ProjectWorkspaceHistoryFileTransition = {
        path,
        kind: deletion.kind,
        entityId: deletion.entityId,
        projectId: deletion.projectId,
        fromContent: current.content,
        toContent: null,
      };
      this.assertHistoryStageIdentity(current.content, transition);
      transitions.push(transition);
    }
    const entry: ProjectWorkspaceHistoryEntry = {
      id: crypto.randomUUID(),
      label: change.label.trim(),
      canvasPath: canvas.path,
      canvasBeforeContent: canvas.content,
      canvasAfterContent: change.canvasAfterContent,
      markdownTransitions: transitions,
    };
    await this.applyHistoryEntry(entry, "redo");
    if (change.recordHistory !== false) this.recordHistoryEntry(entry);
    return this.snapshot();
  }

  private async focusMarkdownUpdates(
    snapshot: ProjectWorkspaceSnapshot,
    relations: readonly CycleRelation[],
    targetCycleIds: readonly string[],
  ): Promise<ProjectWorkspaceMarkdownUpdate[]> {
    const cycles = snapshot.projects.flatMap((project) => project.cycles.map((cycle) => ({
      ...cycle,
      projectId: project.id,
    })));
    const cycleById = new Map(cycles.map((cycle) => [cycle.id, cycle]));
    const revisionById = new Map<string, VaultRevision>();
    const readCycle = async (id: string): Promise<{ cycle: typeof cycles[number]; revision: VaultRevision }> => {
      const cycle = cycleById.get(id);
      if (!cycle) throw new Error(`找不到聚焦问题引用的阶段：${id}`);
      let revision = revisionById.get(id);
      if (!revision) {
        const current = await this.repository.read(cycle.notePath);
        if (!current) throw new Error(`聚焦问题引用的阶段 Markdown 已不存在：${cycle.notePath}`);
        revision = current;
        revisionById.set(id, current);
      }
      return { cycle, revision };
    };
    const updates: ProjectWorkspaceMarkdownUpdate[] = [];
    for (const targetId of [...new Set(targetCycleIds)].sort()) {
      const { cycle: target, revision: targetRevision } = await readCycle(targetId);
      const sourceIds = [...new Set(relations
        .filter((relation) => relation.toCycleId === targetId)
        .flatMap((relation) => relation.fromCycleIds))];
      const sources = new Map<string, FocusSource>();
      const existingEnvelope = parseFocusBridgeEnvelope(targetRevision.content);
      const validationSourceIds = existingEnvelope.kind === "present"
        ? existingEnvelope.blocks.map((block) => block.sourceId)
        : [];
      for (const sourceId of [...new Set([...sourceIds, ...validationSourceIds])]) {
        const { cycle, revision } = await readCycle(sourceId);
        sources.set(sourceId, {
          id: cycle.id,
          notePath: cycle.notePath.replace(/\.md$/i, ""),
          title: cycle.title,
          stageCode: cycle.stageCode,
          markdown: revision.content,
        });
      }
      const plan = planStageFocusBridge(sourceIds, sources, targetRevision.content);
      if (plan.action === "noop") continue;
      updates.push({
        path: target.notePath,
        kind: "stage",
        entityId: target.id,
        projectId: target.projectId,
        beforeHash: targetRevision.hash,
        afterContent: plan.markdown,
      });
    }
    return updates;
  }

  private async focusNewStageMarkdown(
    markdown: string,
    sourceIds: readonly string[],
    snapshot: ProjectWorkspaceSnapshot,
  ): Promise<string> {
    const cycles = snapshot.projects.flatMap((project) => project.cycles);
    const sources = new Map<string, FocusSource>();
    for (const sourceId of sourceIds) {
      const cycle = cycles.find((candidate) => candidate.id === sourceId);
      if (!cycle) throw new Error(`找不到新阶段的前置阶段：${sourceId}`);
      const revision = await this.repository.read(cycle.notePath);
      if (!revision) throw new Error(`新阶段的前置 Markdown 已不存在：${cycle.notePath}`);
      sources.set(sourceId, {
        id: cycle.id,
        notePath: cycle.notePath.replace(/\.md$/i, ""),
        title: cycle.title,
        stageCode: cycle.stageCode,
        markdown: revision.content,
      });
    }
    return planStageFocusBridge(sourceIds, sources, markdown).markdown;
  }

  async initializeFocusBridgeState(): Promise<void> {
    await this.focusBridgeRunner.run(async () => {
      const snapshot = await this.snapshot();
      const loaded = await this.readFocusBridgeState();
      await this.recoverPendingFocusResolution(loaded);
      let changed = false;
      const pendingSourcePaths = new Set<string>();
      const pairs = this.focusBridgePairs(snapshot);
      changed = this.pruneFocusBridgeState(loaded.state, pairs);
      for (const pair of pairs) {
        const existingConflict = loaded.state.conflicts.find((conflict) => conflict.key === pair.key);
        if (existingConflict) {
          const [sourceRevision, targetRevision] = await Promise.all([
            this.repository.read(pair.sourcePath),
            this.repository.read(pair.targetPath),
          ]);
          const recovered = sourceRevision && targetRevision
            ? this.recoverFocusCheckpoint(pair, sourceRevision.content, targetRevision.content)
            : null;
          if (!recovered) continue;
          loaded.state.conflicts = loaded.state.conflicts.filter((conflict) =>
            conflict.key !== pair.key);
          loaded.state.checkpoints[pair.key] = recovered;
          changed = true;
          continue;
        }
        if (loaded.state.checkpoints[pair.key]) {
          pendingSourcePaths.add(pair.sourcePath);
          pendingSourcePaths.add(pair.targetPath);
          continue;
        }
        const [sourceRevision, targetRevision] = await Promise.all([
          this.repository.read(pair.sourcePath),
          this.repository.read(pair.targetPath),
        ]);
        if (!sourceRevision || !targetRevision) continue;
        let baseContent: string | null = null;
        try {
          const parsed = parseFocusBridgeEnvelope(targetRevision.content);
          if (parsed.kind !== "present") throw new Error("目标缺少聚焦桥接自动引用");
          const block = parsed.blocks.find((candidate) => candidate.sourceId === pair.source.id);
          if (!block || focusContentHash(block.content) !== block.baseHash) {
            throw new Error("聚焦桥接正文无法证明同步基线");
          }
          baseContent = block.content;
          const coordination = coordinateStageFocusBridge({
            source: { ...pair.source, markdown: sourceRevision.content },
            targetMarkdown: targetRevision.content,
            baseContent,
          });
          if (coordination.action === "conflict" || coordination.action === "update-source") {
            this.upsertFocusConflict(loaded.state, this.focusConflict(
              pair,
              sourceRevision,
              targetRevision,
              baseContent,
              coordination.action === "conflict"
                ? coordination.conflict.reason
                : "simultaneous-edit",
            ));
            changed = true;
            continue;
          }
          loaded.state.checkpoints[pair.key] = this.focusCheckpoint(pair, block.content);
          if (coordination.action === "update-derived") pendingSourcePaths.add(pair.sourcePath);
          changed = true;
        } catch {
          this.upsertFocusConflict(loaded.state, this.focusConflict(
            pair,
            sourceRevision,
            targetRevision,
            baseContent,
            baseContent === null ? "checkpoint-missing" : "derived-structure-changed",
          ));
          changed = true;
        }
      }
      if (changed) await this.writeFocusBridgeState(loaded);
      if (pendingSourcePaths.size > 0) {
        await this.observeFocusBridgeChangesOnce(pendingSourcePaths);
      }
    });
  }

  async observeFocusBridgeChanges(paths: readonly string[]): Promise<void> {
    const changedPaths = new Set(paths.map((path) => normalizePath(path)));
    if (changedPaths.size === 0) return;
    await this.focusBridgeRunner.run(() => this.observeFocusBridgeChangesOnce(changedPaths));
  }

  async listFocusBridgeConflicts(): Promise<ProjectWorkspaceFocusConflict[]> {
    const { state } = await this.readFocusBridgeState();
    return structuredClone(state.conflicts);
  }

  async resolveFocusBridgeConflict(
    conflictId: string,
    choice: ProjectWorkspaceFocusConflictChoice,
    customContent?: string,
  ): Promise<void> {
    await this.focusBridgeRunner.run(async () => {
      const loaded = await this.readFocusBridgeState();
      await this.recoverPendingFocusResolution(loaded);
      const stateBefore = structuredClone(loaded.state);
      const conflict = loaded.state.conflicts.find((candidate) => candidate.id === conflictId);
      if (!conflict) throw new Error("聚焦桥接冲突不存在或已经解决");
      if (conflict.reason !== "simultaneous-edit") {
        throw new Error("结构或检查点冲突不能使用内容三选一；请重建自动引用或打开 Markdown 手工修复");
      }
      const accepted = choice === "source"
        ? conflict.sourceContent
        : choice === "derived"
          ? conflict.derivedContent
          : customContent;
      if (accepted === undefined) throw new Error("自定义聚焦内容不能为空");
      const snapshot = await this.snapshot();
      const pair = this.focusBridgePairs(snapshot).find((candidate) => candidate.key === conflict.key);
      if (!pair) throw new Error("聚焦桥接关系已经变化，不能应用旧冲突");
      const [sourceRevision, targetRevision, canvas] = await Promise.all([
        this.repository.read(conflict.sourcePath),
        this.repository.read(conflict.targetPath),
        this.repository.read(normalizePath(this.canvasPath())),
      ]);
      if (!sourceRevision || !targetRevision || !canvas ||
        sourceRevision.hash !== conflict.sourceRevisionHash ||
        targetRevision.hash !== conflict.targetRevisionHash) {
        throw new Error("聚焦桥接文件在冲突建立后已经变化，请重新观察后再处理");
      }
      const resolved = resolveStageFocusBridge({
        source: { ...pair.source, markdown: sourceRevision.content },
        targetMarkdown: targetRevision.content,
        acceptedContent: accepted,
      });
      const updates: ProjectWorkspaceMarkdownUpdate[] = [
        {
          path: sourceRevision.path,
          kind: "stage",
          entityId: conflict.sourceId,
          projectId: pair.sourceProjectId,
          beforeHash: sourceRevision.hash,
          afterContent: resolved.sourceMarkdown,
        },
        {
          path: targetRevision.path,
          kind: "stage",
          entityId: conflict.targetId,
          projectId: pair.projectId,
          beforeHash: targetRevision.hash,
          afterContent: resolved.targetMarkdown,
        },
      ];
      for (const other of this.focusBridgePairs(snapshot).filter((candidate) =>
        candidate.source.id === conflict.sourceId && candidate.key !== conflict.key)) {
        if (loaded.state.conflicts.some((candidate) => candidate.key === other.key)) continue;
        const otherCheckpoint = loaded.state.checkpoints[other.key];
        const otherTarget = await this.repository.read(other.targetPath);
        if (!otherCheckpoint || !otherTarget) continue;
        try {
          const current = coordinateStageFocusBridge({
            source: { ...other.source, markdown: sourceRevision.content },
            targetMarkdown: otherTarget.content,
            baseContent: otherCheckpoint.baseContent,
          });
          if (current.action === "update-source" || current.action === "conflict") {
            this.upsertFocusConflict(loaded.state, this.focusConflict(
              other,
              sourceRevision,
              otherTarget,
              otherCheckpoint.baseContent,
              current.action === "conflict"
                ? current.conflict.reason
                : "simultaneous-edit",
            ));
            continue;
          }
          const propagated = resolveStageFocusBridge({
            source: { ...other.source, markdown: sourceRevision.content },
            targetMarkdown: otherTarget.content,
            acceptedContent: accepted,
          });
          updates.push({
            path: otherTarget.path,
            kind: "stage",
            entityId: other.targetId,
            projectId: other.projectId,
            beforeHash: otherTarget.hash,
            afterContent: propagated.targetMarkdown,
          });
          loaded.state.checkpoints[other.key] = this.focusCheckpoint(other, accepted);
        } catch {
          this.upsertFocusConflict(loaded.state, this.focusConflict(
            other,
            sourceRevision,
            otherTarget,
            otherCheckpoint.baseContent,
            "derived-structure-changed",
          ));
        }
      }
      loaded.state.conflicts = loaded.state.conflicts.filter((candidate) => candidate.id !== conflictId);
      loaded.state.checkpoints[pair.key] = this.focusCheckpoint(pair, accepted);
      const finalState = structuredClone(loaded.state);
      await this.applyFocusResolution(loaded, stateBefore, finalState, conflict.id, {
        label: "解决阶段聚焦冲突",
        canvasBeforeHash: canvas.hash,
        canvasAfterContent: canvas.content,
        markdownUpdates: updates,
        recordHistory: false,
      });
    });
  }

  async rebuildFocusBridgeConflict(conflictId: string): Promise<void> {
    await this.focusBridgeRunner.run(async () => {
      const loaded = await this.readFocusBridgeState();
      await this.recoverPendingFocusResolution(loaded);
      const stateBefore = structuredClone(loaded.state);
      const conflict = loaded.state.conflicts.find((candidate) => candidate.id === conflictId);
      if (!conflict) throw new Error("聚焦桥接冲突不存在或已经解决");
      if (conflict.reason !== "derived-structure-changed" ||
        conflict.derivedContent === "<派生受管块结构损坏>") {
        throw new Error("该冲突不能安全重建，请打开 Markdown 手工修复自动引用");
      }
      const snapshot = await this.snapshot();
      const pair = this.focusBridgePairs(snapshot).find((candidate) => candidate.key === conflict.key);
      if (!pair) throw new Error("聚焦桥接关系已经变化，不能重建旧冲突");
      const [sourceRevision, targetRevision, canvas] = await Promise.all([
        this.repository.read(conflict.sourcePath),
        this.repository.read(conflict.targetPath),
        this.repository.read(normalizePath(this.canvasPath())),
      ]);
      if (!sourceRevision || !targetRevision || !canvas ||
        sourceRevision.hash !== conflict.sourceRevisionHash ||
        targetRevision.hash !== conflict.targetRevisionHash) {
        throw new Error("聚焦桥接文件在冲突建立后已经变化，请重新观察后再处理");
      }
      const accepted = scanFocusSection(sourceRevision.content, FOCUS_SOURCE_HEADING, 2)
        .normalizedContent;
      let resolved: ReturnType<typeof resolveStageFocusBridge>;
      try {
        resolved = resolveStageFocusBridge({
          source: { ...pair.source, markdown: sourceRevision.content },
          targetMarkdown: targetRevision.content,
          acceptedContent: accepted,
        });
      } catch {
        throw new Error("自动引用结构无法安全定位，请打开 Markdown 手工修复");
      }
      loaded.state.conflicts = loaded.state.conflicts.filter((candidate) => candidate.id !== conflictId);
      loaded.state.checkpoints[pair.key] = this.focusCheckpoint(pair, accepted);
      const finalState = structuredClone(loaded.state);
      await this.applyFocusResolution(loaded, stateBefore, finalState, conflict.id, {
        label: "重建阶段聚焦自动引用",
        canvasBeforeHash: canvas.hash,
        canvasAfterContent: canvas.content,
        markdownUpdates: [{
          path: targetRevision.path,
          kind: "stage",
          entityId: pair.targetId,
          projectId: pair.projectId,
          beforeHash: targetRevision.hash,
          afterContent: resolved.targetMarkdown,
        }],
        recordHistory: false,
      });
    });
  }

  private async observeFocusBridgeChangesOnce(changedPaths: Set<string>): Promise<void> {
    const snapshot = await this.snapshot();
    const allPairs = this.focusBridgePairs(snapshot);
    let loaded = await this.readFocusBridgeState();
    await this.recoverPendingFocusResolution(loaded);
    const pruned = this.pruneFocusBridgeState(loaded.state, allPairs);
    const pairs = allPairs.filter((pair) =>
      changedPaths.has(normalizePath(pair.sourcePath)) ||
      changedPaths.has(normalizePath(pair.targetPath)));
    if (pairs.length === 0) {
      if (pruned) await this.writeFocusBridgeState(loaded);
      return;
    }
    const safeCheckpoints = structuredClone(loaded.state.checkpoints);
    const canvas = await this.repository.read(normalizePath(this.canvasPath()));
    if (!canvas) throw new Error("聚焦桥接监听找不到项目 Canvas");
    const updates = new Map<string, ProjectWorkspaceMarkdownUpdate>();
    const checkpointAdvances = new Map<string, ProjectWorkspaceFocusCheckpoint>();
    type ReverseCandidate = {
      pair: ProjectWorkspaceFocusPair;
      sourceRevision: VaultRevision;
      targetRevision: VaultRevision;
      checkpoint: ProjectWorkspaceFocusCheckpoint;
      result: Extract<ReturnType<typeof coordinateStageFocusBridge>, { action: "update-source" }>;
      accepted: string;
    };
    const reverseBySource = new Map<string, ReverseCandidate[]>();
    for (const pair of pairs) {
      const frozen = loaded.state.conflicts.find((conflict) => conflict.key === pair.key);
      if (frozen) {
        const [sourceRevision, targetRevision] = await Promise.all([
          this.repository.read(pair.sourcePath),
          this.repository.read(pair.targetPath),
        ]);
        if (!sourceRevision || !targetRevision ||
          (sourceRevision.hash === frozen.sourceRevisionHash &&
            targetRevision.hash === frozen.targetRevisionHash)) continue;
        const refreshed = this.focusConflict(
          pair,
          sourceRevision,
          targetRevision,
          frozen.baseContent,
          frozen.reason,
        );
        refreshed.id = frozen.id;
        refreshed.createdAt = frozen.createdAt;
        this.upsertFocusConflict(loaded.state, refreshed);
        continue;
      }
      const [sourceRevision, targetRevision] = await Promise.all([
        this.repository.read(pair.sourcePath),
        this.repository.read(pair.targetPath),
      ]);
      if (!sourceRevision || !targetRevision) continue;
      let checkpoint: ProjectWorkspaceFocusCheckpoint | null | undefined =
        loaded.state.checkpoints[pair.key];
      const recoveredCheckpoint = this.recoverFocusCheckpoint(
        pair,
        sourceRevision.content,
        targetRevision.content,
      );
      if (!checkpoint ||
        focusContentHash(checkpoint.baseContent) !== checkpoint.baseHash ||
        (recoveredCheckpoint && recoveredCheckpoint.baseHash !== checkpoint.baseHash)) {
        checkpoint = recoveredCheckpoint;
        if (checkpoint) {
          loaded.state.checkpoints[pair.key] = checkpoint;
          safeCheckpoints[pair.key] = checkpoint;
        }
      }
      if (!checkpoint || focusContentHash(checkpoint.baseContent) !== checkpoint.baseHash) {
        this.upsertFocusConflict(loaded.state, this.focusConflict(
          pair,
          sourceRevision,
          targetRevision,
          checkpoint?.baseContent ?? null,
          "checkpoint-missing",
        ));
        continue;
      }
      try {
        const result = coordinateStageFocusBridge({
          source: { ...pair.source, markdown: sourceRevision.content },
          targetMarkdown: updates.get(targetRevision.path)?.afterContent ?? targetRevision.content,
          baseContent: checkpoint.baseContent,
        });
        if (result.action === "noop") continue;
        if (result.action === "conflict") {
          this.upsertFocusConflict(loaded.state, {
            id: `focus-${stableHash([pair.key, sourceRevision.hash, targetRevision.hash])}`,
            key: pair.key,
            sourceId: pair.source.id,
            targetId: pair.targetId,
            sourcePath: sourceRevision.path,
            targetPath: targetRevision.path,
            createdAt: new Date().toISOString(),
            reason: result.conflict.reason,
            baseContent: result.conflict.base.content,
            sourceContent: result.conflict.source.content,
            derivedContent: result.conflict.derived.content,
            sourceRevisionHash: sourceRevision.hash,
            targetRevisionHash: targetRevision.hash,
          });
          continue;
        }
        if (result.action === "update-derived") {
          updates.set(targetRevision.path, {
            path: targetRevision.path,
            kind: "stage",
            entityId: pair.targetId,
            projectId: pair.projectId,
            beforeHash: targetRevision.hash,
            afterContent: result.targetMarkdown,
          });
          const content = scanFocusSection(sourceRevision.content, FOCUS_SOURCE_HEADING, 2)
            .normalizedContent;
          checkpointAdvances.set(pair.key, this.focusCheckpoint(pair, content));
          continue;
        }
        const accepted = scanFocusSection(
          result.sourceMarkdown,
          FOCUS_SOURCE_HEADING,
          2,
        ).normalizedContent;
        const candidates = reverseBySource.get(pair.source.id) ?? [];
        candidates.push({ pair, sourceRevision, targetRevision, checkpoint, result, accepted });
        reverseBySource.set(pair.source.id, candidates);
      } catch (error) {
        this.upsertFocusConflict(loaded.state, this.focusConflict(
          pair,
          sourceRevision,
          targetRevision,
          checkpoint.baseContent,
          error instanceof FocusBridgeError && error.code === "bridge-conflict"
            ? "simultaneous-edit"
            : "derived-structure-changed",
        ));
      }
    }
    for (const [sourceId, candidates] of [...reverseBySource].sort(([left], [right]) =>
      left.localeCompare(right))) {
      const distinct = new Set(candidates.map((candidate) => candidate.accepted));
      if (distinct.size > 1) {
        for (const candidate of candidates) {
          this.upsertFocusConflict(loaded.state, this.focusConflict(
            candidate.pair,
            candidate.sourceRevision,
            candidate.targetRevision,
            candidate.checkpoint.baseContent,
            "simultaneous-edit",
          ));
        }
        continue;
      }
      const accepted = candidates[0]!.accepted;
      const sourceRevision = candidates[0]!.sourceRevision;
      if (candidates.some((candidate) => candidate.sourceRevision.hash !== sourceRevision.hash)) {
        for (const candidate of candidates) {
          this.upsertFocusConflict(loaded.state, this.focusConflict(
            candidate.pair,
            candidate.sourceRevision,
            candidate.targetRevision,
            candidate.checkpoint.baseContent,
            "simultaneous-edit",
          ));
        }
        continue;
      }
      const candidateByKey = new Map(candidates.map((candidate) => [candidate.pair.key, candidate]));
      const sourcePairs = allPairs.filter((pair) => pair.source.id === sourceId);
      for (const pair of sourcePairs) {
        if (loaded.state.conflicts.some((conflict) => conflict.key === pair.key)) continue;
        const candidate = candidateByKey.get(pair.key);
        const targetRevision = candidate?.targetRevision ?? await this.repository.read(pair.targetPath);
        const checkpoint = candidate?.checkpoint ?? loaded.state.checkpoints[pair.key];
        if (!targetRevision || !checkpoint ||
          focusContentHash(checkpoint.baseContent) !== checkpoint.baseHash) {
          if (targetRevision) this.upsertFocusConflict(loaded.state, this.focusConflict(
            pair,
            sourceRevision,
            targetRevision,
            checkpoint?.baseContent ?? null,
            "checkpoint-missing",
          ));
          continue;
        }
        if (!candidate) {
          try {
            const current = coordinateStageFocusBridge({
              source: { ...pair.source, markdown: sourceRevision.content },
              targetMarkdown: updates.get(targetRevision.path)?.afterContent ?? targetRevision.content,
              baseContent: checkpoint.baseContent,
            });
            if (current.action === "update-source" || current.action === "conflict") {
              this.upsertFocusConflict(loaded.state, this.focusConflict(
                pair,
                sourceRevision,
                targetRevision,
                checkpoint.baseContent,
                current.action === "conflict"
                  ? current.conflict.reason
                  : "simultaneous-edit",
              ));
              continue;
            }
          } catch {
            this.upsertFocusConflict(loaded.state, this.focusConflict(
              pair,
              sourceRevision,
              targetRevision,
              checkpoint.baseContent,
              "derived-structure-changed",
            ));
            continue;
          }
        }
        const resolved = resolveStageFocusBridge({
          source: { ...pair.source, markdown: sourceRevision.content },
          targetMarkdown: updates.get(targetRevision.path)?.afterContent ?? targetRevision.content,
          acceptedContent: accepted,
        });
        updates.set(targetRevision.path, {
          path: targetRevision.path,
          kind: "stage",
          entityId: pair.targetId,
          projectId: pair.projectId,
          beforeHash: targetRevision.hash,
          afterContent: resolved.targetMarkdown,
        });
        checkpointAdvances.set(pair.key, this.focusCheckpoint(pair, accepted));
      }
      const sourceAfter = candidates[0]!.result.sourceMarkdown;
      updates.set(sourceRevision.path, {
        path: sourceRevision.path,
        kind: "stage",
        entityId: sourceId,
        projectId: candidates[0]!.pair.sourceProjectId,
        beforeHash: sourceRevision.hash,
        afterContent: sourceAfter,
      });
    }
    if (updates.size > 0) {
      // 先只持久化冲突；检查点必须等 Markdown 事务成功后才能前移。
      const pendingState: LoadedProjectWorkspaceFocusState = {
        state: { ...loaded.state, checkpoints: safeCheckpoints },
        revision: loaded.revision,
      };
      await this.writeFocusBridgeState(pendingState);
      loaded.revision = pendingState.revision;
      await this.applyAtomicWorkspaceChange({
        label: "同步阶段聚焦问题",
        canvasBeforeHash: canvas.hash,
        canvasAfterContent: canvas.content,
        markdownUpdates: [...updates.values()],
        recordHistory: false,
      });
      for (const [key, checkpoint] of checkpointAdvances) {
        loaded.state.checkpoints[key] = checkpoint;
      }
      for (const conflict of loaded.state.conflicts) {
        const sourceUpdate = updates.get(conflict.sourcePath);
        if (sourceUpdate) {
          conflict.sourceRevisionHash = stableHash(sourceUpdate.afterContent);
          conflict.sourceContent = scanFocusSection(
            sourceUpdate.afterContent,
            FOCUS_SOURCE_HEADING,
            2,
          ).normalizedContent;
        }
        const targetUpdate = updates.get(conflict.targetPath);
        if (targetUpdate) conflict.targetRevisionHash = stableHash(targetUpdate.afterContent);
      }
      await this.writeFocusBridgeState(loaded);
      return;
    }
    await this.writeFocusBridgeState(loaded);
  }

  private focusBridgePairs(snapshot: ProjectWorkspaceSnapshot): ProjectWorkspaceFocusPair[] {
    const stages = snapshot.projects.flatMap((project) => project.cycles.map((cycle) => ({
      ...cycle,
      projectId: project.id,
    })));
    const byId = new Map(stages.map((stage) => [stage.id, stage]));
    const pairs = new Map<string, ProjectWorkspaceFocusPair>();
    for (const relation of snapshot.relations) {
      const target = byId.get(relation.toCycleId);
      if (!target) continue;
      for (const sourceId of relation.fromCycleIds) {
        const source = byId.get(sourceId);
        if (!source) continue;
        const key = `${target.id}\u0000${source.id}`;
        pairs.set(key, {
          key,
          source: {
            id: source.id,
            notePath: source.notePath.replace(/\.md$/i, ""),
            title: source.title,
            stageCode: source.stageCode,
            markdown: "",
          },
          sourcePath: source.notePath,
          targetId: target.id,
          targetPath: target.notePath,
          sourceProjectId: source.projectId,
          projectId: target.projectId,
        });
      }
    }
    return [...pairs.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  private pruneFocusBridgeState(
    state: ProjectWorkspaceFocusState,
    pairs: readonly ProjectWorkspaceFocusPair[],
  ): boolean {
    const activeKeys = new Set(pairs.map((pair) => pair.key));
    let changed = false;
    for (const key of Object.keys(state.checkpoints)) {
      if (activeKeys.has(key)) continue;
      delete state.checkpoints[key];
      changed = true;
    }
    const retainedConflicts = state.conflicts.filter((conflict) => activeKeys.has(conflict.key));
    if (retainedConflicts.length !== state.conflicts.length) {
      state.conflicts = retainedConflicts;
      changed = true;
    }
    return changed;
  }

  private focusCheckpoint(
    pair: ProjectWorkspaceFocusPair,
    baseContent: string,
  ): ProjectWorkspaceFocusCheckpoint {
    const normalized = baseContent.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
    return {
      key: pair.key,
      sourceId: pair.source.id,
      targetId: pair.targetId,
      sourcePath: normalizePath(pair.sourcePath),
      targetPath: normalizePath(pair.targetPath),
      baseContent: normalized,
      baseHash: focusContentHash(normalized),
    };
  }

  private recoverFocusCheckpoint(
    pair: ProjectWorkspaceFocusPair,
    sourceMarkdown: string,
    targetMarkdown: string,
  ): ProjectWorkspaceFocusCheckpoint | null {
    try {
      const parsed = parseFocusBridgeEnvelope(targetMarkdown);
      if (parsed.kind !== "present") return null;
      const block = parsed.blocks.find((candidate) => candidate.sourceId === pair.source.id);
      if (!block || focusContentHash(block.content) !== block.baseHash) return null;
      const result = coordinateStageFocusBridge({
        source: { ...pair.source, markdown: sourceMarkdown },
        targetMarkdown,
        baseContent: block.content,
      });
      return result.action === "noop" || result.action === "update-derived"
        ? this.focusCheckpoint(pair, block.content)
        : null;
    } catch {
      return null;
    }
  }

  private focusConflict(
    pair: ProjectWorkspaceFocusPair,
    sourceRevision: VaultRevision,
    targetRevision: VaultRevision,
    baseContent: string | null,
    reason: ProjectWorkspaceFocusConflict["reason"],
  ): ProjectWorkspaceFocusConflict {
    let sourceContent = "";
    let derivedContent = "";
    try {
      sourceContent = scanFocusSection(sourceRevision.content, FOCUS_SOURCE_HEADING, 2)
        .normalizedContent;
    } catch {
      sourceContent = "<来源小节结构损坏>";
    }
    try {
      const parsed = parseFocusBridgeEnvelope(targetRevision.content);
      if (parsed.kind === "present") {
        derivedContent = parsed.blocks.find((block) => block.sourceId === pair.source.id)?.content ?? "";
      }
    } catch {
      derivedContent = "<派生受管块结构损坏>";
    }
    return {
      id: `focus-${stableHash([pair.key, sourceRevision.hash, targetRevision.hash])}`,
      key: pair.key,
      sourceId: pair.source.id,
      targetId: pair.targetId,
      sourcePath: sourceRevision.path,
      targetPath: targetRevision.path,
      createdAt: new Date().toISOString(),
      reason,
      baseContent,
      sourceContent,
      derivedContent,
      sourceRevisionHash: sourceRevision.hash,
      targetRevisionHash: targetRevision.hash,
    };
  }

  private upsertFocusConflict(
    state: ProjectWorkspaceFocusState,
    conflict: ProjectWorkspaceFocusConflict,
  ): void {
    state.conflicts = [
      ...state.conflicts.filter((candidate) => candidate.key !== conflict.key),
      conflict,
    ];
  }

  private async readFocusBridgeState(): Promise<LoadedProjectWorkspaceFocusState> {
    const revision = await this.repository.read(this.focusBridgeStatePath());
    if (!revision) {
      return { state: { version: 1, checkpoints: {}, conflicts: [] }, revision: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(revision.content);
    } catch {
      throw new Error("阶段聚焦桥接检查点文件损坏，已停止自动写入");
    }
    if (!isProjectWorkspaceFocusState(parsed)) {
      throw new Error("阶段聚焦桥接检查点结构无效，已停止自动写入");
    }
    return {
      state: structuredClone(parsed as ProjectWorkspaceFocusState),
      revision,
    };
  }

  private async writeFocusBridgeState(loaded: LoadedProjectWorkspaceFocusState): Promise<void> {
    const content = JSON.stringify(loaded.state, null, 2);
    if (loaded.revision?.content === content) return;
    loaded.revision = loaded.revision
      ? await this.repository.compareAndWrite(loaded.revision, content)
      : await this.repository.create(this.focusBridgeStatePath(), content);
  }

  private async applyFocusResolution(
    loaded: LoadedProjectWorkspaceFocusState,
    stateBefore: ProjectWorkspaceFocusState,
    finalState: ProjectWorkspaceFocusState,
    conflictId: string,
    change: ProjectWorkspaceAtomicChange,
  ): Promise<void> {
    const pending: ProjectWorkspacePendingFocusResolution = {
      id: crypto.randomUUID(),
      conflictId,
      createdAt: new Date().toISOString(),
      transitions: change.markdownUpdates
        .filter((update) => update.beforeHash !== stableHash(update.afterContent))
        .map((update) => ({
          path: update.path,
          beforeHash: update.beforeHash,
          afterHash: stableHash(update.afterContent),
        })),
      finalCheckpoints: structuredClone(finalState.checkpoints),
      finalConflicts: structuredClone(finalState.conflicts),
    };
    loaded.state = { ...stateBefore, pendingResolution: pending };
    // 先认领状态 revision；竞争发生在此处时 Markdown 保持零变化。
    await this.writeFocusBridgeState(loaded);
    try {
      await this.applyAtomicWorkspaceChange(change);
    } catch (error) {
      try {
        await this.recoverPendingFocusResolution(loaded);
      } catch (recoveryError) {
        const message = `聚焦冲突事务失败且无法判定落盘状态：${
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`;
        this.freezePendingStageDeletion(message);
        throw new Error(message);
      }
      throw error;
    }
    loaded.state = {
      version: 1,
      checkpoints: structuredClone(finalState.checkpoints),
      conflicts: structuredClone(finalState.conflicts),
    };
    try {
      await this.writeFocusBridgeState(loaded);
    } catch {
      const current = await this.readFocusBridgeState();
      const result = await this.recoverPendingFocusResolution(current);
      if (result !== "completed") {
        throw new Error("聚焦冲突正文已提交，但状态收口受到竞争；已保留可恢复事务，请重新加载插件");
      }
    }
  }

  private async recoverPendingFocusResolution(
    loaded: LoadedProjectWorkspaceFocusState,
  ): Promise<"none" | "aborted" | "completed"> {
    const pending = loaded.state.pendingResolution;
    if (!pending) return "none";
    const revisions = await Promise.all(pending.transitions.map((transition) =>
      this.repository.read(transition.path)));
    const atBefore = pending.transitions.every((transition, index) =>
      revisions[index]?.hash === transition.beforeHash);
    const atAfter = pending.transitions.every((transition, index) =>
      revisions[index]?.hash === transition.afterHash);
    if (!atBefore && !atAfter) {
      const message = "聚焦冲突待决事务的 Markdown 处于混合或未知版本，项目工作区已冻结";
      this.freezePendingStageDeletion(message);
      throw new Error(message);
    }
    loaded.state = atAfter
      ? {
          version: 1,
          checkpoints: structuredClone(pending.finalCheckpoints),
          conflicts: structuredClone(pending.finalConflicts),
        }
      : {
          version: 1,
          checkpoints: loaded.state.checkpoints,
          conflicts: loaded.state.conflicts,
        };
    await this.writeFocusBridgeState(loaded);
    return atAfter ? "completed" : "aborted";
  }

  async observeCanvasChange(): Promise<void> {
    if (this.applyingHistory) return;
    const current = await this.repository.read(normalizePath(this.canvasPath()));
    const currentHash = current?.hash ?? "<missing>";
    const latestUndo = this.undoStack.at(-1);
    const latestRedo = this.redoStack.at(-1);
    if (
      (latestUndo && stableHash(latestUndo.canvasAfterContent) === currentHash) ||
      (latestRedo && stableHash(latestRedo.canvasBeforeContent) === currentHash)
    ) {
      return;
    }
    this.invalidateHistory();
  }

  isKnownProjectMarkdownPath(path: string): boolean {
    return this.knownMarkdownPaths.has(normalizePath(path));
  }

  async hasProjectWorkspaceIdentity(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (!normalized.endsWith(".md")) return false;
    const revision = await this.repository.read(normalized);
    if (!revision) return false;
    const kind = frontmatterFromContent(revision.content)?.["helix-kind"];
    return kind === "helix-project" ||
      kind === "helix-stage" ||
      kind === "helix-cycle";
  }

  async loadStableWorkspace(): Promise<ProjectWorkspaceSnapshot> {
    const snapshot = await this.readStableSnapshot();
    if (snapshot.migrationRequired) return snapshot;
    return this.ensureCanvasFromSnapshot(snapshot, { allowWrite: false });
  }

  /**
   * 项目扫描只读取项目根目录、上次已纳管路径和元数据缓存确认的 Helix 文件。
   * 正式 Vault 可能有数千篇 Markdown；逐次读取整个 Vault 会让一次状态修改
   * 放大为四轮全库 I/O（稳定快照各读取两次）。
   */
  private projectMarkdownCandidates(): TFile[] {
    const projectsRoot = normalizePath(`${this.rootFolder()}/Projects`);
    return this.app.vault.getMarkdownFiles().filter((file) => {
      const normalized = normalizePath(file.path);
      if (normalized.startsWith(`${projectsRoot}/`) || this.knownMarkdownPaths.has(normalized)) {
        return true;
      }
      const kind = this.app.metadataCache?.getFileCache(file)?.frontmatter?.["helix-kind"];
      return kind === "helix-project" || kind === "helix-stage" || kind === "helix-cycle";
    });
  }

  private async readStableSnapshot(): Promise<ProjectWorkspaceSnapshot> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const first = await this.snapshot();
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 60));
        const second = await this.snapshot();
        if (workspaceStabilitySignature(first) !== workspaceStabilitySignature(second)) {
          throw new Error("项目 Markdown 或 Canvas 仍在变化");
        }
        return second;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 100));
        }
      }
    }
    throw new Error(
      `项目文件尚未稳定，Helix 已暂停结构写入：${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  async undoLastWorkspaceChange(): Promise<ProjectWorkspaceSnapshot> {
    const entry = this.undoStack.at(-1);
    if (!entry) throw new Error("没有可撤销的项目图谱操作");
    await this.applyHistoryEntry(entry, "undo");
    this.undoStack.pop();
    this.redoStack.push(entry);
    return this.snapshot();
  }

  async redoLastWorkspaceChange(): Promise<ProjectWorkspaceSnapshot> {
    const entry = this.redoStack.at(-1);
    if (!entry) throw new Error("没有可重做的项目图谱操作");
    await this.applyHistoryEntry(entry, "redo");
    this.redoStack.pop();
    this.undoStack.push(entry);
    return this.snapshot();
  }

  async recoverPendingWorkspaceHistory(): Promise<StageDeletionRecoveryResult> {
    const generation = this.beginOperation();
    const journalRevision = await this.repository.read(this.historyJournalPath());
    if (!journalRevision) return "none";
    try {
      if (await this.repository.read(this.stageDeletionJournalPath())) {
        throw new Error("同时发现撤销事务与阶段删除事务，禁止猜测执行顺序");
      }
      const journal = this.parseHistoryJournal(journalRevision.content);
      const canvas = await this.repository.read(journal.canvasPath);
      if (!canvas) throw new Error("撤销事务引用的 Canvas 已不存在");
      const fromHash = stableHash(journal.canvasFromContent);
      const toHash = stableHash(journal.canvasToContent);
      if (fromHash === toHash) {
        if (canvas.hash !== fromHash) {
          throw new Error("Canvas 已偏离纯 Markdown 事务的稳定版本");
        }
        if (journal.version !== 2 || !journal.phase) {
          throw new Error("旧版事务日志无法判定 Canvas 起终点相同的恢复方向");
        }
        const states = await this.historyTransitionStates(journal.markdownTransitions);
        if (states.some((state) => state === "unknown")) {
          throw new Error("纯 Markdown 事务文件同时偏离起点和终点");
        }
        const allAfter = states.every((state) => state === "after");
        if (journal.phase !== "prepared" && !allAfter) {
          throw new Error("纯 Markdown 事务相位与文件状态不一致，禁止猜测补写");
        }
        const shouldComplete = journal.phase !== "prepared" || allAfter;
        if (shouldComplete) {
          await this.finishHistoryRemovals(journal.markdownTransitions, generation, journalRevision);
          await this.finishMachineJournal(journalRevision, generation);
          return "completed";
        }
        await this.rollbackHistoryAdditions(journal.markdownTransitions, generation, journalRevision);
        await this.finishMachineJournal(journalRevision, generation);
        return "aborted";
      }
      if (canvas.hash === fromHash) {
        await this.rollbackHistoryAdditions(journal.markdownTransitions, generation, journalRevision);
        await this.finishMachineJournal(journalRevision, generation);
        return "aborted";
      }
      if (canvas.hash !== toHash) {
        throw new Error("Canvas 同时偏离撤销事务的起点和终点");
      }
      await this.finishHistoryRemovals(journal.markdownTransitions, generation, journalRevision);
      await this.finishMachineJournal(journalRevision, generation);
      return "completed";
    } catch (error) {
      const message =
        `项目图谱撤销事务需要人工检查：${
          error instanceof Error ? error.message : String(error)
        }`;
      this.freezePendingStageDeletion(message);
      throw new Error(message);
    }
  }

  async recoverPendingStageDeletion(): Promise<StageDeletionRecoveryResult> {
    const generation = this.beginOperation();
    try {
      const journalRevision = await this.repository.read(this.stageDeletionJournalPath());
      if (!journalRevision) return "none";
      if (await this.repository.read(this.historyJournalPath())) {
        throw new Error("同时发现阶段删除事务与撤销事务，禁止猜测执行顺序");
      }
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
    const markdownCandidates = this.projectMarkdownCandidates();
    const projectFiles = (await Promise.all(markdownCandidates.map(async (file) => {
      const revision = await this.repository.read(file.path);
      const frontmatter = revision
        ? frontmatterFromContent(revision.content)
        : undefined;
      if (frontmatter?.["helix-kind"] !== "helix-project") return [];
      const id = frontmatter["helix-id"];
      const rawStatus = frontmatter["helix-status"];
      const status = projectStatusFromFrontmatter(rawStatus);
      if (
        typeof id !== "string" ||
        !id.trim() ||
        !status
      ) {
        throw new Error(`项目元数据不完整：${file.path}`);
      }
      const heading = revision
        ? /^#\s+(.+?)\s*$/m.exec(revision.content)?.[1]?.trim()
        : undefined;
      return [{
        id,
        title: heading || file.parent?.name || file.basename,
        status,
        notePath: file.path,
        revisionHash: revision?.hash ?? "",
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
    const managedMarkdownRevisionHashes = new Map(
      projectFiles.map((project) => [normalizePath(project.notePath), project.revisionHash]),
    );
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
    for (const file of markdownCandidates) {
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
      const rawStatus = frontmatter["helix-status"];
      const status = stageStatusFromFrontmatter(rawStatus);
      const stageCodeField = managedFrontmatterString(revision?.content ?? "", "helix-stage-code");
      if (
        typeof id !== "string" ||
        !id.trim() ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        !status
      ) {
        throw new Error(`阶段元数据不完整：${file.path}`);
      }
      if (stageCodeField.present &&
          (!stageCodeField.value || !parseStageCode(stageCodeField.value))) {
        throw new Error(`阶段展示编号无效：${file.path}`);
      }
      const stageCode = stageCodeField.value ?? String(sequence);
      managedMarkdownRevisionHashes.set(normalizePath(file.path), revision?.hash ?? "");
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
      if (cycles.some((cycle) => cycle.stageCode === stageCode)) {
        throw new Error(`同一项目的阶段展示编号重复：${project.title} / 阶段 ${stageCode}`);
      }
      const heading = revision
        ? /^#\s+(.+?)\s*$/m.exec(revision.content)?.[1]?.trim()
        : undefined;
      cycles.push({
        id,
        title: stageTitleFromHeading(heading, stageCode),
        notePath: file.path,
        sequence,
        stageCode,
        status,
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
    validatedStageCodeLedger(canvas.document);
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
        throw new Error(`Helix 管理节点类型无效：${node.id}`);
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
    const physicalEdges: ProjectGraphEdge[] = [];
    const nativeRelationCandidates: ProjectWorkspaceNativeRelationCandidate[] = [];
    for (const edge of canvas.document.edges) {
      const from = cycleByNode.get(edge.fromNode);
      const to = cycleByNode.get(edge.toNode);
      if (isLegacyDerivesEdge(edge)) continue;
      if (edge.helixManaged === true) {
        if (!from || !to) {
          throw new Error(`Helix 管理边引用缺失或非阶段节点：${edge.id}`);
        }
        physicalEdges.push({
          id: edge.id,
          fromCycleId: from.id,
          toCycleId: to.id,
        });
        continue;
      }
      if (!from || !to) continue;
      nativeRelationCandidates.push({
        edgeId: edge.id,
        canvasRevisionHash: canvas.revision?.hash ?? "",
        fromCycleId: from.id,
        toCycleId: to.id,
        fromTitle: from.title,
        toTitle: to.title,
        crossProject: cycleOwner.get(from.id) !== cycleOwner.get(to.id),
      });
    }
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
    const normalizedGraph = normalizeProjectGraph(
      cycles.map((cycle) => cycle.id),
      physicalEdges,
    );
    const relations = normalizedGraph.relations;
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
    const result: ProjectWorkspaceSnapshot = {
      canvasPath: normalizePath(this.canvasPath()),
      canvasRevisionHash: canvas.revision?.hash ?? null,
      managedMarkdownRevisionHashes: Object.fromEntries(
        [...managedMarkdownRevisionHashes.entries()].sort(([left], [right]) =>
          left.localeCompare(right)),
      ),
      projects,
      nextStageSequenceByProject,
      relations,
      migrationWarnings: [...new Set(migrationWarnings)],
      migrationItems: pendingMigrationItems,
      migrationRequired: pendingMigrationItems.length > 0,
      canvasRepairRequired: false,
      canvasRepairReasons: [],
      canvasNodes,
      collapsedCompletedProjectIds: validatedCompletedCollapse(
        canvas.document,
        new Set(projects.map((project) => project.id)),
      ),
      nativeRelationCandidates,
    };
    this.knownMarkdownPaths = new Set([
      ...projects.map((project) => normalizePath(project.notePath)),
      ...projects.flatMap((project) =>
        project.cycles.map((cycle) => normalizePath(cycle.notePath))),
    ]);
    return result;
  }

  async ensureCanvas(): Promise<ProjectWorkspaceSnapshot> {
    return this.ensureCanvasFromSnapshot(await this.readStableSnapshot(), { allowWrite: true });
  }

  async repairDerivedCanvasCache(
    snapshot: ProjectWorkspaceSnapshot,
  ): Promise<ProjectWorkspaceSnapshot> {
    if (!canSilentlyRepairProjectCanvas(snapshot)) return snapshot;
    return this.ensureCanvasFromSnapshot(snapshot, { allowWrite: true });
  }

  private async ensureCanvasFromSnapshot(
    snapshot: ProjectWorkspaceSnapshot,
    options: { allowWrite: boolean },
  ): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    if (snapshot.migrationRequired) {
      throw new Error("检测到旧项目数据。请先在项目页预览并确认迁移，不会自动改写。");
    }
    let canvas = await this.readCanvas(false, generation);
    if ((canvas.revision?.hash ?? null) !== snapshot.canvasRevisionHash) {
      throw new Error("Canvas 在稳定读取后再次变化，未执行摘要修复");
    }
    const canvasMissing = !canvas.revision;
    canvas = {
      revision: canvas.revision,
      document: JSON.parse(JSON.stringify(canvas.document)) as CanvasDocument,
    };
    let changed = canvasMissing;
    const reasons = new Set<string>();
    if (canvasMissing) reasons.add("项目 Canvas 不存在");
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
            status: stageStatusText(cycle.status),
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
      if (!entity) throw new Error(`无法修复 Helix 管理节点：${node.id}`);
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
        reasons.add("Helix 管理节点摘要需要更新");
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
        reasons.add("缺少项目 Canvas 节点");
      }
      project.cycles.forEach((cycle, cycleIndex) => {
        if (existingCycles.has(cycle.id)) return;
        canvas.document.nodes.push(cardNode(
          `helix-stage-${cycle.id}`,
          cycle.notePath,
          cycle.title,
          stageStatusText(cycle.status),
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
        reasons.add("缺少阶段 Canvas 节点");
      });
    });
    if (ensureStageSequenceLedger(canvas.document, snapshot)) {
      changed = true;
      reasons.add("阶段编号高水位需要补齐");
    }
    const edgeBefore = JSON.stringify(canvas.document.edges);
    const normalized = normalizeProjectGraph(
      snapshot.projects.flatMap((project) =>
        project.cycles.map((cycle) => cycle.id)),
      physicalManagedEdges(canvas.document),
    );
    applyNormalizedManagedEdges(canvas.document, normalized.edges);
    if (JSON.stringify(canvas.document.edges) !== edgeBefore) {
      changed = true;
      reasons.add("Helix 管理的阶段关系需要正规化");
    }
    if (changed) {
      if (!options.allowWrite) return {
        ...snapshot,
        canvasRepairRequired: true,
        canvasRepairReasons: [...reasons],
      };
      await this.assertManagedMarkdownRevisions(snapshot);
      this.assertActive(generation);
      await this.writeCanvas(canvas, generation);
    }
    return this.snapshot();
  }

  private async assertManagedMarkdownRevisions(
    snapshot: ProjectWorkspaceSnapshot,
  ): Promise<void> {
    for (const [path, expectedHash] of Object.entries(snapshot.managedMarkdownRevisionHashes)
      .sort(([left], [right]) => left.localeCompare(right))) {
      const current = await this.repository.read(path);
      if (!current || !expectedHash || current.hash !== expectedHash) {
        throw new Error("项目 Markdown 已变化，请重试");
      }
    }
  }

  async moveCanvasNode(
    nodeId: string,
    x: number,
    y: number,
  ): Promise<ProjectWorkspaceSnapshot> {
    const snapshot = await this.snapshot();
    if (!snapshot.canvasRevisionHash) throw new Error("项目 Canvas 不存在");
    return this.moveCanvasNodes(
      [{ nodeId, x, y }],
      snapshot.canvasRevisionHash,
    );
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

  async prepareProjectDidaMappingUpdate(
    projectId: string,
  ): Promise<ProjectWorkspaceDidaMappingUpdatePlan> {
    const generation = this.beginOperation();
    const snapshot = await this.snapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("找不到需要映射滴答清单的项目");
    const revision = await this.repository.read(project.notePath);
    if (!revision) throw new Error("项目 Markdown 已不存在");
    const frontmatter = frontmatterFromContent(revision.content);
    const current = typeof frontmatter?.["helix-dida-project-id"] === "string" &&
      frontmatter["helix-dida-project-id"].trim()
      ? frontmatter["helix-dida-project-id"].trim()
      : undefined;
    if (
      frontmatter?.["helix-kind"] !== "helix-project" ||
      frontmatter["helix-id"] !== project.id ||
      current !== project.didaProjectId
    ) {
      throw new Error("项目 Markdown 身份或滴答映射已变化，请重新打开映射编辑");
    }
    this.assertActive(generation);
    return {
      kind: "project-dida-mapping",
      entityId: project.id,
      notePath: project.notePath,
      revisionHash: revision.hash,
      currentDidaProjectId: project.didaProjectId,
    };
  }

  async updateProjectDidaMapping(
    plan: ProjectWorkspaceDidaMappingUpdatePlan,
    didaProjectId?: string,
  ): Promise<ProjectWorkspaceSnapshot> {
    const nextId = didaProjectId?.trim() || undefined;
    if (nextId?.startsWith("local-project-")) {
      throw new Error("待核对的本地临时清单不能成为项目映射");
    }
    const generation = this.beginOperation();
    const snapshot = await this.snapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === plan.entityId);
    if (!project) throw new Error("找不到需要映射滴答清单的项目");
    if (project.didaProjectId !== plan.currentDidaProjectId) {
      throw new Error("项目滴答映射在确认期间已经变化，请重新打开");
    }
    const owner = nextId && snapshot.projects.find((candidate) =>
      candidate.id !== project.id && candidate.didaProjectId === nextId);
    if (owner) throw new Error(`该滴答清单已映射到另一 Helix 项目：${owner.title}`);
    const revision = await this.repository.read(plan.notePath);
    if (!revision) throw new Error("项目 Markdown 已不存在");
    const frontmatter = frontmatterFromContent(revision.content);
    const current = typeof frontmatter?.["helix-dida-project-id"] === "string" &&
      frontmatter["helix-dida-project-id"].trim()
      ? frontmatter["helix-dida-project-id"].trim()
      : undefined;
    if (
      plan.kind !== "project-dida-mapping" ||
      revision.hash !== plan.revisionHash ||
      frontmatter?.["helix-kind"] !== "helix-project" ||
      frontmatter["helix-id"] !== plan.entityId ||
      current !== plan.currentDidaProjectId
    ) {
      throw new Error("项目 Markdown 在映射确认期间已经变化，请重新打开");
    }
    this.assertActive(generation);
    await this.repository.compareAndWrite(
      revision,
      patchManagedFrontmatter(revision.content, {
        "helix-dida-project-id": nextId,
        "helix-updated": new Date().toISOString(),
      }),
      () => this.assertActive(generation),
    );
    return this.snapshot();
  }

  async prepareProjectStatusUpdate(
    projectId: string,
  ): Promise<ProjectWorkspaceProjectStatusUpdatePlan> {
    const generation = this.beginOperation();
    const snapshot = await this.snapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("找不到需要修改状态的项目");
    const revision = await this.repository.read(project.notePath);
    if (!revision) throw new Error("项目 Markdown 已不存在");
    this.assertActive(generation);
    const frontmatter = frontmatterFromContent(revision.content);
    if (
      frontmatter?.["helix-kind"] !== "helix-project" ||
      frontmatter["helix-id"] !== project.id ||
      projectStatusFromFrontmatter(frontmatter["helix-status"]) !== project.status
    ) {
      throw new Error("项目 Markdown 身份或状态已变化，请重新打开状态编辑");
    }
    return {
      kind: "project",
      entityId: project.id,
      notePath: project.notePath,
      revisionHash: revision.hash,
      currentStatus: project.status,
      currentStoredStatus: String(frontmatter["helix-status"]),
    };
  }

  async updateProjectStatus(
    plan: ProjectWorkspaceProjectStatusUpdatePlan,
    status: ProjectWorkspaceProjectStatus,
  ): Promise<ProjectWorkspaceSnapshot> {
    if (!isProjectStatus(status)) {
      throw new Error("项目状态无效");
    }
    const generation = this.beginOperation();
    const revision = await this.repository.read(plan.notePath);
    if (!revision) throw new Error("项目 Markdown 已不存在");
    const frontmatter = frontmatterFromContent(revision.content);
    if (
      plan.kind !== "project" ||
      revision.hash !== plan.revisionHash ||
      frontmatter?.["helix-kind"] !== "helix-project" ||
      frontmatter["helix-id"] !== plan.entityId ||
      frontmatter["helix-status"] !== plan.currentStoredStatus
    ) {
      throw new Error("项目 Markdown 在状态确认期间已经变化，请重新打开状态编辑");
    }
    this.assertActive(generation);
    await this.repository.compareAndWrite(
      revision,
      patchManagedFrontmatter(revision.content, {
        "helix-status": status,
        "helix-updated": new Date().toISOString(),
      }),
      () => this.assertActive(generation),
    );
    return this.snapshot();
  }

  async renameProject(
    projectId: string,
    title: string,
  ): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error("请输入项目名称");
    assertSingleLineTitle(normalizedTitle, "项目名称");
    const snapshot = await this.snapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("找不到需要重命名的项目");
    if (project.title === normalizedTitle) return snapshot;
    const revision = await this.repository.read(project.notePath);
    if (!revision || revision.hash !== snapshot.managedMarkdownRevisionHashes[project.notePath]) {
      throw new Error("项目 Markdown 在重命名期间已经变化，请重新操作");
    }
    assertManagedIdentity(revision.content, "helix-project", project.id);
    const canvas = await this.readCanvas(false, generation);
    if (!canvas.revision || canvas.revision.hash !== snapshot.canvasRevisionHash) {
      throw new Error("Canvas 在项目重命名期间已经变化，请重新操作");
    }
    const afterContent = rewriteFirstHeading(
      patchManagedFrontmatter(revision.content, {
        "helix-updated": new Date().toISOString(),
      }),
      normalizedTitle,
      "项目",
    );
    updateManagedNodeSummary(
      canvas.document,
      { kind: "project", entityId: project.id },
      project.notePath,
      normalizedTitle,
      projectStatusText(project.status),
    );
    this.assertActive(generation);
    return this.applyAtomicWorkspaceChange({
      label: "重命名项目",
      canvasBeforeHash: canvas.revision.hash,
      canvasAfterContent: JSON.stringify(canvas.document, null, 2),
      markdownUpdates: [{
        path: project.notePath,
        kind: "project",
        entityId: project.id,
        projectId: project.id,
        beforeHash: revision.hash,
        afterContent,
      }],
    });
  }

  async prepareCycleStatusUpdate(
    cycleId: string,
  ): Promise<ProjectWorkspaceCycleStatusUpdatePlan> {
    const generation = this.beginOperation();
    const snapshot = await this.snapshot();
    const owner = snapshot.projects.find((project) =>
      project.cycles.some((candidate) => candidate.id === cycleId));
    const cycle = owner?.cycles.find((candidate) => candidate.id === cycleId);
    if (!owner || !cycle) throw new Error("找不到需要修改状态的阶段");
    const revision = await this.repository.read(cycle.notePath);
    if (!revision) throw new Error("阶段 Markdown 已不存在");
    this.assertActive(generation);
    const frontmatter = frontmatterFromContent(revision.content);
    if (
      (
        frontmatter?.["helix-kind"] !== "helix-stage" &&
        frontmatter?.["helix-kind"] !== "helix-cycle"
      ) ||
      frontmatter["helix-id"] !== cycle.id ||
      frontmatter["helix-project-id"] !== owner.id ||
      stageStatusFromFrontmatter(frontmatter["helix-status"]) !== cycle.status
    ) {
      throw new Error("阶段 Markdown 身份、所属项目或状态已变化，请重新打开状态编辑");
    }
    return {
      kind: "cycle",
      entityId: cycle.id,
      projectId: owner.id,
      notePath: cycle.notePath,
      revisionHash: revision.hash,
      currentStatus: cycle.status,
      currentStoredStatus: String(frontmatter["helix-status"]),
    };
  }

  async updateCycleStatus(
    plan: ProjectWorkspaceCycleStatusUpdatePlan,
    status: ProjectWorkspaceCycleStatus,
  ): Promise<ProjectWorkspaceSnapshot> {
    if (!isStageStatus(status)) {
      throw new Error("阶段状态无效");
    }
    const generation = this.beginOperation();
    const revision = await this.repository.read(plan.notePath);
    if (!revision) throw new Error("阶段 Markdown 已不存在");
    const frontmatter = frontmatterFromContent(revision.content);
    if (
      plan.kind !== "cycle" ||
      revision.hash !== plan.revisionHash ||
      (
        frontmatter?.["helix-kind"] !== "helix-stage" &&
        frontmatter?.["helix-kind"] !== "helix-cycle"
      ) ||
      frontmatter["helix-id"] !== plan.entityId ||
      frontmatter["helix-project-id"] !== plan.projectId ||
      frontmatter["helix-status"] !== plan.currentStoredStatus
    ) {
      throw new Error("阶段 Markdown 在状态确认期间已经变化，请重新打开状态编辑");
    }
    this.assertActive(generation);
    await this.repository.compareAndWrite(
      revision,
      patchManagedFrontmatter(revision.content, {
        "helix-status": status,
        "helix-closed": isTerminalStageStatus(status) ? new Date().toISOString() : undefined,
        "helix-updated": new Date().toISOString(),
      }),
      () => this.assertActive(generation),
    );
    return this.snapshot();
  }

  async renameCycle(
    cycleId: string,
    title: string,
  ): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error("请输入阶段名称");
    assertSingleLineTitle(normalizedTitle, "阶段名称");
    const snapshot = await this.snapshot();
    const project = snapshot.projects.find((candidate) =>
      candidate.cycles.some((cycle) => cycle.id === cycleId));
    const cycle = project?.cycles.find((candidate) => candidate.id === cycleId);
    if (!project || !cycle) throw new Error("找不到需要重命名的阶段");
    if (cycle.title === normalizedTitle) return snapshot;
    const revision = await this.repository.read(cycle.notePath);
    if (!revision || revision.hash !== snapshot.managedMarkdownRevisionHashes[cycle.notePath]) {
      throw new Error("阶段 Markdown 在重命名期间已经变化，请重新操作");
    }
    assertManagedStageIdentity(revision.content, cycle.id, project.id);
    const canvas = await this.readCanvas(false, generation);
    if (!canvas.revision || canvas.revision.hash !== snapshot.canvasRevisionHash) {
      throw new Error("Canvas 在阶段重命名期间已经变化，请重新操作");
    }
    const afterContent = rewriteFirstHeading(
      patchManagedFrontmatter(revision.content, {
        "helix-updated": new Date().toISOString(),
      }),
      `阶段 ${cycle.stageCode} · ${normalizedTitle}`,
      "阶段",
    );
    updateManagedNodeSummary(
      canvas.document,
      { kind: "cycle", entityId: cycle.id },
      cycle.notePath,
      normalizedTitle,
      stageStatusText(cycle.status),
    );
    const renamedSnapshot: ProjectWorkspaceSnapshot = {
      ...snapshot,
      projects: snapshot.projects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              cycles: candidate.cycles.map((item) =>
                item.id === cycle.id ? { ...item, title: normalizedTitle } : item),
            }
          : candidate),
    };
    const downstreamIds = snapshot.relations
      .filter((relation) => relation.fromCycleIds.includes(cycle.id))
      .map((relation) => relation.toCycleId);
    const focusUpdates = await this.focusMarkdownUpdates(
      renamedSnapshot,
      snapshot.relations,
      downstreamIds,
    );
    this.assertActive(generation);
    return this.applyAtomicWorkspaceChange({
      label: "重命名阶段",
      canvasBeforeHash: canvas.revision.hash,
      canvasAfterContent: JSON.stringify(canvas.document, null, 2),
      markdownUpdates: [
        {
          path: cycle.notePath,
          kind: "stage",
          entityId: cycle.id,
          projectId: project.id,
          beforeHash: revision.hash,
          afterContent,
        },
        ...focusUpdates,
      ],
    });
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
    await this.writeCanvas(canvas, generation, {
      label: collapsed ? "折叠已完成阶段" : "展开已完成阶段",
      markdownTransitions: [],
    });
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
    const addedEdge = after.edges.find((edge) =>
      edge.fromCycleId === sourceCycleId && edge.toCycleId === targetCycleId);
    if (!addedEdge) throw new Error("无法确认新增阶段关系的显示类型");
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
      targetInboundCount: physical.filter((edge) =>
        edge.toCycleId === targetCycleId).length,
      resultKind: addedEdge.kind,
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
    return this.applyAtomicWorkspaceChange({
      label: "建立阶段连接",
      canvasBeforeHash: canvas.revision.hash,
      canvasAfterContent: JSON.stringify(canvas.document, null, 2),
      markdownUpdates: await this.focusMarkdownUpdates(
        snapshot,
        normalized.relations,
        [canonicalPlan.targetCycleId],
      ),
    });
  }

  async adoptNativeRelation(
    candidate: ProjectWorkspaceNativeRelationCandidate,
    options: { confirmCrossProject?: boolean } = {},
  ): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const snapshot = await this.snapshot();
    const canonical = snapshot.nativeRelationCandidates.find((current) =>
      sameNativeRelationCandidate(current, candidate));
    if (!canonical) {
      throw new Error("原生 Canvas 连线在确认期间已经变化，请重新打开项目页");
    }
    if (canonical.crossProject && !options.confirmCrossProject) {
      throw new Error("跨项目原生连线必须明确确认");
    }
    const canvas = await this.readCanvas(false, generation);
    if (
      !canvas.revision ||
      canvas.revision.hash !== canonical.canvasRevisionHash ||
      snapshot.canvasRevisionHash !== canonical.canvasRevisionHash
    ) {
      throw new Error("Canvas 在确认交由 Helix 管理期间已经变化，本次操作未写入");
    }
    const stageByNode = new Map(canvas.document.nodes.flatMap((node) => {
      const stageId = managedStageId(node);
      return stageId ? [[node.id, stageId] as const] : [];
    }));
    const edge = canvas.document.edges.find((current) =>
      current.id === canonical.edgeId);
    if (
      !edge ||
      edge.helixManaged === true ||
      isLegacyDerivesEdge(edge) ||
      stageByNode.get(edge.fromNode) !== canonical.fromCycleId ||
      stageByNode.get(edge.toNode) !== canonical.toCycleId
    ) {
      throw new Error("原生 Canvas 连线的端点或身份已经变化，本次操作未写入");
    }
    const physical = [
      ...physicalManagedEdges(canvas.document),
      {
        id: canonical.edgeId,
        fromCycleId: canonical.fromCycleId,
        toCycleId: canonical.toCycleId,
      },
    ];
    const normalized = normalizeProjectGraph(
      snapshot.projects.flatMap((project) =>
        project.cycles.map((cycle) => cycle.id)),
      physical,
    );
    edge.helixManaged = true;
    applyNormalizedManagedEdges(canvas.document, normalized.edges);
    const affected = affectedWeakComponent(
      [canonical.fromCycleId, canonical.toCycleId],
      physical,
    );
    applyManagedLayout(canvas.document, snapshot, physical, affected);
    this.assertActive(generation);
    return this.applyAtomicWorkspaceChange({
      label: "由 Helix 管理原生阶段连线",
      canvasBeforeHash: canvas.revision.hash,
      canvasAfterContent: JSON.stringify(canvas.document, null, 2),
      markdownUpdates: await this.focusMarkdownUpdates(
        snapshot,
        normalized.relations,
        [canonical.toCycleId],
      ),
    });
  }

  async planNativeRelationAdoption(
    candidate: ProjectWorkspaceNativeRelationCandidate,
  ): Promise<ProjectWorkspaceNativeRelationAdoptionPlan> {
    const snapshot = await this.snapshot();
    const canonical = snapshot.nativeRelationCandidates.find((current) =>
      sameNativeRelationCandidate(current, candidate));
    if (!canonical) {
      throw new Error("原生 Canvas 连线在预览期间已经变化，请重新打开项目页");
    }
    const canvas = await this.readCanvas();
    if (
      !canvas.revision ||
      canvas.revision.hash !== canonical.canvasRevisionHash ||
      snapshot.canvasRevisionHash !== canonical.canvasRevisionHash
    ) {
      throw new Error("Canvas 在管理操作预览期间已经变化，请重试");
    }
    const physical = physicalManagedEdges(canvas.document);
    const before = normalizeProjectGraph(
      snapshot.projects.flatMap((project) =>
        project.cycles.map((cycle) => cycle.id)),
      physical,
    );
    const nextPhysical = [
      ...physical,
      {
        id: canonical.edgeId,
        fromCycleId: canonical.fromCycleId,
        toCycleId: canonical.toCycleId,
      },
    ];
    const after = normalizeProjectGraph(
      snapshot.projects.flatMap((project) =>
        project.cycles.map((cycle) => cycle.id)),
      nextPhysical,
    );
    const adopted = after.edges.find((edge) => edge.id === canonical.edgeId);
    if (!adopted) throw new Error("无法计算原生 Canvas 连线的关系类型");
    return {
      ...canonical,
      affectedNodeCount: affectedWeakComponent(
        [canonical.fromCycleId, canonical.toCycleId],
        nextPhysical,
      ).size,
      relabeledEdgeCount: countRelabeledEdges(before, after),
      resultKind: adopted.kind,
    };
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
    await this.writeCanvas(canvas, generation, {
      label: "整理项目图谱",
      markdownTransitions: [],
    });
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
    expectedCanvasRevisionHash: string,
    options: { recordHistory?: boolean } = {},
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
    if (
      !expectedCanvasRevisionHash ||
      canvas.revision.hash !== expectedCanvasRevisionHash
    ) {
      throw new Error("Canvas 在拖动期间已经变化，卡片位置未写入");
    }
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
    await this.writeCanvas(
      canvas,
      generation,
      options.recordHistory === false
        ? undefined
        : {
            label: moves.length > 1 ? `移动 ${moves.length} 个阶段` : "移动阶段",
            markdownTransitions: [],
          },
    );
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
    const cycleFrontmatter = frontmatterFromContent(cycleRevision.content);
    if (
      (
        cycleFrontmatter?.["helix-kind"] !== "helix-stage" &&
        cycleFrontmatter?.["helix-kind"] !== "helix-cycle"
      ) ||
      cycleFrontmatter["helix-id"] !== cycleId ||
      cycleFrontmatter["helix-project-id"] !== owner.id
    ) {
      throw new Error("阶段 Markdown 在删除确认后被其他内容替换，本次操作未写入");
    }

    const canvas = await this.readCanvas(false, generation);
    if (!canvas.revision || canvas.revision.hash !== canonicalPlan.canvasRevisionHash) {
      throw new Error("Canvas 在删除确认期间已经变化，本次操作未写入");
    }
    const node = canvas.document.nodes.find((candidate) =>
      candidate.helixManaged === true && managedStageId(candidate) === cycleId);
    if (!node) throw new Error("Canvas 中找不到需要删除的阶段节点");
    const unmanagedAttachments = canvas.document.edges.filter((edge) =>
      (edge.fromNode === node.id || edge.toNode === node.id) &&
      (edge.helixManaged !== true || isLegacyDerivesEdge(edge)));
    if (unmanagedAttachments.length > 0) {
      throw new Error(
        `该阶段还有 ${unmanagedAttachments.length} 条原生 Canvas 连线尚未交由 Helix 管理；` +
        "为避免删除用户关系，请先在 Canvas 中移除这些连线，或明确交由 Helix 管理",
      );
    }
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
    const remainingOwnerCycles = owner.cycles.filter((candidate) => candidate.id !== cycleId);
    const maintainedCodes = maintainedStageCodes(remainingOwnerCycles, normalized.relations);
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
              cycles: remainingOwnerCycles.map((candidate) => ({
                ...candidate,
                stageCode: maintainedCodes.get(candidate.id) ?? candidate.stageCode,
              })),
            }
          : project),
      canvasNodes: snapshot.canvasNodes.filter((candidate) =>
        candidate.entityId !== cycleId),
    };
    applyManagedLayout(canvas.document, layoutSnapshot, physical, affected);
    canvas.document.helixStageCodes = replaceProjectStageCodes(
      canvas.document,
      owner.id,
      remainingOwnerCycles.map((candidate) =>
        maintainedCodes.get(candidate.id) ?? candidate.stageCode),
    );

    const nextCanvasContent = JSON.stringify(canvas.document, null, 2);
    const changedFocusTargets = remainingCycleIds.filter((targetId) =>
      relationSourceSignature(snapshot.relations, targetId) !==
        relationSourceSignature(normalized.relations, targetId));
    const focusUpdates = await this.focusMarkdownUpdates(
      // 旧来源仍需参与受管块 canonical 校验；它只用于校验，最终派生关系
      // 仍完全取自 normalized.relations，且其 Markdown 会在同一事务删除。
      snapshot,
      normalized.relations,
      changedFocusTargets,
    );
    const markdownUpdates = new Map(focusUpdates.map((update) =>
      [normalizePath(update.path), update] as const));
    for (const surviving of remainingOwnerCycles) {
      const nextCode = maintainedCodes.get(surviving.id) ?? surviving.stageCode;
      if (nextCode === surviving.stageCode) continue;
      const path = normalizePath(surviving.notePath);
      const existing = markdownUpdates.get(path);
      const revision = await this.repository.read(path);
      if (!revision || (existing && existing.beforeHash !== revision.hash)) {
        throw new Error(`阶段编号维护前 Markdown 已变化：${path}`);
      }
      const frontmatter = frontmatterFromContent(revision.content);
      const currentCode = managedFrontmatterString(revision.content, "helix-stage-code");
      if (
        frontmatter?.["helix-id"] !== surviving.id ||
        frontmatter["helix-project-id"] !== owner.id ||
        (currentCode.present
          ? currentCode.value !== surviving.stageCode
          : surviving.stageCode !== String(surviving.sequence))
      ) {
        throw new Error(`阶段编号维护前身份或展示编号已变化：${path}`);
      }
      const sourceContent = existing?.afterContent ?? revision.content;
      const afterContent = rewriteManagedStageHeading(
        patchManagedFrontmatter(sourceContent, { "helix-stage-code": nextCode }),
        surviving.stageCode,
        nextCode,
      );
      markdownUpdates.set(path, {
        path,
        kind: "stage",
        entityId: surviving.id,
        projectId: owner.id,
        beforeHash: revision.hash,
        afterContent,
      });
    }
    if (markdownUpdates.size > 0) {
      this.assertActive(generation);
      return this.applyAtomicWorkspaceChange({
        label: bridge ? "删除并桥接阶段" : "删除阶段",
        canvasBeforeHash: canvas.revision.hash,
        canvasAfterContent: nextCanvasContent,
        markdownUpdates: [...markdownUpdates.values()],
        markdownDeletions: [{
          path: cycleRevision.path,
          kind: "stage",
          entityId: cycleId,
          projectId: owner.id,
          beforeHash: cycleRevision.hash,
        }],
      });
    }
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
    if (
      await this.repository.read(this.historyJournalPath()) ||
      await this.repository.read(this.stageDeletionJournalPath())
    ) {
      const message = "已有项目图谱事务日志，不能开始阶段删除";
      this.freezePendingStageDeletion(message);
      throw new Error(message);
    }
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
      if (error instanceof VaultDeletionClaimError) {
        const message =
          `阶段删除的 Markdown 认领无法恢复，Canvas 和事务日志保持待恢复状态：${error.message}`;
        this.freezePendingStageDeletion(message);
        throw new Error(message);
      }
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
    this.recordHistoryEntry({
      id: crypto.randomUUID(),
      label: bridge ? "删除并桥接阶段" : "删除阶段",
      canvasPath: canvas.revision.path,
      canvasBeforeContent: canvas.revision.content,
      canvasAfterContent: writtenCanvas.content,
      markdownTransitions: [{
        path: cycleRevision.path,
        kind: "stage",
        entityId: cycleId,
        projectId: owner.id,
        fromContent: cycleRevision.content,
        toContent: null,
      }],
    });
    return this.snapshot();
  }

  async deleteProject(projectId: string): Promise<ProjectWorkspaceSnapshot> {
    const generation = this.beginOperation();
    const snapshot = await this.ensureCanvas();
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("找不到需要删除的项目");
    const canvas = await this.readCanvas(false, generation);
    if (!canvas.revision || canvas.revision.hash !== snapshot.canvasRevisionHash) {
      throw new Error("Canvas 在项目删除前已经变化，本次操作未写入");
    }
    const projectRevision = await this.repository.read(project.notePath);
    if (!projectRevision) throw new Error("项目 Markdown 已不存在");
    const projectFrontmatter = frontmatterFromContent(projectRevision.content);
    if (
      projectFrontmatter?.["helix-kind"] !== "helix-project" ||
      projectFrontmatter["helix-id"] !== projectId
    ) {
      throw new Error("项目 Markdown 身份已变化，本次操作未写入");
    }
    const stageRevisions: VaultRevision[] = [];
    for (const stage of project.cycles) {
      const revision = await this.repository.read(stage.notePath);
      const frontmatter = revision ? frontmatterFromContent(revision.content) : null;
      if (
        !revision ||
        (frontmatter?.["helix-kind"] !== "helix-stage" &&
          frontmatter?.["helix-kind"] !== "helix-cycle") ||
        frontmatter["helix-id"] !== stage.id ||
        frontmatter["helix-project-id"] !== projectId
      ) {
        throw new Error(`阶段 Markdown 身份已变化，本次操作未写入：${stage.notePath}`);
      }
      stageRevisions.push(revision);
    }
    const deletedStageIds = new Set(project.cycles.map((stage) => stage.id));
    const removedNodeIds = new Set(canvas.document.nodes.flatMap((node) => {
      const stageId = managedStageId(node);
      const isProjectNode = node.helixManaged === true &&
        node.helixNodeKind === "project" && node.helixProjectId === projectId;
      return isProjectNode || (stageId && deletedStageIds.has(stageId)) ? [node.id] : [];
    }));
    const unmanagedAttachments = canvas.document.edges.filter((edge) =>
      (removedNodeIds.has(edge.fromNode) || removedNodeIds.has(edge.toNode)) &&
      (edge.helixManaged !== true || isLegacyDerivesEdge(edge)));
    if (unmanagedAttachments.length > 0) {
      throw new Error(
        `该项目还有 ${unmanagedAttachments.length} 条原生 Canvas 连线未交由 Helix 管理，` +
        "为避免删除用户关系，本次操作已取消",
      );
    }
    const physical = physicalManagedEdges(canvas.document).filter((edge) =>
      !deletedStageIds.has(edge.fromCycleId) && !deletedStageIds.has(edge.toCycleId));
    const remainingProjects = snapshot.projects.filter((candidate) => candidate.id !== projectId);
    const remainingStageIds = remainingProjects.flatMap((candidate) =>
      candidate.cycles.map((stage) => stage.id));
    const normalized = normalizeProjectGraph(remainingStageIds, physical);
    canvas.document.nodes = canvas.document.nodes.filter((node) => !removedNodeIds.has(node.id));
    canvas.document.edges = canvas.document.edges.filter((edge) =>
      !removedNodeIds.has(edge.fromNode) && !removedNodeIds.has(edge.toNode));
    applyNormalizedManagedEdges(canvas.document, normalized.edges);
    const sequenceLedger = validatedStageSequenceLedger(canvas.document);
    delete sequenceLedger[projectId];
    canvas.document.helixStageSequences = sequenceLedger;
    const codeLedger = validatedStageCodeLedger(canvas.document);
    delete codeLedger[projectId];
    canvas.document.helixStageCodes = codeLedger;
    if (canvas.document.helixCompletedCollapse) {
      canvas.document.helixCompletedCollapse.projectIds =
        canvas.document.helixCompletedCollapse.projectIds.filter((id) => id !== projectId);
    }
    const nextSnapshot: ProjectWorkspaceSnapshot = {
      ...snapshot,
      projects: remainingProjects,
      canvasNodes: snapshot.canvasNodes.filter((node) => node.projectId !== projectId),
    };
    applyManagedLayout(canvas.document, nextSnapshot, physical);
    const changedFocusTargets = remainingStageIds.filter((targetId) =>
      relationSourceSignature(snapshot.relations, targetId) !==
        relationSourceSignature(normalized.relations, targetId));
    const focusUpdates = await this.focusMarkdownUpdates(
      snapshot,
      normalized.relations,
      changedFocusTargets,
    );
    this.assertActive(generation);
    return this.applyAtomicWorkspaceChange({
      label: `删除项目：${project.title}`,
      canvasBeforeHash: canvas.revision.hash,
      canvasAfterContent: JSON.stringify(canvas.document, null, 2),
      markdownUpdates: focusUpdates,
      markdownDeletions: [
        {
          path: projectRevision.path,
          kind: "project",
          entityId: projectId,
          projectId,
          beforeHash: projectRevision.hash,
        },
        ...stageRevisions.map((revision, index) => ({
          path: revision.path,
          kind: "stage" as const,
          entityId: project.cycles[index]!.id,
          projectId,
          beforeHash: revision.hash,
        })),
      ],
    });
  }

  private stageDeletionJournalPath(): string {
    return normalizePath(`${this.rootFolder()}/.transactions/stage-delete.json`);
  }

  private historyJournalPath(): string {
    return normalizePath(`${this.rootFolder()}/.transactions/workspace-history.json`);
  }

  private focusBridgeStatePath(): string {
    return normalizePath(`${this.rootFolder()}/.transactions/stage-focus-bridge.json`);
  }

  private recordHistoryEntry(entry: ProjectWorkspaceHistoryEntry): void {
    if (this.applyingHistory) return;
    if (entry.canvasBeforeContent === entry.canvasAfterContent &&
      entry.markdownTransitions.length === 0) return;
    this.undoStack.push(entry);
    while (
      this.undoStack.length > ProjectWorkspaceService.HISTORY_ENTRY_LIMIT ||
      this.historyBytes(this.undoStack) >
        ProjectWorkspaceService.HISTORY_BYTE_LIMIT
    ) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  private historyBytes(entries: ProjectWorkspaceHistoryEntry[]): number {
    const bytes = (value: string): number =>
      new TextEncoder().encode(value).byteLength;
    return entries.reduce((sum, entry) =>
      sum + bytes(entry.canvasBeforeContent) + bytes(entry.canvasAfterContent) +
      entry.markdownTransitions.reduce((transitionSum, transition) =>
        transitionSum +
        (transition.fromContent ? bytes(transition.fromContent) : 0) +
        (transition.toContent ? bytes(transition.toContent) : 0), 0), 0);
  }

  private async applyHistoryEntry(
    entry: ProjectWorkspaceHistoryEntry,
    direction: "undo" | "redo",
  ): Promise<void> {
    if (this.applyingHistory) throw new Error("已有撤销或重做正在执行");
    const generation = this.beginOperation();
    const fromCanvasContent = direction === "undo"
      ? entry.canvasAfterContent
      : entry.canvasBeforeContent;
    const toCanvasContent = direction === "undo"
      ? entry.canvasBeforeContent
      : entry.canvasAfterContent;
    const transitions = entry.markdownTransitions.map((transition) =>
      direction === "undo"
        ? {
            ...transition,
            fromContent: transition.toContent,
            toContent: transition.fromContent,
          }
        : { ...transition });
    const canvas = await this.repository.read(entry.canvasPath);
    if (!canvas || canvas.hash !== stableHash(fromCanvasContent)) {
      throw new Error("Canvas 在操作完成后已被修改，不能撤销或重做");
    }
    await this.assertHistoryFromState(transitions);
    let journal: ProjectWorkspaceHistoryJournal = {
      version: 2,
      operation: "apply-workspace-history",
      phase: "prepared",
      createdAt: new Date().toISOString(),
      entryId: entry.id,
      direction,
      canvasPath: entry.canvasPath,
      canvasFromContent: fromCanvasContent,
      canvasToContent: toCanvasContent,
      markdownTransitions: transitions,
    };
    if (
      await this.repository.read(this.stageDeletionJournalPath()) ||
      await this.repository.read(this.historyJournalPath())
    ) {
      const message = "已有项目图谱事务日志，不能开始撤销或重做";
      this.freezePendingStageDeletion(message);
      throw new Error(message);
    }
    let journalRevision = await this.repository.create(
      this.historyJournalPath(),
      JSON.stringify(journal, null, 2),
      () => this.assertActive(generation),
    );
    this.applyingHistory = true;
    try {
      for (const transition of transitions) {
        if (transition.fromContent === null && transition.toContent !== null) {
          await this.assertHistoryJournalCurrent(journalRevision);
          await this.repository.create(
            transition.path,
            transition.toContent,
            () => this.assertActive(generation),
          );
        } else if (
          transition.fromContent !== null &&
          transition.toContent !== null
        ) {
          const current = await this.repository.read(transition.path);
          if (!current || current.hash !== stableHash(transition.fromContent)) {
            throw new Error(`阶段 Markdown 已变化，不能应用历史：${transition.path}`);
          }
          await this.assertHistoryJournalCurrent(journalRevision);
          await this.repository.compareAndWrite(
            current,
            transition.toContent,
            () => this.assertActive(generation),
          );
        }
      }
      ({ journal, revision: journalRevision } = await this.updateHistoryJournalPhase(
        journalRevision,
        journal,
        "markdown-applied",
        generation,
      ));
      await this.assertHistoryJournalCurrent(journalRevision);
      await this.repository.compareAndWrite(
        canvas,
        toCanvasContent,
        () => this.assertActive(generation),
      );
      ({ journal, revision: journalRevision } = await this.updateHistoryJournalPhase(
        journalRevision,
        journal,
        "canvas-applied",
        generation,
      ));
      await this.finishHistoryRemovals(transitions, generation, journalRevision);
      await this.finishMachineJournal(journalRevision, generation);
    } catch (error) {
      let currentCanvas: VaultRevision | null;
      try {
        currentCanvas = await this.repository.read(entry.canvasPath);
      } catch (readError) {
        const message =
          `项目图谱历史失败后无法复核 Canvas，事务日志已保留：${
            readError instanceof Error ? readError.message : String(readError)
          }`;
        this.freezePendingStageDeletion(message);
        throw new Error(message);
      }
      const canvasFromHash = stableHash(fromCanvasContent);
      const canvasToHash = stableHash(toCanvasContent);
      if (
        currentCanvas?.hash === canvasFromHash &&
        canvasFromHash === canvasToHash &&
        journal.phase === "canvas-applied"
      ) {
        const message =
          `纯 Markdown 项目事务已提交但日志尚未清理，已保留目标态等待重启恢复：${
            error instanceof Error ? error.message : String(error)
          }`;
        this.freezePendingStageDeletion(message);
        throw new Error(message);
      }
      if (currentCanvas?.hash === canvasFromHash) {
        try {
          await this.rollbackHistoryAdditions(transitions, generation, journalRevision);
          await this.finishMachineJournal(journalRevision, generation);
        } catch (cleanupError) {
          const message =
            `项目图谱历史失败且清理未完成，事务日志已保留：${
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError)
            }`;
          this.freezePendingStageDeletion(message);
          throw new Error(message);
        }
      } else {
        const message =
          `项目图谱${direction === "undo" ? "撤销" : "重做"}未完整结束；事务日志已保留，重启将继续恢复：${
            error instanceof Error ? error.message : String(error)
          }`;
        this.freezePendingStageDeletion(message);
        throw new Error(message);
      }
      throw error;
    } finally {
      this.applyingHistory = false;
    }
  }

  private async assertHistoryFromState(
    transitions: ProjectWorkspaceHistoryFileTransition[],
  ): Promise<void> {
    for (const transition of transitions) {
      const current = await this.repository.read(transition.path);
      if (transition.fromContent === null) {
        if (current) throw new Error(`目标路径已被占用，不能应用历史：${transition.path}`);
        continue;
      }
      if (!current || current.hash !== stableHash(transition.fromContent)) {
        throw new Error(`阶段 Markdown 已变化，不能应用历史：${transition.path}`);
      }
      this.assertHistoryStageIdentity(current.content, transition);
    }
  }

  private async historyTransitionStates(
    transitions: ProjectWorkspaceHistoryFileTransition[],
  ): Promise<Array<"before" | "after" | "unknown">> {
    const states: Array<"before" | "after" | "unknown"> = [];
    for (const transition of transitions) {
      const current = await this.repository.read(transition.path);
      const beforeMatches = transition.fromContent === null
        ? current === null
        : current?.hash === stableHash(transition.fromContent);
      const afterMatches = transition.toContent === null
        ? current === null
        : current?.hash === stableHash(transition.toContent);
      if (beforeMatches === afterMatches) {
        states.push("unknown");
        continue;
      }
      if (current) this.assertHistoryStageIdentity(current.content, transition);
      states.push(beforeMatches ? "before" : "after");
    }
    return states;
  }

  private async rollbackHistoryAdditions(
    transitions: ProjectWorkspaceHistoryFileTransition[],
    generation: number,
    journalRevision: VaultRevision,
  ): Promise<void> {
    for (const transition of transitions) {
      if (transition.fromContent === null && transition.toContent !== null) {
        const current = await this.repository.read(transition.path);
        if (!current) continue;
        if (current.hash !== stableHash(transition.toContent)) {
          throw new Error(`撤销事务新增的 Markdown 已被修改：${transition.path}`);
        }
        this.assertHistoryStageIdentity(current.content, transition);
        await this.assertHistoryJournalCurrent(journalRevision);
        await this.repository.trashIfUnchanged(
          current,
          () => this.assertActive(generation),
          { requireExisting: true },
        );
      } else if (transition.fromContent !== null) {
        const current = await this.repository.read(transition.path);
        if (!current) {
          throw new Error(`撤销事务起点 Markdown 已缺失：${transition.path}`);
        }
        if (
          transition.toContent !== null &&
          current.hash === stableHash(transition.toContent)
        ) {
          this.assertHistoryStageIdentity(current.content, transition);
          await this.assertHistoryJournalCurrent(journalRevision);
          await this.repository.compareAndWrite(
            current,
            transition.fromContent,
            () => this.assertActive(generation),
          );
          continue;
        }
        if (current.hash !== stableHash(transition.fromContent)) {
          throw new Error(`撤销事务 Markdown 已变化并同时偏离起点和终点：${transition.path}`);
        }
        this.assertHistoryStageIdentity(current.content, transition);
      }
    }
  }

  private async finishHistoryRemovals(
    transitions: ProjectWorkspaceHistoryFileTransition[],
    generation: number,
    journalRevision: VaultRevision,
  ): Promise<void> {
    for (const transition of transitions) {
      const current = await this.repository.read(transition.path);
      if (transition.toContent === null) {
        if (!current) continue;
        if (
          transition.fromContent === null ||
          current.hash !== stableHash(transition.fromContent)
        ) {
          throw new Error(`待移除的阶段 Markdown 已变化：${transition.path}`);
        }
        this.assertHistoryStageIdentity(current.content, transition);
        await this.assertHistoryJournalCurrent(journalRevision);
        await this.repository.trashIfUnchanged(
          current,
          () => this.assertActive(generation),
          { requireExisting: true },
        );
        continue;
      }
      if (!current && transition.fromContent === null) {
        await this.assertHistoryJournalCurrent(journalRevision);
        await this.repository.create(
          transition.path,
          transition.toContent,
          () => this.assertActive(generation),
        );
        continue;
      }
      if (!current) {
        throw new Error(`历史目标 Markdown 缺失：${transition.path}`);
      }
      if (
        transition.fromContent !== null &&
        current.hash === stableHash(transition.fromContent)
      ) {
        this.assertHistoryStageIdentity(current.content, transition);
        await this.assertHistoryJournalCurrent(journalRevision);
        await this.repository.compareAndWrite(
          current,
          transition.toContent,
          () => this.assertActive(generation),
        );
        continue;
      }
      if (current.hash !== stableHash(transition.toContent)) {
        throw new Error(`历史目标 Markdown 同时偏离起点和终点：${transition.path}`);
      }
      this.assertHistoryStageIdentity(current.content, transition);
    }
  }

  private assertHistoryStageIdentity(
    content: string,
    transition: ProjectWorkspaceHistoryFileTransition,
  ): void {
    const frontmatter = frontmatterFromContent(content);
    const valid = transition.kind === "project"
      ? (
          frontmatter?.["helix-kind"] === "helix-project" &&
          frontmatter["helix-id"] === transition.entityId
        )
      : (
          (
            frontmatter?.["helix-kind"] === "helix-stage" ||
            frontmatter?.["helix-kind"] === "helix-cycle"
          ) &&
          frontmatter["helix-id"] === transition.entityId &&
          frontmatter["helix-project-id"] === transition.projectId
        );
    if (!valid) {
      throw new Error(`历史事务中的 Markdown 身份不匹配：${transition.path}`);
    }
  }

  private parseHistoryJournal(content: string): ProjectWorkspaceHistoryJournal {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error("项目图谱撤销事务日志不是有效 JSON");
    }
    if (!value || typeof value !== "object") {
      throw new Error("项目图谱撤销事务日志根结构无效");
    }
    const journal = value as Partial<ProjectWorkspaceHistoryJournal>;
    if (
      (journal.version !== 1 && journal.version !== 2) ||
      journal.operation !== "apply-workspace-history" ||
      (journal.version === 2 &&
        journal.phase !== "prepared" &&
        journal.phase !== "markdown-applied" &&
        journal.phase !== "canvas-applied") ||
      (journal.direction !== "undo" && journal.direction !== "redo") ||
      typeof journal.createdAt !== "string" ||
      !journal.createdAt ||
      !isCanonicalIsoTimestamp(journal.createdAt) ||
      typeof journal.entryId !== "string" ||
      !journal.entryId ||
      typeof journal.canvasPath !== "string" ||
      journal.canvasPath !== normalizePath(this.canvasPath()) ||
      typeof journal.canvasFromContent !== "string" ||
      typeof journal.canvasToContent !== "string" ||
      !Array.isArray(journal.markdownTransitions)
    ) {
      throw new Error("项目图谱撤销事务日志字段无效");
    }
    const root = `${normalizePath(this.rootFolder())}/Projects/`;
    const transitionPaths = new Set<string>();
    for (const transition of journal.markdownTransitions) {
      if (
        !transition ||
        (transition.kind !== "stage" && transition.kind !== "project") ||
        typeof transition.path !== "string" ||
        normalizePath(transition.path) !== transition.path ||
        !transition.path.startsWith(root) ||
        !transition.path.endsWith(".md") ||
        typeof transition.entityId !== "string" ||
        !transition.entityId ||
        typeof transition.projectId !== "string" ||
        !transition.projectId ||
        !(
          transition.fromContent === null ||
          typeof transition.fromContent === "string"
        ) ||
        !(
          transition.toContent === null ||
          typeof transition.toContent === "string"
        ) ||
        transition.fromContent === transition.toContent
      ) {
        throw new Error("项目图谱撤销事务日志的 Markdown 转换无效");
      }
      if (transitionPaths.has(transition.path)) {
        throw new Error(`项目图谱撤销事务日志包含重复路径：${transition.path}`);
      }
      transitionPaths.add(transition.path);
      if (transition.fromContent !== null) {
        this.assertHistoryStageIdentity(transition.fromContent, transition);
      }
      if (transition.toContent !== null) {
        this.assertHistoryStageIdentity(transition.toContent, transition);
      }
    }
    return journal as ProjectWorkspaceHistoryJournal;
  }

  private async updateHistoryJournalPhase(
    revision: VaultRevision,
    journal: ProjectWorkspaceHistoryJournal,
    phase: "markdown-applied" | "canvas-applied",
    generation: number,
  ): Promise<{ journal: ProjectWorkspaceHistoryJournal; revision: VaultRevision }> {
    const current = await this.repository.read(revision.path);
    if (!current || current.hash !== revision.hash) {
      throw new Error("项目图谱事务日志在阶段推进前发生变化");
    }
    const next: ProjectWorkspaceHistoryJournal = { ...journal, version: 2, phase };
    const written = await this.repository.compareAndWrite(
      current,
      JSON.stringify(next, null, 2),
      () => this.assertActive(generation),
    );
    return { journal: next, revision: written };
  }

  private async assertHistoryJournalCurrent(revision: VaultRevision): Promise<void> {
    const current = await this.repository.read(revision.path);
    if (!current) throw new Error("项目图谱事务日志在写入前已不存在");
    const expected = this.parseHistoryJournal(revision.content);
    const actual = this.parseHistoryJournal(current.content);
    if (
      current.hash !== revision.hash ||
      stableHash(actual) !== stableHash(expected)
    ) {
      throw new Error("项目图谱事务日志在写入前发生变化");
    }
  }

  private async finishMachineJournal(
    revision: VaultRevision,
    generation: number,
  ): Promise<void> {
    const current = await this.repository.read(revision.path);
    if (!current) throw new Error("项目图谱事务日志在清理前已不存在");
    const expected = this.parseHistoryJournal(revision.content);
    const actual = this.parseHistoryJournal(current.content);
    if (stableHash(expected) !== stableHash(actual)) {
      throw new Error("项目图谱事务日志在清理前发生语义变化");
    }
    await this.repository.trashIfUnchanged(
      current,
      () => this.assertActive(generation),
      { requireExisting: true },
    );
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
      const current = await this.repository.read(revision.path);
      if (!current) {
        throw new Error("阶段删除事务日志在清理前已不存在");
      }
      const expectedJournal = this.parseStageDeletionJournal(revision.content);
      const currentJournal = this.parseStageDeletionJournal(current.content);
      if (stableHash(currentJournal) !== stableHash(expectedJournal)) {
        throw new Error("阶段删除事务日志在清理前发生语义变化");
      }
      await this.repository.trashIfUnchanged(
        current,
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
    if (canvas.revision.hash !== snapshot.canvasRevisionHash) {
      throw new Error("Canvas 在关系编辑期间已经变化，本次操作未写入");
    }
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
    return this.applyAtomicWorkspaceChange({
      label: replacement ? "修改阶段关系" : "删除阶段关系",
      canvasBeforeHash: canvas.revision.hash,
      canvasAfterContent: JSON.stringify(canvas.document, null, 2),
      markdownUpdates: await this.focusMarkdownUpdates(
        snapshot,
        normalized.relations,
        [current.toCycleId],
      ),
    });
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
    initialStageTitle: string,
    didaProjectId?: string,
    color?: string,
  ): Promise<ProjectWorkspaceProject> {
    const generation = this.beginOperation();
    const normalizedTitle = title.trim();
    const normalizedStageTitle = initialStageTitle.trim();
    const normalizedColor = normalizeProjectColor(color);
    const normalizedDidaProjectId = didaProjectId?.trim() || undefined;
    if (!normalizedTitle) throw new Error("请输入项目名称");
    if (!normalizedStageTitle) throw new Error("请输入首阶段名称");
    if (normalizedDidaProjectId?.startsWith("local-project-")) {
      throw new Error("本地临时清单尚未取得稳定远端 ID，不能建立项目映射");
    }
    assertSingleLineTitle(normalizedTitle, "项目名称");
    assertSingleLineTitle(normalizedStageTitle, "首阶段名称");
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
    // 模板不可用时不得为一次尚未创建的项目留下空 Canvas 或 Markdown。
    const [projectBody, stageBody] = await this.renderTemplateBodies([
      { kind: "project", values: { title: normalizedTitle, project: normalizedTitle } },
      { kind: "stage", values: {
        title: normalizedStageTitle,
        project: normalizedTitle,
        stage: normalizedStageTitle,
      } },
    ]);
    const before = await this.ensureCanvas();
    if (
      normalizedDidaProjectId &&
      before.projects.some((project) => project.didaProjectId === normalizedDidaProjectId)
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
          didaProjectId: normalizedDidaProjectId,
          color: normalizedColor,
        }, projectBody),
        () => this.assertActive(generation),
      ));
      createdRevisions.push(await this.repository.create(
        cyclePath,
        cycleTemplate({
          id: cycleId,
          projectId,
          projectLink: "[[Project]]",
          sequence: 1,
          stageCode: "1",
          startedAt: now,
          status: "idea",
          stageTitle: normalizedStageTitle,
        }, stageBody),
        () => this.assertActive(generation),
      ));
      const plannedProject: ProjectWorkspaceProject = {
        id: projectId,
        title: normalizedTitle,
        status: "planned",
        notePath: projectPath,
        didaProjectId: normalizedDidaProjectId,
        color: normalizedColor,
        cycles: [{
          id: cycleId,
          title: normalizedStageTitle,
          notePath: cyclePath,
          sequence: 1,
          stageCode: "1",
          status: "idea",
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
      canvas.document.helixStageCodes = replaceProjectStageCodes(
        canvas.document,
        projectId,
        ["1"],
      );
      this.assertActive(generation);
      await this.writeCanvas(canvas, generation, {
        label: "创建项目",
        markdownTransitions: createdRevisions.map((revision, index) => ({
          path: revision.path,
          kind: index === 0 ? "project" as const : "stage" as const,
          entityId: index === 0 ? projectId : cycleId,
          projectId,
          fromContent: null,
          toContent: revision.content,
        })),
      });
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
    const predecessorCycles = predecessors.map((id) => {
      const cycle = allCycles.find((candidate) => candidate.id === id);
      if (!cycle) throw new Error("找不到前置阶段");
      return cycle;
    });
    // 展示编号只由当前图谱占用情况决定。物理文件序号仍使用高水位单调递增，
    // 但已删除阶段不得永久占住用户可见的继承／分支／合并编号。
    const codeCandidates = project.cycles.map((cycle) => ({
      code: cycle.stageCode,
      sequence: cycle.sequence,
    }));
    let stageCodes: string[];
    const stageCodeConversions: Array<{ cycle: ProjectWorkspaceCycle; stageCode: string }> = [];
    if (relationKind === "branch") {
      const source = predecessorCycles[0]!;
      if (convertedInheritances.length > 0) {
        const existingTarget = allCycles.find((cycle) =>
          cycle.id === convertedInheritances[0]!.toCycleId);
        if (!existingTarget) throw new Error("找不到需要转换为分支的既有阶段");
        if (parseStageCode(existingTarget.stageCode)?.branch !== undefined) {
          stageCodes = nextBranchStageCodes(
            { code: source.stageCode, sequence: source.sequence },
            [...codeCandidates, { code: existingTarget.stageCode, sequence: existingTarget.sequence }],
            1,
            1,
          );
        } else {
          const pair = nextBranchStageCodes(
            { code: source.stageCode, sequence: source.sequence }, codeCandidates, 2);
          stageCodeConversions.push({ cycle: existingTarget, stageCode: pair[0]! });
          stageCodes = [pair[1]!];
        }
      } else {
      const siblings = snapshot.relations
        .filter((relation) => relation.fromCycleIds.includes(source.id))
        .map((relation) => allCycles.find((cycle) => cycle.id === relation.toCycleId))
        .filter((cycle): cycle is ProjectWorkspaceCycle => Boolean(cycle));
      const sourceMajor = parseStageCode(source.stageCode)?.major ?? source.sequence;
      const branchBase = sourceMajor + 1;
      stageCodes = nextBranchStageCodes(
        { ...source, code: String(branchBase - 1) },
        [...siblings.map((cycle) => ({ code: cycle.stageCode, sequence: cycle.sequence })), ...codeCandidates],
        createCount,
        1,
      );
      }
    } else {
      if (relationKind === "merge") {
        const minimumMajor = Math.max(...predecessorCycles.map((cycle) =>
          parseStageCode(cycle.stageCode)?.major ?? cycle.sequence)) + 1;
        stageCodes = [nextUnusedMajorStageCode(codeCandidates, minimumMajor)];
      } else {
        stageCodes = Array.from({ length: createCount }, () => nextMajorStageCode(codeCandidates));
      }
    }
    const specs = Array.from({ length: createCount }, (_, index) => {
      const sequence = firstSequence + index;
      const name = `Stage-${String(sequence).padStart(2, "0")}`;
      return {
        id: crypto.randomUUID(),
        sequence,
        stageCode: stageCodes[index]!,
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
    const bodies = await this.renderTemplateBodies(specs.map((spec) => ({
      kind: "stage" as const,
      values: {
        title: spec.stageTitle,
        project: project.title,
        stage: spec.stageTitle,
      },
    })));
    const plannedCreations: ProjectWorkspaceMarkdownCreation[] = [];
    for (const [index, spec] of specs.entries()) {
      plannedCreations.push({
        path: spec.path,
        kind: "stage",
        entityId: spec.id,
        projectId,
        content: await this.focusNewStageMarkdown(
          cycleTemplate({
            id: spec.id,
            projectId,
            projectLink: "[[Project]]",
            sequence: spec.sequence,
            stageCode: spec.stageCode,
            startedAt: new Date().toISOString(),
            status: "idea",
            stageTitle: spec.stageTitle,
          }, bodies[index]),
          predecessors,
          snapshot,
        ),
      });
    }
    const convertedCodeRevisions: Array<{ before: VaultRevision; afterContent: string }> = [];
    try {
      for (const conversion of stageCodeConversions) {
        const before = await this.repository.read(conversion.cycle.notePath);
        if (!before) throw new Error("既有分支阶段 Markdown 已不存在");
        const frontmatter = frontmatterFromContent(before.content);
        const currentCode = managedFrontmatterString(before.content, "helix-stage-code");
        if (
          frontmatter?.["helix-id"] !== conversion.cycle.id ||
          stageStatusFromFrontmatter(frontmatter["helix-status"]) !== conversion.cycle.status ||
          (currentCode.present
            ? currentCode.value !== conversion.cycle.stageCode
            : conversion.cycle.stageCode !== String(conversion.cycle.sequence))
        ) {
          throw new Error("既有继承阶段在分支确认期间已经变化，请重新操作");
        }
        const nextContent = rewriteManagedStageHeading(
          patchManagedFrontmatter(before.content, { "helix-stage-code": conversion.stageCode }),
          conversion.cycle.stageCode,
          conversion.stageCode,
        );
        convertedCodeRevisions.push({ before, afterContent: nextContent });
      }
      const plannedCycles = specs.map((spec) => ({
      id: spec.id,
      title: spec.stageTitle,
      notePath: spec.path,
      sequence: spec.sequence,
      stageCode: spec.stageCode,
      status: "idea" as const,
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
      const convertedCodes = new Map(stageCodeConversions.map((conversion) =>
        [conversion.cycle.id, conversion.stageCode] as const));
      canvas.document.helixStageCodes = replaceProjectStageCodes(
        canvas.document,
        projectId,
        [
          ...project.cycles.map((cycle) => convertedCodes.get(cycle.id) ?? cycle.stageCode),
          ...specs.map((spec) => spec.stageCode),
        ],
      );
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
                  stageCode: spec.stageCode,
                  status: "idea" as const,
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
      await this.applyAtomicWorkspaceChange({
        label: specs.length > 1 ? `创建 ${specs.length} 个阶段` : "创建阶段",
        canvasBeforeHash: canvas.revision.hash,
        canvasAfterContent: JSON.stringify(canvas.document, null, 2),
        markdownCreations: plannedCreations,
        markdownUpdates: convertedCodeRevisions.map((revision) => ({
          path: revision.before.path,
          kind: "stage" as const,
          entityId: stageCodeConversions.find((conversion) =>
            conversion.cycle.notePath === revision.before.path)!.cycle.id,
          projectId,
          beforeHash: revision.before.hash,
          afterContent: revision.afterContent,
        })),
      });
    } catch (error) {
      throw error;
    }
    const created = (await this.snapshot()).projects
      .find((candidate) => candidate.id === projectId)
      ?.cycles.find((cycle) => cycle.id === specs[0]!.id);
    if (!created) throw new Error("阶段已写入，但重新扫描未找到");
    return created;
  }

  private async renderTemplateBodies(
    requests: readonly HelixTemplateRenderRequest[],
  ): Promise<Array<string | undefined>> {
    if (!this.templateBodies) return requests.map(() => undefined);
    const bodies = await this.templateBodies(requests);
    if (bodies.length !== requests.length) {
      throw new Error("模板渲染结果数量不一致，已取消创建以避免混用模板目录");
    }
    return bodies;
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
      const failure =
        `阶段操作失败且回滚遇到竞争，已停止后续写入：${message}；${rollbackErrors.join("；")}`;
      this.freezePendingStageDeletion(failure);
      throw new Error(failure);
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
  }, generation?: number, history?: {
    label: string;
    markdownTransitions: ProjectWorkspaceHistoryFileTransition[];
  }): Promise<VaultRevision> {
    const content = JSON.stringify(canvas.document, null, 2);
    const fence = generation === undefined
      ? undefined
      : () => this.assertActive(generation);
    let written: VaultRevision;
    if (canvas.revision) {
      written = await this.repository.compareAndWrite(canvas.revision, content, fence);
    } else {
      written = await this.repository.create(
        normalizePath(this.canvasPath()),
        content,
        fence,
      );
    }
    if (history && canvas.revision) {
      this.recordHistoryEntry({
        id: crypto.randomUUID(),
        label: history.label,
        canvasPath: written.path,
        canvasBeforeContent: canvas.revision.content,
        canvasAfterContent: written.content,
        markdownTransitions: history.markdownTransitions,
      });
    } else if (!history && !this.applyingHistory) {
      this.invalidateHistory();
    }
    return written;
  }
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isProjectWorkspaceFocusState(value: unknown): value is ProjectWorkspaceFocusState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ProjectWorkspaceFocusState>;
  if (state.version !== 1 || !state.checkpoints || typeof state.checkpoints !== "object" ||
    !Array.isArray(state.conflicts)) return false;
  const text = (candidate: unknown): candidate is string => typeof candidate === "string";
  for (const [key, checkpoint] of Object.entries(state.checkpoints)) {
    if (!checkpoint || typeof checkpoint !== "object") return false;
    const item = checkpoint as Partial<ProjectWorkspaceFocusCheckpoint>;
    if (item.key !== key || !text(item.sourceId) || !text(item.targetId) ||
      !text(item.sourcePath) || !text(item.targetPath) || !text(item.baseContent) ||
      !text(item.baseHash) || focusContentHash(item.baseContent) !== item.baseHash) return false;
  }
  const validConflict = (candidate: unknown): candidate is ProjectWorkspaceFocusConflict => {
    if (!candidate || typeof candidate !== "object") return false;
    const item = candidate as Partial<ProjectWorkspaceFocusConflict>;
    return text(item.id) && text(item.key) && text(item.sourceId) && text(item.targetId) &&
      text(item.sourcePath) && text(item.targetPath) && text(item.createdAt) &&
      ["simultaneous-edit", "derived-structure-changed", "checkpoint-missing"].includes(String(item.reason)) &&
      (item.baseContent === null || text(item.baseContent)) && text(item.sourceContent) &&
      text(item.derivedContent) && text(item.sourceRevisionHash) && text(item.targetRevisionHash);
  };
  if (!state.conflicts.every(validConflict)) return false;
  if (state.pendingResolution === undefined) return true;
  const pending = state.pendingResolution as Partial<ProjectWorkspacePendingFocusResolution>;
  if (!pending || typeof pending !== "object" || !text(pending.id) ||
    !text(pending.conflictId) || !text(pending.createdAt) ||
    !Array.isArray(pending.transitions) || !pending.transitions.every((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const transition = candidate as { path?: unknown; beforeHash?: unknown; afterHash?: unknown };
      return text(transition.path) && text(transition.beforeHash) && text(transition.afterHash);
    }) || !pending.finalCheckpoints || typeof pending.finalCheckpoints !== "object" ||
    !Array.isArray(pending.finalConflicts) || !pending.finalConflicts.every(validConflict)) return false;
  for (const [key, checkpoint] of Object.entries(pending.finalCheckpoints)) {
    if (!checkpoint || typeof checkpoint !== "object") return false;
    const item = checkpoint as Partial<ProjectWorkspaceFocusCheckpoint>;
    if (item.key !== key || !text(item.sourceId) || !text(item.targetId) ||
      !text(item.sourcePath) || !text(item.targetPath) || !text(item.baseContent) ||
      !text(item.baseHash) || focusContentHash(item.baseContent) !== item.baseHash) return false;
  }
  return true;
}

function relationSourceSignature(
  relations: readonly CycleRelation[],
  targetId: string,
): string {
  return [...new Set(relations
    .filter((relation) => relation.toCycleId === targetId)
    .flatMap((relation) => relation.fromCycleIds))]
    .sort()
    .join("\u0000");
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
    left.relabeledEdgeCount === right.relabeledEdgeCount &&
    left.targetInboundCount === right.targetInboundCount &&
    left.resultKind === right.resultKind;
}

function sameNativeRelationCandidate(
  left: ProjectWorkspaceNativeRelationCandidate,
  right: ProjectWorkspaceNativeRelationCandidate,
): boolean {
  return left.edgeId === right.edgeId &&
    left.canvasRevisionHash === right.canvasRevisionHash &&
    left.fromCycleId === right.fromCycleId &&
    left.toCycleId === right.toCycleId &&
    left.fromTitle === right.fromTitle &&
    left.toTitle === right.toTitle &&
    left.crossProject === right.crossProject;
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

function workspaceStabilitySignature(
  snapshot: ProjectWorkspaceSnapshot,
): string {
  return stableHash({
    canvasRevisionHash: snapshot.canvasRevisionHash,
    managedMarkdownRevisionHashes: Object.entries(snapshot.managedMarkdownRevisionHashes)
      .sort(([left], [right]) => left.localeCompare(right)),
    migrationRequired: snapshot.migrationRequired,
    migrationItems: snapshot.migrationItems.map((item) => ({
      id: item.id,
      sourcePath: item.sourcePath,
      action: item.action,
    })),
    migrationWarnings: [...snapshot.migrationWarnings].sort(),
    projects: snapshot.projects.map((project) => ({
      id: project.id,
      title: project.title,
      status: project.status,
      notePath: project.notePath,
      didaProjectId: project.didaProjectId,
      color: project.color,
      cycles: project.cycles.map((cycle) => ({
        id: cycle.id,
        title: cycle.title,
        notePath: cycle.notePath,
        sequence: cycle.sequence,
        status: cycle.status,
      })),
    })),
  });
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
    terminated: "已终止",
  }[status];
}

function stageStatusText(status: ProjectWorkspaceCycle["status"]): string {
  return {
    idea: "想法",
    active: "进行中",
    completed: "已完成",
    paused: "已暂停",
    terminated: "已终止",
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
        stageStatusText(cycle.status),
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

function validatedStageCodeLedger(document: CanvasDocument): Record<string, string[]> {
  const raw = document.helixStageCodes;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Canvas 阶段展示编号账本无效");
  }
  const ledger: Record<string, string[]> = {};
  for (const [projectId, codes] of Object.entries(raw)) {
    if (!projectId.trim() || !Array.isArray(codes) || codes.some((code) =>
      typeof code !== "string" || !parseStageCode(code))) {
      throw new Error(`Canvas 阶段展示编号账本无效：${projectId}`);
    }
    if (new Set(codes).size !== codes.length) {
      throw new Error(`Canvas 阶段展示编号账本存在重复：${projectId}`);
    }
    ledger[projectId] = [...codes];
  }
  return ledger;
}

function replaceProjectStageCodes(
  document: CanvasDocument,
  projectId: string,
  current: readonly string[],
): Record<string, string[]> {
  const ledger = validatedStageCodeLedger(document);
  if (current.some((code) => !parseStageCode(code)) || new Set(current).size !== current.length) {
    throw new Error("当前阶段展示编号无效或重复");
  }
  return {
    ...ledger,
    [projectId]: [...current],
  };
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

function assertManagedIdentity(
  content: string,
  kind: "helix-project",
  entityId: string,
): void {
  const frontmatter = frontmatterFromContent(content);
  if (frontmatter?.["helix-kind"] !== kind || frontmatter["helix-id"] !== entityId) {
    throw new Error("项目 Markdown 身份已变化，请重新操作");
  }
}

function assertManagedStageIdentity(
  content: string,
  entityId: string,
  projectId: string,
): void {
  const frontmatter = frontmatterFromContent(content);
  if (
    (
      frontmatter?.["helix-kind"] !== "helix-stage" &&
      frontmatter?.["helix-kind"] !== "helix-cycle"
    ) ||
    frontmatter["helix-id"] !== entityId ||
    frontmatter["helix-project-id"] !== projectId
  ) {
    throw new Error("阶段 Markdown 身份或所属项目已变化，请重新操作");
  }
}

function rewriteFirstHeading(
  content: string,
  title: string,
  entityLabel: "项目" | "阶段",
): string {
  if (!/^#\s+.+?\s*$/m.test(content)) {
    throw new Error(`${entityLabel} Markdown 缺少一级标题，未执行重命名`);
  }
  return content.replace(/^#\s+.+?\s*$/m, `# ${title}`);
}

function updateManagedNodeSummary(
  document: CanvasDocument,
  identity: { kind: "project" | "cycle"; entityId: string },
  path: string,
  title: string,
  status: string,
): void {
  const node = document.nodes.find((candidate) =>
    candidate.helixManaged === true && (
      identity.kind === "project"
        ? candidate.helixNodeKind === "project" &&
          candidate.helixProjectId === identity.entityId
        : managedStageId(candidate) === identity.entityId
    ));
  if (!node) throw new Error("Canvas 中缺少对应的 Helix 管理节点");
  node.type = "text";
  node.helixFilePath = normalizePath(path);
  node.text = canvasCardText(path, title, status);
  delete node.file;
}

function stageTitleFromHeading(
  heading: string | undefined,
  stageCode: string,
): string {
  if (!heading || /^Cycle\s+\d+$/i.test(heading)) return `阶段 ${stageCode}`;
  const modern = /^阶段\s+\d+(?:\.\d+)?\s*[·:：-]\s*(.+)$/.exec(heading);
  return modern?.[1]?.trim() || heading;
}

/** 只改 Helix 创建的一级阶段标题编号，不触碰标题文字或后续正文。 */
function rewriteManagedStageHeading(
  content: string,
  oldCode: string,
  nextCode: string,
): string {
  const escaped = oldCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(#\\s+阶段\\s+)${escaped}(\\s*[·:：-]\\s*.+)$`, "m");
  if (!pattern.test(content)) {
    throw new Error("既有阶段标题在分支确认期间已经变化，请重新操作");
  }
  return content.replace(pattern, `$1${nextCode}$2`);
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
  const frontmatter = match[1] ?? "";
  // Vault 扫描会经过所有 Markdown。先用 Helix 的顶层身份键筛选候选，避免把
  // 以水平线开头、稍后又含水平线的普通正文或受管块整体交给 YAML 解析器。
  // 一旦出现身份键，仍解析并严格校验完整 frontmatter，绝不吞掉 Helix 结构错误。
  if (!/^(?:helix-kind|"helix-kind"|'helix-kind')[ \t]*:/m.test(frontmatter)) {
    return undefined;
  }
  const parsed = parseYaml(frontmatter);
  return parsed && typeof parsed === "object"
    ? parsed as Record<string, unknown>
    : undefined;
}

/** 只接受显式引用的字符串，避免 YAML 将展示编号折叠为数值。 */
function managedFrontmatterString(
  content: string,
  key: string,
): { present: boolean; value?: string } {
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)?.[1];
  if (frontmatter === undefined) return { present: false };
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...frontmatter.matchAll(new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, "gm"))];
  if (matches.length > 1) throw new Error(`重复的 Helix 管理属性：${key}`);
  if (matches.length === 0) return { present: false };
  const raw = matches[0]![1]!.trim();
  const quoted = /^(?:"([\s\S]*)"|'([\s\S]*)')$/.exec(raw);
  return { present: true, value: quoted?.[1] ?? quoted?.[2] };
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
