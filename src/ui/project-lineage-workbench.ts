import { setIcon } from "obsidian";
import {
  CYCLE_RELATION_LABELS,
  type CycleRelation,
} from "../domain/cycle-graph";
import {
  collapsedClosedComponents,
  planProjectGraphLayout,
  projectedGraphIsAcyclic,
  type ProjectGraphEdge,
} from "../domain/project-graph";
import {
  STAGE_BOARD_COLUMNS,
  STAGE_STATUS_PRESENTATION,
  stageBoardCycleIds,
  stageBoardMoveDecision,
  stageBoardPointerDecision,
  StageBoardMoveRegistry,
} from "../domain/stage-board";
import { PROJECT_STATUS_LABELS } from "../domain/project-status";
import type {
  ProjectWorkspaceCanvasNode,
  ProjectWorkspaceNodeMove,
  ProjectWorkspaceCycle,
  ProjectWorkspaceProject,
  ProjectWorkspaceSnapshot,
} from "../services/project-workspace";

export type ProjectLineageViewMode = "graph" | "cards" | "kanban";

export interface LineagePoint {
  x: number;
  y: number;
}

interface LineageGraphBox extends LineagePoint {
  width: number;
  height: number;
  right: number;
  bottom: number;
  centerY: number;
}

export interface LineageAlignmentGuide {
  axis: "x" | "y";
  start: LineagePoint;
  end: LineagePoint;
}

export interface LineageAlignmentBox extends LineagePoint {
  id: string;
  width: number;
  height: number;
}

export interface LineageProjectContainerBox extends LineagePoint {
  width: number;
  height: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

export interface LineageCamera {
  zoom: number;
  rawCenterX: number;
  rawCenterY: number;
}

export interface LineageLayoutSnapshot {
  [entityId: string]: LineagePoint;
}

export interface LineageAlignmentTarget extends LineagePoint {
  id: string;
}

export interface LineageShiftAlignment {
  point: LineagePoint;
  xTarget?: LineageAlignmentTarget;
  yTarget?: LineageAlignmentTarget;
}

export function lineageShiftAlignment(
  moving: LineagePoint,
  fixed: readonly LineageAlignmentTarget[],
  threshold = 10,
): LineageShiftAlignment {
  const nearest = (axis: "x" | "y"): LineageAlignmentTarget | undefined => {
    const candidate = fixed.reduce<{ target: LineageAlignmentTarget; distance: number } | null>(
      (best, target) => {
        const distance = Math.abs(target[axis] - moving[axis]);
        return !best || distance < best.distance ? { target, distance } : best;
      },
      null,
    );
    return candidate && candidate.distance <= threshold ? candidate.target : undefined;
  };
  const xTarget = nearest("x");
  const yTarget = nearest("y");
  return {
    point: {
      x: xTarget?.x ?? moving.x,
      y: yTarget?.y ?? moving.y,
    },
    ...(xTarget ? { xTarget } : {}),
    ...(yTarget ? { yTarget } : {}),
  };
}

export function lineageShiftAlignedPoint(
  moving: LineagePoint,
  fixed: readonly LineagePoint[],
  threshold = 10,
): LineagePoint {
  return lineageShiftAlignment(
    moving,
    fixed.map((point, index) => ({ ...point, id: String(index) })),
    threshold,
  ).point;
}

export function lineageShiftBoxAlignment(
  moving: LineageAlignmentBox,
  fixed: readonly LineageAlignmentBox[],
  threshold = 10,
): LineageShiftAlignment & { guides: LineageAlignmentGuide[] } {
  type Candidate = {
    value: number;
    distance: number;
    guides: LineageAlignmentGuide[];
  };
  const axisCandidate = (axis: "x" | "y"): Candidate | undefined => {
    const size = axis === "x" ? "width" : "height";
    const cross = axis === "x" ? "y" : "x";
    const crossSize = axis === "x" ? "height" : "width";
    const point = (primary: number, secondary: number): LineagePoint =>
      axis === "x" ? { x: primary, y: secondary } : { x: secondary, y: primary };
    const candidates: Candidate[] = [];
    for (const target of fixed) {
      const value = target[axis];
      candidates.push({
        value,
        distance: Math.abs(value - moving[axis]),
        guides: [{
          axis,
          start: point(value, moving[cross] + moving[crossSize] / 2),
          end: point(value, target[cross] + target[crossSize] / 2),
        }],
      });
    }
    const ordered = [...fixed].sort((left, right) => left[axis] - right[axis]);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const first = ordered[index]!;
      const second = ordered[index + 1]!;
      const firstEnd = first[axis] + first[size];
      const gap = second[axis] - firstEnd;
      if (gap < 0) continue;
      const between = firstEnd + (gap - moving[size]) / 2;
      if (between >= firstEnd && between + moving[size] <= second[axis]) {
        const crossValue = moving[cross] + moving[crossSize] / 2;
        candidates.push({
          value: between,
          distance: Math.abs(between - moving[axis]),
          guides: [
            {
              axis,
              start: point(firstEnd, crossValue),
              end: point(between, crossValue),
            },
            {
              axis,
              start: point(between + moving[size], crossValue),
              end: point(second[axis], crossValue),
            },
          ],
        });
      }
      const after = second[axis] + second[size] + gap;
      const afterCross = moving[cross] + moving[crossSize] / 2;
      candidates.push({
        value: after,
        distance: Math.abs(after - moving[axis]),
        guides: [
          {
            axis,
            start: point(firstEnd, afterCross),
            end: point(second[axis], afterCross),
          },
          {
            axis,
            start: point(second[axis] + second[size], afterCross),
            end: point(after, afterCross),
          },
        ],
      });
      const before = first[axis] - gap - moving[size];
      const beforeCross = moving[cross] + moving[crossSize] / 2;
      candidates.push({
        value: before,
        distance: Math.abs(before - moving[axis]),
        guides: [
          {
            axis,
            start: point(before + moving[size], beforeCross),
            end: point(first[axis], beforeCross),
          },
          {
            axis,
            start: point(firstEnd, beforeCross),
            end: point(second[axis], beforeCross),
          },
        ],
      });
    }
    const best = candidates.reduce<Candidate | undefined>((current, candidate) =>
      !current || candidate.distance < current.distance ? candidate : current, undefined);
    return best && best.distance <= threshold ? best : undefined;
  };
  const x = axisCandidate("x");
  const y = axisCandidate("y");
  return {
    point: { x: x?.value ?? moving.x, y: y?.value ?? moving.y },
    guides: [...(x?.guides ?? []), ...(y?.guides ?? [])],
  };
}

export interface LineageLayoutDraft {
  canvasRevisionHash: string;
  /** 生成草稿时读取到的 Canvas 坐标，用于区分新增节点和外部布局竞争。 */
  basePositions: LineageLayoutSnapshot;
  positions: LineageLayoutSnapshot;
  undo: LineageLayoutSnapshot[];
  redo: LineageLayoutSnapshot[];
  dirty: boolean;
}

export interface ReconciledLineageLayoutDraft {
  positions: LineageLayoutSnapshot;
  undo: LineageLayoutSnapshot[];
  redo: LineageLayoutSnapshot[];
  dirty: boolean;
}

/**
 * 结构写入新增节点后保留尚未保存的会话布局。只有 Canvas 中仍与旧 Base
 * 一致的既有节点才继承草稿；发生外部移动的节点始终采用新的权威坐标。
 */
export function reconcileLineageLayoutDraft(
  draft: LineageLayoutDraft,
  currentPositions: LineageLayoutSnapshot,
  currentCanvasRevisionHash: string | null,
  relations: readonly CycleRelation[],
): ReconciledLineageLayoutDraft | undefined {
  if (!currentCanvasRevisionHash) return undefined;
  const currentIds = Object.keys(currentPositions);
  const sameEntities = currentIds.length === Object.keys(draft.positions).length &&
    currentIds.every((id) => draft.positions[id] !== undefined);
  if (draft.canvasRevisionHash === currentCanvasRevisionHash && sameEntities) {
    return {
      positions: cloneLayoutSnapshot(draft.positions),
      undo: draft.undo
        .filter((item) => currentIds.every((id) => item[id] !== undefined))
        .map((item) => cloneLayoutSnapshot(item)),
      redo: draft.redo
        .filter((item) => currentIds.every((id) => item[id] !== undefined))
        .map((item) => cloneLayoutSnapshot(item)),
      dirty: draft.dirty,
    };
  }

  const base = draft.basePositions;
  if (!base) return undefined;
  const safeExistingIds = new Set(currentIds.filter((id) =>
    draft.positions[id] !== undefined &&
    base[id] !== undefined &&
    sameLineagePoint(currentPositions[id]!, base[id]!)));
  if (safeExistingIds.size === 0) return undefined;
  const addedIds = new Set(currentIds.filter((id) => base[id] === undefined));
  const merge = (source: LineageLayoutSnapshot): LineageLayoutSnapshot => {
    const next = cloneLayoutSnapshot(currentPositions);
    for (const id of safeExistingIds) {
      const point = source[id];
      if (point) next[id] = { ...point };
    }
    rebaseAddedLineageTargets(next, currentPositions, addedIds, relations);
    return next;
  };
  const positions = merge(draft.positions);
  return {
    positions,
    undo: draft.undo.map(merge),
    redo: draft.redo.map(merge),
    dirty: !sameLineageLayout(positions, currentPositions),
  };
}

interface WorkbenchOptions {
  snapshot: ProjectWorkspaceSnapshot;
  selectedProjectId: string | null;
  focusEntityId?: string;
  initialCamera?: LineageCamera;
  initialLayoutDraft?: LineageLayoutDraft;
  onFocusApplied?: (entityId: string) => void;
  mode: ProjectLineageViewMode;
  arrivalCycleId?: string;
  onModeChange: (mode: ProjectLineageViewMode) => void;
  onSelectProject: (projectId: string | null) => void;
  onCreateProject: () => void;
  onCreateCycle: (projectId: string, sourceCycleIds: string[]) => void;
  onDeleteCycle: (cycleId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onRenameProject: (projectId: string, currentTitle: string, currentColor: string) => void;
  onRenameCycle: (cycleId: string, currentTitle: string) => void;
  onOpenNote: (path: string) => void;
  onSaveLayout: (moves: ProjectWorkspaceNodeMove[]) => Promise<void>;
  onReorderProjects: (projectIds: string[]) => Promise<void>;
  onManageRelation: (relationId: string) => void;
  onInsertCycle: (
    relationId: string,
    sourceCycleId: string,
    targetCycleId: string,
    projectId: string,
  ) => void;
  onConnectCycles: (sourceCycleId: string, targetCycleId: string) => void;
  onChooseConnectionTarget: (
    sourceCycleId: string,
    allowedTargetIds: string[],
  ) => void;
  onEditProjectColor: (projectId: string, color: string) => void;
  onEditProjectStatus: (
    projectId: string,
    status: ProjectWorkspaceProject["status"],
  ) => void;
  onEditCycleStatus: (
    cycleId: string,
    status: ProjectWorkspaceCycle["status"],
  ) => void;
  requestCycleStatusChange: (
    cycleId: string,
    expectedStatus: ProjectWorkspaceCycle["status"],
    status: ProjectWorkspaceCycle["status"],
  ) => Promise<void>;
  onToggleCompletedCollapse: (projectId: string, collapsed: boolean) => void;
  onExpandCompletedProjects: (projectIds: string[]) => void;
  onStatusPopoverChange?: (open: boolean) => void;
  onError: (error: unknown) => void;
}

const PADDING = 64;
const GRID_SIZE = 28;
const MAX_ZOOM = 1.2;
const MIN_FIT_ZOOM = 0.0001;
const GRAPH_CARD_WIDTH = 292;
const GRAPH_CARD_HEIGHT = 144;
const GRAPH_COLUMN_GAP = 116;
const GRAPH_ROW_GAP = 56;
const PROJECT_CONTAINER_SIDE_PADDING = 28;
const PROJECT_CONTAINER_TOP_PADDING = 58;
const PROJECT_CONTAINER_BOTTOM_PADDING = 28;
const VIRTUAL_MARGIN = 2400;
const VIRTUAL_EXPAND = 1800;
const VIEWPORT_SAFE_MARGIN = 400;
const PROJECT_STATUS_ORDER: ReadonlyArray<ProjectWorkspaceProject["status"]> = [
  "planned",
  "active",
  "completed",
  "paused",
  "terminated",
];
const PROJECT_STATUS_ICONS: Record<ProjectWorkspaceProject["status"], string> = {
  planned: "circle-dashed",
  active: "play-circle",
  completed: "circle-check",
  paused: "circle-pause",
  terminated: "circle-x",
};

interface LineageStatusOption<T extends string> {
  value: T;
  label: string;
  icon: string;
}
export const LINEAGE_ALL_PROJECTS_FOCUS_ID = "helix:all-projects";

export type LineageArrangeScope =
  | { kind: "disabled"; reason: "empty" | "cross-project" }
  | { kind: "project"; projectId: string; entityIds: string[] }
  | { kind: "selection"; projectId: string; entityIds: string[] };

export function lineageArrangeScope(
  selectedEntityIds: readonly string[],
  selectedProjectId: string | null,
  nodes: readonly ProjectWorkspaceCanvasNode[],
): LineageArrangeScope {
  const stages = nodes.filter((node) => node.kind === "cycle");
  if (selectedEntityIds.length > 0) {
    const selected = selectedEntityIds.flatMap((id) => {
      const node = stages.find((candidate) => candidate.entityId === id);
      return node ? [node] : [];
    });
    const projects = new Set(selected.map((node) => node.projectId));
    if (projects.size !== 1 || selected.length === 0) {
      return { kind: "disabled", reason: "cross-project" };
    }
    return {
      kind: "selection",
      projectId: selected[0]!.projectId,
      entityIds: selected.map((node) => node.entityId),
    };
  }
  if (!selectedProjectId) return { kind: "disabled", reason: "empty" };
  return {
    kind: "project",
    projectId: selectedProjectId,
    entityIds: stages
      .filter((node) => node.projectId === selectedProjectId)
      .map((node) => node.entityId),
  };
}

export function lineageGraphBox(
  _node: Pick<ProjectWorkspaceCanvasNode, "width" | "height">,
  point: LineagePoint,
): LineageGraphBox {
  return {
    x: point.x,
    y: point.y,
    width: GRAPH_CARD_WIDTH,
    height: GRAPH_CARD_HEIGHT,
    right: point.x + GRAPH_CARD_WIDTH,
    bottom: point.y + GRAPH_CARD_HEIGHT,
    centerY: point.y + GRAPH_CARD_HEIGHT / 2,
  };
}

export function lineageGraphEdgeAnchors(
  sourceNode: Pick<ProjectWorkspaceCanvasNode, "width" | "height">,
  sourcePoint: LineagePoint,
  targetNode: Pick<ProjectWorkspaceCanvasNode, "width" | "height">,
  targetPoint: LineagePoint,
): { start: LineagePoint; end: LineagePoint } {
  const source = lineageGraphBox(sourceNode, sourcePoint);
  const target = lineageGraphBox(targetNode, targetPoint);
  return {
    start: { x: source.right, y: source.centerY },
    end: { x: target.x, y: target.centerY },
  };
}

export function lineageMovePayload(
  node: Pick<ProjectWorkspaceCanvasNode, "nodeId">,
  point: LineagePoint,
  canvasOffset: LineagePoint,
): ProjectWorkspaceNodeMove {
  return {
    nodeId: node.nodeId,
    x: point.x - canvasOffset.x,
    y: point.y - canvasOffset.y,
  };
}

export function lineageProjectContainerBox(
  projectId: string,
  nodes: ProjectWorkspaceCanvasNode[],
  layout: ReadonlyMap<string, LineagePoint>,
): LineageProjectContainerBox | undefined {
  const boxes = nodes.flatMap((node) => {
    if (node.kind !== "cycle" || node.projectId !== projectId) return [];
    const point = layout.get(node.entityId);
    return point ? [lineageGraphBox(node, point)] : [];
  });
  if (boxes.length === 0) return undefined;
  const x = Math.min(...boxes.map((box) => box.x)) - PROJECT_CONTAINER_SIDE_PADDING;
  const y = Math.min(...boxes.map((box) => box.y)) - PROJECT_CONTAINER_TOP_PADDING;
  const right = Math.max(...boxes.map((box) => box.right)) +
    PROJECT_CONTAINER_SIDE_PADDING;
  const bottom = Math.max(...boxes.map((box) => box.bottom)) +
    PROJECT_CONTAINER_BOTTOM_PADDING;
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
    right,
    bottom,
    centerX: (x + right) / 2,
    centerY: (y + bottom) / 2,
  };
}

export interface LineageViewportPlan {
  shiftX: number;
  shiftY: number;
  growRightBy: number;
  growBottomBy: number;
  left: number;
  top: number;
}

export function lineageCenteredZoomPlan(
  viewport: {
    scrollLeft: number;
    scrollTop: number;
    clientWidth: number;
    clientHeight: number;
  },
  previousZoom: number,
  nextZoom: number,
  logicalWidth: number,
  logicalHeight: number,
): LineageViewportPlan {
  const safePrevious = Math.max(MIN_FIT_ZOOM, previousZoom);
  const safeNext = Math.max(MIN_FIT_ZOOM, nextZoom);
  const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / safePrevious;
  const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / safePrevious;
  const unshiftedLeft = centerX * safeNext - viewport.clientWidth / 2;
  const unshiftedTop = centerY * safeNext - viewport.clientHeight / 2;
  const shiftX = Math.max(0, (VIEWPORT_SAFE_MARGIN - unshiftedLeft) / safeNext);
  const shiftY = Math.max(0, (VIEWPORT_SAFE_MARGIN - unshiftedTop) / safeNext);
  const left = (centerX + shiftX) * safeNext - viewport.clientWidth / 2;
  const top = (centerY + shiftY) * safeNext - viewport.clientHeight / 2;
  const shiftedWidth = logicalWidth + shiftX;
  const shiftedHeight = logicalHeight + shiftY;
  return {
    shiftX,
    shiftY,
    growRightBy: Math.max(
      0,
      (left + viewport.clientWidth + VIEWPORT_SAFE_MARGIN) / safeNext -
        shiftedWidth,
    ),
    growBottomBy: Math.max(
      0,
      (top + viewport.clientHeight + VIEWPORT_SAFE_MARGIN) / safeNext -
        shiftedHeight,
    ),
    left,
    top,
  };
}

export function lineageCenteredPointPlan(
  point: LineagePoint,
  zoom: number,
  viewport: { clientWidth: number; clientHeight: number },
  logicalWidth: number,
  logicalHeight: number,
): LineageViewportPlan {
  const safeZoom = Math.max(MIN_FIT_ZOOM, zoom);
  const unshiftedLeft = point.x * safeZoom - viewport.clientWidth / 2;
  const unshiftedTop = point.y * safeZoom - viewport.clientHeight / 2;
  const shiftX = Math.max(0, (VIEWPORT_SAFE_MARGIN - unshiftedLeft) / safeZoom);
  const shiftY = Math.max(0, (VIEWPORT_SAFE_MARGIN - unshiftedTop) / safeZoom);
  const left = (point.x + shiftX) * safeZoom - viewport.clientWidth / 2;
  const top = (point.y + shiftY) * safeZoom - viewport.clientHeight / 2;
  return {
    shiftX,
    shiftY,
    growRightBy: Math.max(
      0,
      (left + viewport.clientWidth + VIEWPORT_SAFE_MARGIN) / safeZoom -
        (logicalWidth + shiftX),
    ),
    growBottomBy: Math.max(
      0,
      (top + viewport.clientHeight + VIEWPORT_SAFE_MARGIN) / safeZoom -
        (logicalHeight + shiftY),
    ),
    left,
    top,
  };
}

export function lineageVisibleStageIdsByProject(
  nodes: ProjectWorkspaceCanvasNode[],
  hiddenByCollapseHead: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.kind !== "cycle" || hiddenByCollapseHead.has(node.entityId)) continue;
    const group = result.get(node.projectId) ?? [];
    group.push(node.entityId);
    result.set(node.projectId, group);
  }
  return result;
}

export function lineageFitScale(
  viewportWidth: number,
  viewportHeight: number,
  contentWidth: number,
  contentHeight: number,
): number {
  return Math.max(
    MIN_FIT_ZOOM,
    Math.min(
      1,
      Math.max(1, viewportWidth - 48) / Math.max(1, contentWidth),
      Math.max(1, viewportHeight - 48) / Math.max(1, contentHeight),
    ),
  );
}

export function lineageFocusScale(
  viewportWidth: number,
  viewportHeight: number,
  contentWidth: number,
  contentHeight: number,
): number {
  return lineageClampedZoom(Math.min(
    Math.max(1, viewportWidth - 48) / Math.max(1, contentWidth),
    Math.max(1, viewportHeight - 48) / Math.max(1, contentHeight),
  ));
}

export function lineageCameraFrame(
  startCenter: LineagePoint,
  targetCenter: LineagePoint,
  startZoom: number,
  targetZoom: number,
  progress: number,
  viewport: { clientWidth: number; clientHeight: number },
): { zoom: number; left: number; top: number } {
  const normalized = Math.min(1, Math.max(0, progress));
  const eased = 1 - (1 - normalized) ** 3;
  const zoom = lineageClampedZoom(
    startZoom + (targetZoom - startZoom) * eased,
  );
  const centerX = startCenter.x + (targetCenter.x - startCenter.x) * eased;
  const centerY = startCenter.y + (targetCenter.y - startCenter.y) * eased;
  return {
    zoom,
    left: centerX * zoom - viewport.clientWidth / 2,
    top: centerY * zoom - viewport.clientHeight / 2,
  };
}

export function lineageFocusBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth";
}

export function lineageShouldFocusOnDoubleClick(target: EventTarget | null): boolean {
  const closest = (
    target as { closest?: (selector: string) => unknown } | null
  )?.closest;
  return typeof closest !== "function" || !closest.call(target, "button");
}

export interface LineageSelectionBox extends LineagePoint {
  right: number;
  bottom: number;
}

export interface LineageLassoSelectionState {
  entityIds: string[];
  relationId: string | null;
}

export type LineagePointerSurface =
  "blank" | "card" | "project-container" | "project-header" | "edge" | "button";

export function lineageViewportPointerIntent(
  button: number,
  spaceHeld: boolean,
  surface: LineagePointerSurface,
): "pan" | "lasso" | "defer" {
  const panRequested = button === 1 || (button === 0 && spaceHeld);
  if (panRequested) {
    return surface === "button" || surface === "edge" ? "defer" : "pan";
  }
  return button === 0 && surface === "blank" ? "lasso" : "defer";
}

export function lineageAnchoredSelectionLayout(
  selectedEntityIds: readonly string[],
  currentStages: ReadonlyArray<Pick<ProjectWorkspaceCanvasNode,
    "entityId" | "projectId" | "x" | "y">>,
  plannedStages: ReadonlyArray<{ id: string; x: number; y: number }>,
  edges: readonly ProjectGraphEdge[],
): LineageLayoutSnapshot {
  const selected = new Set(selectedEntityIds);
  const currentById = new Map(currentStages.map((stage) => [stage.entityId, stage]));
  const plannedById = new Map(plannedStages.map((stage) => [stage.id, stage]));
  const remaining = new Set(selectedEntityIds.filter((id) => currentById.has(id)));
  const components: string[][] = [];
  while (remaining.size > 0) {
    const start = remaining.values().next().value as string;
    const component: string[] = [];
    const queue = [start];
    remaining.delete(start);
    while (queue.length > 0) {
      const id = queue.shift()!;
      component.push(id);
      for (const edge of edges) {
        if (!selected.has(edge.fromCycleId) || !selected.has(edge.toCycleId)) continue;
        const other = edge.fromCycleId === id
          ? edge.toCycleId
          : edge.toCycleId === id
            ? edge.fromCycleId
            : null;
        if (other && remaining.delete(other)) queue.push(other);
      }
    }
    components.push(component);
  }
  const result: LineageLayoutSnapshot = {};
  const occupied = currentStages
    .filter((stage) => !selected.has(stage.entityId))
    .map((stage) => ({
      projectId: stage.projectId,
      x: stage.x,
      y: stage.y,
      right: stage.x + GRAPH_CARD_WIDTH,
      bottom: stage.y + GRAPH_CARD_HEIGHT,
    }));
  components.sort((left, right) => {
    const a = left.map((id) => currentById.get(id)!)
      .sort((first, second) => first.y - second.y || first.x - second.x ||
        first.entityId.localeCompare(second.entityId))[0]!;
    const b = right.map((id) => currentById.get(id)!)
      .sort((first, second) => first.y - second.y || first.x - second.x ||
        first.entityId.localeCompare(second.entityId))[0]!;
    return a.y - b.y || a.x - b.x || a.entityId.localeCompare(b.entityId);
  });
  for (const component of components) {
    const componentSet = new Set(component);
    const roots = component
      .filter((id) => !edges.some((edge) =>
        edge.toCycleId === id && componentSet.has(edge.fromCycleId)))
      .sort((left, right) => {
        const a = currentById.get(left)!;
        const b = currentById.get(right)!;
        return a.y - b.y || a.x - b.x || left.localeCompare(right);
      });
    const rootId = roots[0] ?? component[0]!;
    const root = currentById.get(rootId)!;
    const plannedRoot = plannedById.get(rootId) ?? { id: rootId, x: root.x, y: root.y };
    const parents = edges
      .filter((edge) => edge.toCycleId === rootId && !componentSet.has(edge.fromCycleId))
      .flatMap((edge) => {
        const parent = currentById.get(edge.fromCycleId);
        return parent ? [parent] : [];
      });
    const anchor = parents.length > 0
      ? {
          x: Math.max(...parents.map((parent) => parent.x)) +
            GRAPH_CARD_WIDTH + GRAPH_COLUMN_GAP,
          y: parents.reduce((sum, parent) => sum + parent.y, 0) / parents.length,
        }
      : { x: root.x, y: root.y };
    const dx = anchor.x - plannedRoot.x;
    const dy = anchor.y - plannedRoot.y;
    const translated = component.map((id) => {
      const current = currentById.get(id)!;
      const planned = plannedById.get(id) ?? { id, x: current.x, y: current.y };
      return {
        id,
        projectId: current.projectId,
        x: planned.x + dx,
        y: planned.y + dy,
      };
    });
    let shiftY = 0;
    for (;;) {
      const conflicts = translated.flatMap((stage) => {
        const box = {
          x: stage.x,
          y: stage.y + shiftY,
          right: stage.x + GRAPH_CARD_WIDTH,
          bottom: stage.y + shiftY + GRAPH_CARD_HEIGHT,
        };
        return occupied.filter((fixed) =>
          fixed.projectId === stage.projectId &&
          box.x < fixed.right && box.right > fixed.x &&
          box.y < fixed.bottom && box.bottom > fixed.y);
      });
      if (conflicts.length === 0) break;
      const componentTop = Math.min(...translated.map((stage) => stage.y));
      shiftY = Math.max(
        shiftY + GRAPH_CARD_HEIGHT + GRAPH_ROW_GAP,
        ...conflicts.map((fixed) => fixed.bottom + GRAPH_ROW_GAP - componentTop),
      );
    }
    for (const stage of translated) {
      const point = { x: stage.x, y: stage.y + shiftY };
      result[stage.id] = point;
      occupied.push({
        projectId: stage.projectId,
        x: point.x,
        y: point.y,
        right: point.x + GRAPH_CARD_WIDTH,
        bottom: point.y + GRAPH_CARD_HEIGHT,
      });
    }
  }
  return result;
}

export function lineageCardDragAllowed(
  button: number,
  spaceHeld: boolean,
  insideButton: boolean,
  collapseHead: boolean,
): boolean {
  return button === 0 && !spaceHeld && !insideButton && !collapseHead;
}

export function lineageLassoSelectionState(
  baseEntityIds: Iterable<string>,
  baseRelationId: string | null,
  hitEntityIds: Iterable<string>,
  mode: "replace" | "add" | "clear" | "cancel",
): LineageLassoSelectionState {
  if (mode === "cancel") {
    return {
      entityIds: [...new Set(baseEntityIds)],
      relationId: baseRelationId,
    };
  }
  if (mode === "clear") return { entityIds: [], relationId: null };
  const entityIds = mode === "add"
    ? new Set(baseEntityIds)
    : new Set<string>();
  for (const entityId of hitEntityIds) entityIds.add(entityId);
  return { entityIds: [...entityIds], relationId: null };
}

export function lineageSelectionBox(
  start: LineagePoint,
  end: LineagePoint,
): LineageSelectionBox {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

export function lineageEntitiesInSelection(
  nodes: ProjectWorkspaceCanvasNode[],
  layout: ReadonlyMap<string, LineagePoint>,
  selection: LineageSelectionBox,
): string[] {
  const selected: string[] = [];
  for (const node of nodes) {
    const point = layout.get(node.entityId);
    if (!point) continue;
    const box = lineageGraphBox(node, point);
    if (
      box.x <= selection.right &&
      box.right >= selection.x &&
      box.y <= selection.bottom &&
      box.bottom >= selection.y
    ) {
      selected.push(node.entityId);
    }
  }
  return selected;
}

export function lineageRequestedFocusBox<T>(
  requestedFocusId: string | undefined,
  focusedStageBox: T | undefined,
  focusedProjectBox: T | undefined,
  contentBounds: T,
): T | undefined {
  return requestedFocusId === LINEAGE_ALL_PROJECTS_FOCUS_ID
    ? contentBounds
    : focusedStageBox ?? focusedProjectBox;
}

export function lineageZoomLabel(zoom: number): string {
  const percent = Math.max(0, zoom) * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  if (percent < 1) return `${Number(percent.toFixed(2))}%`;
  if (percent < 10) return `${Number(percent.toFixed(1))}%`;
  return `${Math.round(percent)}%`;
}

export function lineageClampedZoom(value: number): number {
  return Math.max(MIN_FIT_ZOOM, Math.min(MAX_ZOOM, value));
}

export function lineageConnectionDropTarget(
  moved: boolean,
  canceled: boolean,
  targetId?: string,
): string | undefined {
  return moved && !canceled ? targetId : undefined;
}

export function lineageVirtualExpansionPlan(viewport: {
  scrollLeft: number;
  scrollTop: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}, zoom = 1): {
  shiftX: number;
  shiftY: number;
  growRightBy: number;
  growBottomBy: number;
} {
  const logicalExpansion = VIRTUAL_EXPAND / Math.max(MIN_FIT_ZOOM, zoom);
  return {
    shiftX: viewport.scrollLeft < 320 ? logicalExpansion : 0,
    shiftY: viewport.scrollTop < 320 ? logicalExpansion : 0,
    growRightBy: viewport.scrollLeft + viewport.clientWidth >
      viewport.scrollWidth - 320 ? logicalExpansion : 0,
    growBottomBy: viewport.scrollTop + viewport.clientHeight >
      viewport.scrollHeight - 320 ? logicalExpansion : 0,
  };
}

export function creationSourcesFromSelection(
  clickedCycleId: string,
  selectedEntityIds: Iterable<string>,
  nodes: ProjectWorkspaceCanvasNode[],
  currentLayout?: ReadonlyMap<string, { x: number; y: number }>,
): string[] {
  const selected = new Set(selectedEntityIds);
  const selectedCycles = nodes
    .filter((node) =>
      node.kind === "cycle" &&
      selected.has(node.entityId))
    .sort((left, right) => {
      const leftPoint = currentLayout?.get(left.entityId) ?? left;
      const rightPoint = currentLayout?.get(right.entityId) ?? right;
      return leftPoint.y - rightPoint.y || leftPoint.x - rightPoint.x;
    })
    .map((node) => node.entityId);
  return selectedCycles.length > 1 && selectedCycles.includes(clickedCycleId)
    ? selectedCycles
    : [clickedCycleId];
}

export interface LineageCompletedProjection {
  hiddenByCollapseHead: Map<string, string>;
  collapseHeadByMember: Map<string, string>;
  collapseCountByHead: Map<string, number>;
}

export interface LineageProjectedRelation {
  sourceId: string;
  targetId: string;
  relation: CycleRelation;
  count: number;
  aggregate: boolean;
  foldedProjectIds: string[];
}

export function completedLineageProjection(
  snapshot: ProjectWorkspaceSnapshot,
): LineageCompletedProjection {
  const hiddenByCollapseHead = new Map<string, string>();
  const collapseHeadByMember = new Map<string, string>();
  const collapseCountByHead = new Map<string, number>();
  const collapsed = new Set(snapshot.collapsedCompletedProjectIds);
  const physical = physicalEdgesFromSnapshot(snapshot);
  const cycleIds = snapshot.projects.flatMap((project) =>
    project.cycles.map((cycle) => cycle.id));
  for (const project of [...snapshot.projects].sort((left, right) =>
    left.id.localeCompare(right.id))) {
    if (!collapsed.has(project.id)) continue;
    const components = collapsedClosedComponents(
      project.cycles.map((cycle) => cycle.id),
      new Set(project.cycles
        .filter((cycle) => cycle.status === "completed")
        .map((cycle) => cycle.id)),
      physical,
    );
    for (const component of components.sort((left, right) =>
      left.headId.localeCompare(right.headId))) {
      const tentative = new Map(collapseHeadByMember);
      for (const id of component.memberIds) tentative.set(id, component.headId);
      if (!projectedGraphIsAcyclic(cycleIds, physical, tentative)) continue;
      collapseCountByHead.set(component.headId, component.memberIds.length);
      for (const id of component.memberIds) {
        collapseHeadByMember.set(id, component.headId);
        if (id !== component.headId) hiddenByCollapseHead.set(id, component.headId);
      }
    }
  }
  return {
    hiddenByCollapseHead,
    collapseHeadByMember,
    collapseCountByHead,
  };
}

export function projectedLineageRelations(
  snapshot: ProjectWorkspaceSnapshot,
  projection: LineageCompletedProjection,
): LineageProjectedRelation[] {
  const nodeByEntity = new Map(snapshot.canvasNodes.map((node) => [node.entityId, node]));
  const projected = new Map<string, LineageProjectedRelation & {
    foldedProjectSet: Set<string>;
  }>();
  for (const relation of snapshot.relations) {
    for (const physicalSourceId of relation.fromCycleIds) {
      const sourceId = projection.collapseHeadByMember.get(physicalSourceId) ??
        physicalSourceId;
      const targetId = projection.collapseHeadByMember.get(relation.toCycleId) ??
        relation.toCycleId;
      if (sourceId === targetId) continue;
      const foldedProjectSet = new Set<string>();
      if (projection.collapseHeadByMember.has(physicalSourceId)) {
        const projectId = nodeByEntity.get(physicalSourceId)?.projectId;
        if (projectId) foldedProjectSet.add(projectId);
      }
      if (projection.collapseHeadByMember.has(relation.toCycleId)) {
        const projectId = nodeByEntity.get(relation.toCycleId)?.projectId;
        if (projectId) foldedProjectSet.add(projectId);
      }
      const key = `${sourceId}\u0000${targetId}\u0000${relation.kind}`;
      const current = projected.get(key);
      if (current) {
        current.count += 1;
        for (const projectId of foldedProjectSet) current.foldedProjectSet.add(projectId);
      } else {
        projected.set(key, {
          sourceId,
          targetId,
          relation,
          count: 1,
          aggregate: foldedProjectSet.size > 0,
          foldedProjectIds: [],
          foldedProjectSet,
        });
      }
    }
  }
  return [...projected.values()].map((item) => ({
    sourceId: item.sourceId,
    targetId: item.targetId,
    relation: item.relation,
    count: item.count,
    aggregate: item.aggregate,
    foldedProjectIds: [...item.foldedProjectSet].sort(),
  }));
}

export function lineageProjectedEdgeKey(sourceId: string, targetId: string): string {
  return `${sourceId}\u0000${targetId}`;
}

export function lineageAncestorHighlight(
  hoveredStageId: string,
  relations: ReadonlyArray<Pick<LineageProjectedRelation, "sourceId" | "targetId">>,
): { entityIds: Set<string>; edgeKeys: Set<string> } {
  const entityIds = new Set([hoveredStageId]);
  const edgeKeys = new Set<string>();
  const incoming = new Map<string, Array<{ sourceId: string; targetId: string }>>();
  for (const relation of relations) {
    const group = incoming.get(relation.targetId) ?? [];
    group.push(relation);
    incoming.set(relation.targetId, group);
  }
  const queue = [hoveredStageId];
  while (queue.length > 0) {
    const targetId = queue.shift()!;
    for (const relation of incoming.get(targetId) ?? []) {
      edgeKeys.add(lineageProjectedEdgeKey(relation.sourceId, relation.targetId));
      if (entityIds.has(relation.sourceId)) continue;
      entityIds.add(relation.sourceId);
      queue.push(relation.sourceId);
    }
  }
  return { entityIds, edgeKeys };
}

export function lineageConnectionTargetIds(
  snapshot: ProjectWorkspaceSnapshot,
  sourceCycleId: string,
  projection: LineageCompletedProjection,
): string[] {
  return snapshot.canvasNodes
    .filter((node) =>
      node.kind === "cycle" &&
      node.entityId !== sourceCycleId &&
      !projection.hiddenByCollapseHead.has(node.entityId) &&
      !projection.collapseCountByHead.has(node.entityId))
    .map((node) => node.entityId);
}

export function lineageStructuralEntityIds(
  snapshot: ProjectWorkspaceSnapshot,
  projection: LineageCompletedProjection,
): string[] {
  return snapshot.canvasNodes
    .filter((node) =>
      node.kind === "cycle" &&
      !projection.hiddenByCollapseHead.has(node.entityId) &&
      !projection.collapseCountByHead.has(node.entityId))
    .map((node) => node.entityId);
}

export class ProjectLineageWorkbench {
  private root: HTMLElement | null = null;
  private readonly layout = new Map<string, LineagePoint>();
  private readonly nodeByEntity = new Map<string, ProjectWorkspaceCanvasNode>();
  private readonly selected = new Set<string>();
  private canvasOffset: LineagePoint;
  private readonly hiddenByCollapseHead = new Map<string, string>();
  private readonly collapseHeadByMember = new Map<string, string>();
  private readonly collapseCountByHead = new Map<string, number>();
  private readonly visibleStageIdsByProject = new Map<string, string[]>();
  private readonly markerId = `helix-lineage-arrow-${crypto.randomUUID()}`;
  private alignmentGuides: LineageAlignmentGuide[] = [];
  private zoom = 1;
  private viewport: HTMLElement | null = null;
  private plane: HTMLElement | null = null;
  private surface: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private projectLayer: HTMLElement | null = null;
  private projectHeaderLayer: HTMLElement | null = null;
  private nodeLayer: HTMLElement | null = null;
  private relationPanel: HTMLElement | null = null;
  private selectedRelationId: string | null = null;
  private hoveredStageId: string | null = null;
  private width = 960;
  private height = 640;
  private pan:
    | { pointerId: number; x: number; y: number; left: number; top: number }
    | null = null;
  private lasso:
    | {
        pointerId: number;
        start: LineagePoint;
        baseSelection: Set<string>;
        baseRelationId: string | null;
        additive: boolean;
        moved: boolean;
        overlay: HTMLElement;
      }
    | null = null;
  private spaceHeld = false;
  private destroyed = false;
  private movePending = false;
  private moveVersion = 0;
  private connectionDrag:
    | { pointerId: number; sourceId: string; moved: boolean; startX: number; startY: number }
    | null = null;
  private suppressConnectorClick = false;
  private connectionPreview: { sourceId: string; point: LineagePoint } | null = null;
  private suppressVirtualExpansion = false;
  private programmaticScrollTimer: number | null = null;
  private programmaticScrollFrame: number | null = null;
  private pendingCamera: LineageCamera | null = null;
  private readonly boardMoves = new StageBoardMoveRegistry();
  private boardDrag: {
    card: HTMLElement;
    cycleId: string;
    pointerId: number;
    sourceStatus: ProjectWorkspaceCycle["status"];
  } | null = null;
  private boardEscapeListener: ((event: KeyboardEvent) => void) | null = null;
  private statusPopover: HTMLElement | null = null;
  private statusPopoverAnchor: HTMLButtonElement | null = null;
  private statusPopoverAbort: AbortController | null = null;
  private statusPopoverListenerTimer: number | null = null;
  private projectOrderPopover: HTMLElement | null = null;
  private projectOrderPopoverAbort: AbortController | null = null;
  private readonly persistedLayout: LineageLayoutSnapshot;
  private layoutUndo: LineageLayoutSnapshot[] = [];
  private layoutRedo: LineageLayoutSnapshot[] = [];
  private layoutDirty = false;
  private undoButton: HTMLButtonElement | null = null;
  private redoButton: HTMLButtonElement | null = null;
  private arrangeButton: HTMLButtonElement | null = null;
  private restoreLayoutButton: HTMLButtonElement | null = null;
  private saveLayoutButton: HTMLButtonElement | null = null;
  private layoutSavePending = false;

  constructor(private readonly options: WorkbenchOptions) {
    const minimumX = Math.min(0, ...options.snapshot.canvasNodes.map((node) => node.x));
    const minimumY = Math.min(0, ...options.snapshot.canvasNodes.map((node) => node.y));
    this.canvasOffset = {
      x: VIRTUAL_MARGIN - minimumX,
      y: VIRTUAL_MARGIN - minimumY,
    };
    for (const node of options.snapshot.canvasNodes) {
      this.nodeByEntity.set(node.entityId, node);
      this.layout.set(node.entityId, {
        x: node.x + this.canvasOffset.x,
        y: node.y + this.canvasOffset.y,
      });
    }
    this.persistedLayout = this.captureRawLayout();
    const draft = options.initialLayoutDraft;
    const reconciledDraft = draft
      ? reconcileLineageLayoutDraft(
          draft,
          this.persistedLayout,
          options.snapshot.canvasRevisionHash,
          options.snapshot.relations,
        )
      : undefined;
    if (reconciledDraft) {
      this.applyRawLayout(reconciledDraft.positions);
      this.layoutUndo = reconciledDraft.undo;
      this.layoutRedo = reconciledDraft.redo;
      this.layoutDirty = reconciledDraft.dirty;
    }
    this.prepareCompletedProjection();
    for (const [projectId, entityIds] of lineageVisibleStageIdsByProject(
      options.snapshot.canvasNodes,
      this.hiddenByCollapseHead,
    )) {
      this.visibleStageIdsByProject.set(projectId, entityIds);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.closeStatusPopover();
    this.closeProjectOrderPopover();
    this.boardDrag = null;
    this.clearBoardEscapeListener();
    this.moveVersion += 1;
    this.selected.clear();
    this.root = null;
    this.lasso?.overlay.remove();
    this.lasso = null;
    if (this.programmaticScrollTimer !== null) {
      window.clearTimeout(this.programmaticScrollTimer);
      this.programmaticScrollTimer = null;
    }
    if (this.programmaticScrollFrame !== null) {
      window.cancelAnimationFrame(this.programmaticScrollFrame);
      this.programmaticScrollFrame = null;
    }
  }

  hasOpenStatusPopover(): boolean {
    return this.statusPopover !== null;
  }

  camera(): LineageCamera | undefined {
    if (this.pendingCamera) return { ...this.pendingCamera };
    if (!this.viewport) return this.options.initialCamera
      ? { ...this.options.initialCamera }
      : undefined;
    return {
      zoom: this.zoom,
      rawCenterX: (
        this.viewport.scrollLeft + this.viewport.clientWidth / 2
      ) / Math.max(MIN_FIT_ZOOM, this.zoom) - this.canvasOffset.x,
      rawCenterY: (
        this.viewport.scrollTop + this.viewport.clientHeight / 2
      ) / Math.max(MIN_FIT_ZOOM, this.zoom) - this.canvasOffset.y,
    };
  }

  layoutDraft(): LineageLayoutDraft | undefined {
    if (!this.options.snapshot.canvasRevisionHash ||
      (!this.layoutDirty && this.layoutUndo.length === 0 && this.layoutRedo.length === 0)) {
      return undefined;
    }
    return {
      canvasRevisionHash: this.options.snapshot.canvasRevisionHash,
      basePositions: cloneLayoutSnapshot(this.persistedLayout),
      positions: this.captureRawLayout(),
      undo: this.layoutUndo.map((item) => cloneLayoutSnapshot(item)),
      redo: this.layoutRedo.map((item) => cloneLayoutSnapshot(item)),
      dirty: this.layoutDirty,
    };
  }

  markLayoutSaved(): void {
    this.layoutDirty = false;
    this.layoutUndo = [];
    this.layoutRedo = [];
    this.updateLayoutControls();
  }

  selectProject(projectId: string | null): void {
    this.options.selectedProjectId = projectId;
    const root = this.root;
    if (!root) return;
    root.querySelectorAll<HTMLElement>(".helix-lineage-project-choice")
      .forEach((choice) => {
        const active = choice.dataset.projectId === (projectId ?? LINEAGE_ALL_PROJECTS_FOCUS_ID);
        choice.toggleClass("is-active", active);
        choice.querySelector("button")?.setAttribute("aria-pressed", String(active));
      });
    root.querySelectorAll<HTMLElement>("[data-project-id]")
      .forEach((element) => {
        if (element.hasClass("helix-lineage-project-choice")) return;
        const current = element.dataset.projectId === projectId;
        element.toggleClass("is-current-project", current);
        element.toggleClass("is-other-project", projectId !== null && !current);
      });
    root.querySelectorAll<HTMLElement>(".helix-lineage-card[data-entity-id]")
      .forEach((card) => {
        const node = this.nodeByEntity.get(card.dataset.entityId ?? "");
        const current = node?.projectId === projectId;
        card.toggleClass("is-current-project", current);
        card.toggleClass("is-other-project", projectId !== null && !current);
      });
    this.updateLayoutControls();
    this.focusEntity(projectId ?? LINEAGE_ALL_PROJECTS_FOCUS_ID);
  }

  focusEntity(entityId: string): boolean {
    if (this.options.mode !== "graph" || !this.viewport) return false;
    if (entityId === LINEAGE_ALL_PROJECTS_FOCUS_ID) {
      this.focusGraphBox(this.contentBounds());
      return true;
    }
    const resolvedId = this.hiddenByCollapseHead.get(entityId) ?? entityId;
    const node = this.nodeByEntity.get(resolvedId);
    if (node?.kind === "cycle") {
      this.focusGraphCard(node);
      return true;
    }
    const projectBox = this.projectContainerBox(resolvedId);
    if (!projectBox) return false;
    this.focusGraphBox(projectBox);
    return true;
  }

  render(parent: HTMLElement): void {
    this.closeStatusPopover();
    this.root = parent;
    parent.empty();
    parent.addClass("helix-lineage-shell");
    this.renderToolbar(parent);
    this.renderProjectStrip(parent);
    const body = parent.createDiv({ cls: "helix-lineage-body" });
    if (this.options.mode === "graph") this.renderGraph(body);
    else if (this.options.mode === "cards") this.renderCardGrid(body);
    else this.renderKanban(body);
  }

  private renderToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "helix-lineage-toolbar" });
    const title = toolbar.createDiv({ cls: "helix-lineage-toolbar-title" });
    title.createEl("h2", { text: "Project Lineage" });
    title.createSpan({
      text: `${this.options.snapshot.projects.length} 个项目 · ${
        this.options.snapshot.projects.reduce((sum, project) => sum + project.cycles.length, 0)
      } 个阶段`,
    });
    const switcher = toolbar.createDiv({
      cls: "helix-lineage-view-switcher",
      attr: { role: "tablist", "aria-label": "项目视图" },
    });
    for (const item of [
      { id: "graph" as const, label: "关系图", icon: "workflow" },
      { id: "cards" as const, label: "卡片", icon: "panels-top-left" },
      { id: "kanban" as const, label: "阶段看板", icon: "layout-dashboard" },
    ]) {
      const button = switcher.createEl("button", {
        cls: item.id === this.options.mode ? "is-active" : "",
        attr: { role: "tab", "aria-selected": String(item.id === this.options.mode) },
      });
      setIcon(button.createSpan(), item.icon);
      button.createSpan({ text: item.label });
      button.addEventListener("click", () => this.options.onModeChange(item.id));
    }
    const actions = toolbar.createDiv({ cls: "helix-lineage-toolbar-actions" });
    if (this.options.mode !== "graph") return;
    const undo = actions.createEl("button", {
      cls: "helix-secondary-button helix-lineage-history-button",
      text: "撤销",
      attr: { title: "撤销尚未保存的布局变化" },
    });
    undo.addEventListener("click", () => this.undoLayout());
    const redo = actions.createEl("button", {
      cls: "helix-secondary-button helix-lineage-history-button",
      text: "重做",
      attr: { title: "重做尚未保存的布局变化" },
    });
    redo.addEventListener("click", () => this.redoLayout());
    const arrange = actions.createEl("button", {
      cls: "helix-secondary-button",
      text: "整理",
    });
    arrange.addEventListener("click", () => this.arrangeCurrentScope());
    const restore = actions.createEl("button", {
      cls: "helix-secondary-button",
      text: "读取保存布局",
      attr: { title: "放弃尚未保存的视图变化，恢复 Canvas 中最后保存的位置" },
    });
    restore.addEventListener("click", () => this.restoreSavedLayout());
    const save = actions.createEl("button", {
      cls: "helix-secondary-button",
      text: "保存当前布局",
      attr: { title: "将当前卡片位置保存到 Canvas，并覆盖上一版布局" },
    });
    save.addEventListener("click", () => void this.saveCurrentLayout());
    const addProject = actions.createEl("button", {
      cls: "helix-secondary-button",
      text: "新建项目",
    });
    addProject.addEventListener("click", this.options.onCreateProject);
    const reorder = actions.createEl("button", {
      cls: "helix-secondary-button helix-lineage-project-order-button",
      text: "项目排序",
      attr: { "aria-label": "调整项目顺序", title: "拖动调整项目顺序" },
    });
    reorder.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openProjectOrderPopover(reorder);
    });
    this.undoButton = undo;
    this.redoButton = redo;
    this.arrangeButton = arrange;
    this.restoreLayoutButton = restore;
    this.saveLayoutButton = save;
    this.updateLayoutControls();
  }

  private openProjectOrderPopover(anchor: HTMLButtonElement): void {
    this.closeProjectOrderPopover();
    const popover = document.body.createDiv({
      cls: "helix-lineage-project-order-popover",
      attr: { role: "dialog", "aria-label": "项目排序" },
    });
    popover.createDiv({ cls: "helix-lineage-project-order-title", text: "拖动调整项目顺序" });
    const list = popover.createDiv({ cls: "helix-lineage-project-order-list" });
    let dragged: HTMLElement | null = null;
    let submitted = false;
    const initialOrder = this.options.snapshot.projects.map((project) => project.id);
    const submitOrder = (): void => {
      if (submitted) return;
      const projectIds = [...list.querySelectorAll<HTMLElement>("[data-project-id]")]
        .map((row) => row.dataset.projectId!)
        .filter(Boolean);
      if (projectIds.every((projectId, index) => projectId === initialOrder[index])) return;
      submitted = true;
      this.closeProjectOrderPopover();
      void this.options.onReorderProjects(projectIds).catch(this.options.onError);
    };
    for (const project of this.options.snapshot.projects) {
      const row = list.createDiv({
        cls: "helix-lineage-project-order-row",
        attr: { draggable: "true", "data-project-id": project.id },
      });
      row.style.setProperty("--helix-project-color", this.projectColor(project));
      const grip = row.createSpan({ cls: "helix-lineage-project-order-grip" });
      setIcon(grip, "grip-vertical");
      row.createSpan({ cls: "helix-lineage-project-order-swatch" });
      row.createSpan({ cls: "helix-lineage-project-order-name", text: project.title });
      row.addEventListener("dragstart", (event) => {
        dragged = row;
        row.addClass("is-dragging");
        event.dataTransfer?.setData("text/plain", project.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        row.removeClass("is-dragging");
        dragged = null;
        window.setTimeout(submitOrder, 0);
      });
      row.addEventListener("dragover", (event) => {
        if (!dragged || dragged === row) return;
        event.preventDefault();
        const before = event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
        list.insertBefore(dragged, before ? row : row.nextSibling);
      });
    }
    list.addEventListener("drop", (event) => {
      event.preventDefault();
      submitOrder();
    });
    const rect = anchor.getBoundingClientRect();
    popover.style.left = `${Math.max(12, Math.min(rect.right - 272, window.innerWidth - 284))}px`;
    popover.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - popover.offsetHeight - 12)}px`;
    this.projectOrderPopover = popover;
    const abort = new AbortController();
    this.projectOrderPopoverAbort = abort;
    window.setTimeout(() => {
      document.addEventListener("pointerdown", (event) => {
        if (!popover.contains(event.target as Node) && event.target !== anchor) {
          this.closeProjectOrderPopover();
        }
      }, { capture: true, signal: abort.signal });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") this.closeProjectOrderPopover();
      }, { signal: abort.signal });
    }, 0);
  }

  private closeProjectOrderPopover(): void {
    this.projectOrderPopoverAbort?.abort();
    this.projectOrderPopoverAbort = null;
    this.projectOrderPopover?.remove();
    this.projectOrderPopover = null;
  }

  private renderProjectStrip(parent: HTMLElement): void {
    const strip = parent.createDiv({ cls: "helix-lineage-project-strip" });
    const allChoice = strip.createDiv({
      cls: `helix-lineage-project-choice is-all${
        this.options.selectedProjectId === null ? " is-active" : ""
      }`,
      attr: { "data-project-id": LINEAGE_ALL_PROJECTS_FOCUS_ID },
    });
    const allSwatch = allChoice.createSpan({
      cls: "helix-lineage-project-all-swatch",
      attr: { "aria-hidden": "true" },
    });
    setIcon(allSwatch, "layers-3");
    const all = allChoice.createEl("button", {
      attr: {
        "aria-pressed": String(this.options.selectedProjectId === null),
        "aria-label": `全部项目，${this.options.snapshot.projects.length} 个项目`,
      },
    });
    all.createSpan({ cls: "helix-lineage-project-name", text: "全部项目" });
    all.createEl("small", {
      text: `${this.options.snapshot.projects.length} 个项目`,
    });
    all.addEventListener("click", () => this.options.onSelectProject(null));
    for (const project of this.options.snapshot.projects) {
      const item = strip.createDiv({
        cls: `helix-lineage-project-choice${
          project.id === this.options.selectedProjectId ? " is-active" : ""
        }`,
        attr: { "data-project-id": project.id },
      });
      item.style.setProperty("--helix-project-color", this.projectColor(project));
      const palette = item.createSpan({
        cls: "helix-lineage-project-palette",
        attr: { title: "设置项目颜色" },
      });
      setIcon(palette, "palette");
      const color = palette.createEl("input", {
        cls: "helix-lineage-project-color",
        type: "color",
        attr: {
          value: this.projectColor(project),
          "aria-label": `设置 ${project.title} 的颜色`,
          title: "设置项目颜色",
        },
      });
      color.value = this.projectColor(project);
      color.addEventListener("change", () =>
        this.options.onEditProjectColor(project.id, color.value));
      const button = item.createEl("button", {
        attr: {
          "aria-pressed": String(project.id === this.options.selectedProjectId),
          "aria-label": `${project.title}，${PROJECT_STATUS_LABELS[project.status]}，${
            project.cycles.filter((cycle) => cycle.status === "active").length
          } 个进行中阶段`,
        },
      });
      button.createSpan({ cls: "helix-lineage-project-name", text: project.title });
      const status = button.createEl("small", {
        cls: `helix-lineage-project-choice-status is-${project.status}`,
      });
      const statusIcon = status.createSpan({ cls: "helix-lineage-project-status-icon" });
      setIcon(statusIcon, PROJECT_STATUS_ICONS[project.status]);
      status.createSpan({ text: PROJECT_STATUS_LABELS[project.status] });
      status.createSpan({
        cls: "helix-lineage-project-choice-stage-count",
        text: `· ${project.cycles.filter((cycle) => cycle.status === "active").length} 个进行中阶段`,
      });
      button.addEventListener("click", () => this.options.onSelectProject(project.id));
    }
  }

  private renderGraph(parent: HTMLElement): void {
    const root = parent.createDiv({ cls: "helix-lineage-graph" });
    const viewport = root.createDiv({
      cls: "helix-lineage-viewport",
      attr: { tabindex: "0", "aria-label": "项目关系画布" },
    });
    const plane = viewport.createDiv({ cls: "helix-lineage-plane" });
    const surface = plane.createDiv({ cls: "helix-lineage-surface" });
    const bounds = this.measure();
    this.width = bounds.width;
    this.height = bounds.height;
    const projectLayer = surface.createDiv({ cls: "helix-lineage-project-layer" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("helix-lineage-edges");
    surface.appendChild(svg);
    const layer = surface.createDiv({ cls: "helix-lineage-node-layer" });
    const projectHeaderLayer = surface.createDiv({
      cls: "helix-lineage-project-header-layer",
    });
    this.viewport = viewport;
    this.plane = plane;
    this.surface = surface;
    this.svg = svg;
    this.projectLayer = projectLayer;
    this.projectHeaderLayer = projectHeaderLayer;
    this.nodeLayer = layer;
    this.applyScale();
    this.renderProjectContainers();
    this.renderEdges();
    for (const node of this.visibleStageNodes()) this.renderGraphCard(node);
    this.bindNavigation(viewport);
    this.renderZoomControls(root);
    this.relationPanel = root.createDiv({ cls: "helix-lineage-relation-panel" });
    this.updateRelationPanel();
    window.requestAnimationFrame(() => this.centerInitialContent());
  }

  private renderGraphCard(node: ProjectWorkspaceCanvasNode): void {
    if (!this.nodeLayer) return;
    const point = this.layout.get(node.entityId);
    if (!point) return;
    const card = this.nodeLayer.createDiv({
      cls: `helix-lineage-card is-graph is-${node.kind}${
        node.projectId === this.options.selectedProjectId ? " is-current-project" : ""
      }${this.options.selectedProjectId &&
        node.projectId !== this.options.selectedProjectId ? " is-other-project" : ""}${
        this.collapseCountByHead.has(node.entityId) ? " is-collapse-head" : ""
      }`,
      attr: {
        "data-entity-id": node.entityId,
        "aria-selected": "false",
        "aria-label": `${node.title}，双击聚焦`,
        title: `双击聚焦 ${node.title}`,
      },
    });
    card.style.setProperty("--helix-project-color", this.projectColor(
      this.projectFor(node.projectId),
    ));
    const box = lineageGraphBox(node, point);
    card.style.left = `${box.x}px`;
    card.style.top = `${box.y}px`;
    card.style.width = `${box.width}px`;
    card.style.height = `${box.height}px`;
    this.fillCard(card, node, true);
    if (node.kind === "cycle" && !this.collapseCountByHead.has(node.entityId)) {
      this.renderCycleActions(card, node);
    }
    card.addEventListener("pointerenter", () => {
      this.hoveredStageId = node.entityId;
      this.updateLineageHoverFocus();
    });
    card.addEventListener("pointerleave", () => {
      if (this.hoveredStageId !== node.entityId) return;
      this.hoveredStageId = null;
      this.updateLineageHoverFocus();
    });
    let drag:
      | {
          pointerId: number;
          clientX: number;
          clientY: number;
          starts: Array<{
            node: ProjectWorkspaceCanvasNode;
            el: HTMLElement;
            point: LineagePoint;
          }>;
          moved: boolean;
          beforeLayout: LineageLayoutSnapshot;
        }
      | null = null;
    card.addEventListener("pointerdown", (event) => {
      if (this.destroyed || this.movePending) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!lineageCardDragAllowed(
        event.button,
        this.spaceHeld,
        Boolean(target?.closest("button")),
        this.collapseCountByHead.has(node.entityId),
      )) return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey || event.shiftKey) {
        if (this.selected.has(node.entityId)) this.selected.delete(node.entityId);
        else this.selected.add(node.entityId);
      } else if (!this.selected.has(node.entityId)) {
        this.selected.clear();
        this.selected.add(node.entityId);
      }
      this.updateSelection();
      const structuralIds = new Set(this.structuralNodes().map((item) => item.entityId));
      const starts = [...this.selected].flatMap((entityId) => {
        if (!structuralIds.has(entityId)) return [];
        const selectedNode = this.nodeByEntity.get(entityId);
        const selectedPoint = this.layout.get(entityId);
        const selectedEl = this.nodeLayer?.querySelector<HTMLElement>(
          `.helix-lineage-card[data-entity-id="${CSS.escape(entityId)}"]`,
        );
        return selectedNode && selectedPoint && selectedEl
          ? [{ node: selectedNode, el: selectedEl, point: { ...selectedPoint } }]
          : [];
      });
      drag = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        starts,
        moved: false,
        beforeLayout: this.captureRawLayout(),
      };
      card.setPointerCapture(event.pointerId);
    });
    card.addEventListener("pointermove", (event) => {
      if (this.destroyed || !drag || drag.pointerId !== event.pointerId) return;
      const dx = (event.clientX - drag.clientX) / this.zoom;
      const dy = (event.clientY - drag.clientY) / this.zoom;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      let alignedDx = dx;
      let alignedDy = dy;
      if (event.shiftKey && drag.starts[0]) {
        const movingIds = new Set(drag.starts.map((item) => item.node.entityId));
        const fixed = this.structuralNodes()
          .filter((item) => !movingIds.has(item.entityId))
          .flatMap((item) => {
            const point = this.layout.get(item.entityId);
            return point ? [{
              id: item.entityId,
              ...point,
              width: GRAPH_CARD_WIDTH,
              height: GRAPH_CARD_HEIGHT,
            }] : [];
          });
        const alignment = lineageShiftBoxAlignment({
          id: drag.starts[0].node.entityId,
          x: drag.starts[0].point.x + dx,
          y: drag.starts[0].point.y + dy,
          width: GRAPH_CARD_WIDTH,
          height: GRAPH_CARD_HEIGHT,
        }, fixed, 12 / this.zoom);
        const candidate = alignment.point;
        alignedDx = candidate.x - drag.starts[0].point.x;
        alignedDy = candidate.y - drag.starts[0].point.y;
        card.toggleClass("is-shift-aligned", candidate.x !== drag.starts[0].point.x + dx ||
          candidate.y !== drag.starts[0].point.y + dy);
        this.alignmentGuides = alignment.guides;
      } else {
        card.removeClass("is-shift-aligned");
        this.alignmentGuides = [];
      }
      for (const item of drag.starts) {
        const next = {
          x: Math.max(16, item.point.x + alignedDx),
          y: Math.max(16, item.point.y + alignedDy),
        };
        this.layout.set(item.node.entityId, next);
        item.el.style.left = `${next.x}px`;
        item.el.style.top = `${next.y}px`;
        item.el.addClass("is-dragging");
        this.ensureBounds(next, item.node);
      }
      this.updateProjectContainerGeometry(
        new Set(drag.starts.map((item) => item.node.projectId)),
      );
      this.renderEdges();
    });
    const finish = (event: PointerEvent): void => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const completed = drag;
      drag = null;
      if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
      for (const item of completed.starts) item.el.removeClass("is-dragging");
      card.removeClass("is-shift-aligned");
      this.alignmentGuides = [];
      this.renderEdges();
      if (!completed.moved || this.destroyed || this.movePending) return;
      this.recordLayoutChange(completed.beforeLayout);
    };
    const cancelMove = (event: PointerEvent): void => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const canceled = drag;
      drag = null;
      if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
      for (const item of canceled.starts) {
        item.el.removeClass("is-dragging");
        this.layout.set(item.node.entityId, item.point);
        item.el.style.left = `${item.point.x}px`;
        item.el.style.top = `${item.point.y}px`;
      }
      card.removeClass("is-shift-aligned");
      this.alignmentGuides = [];
      this.updateProjectContainerGeometry(
        new Set(canceled.starts.map((item) => item.node.projectId)),
      );
      this.renderEdges();
    };
    card.addEventListener("pointerup", finish);
    card.addEventListener("pointercancel", cancelMove);
    card.addEventListener("lostpointercapture", cancelMove);
    card.addEventListener("dblclick", (event) => {
      if (!lineageShouldFocusOnDoubleClick(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      this.focusGraphCard(node);
    });
  }

  private renderProjectContainers(): void {
    if (!this.projectLayer || !this.projectHeaderLayer) return;
    this.projectLayer.empty();
    this.projectHeaderLayer.empty();
    for (const project of this.options.snapshot.projects) {
      const box = this.projectContainerBox(project.id);
      if (!box) continue;
      const collapsed = this.options.snapshot.collapsedCompletedProjectIds
        .includes(project.id);
      const container = this.projectLayer.createDiv({
        cls: `helix-lineage-project-container${
          project.id === this.options.selectedProjectId ? " is-current-project" : ""
        }${this.options.selectedProjectId &&
          project.id !== this.options.selectedProjectId ? " is-other-project" : ""}${
          collapsed ? " is-collapsed" : ""
        }`,
        attr: { "data-project-id": project.id },
      });
      container.style.setProperty("--helix-project-color", this.projectColor(project));
      this.applyProjectContainerBox(container, box);
      container.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.options.onSelectProject(project.id);
      });
      const header = this.projectHeaderLayer.createDiv({
        cls: `helix-lineage-project-container-header${
          project.id === this.options.selectedProjectId ? " is-current-project" : ""
        }${this.options.selectedProjectId &&
          project.id !== this.options.selectedProjectId ? " is-other-project" : ""}`,
        attr: { "data-project-id": project.id },
      });
      header.style.setProperty("--helix-project-color", this.projectColor(project));
      this.applyProjectHeaderBox(header, box);
      header.addEventListener("dblclick", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button")) return;
        event.preventDefault();
        event.stopPropagation();
        this.options.onSelectProject(project.id);
      });
      const open = header.createEl("button", {
        cls: "helix-lineage-project-container-title",
        attr: { "aria-label": `打开项目 ${project.title}` },
      });
      open.createSpan({ cls: "helix-lineage-project-container-swatch" });
      open.createSpan({ text: project.title });
      this.bindProjectTitleDrag(open, project);
      const rename = header.createEl("button", {
        cls: "helix-lineage-project-container-rename",
        attr: {
          "aria-label": `编辑项目 ${project.title}`,
          title: "编辑项目名称和颜色",
        },
      });
      setIcon(rename, "pencil");
      rename.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.options.onRenameProject(project.id, project.title, this.projectColor(project));
      });
      const status = header.createEl("button", {
        cls: `helix-lineage-project-container-status is-${project.status}`,
        attr: {
          "aria-label": `修改 ${project.title} 的项目状态，当前${
            PROJECT_STATUS_LABELS[project.status]
          }`,
          title: "修改项目状态",
        },
      });
      const statusIcon = status.createSpan({ cls: "helix-lineage-project-status-icon" });
      setIcon(statusIcon, PROJECT_STATUS_ICONS[project.status]);
      status.createSpan({ text: PROJECT_STATUS_LABELS[project.status] });
      status.addEventListener("pointerdown", (event) => event.stopPropagation());
      status.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openStatusPopover(
          status,
          PROJECT_STATUS_ORDER.map((value) => ({
            value,
            label: PROJECT_STATUS_LABELS[value],
            icon: PROJECT_STATUS_ICONS[value],
          })),
          project.status,
          (value) => this.options.onEditProjectStatus(project.id, value),
        );
      });
      header.createSpan({
        cls: "helix-lineage-project-container-count",
        text: `${project.cycles.length} 阶段`,
      });
      const completedCount = project.cycles.filter((cycle) => cycle.status === "completed").length;
      if (completedCount > 0) {
        header.createSpan({
          cls: "helix-lineage-project-container-completed",
          text: `${completedCount} 已完成`,
        });
      }
      if (collapsed || this.hasCollapsibleCompleted(project)) {
        const fold = header.createEl("button", {
          cls: "helix-lineage-project-container-fold",
          attr: {
            "aria-label": `${collapsed ? "展开" : "折叠"} ${project.title} 的已完成阶段`,
            title: collapsed ? "展开已完成阶段" : "折叠已完成阶段",
          },
        });
        setIcon(fold, collapsed ? "unfold-vertical" : "fold-vertical");
        fold.createSpan({ text: collapsed ? "展开已完成" : "折叠已完成" });
        fold.addEventListener("click", () =>
          this.options.onToggleCompletedCollapse(project.id, !collapsed));
      }
      const remove = header.createEl("button", {
        cls: "helix-lineage-project-container-delete",
        attr: {
          "aria-label": `删除项目 ${project.title}`,
          title: "删除项目",
        },
      });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.options.onDeleteProject(project.id);
      });
    }
  }

  private bindProjectTitleDrag(
    button: HTMLButtonElement,
    project: ProjectWorkspaceProject,
  ): void {
    let drag: {
      pointerId: number;
      x: number;
      y: number;
      moved: boolean;
      before: LineageLayoutSnapshot;
      starts: Array<{ entityId: string; point: LineagePoint }>;
      box: LineageProjectContainerBox;
    } | null = null;
    let suppressClick = false;
    button.title = "单击打开项目；按住拖动整个项目";
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || this.destroyed || this.movePending) return;
      const starts = this.options.snapshot.canvasNodes
        .filter((node) => node.kind === "cycle" && node.projectId === project.id)
        .flatMap((node) => {
          const point = this.layout.get(node.entityId);
          return point ? [{ entityId: node.entityId, point: { ...point } }] : [];
        });
      if (starts.length === 0) return;
      const box = this.projectContainerBox(project.id);
      if (!box) return;
      event.preventDefault();
      event.stopPropagation();
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        before: this.captureRawLayout(),
        starts,
        box,
      };
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = (event.clientX - drag.x) / this.zoom;
      const dy = (event.clientY - drag.y) / this.zoom;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      suppressClick = true;
      let alignedDx = dx;
      let alignedDy = dy;
      if (event.shiftKey) {
        const fixed = this.options.snapshot.projects
          .filter((candidate) => candidate.id !== project.id)
          .flatMap((candidate) => {
            const box = this.projectContainerBox(candidate.id);
            return box ? [{
              id: candidate.id,
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
            }] : [];
          });
        const alignment = lineageShiftBoxAlignment(
          {
            id: project.id,
            x: drag.box.x + dx,
            y: drag.box.y + dy,
            width: drag.box.width,
            height: drag.box.height,
          },
          fixed,
          12 / this.zoom,
        );
        alignedDx = alignment.point.x - drag.box.x;
        alignedDy = alignment.point.y - drag.box.y;
        this.alignmentGuides = alignment.guides;
      } else {
        this.alignmentGuides = [];
      }
      for (const start of drag.starts) {
        this.layout.set(start.entityId, {
          x: Math.max(16, start.point.x + alignedDx),
          y: Math.max(16, start.point.y + alignedDy),
        });
      }
      this.renderLayoutPositions();
      const aligned = this.alignmentGuides.length > 0;
      this.projectLayer?.querySelector<HTMLElement>(
        `.helix-lineage-project-container[data-project-id="${CSS.escape(project.id)}"]`,
      )?.toggleClass("is-shift-aligned", aligned);
      this.projectHeaderLayer?.querySelector<HTMLElement>(
        `.helix-lineage-project-container-header[data-project-id="${CSS.escape(project.id)}"]`,
      )?.toggleClass("is-shift-aligned", aligned);
    });
    const finish = (event: PointerEvent, canceled: boolean): void => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const completed = drag;
      drag = null;
      this.alignmentGuides = [];
      if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      if (canceled) {
        this.applyRawLayout(completed.before);
        this.renderLayoutPositions();
      } else if (completed.moved) {
        this.recordLayoutChange(completed.before);
      }
      this.projectLayer?.querySelector<HTMLElement>(
        `.helix-lineage-project-container[data-project-id="${CSS.escape(project.id)}"]`,
      )?.removeClass("is-shift-aligned");
      this.projectHeaderLayer?.querySelector<HTMLElement>(
        `.helix-lineage-project-container-header[data-project-id="${CSS.escape(project.id)}"]`,
      )?.removeClass("is-shift-aligned");
      this.renderEdges();
    };
    button.addEventListener("pointerup", (event) => finish(event, false));
    button.addEventListener("pointercancel", (event) => finish(event, true));
    button.addEventListener("lostpointercapture", (event) => finish(event, true));
    button.addEventListener("click", (event) => {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      this.options.onOpenNote(project.notePath);
    });
  }

  private updateProjectContainerGeometry(projectIds?: Iterable<string>): void {
    if (!this.projectLayer || !this.projectHeaderLayer) return;
    const requested = projectIds
      ? new Set(projectIds)
      : new Set(this.options.snapshot.projects.map((project) => project.id));
    for (const project of this.options.snapshot.projects) {
      if (!requested.has(project.id)) continue;
      const container = this.projectLayer.querySelector<HTMLElement>(
        `.helix-lineage-project-container[data-project-id="${CSS.escape(project.id)}"]`,
      );
      const header = this.projectHeaderLayer.querySelector<HTMLElement>(
        `.helix-lineage-project-container-header[data-project-id="${
          CSS.escape(project.id)
        }"]`,
      );
      const box = this.projectContainerBox(project.id);
      if (container && box) this.applyProjectContainerBox(container, box);
      if (header && box) this.applyProjectHeaderBox(header, box);
    }
  }

  private applyProjectContainerBox(
    container: HTMLElement,
    box: LineageProjectContainerBox,
  ): void {
    container.style.left = `${box.x}px`;
    container.style.top = `${box.y}px`;
    container.style.width = `${box.width}px`;
    container.style.height = `${box.height}px`;
  }

  private applyProjectHeaderBox(
    header: HTMLElement,
    box: LineageProjectContainerBox,
  ): void {
    header.style.left = `${box.x + 14}px`;
    header.style.top = `${box.y + 10}px`;
    header.style.maxWidth = `${Math.max(120, box.width - 28)}px`;
  }

  private fillCard(
    card: HTMLElement,
    node: ProjectWorkspaceCanvasNode,
    graph: boolean,
  ): void {
    const owner = this.projectFor(node.projectId);
    const top = card.createDiv({ cls: "helix-lineage-card-top" });
    top.createSpan({
      cls: "helix-lineage-card-kind",
      text: node.kind === "project" ? "PROJECT" : `阶段 ${
        owner.cycles.find((cycle) => cycle.id === node.entityId)?.stageCode ??
          owner.cycles.find((cycle) => cycle.id === node.entityId)?.sequence ?? ""
      }`,
    });
    let cycle: ProjectWorkspaceCycle | undefined;
    if (node.kind === "cycle") {
      cycle = owner.cycles.find((item) => item.id === node.entityId);
      if (cycle) {
        const presentation = STAGE_STATUS_PRESENTATION[cycle.status];
        const status = top.createEl("button", {
          cls: `helix-lineage-status-button is-${cycle.status}`,
          attr: {
            "aria-label": `修改 ${cycle.title} 的阶段状态，当前${presentation.label}`,
            title: "修改阶段状态",
          },
        });
        const statusIcon = status.createSpan({ cls: "helix-lineage-status-icon" });
        setIcon(statusIcon, presentation.icon);
        status.createSpan({ text: presentation.label });
        status.addEventListener("pointerdown", (event) => event.stopPropagation());
        status.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.openStatusPopover(
            status,
            STAGE_BOARD_COLUMNS.map((value) => ({
              value,
              label: STAGE_STATUS_PRESENTATION[value].label,
              icon: STAGE_STATUS_PRESENTATION[value].icon,
            })),
            cycle!.status,
            (value) => this.options.onEditCycleStatus(cycle!.id, value),
          );
        });
      }
    }
    const titleRow = card.createDiv({ cls: "helix-lineage-card-title-row" });
    const open = titleRow.createEl("button", {
      cls: "helix-lineage-card-title",
      text: node.title,
      attr: { "aria-label": `打开 ${node.title}` },
    });
    open.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.options.onOpenNote(node.notePath);
    });
    if (cycle) {
      const rename = titleRow.createEl("button", {
        cls: "helix-lineage-card-rename",
        attr: {
          "aria-label": `重命名阶段 ${cycle.title}`,
          title: "重命名阶段",
        },
      });
      setIcon(rename, "pencil");
      rename.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.options.onRenameCycle(cycle!.id, cycle!.title);
      });
    }
    const meta = card.createDiv({ cls: "helix-lineage-card-meta" });
    if (node.kind === "project") {
      const status = meta.createEl("button", {
        cls: `helix-lineage-status-button is-project is-${owner.status}`,
        attr: {
          "aria-label": `修改 ${owner.title} 的项目状态，当前${
            PROJECT_STATUS_LABELS[owner.status]
          }`,
          title: "修改项目状态",
        },
      });
      const statusIcon = status.createSpan({ cls: "helix-lineage-status-icon" });
      setIcon(statusIcon, PROJECT_STATUS_ICONS[owner.status]);
      status.createSpan({ text: PROJECT_STATUS_LABELS[owner.status] });
      status.addEventListener("pointerdown", (event) => event.stopPropagation());
      status.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openStatusPopover(
          status,
          PROJECT_STATUS_ORDER.map((value) => ({
            value,
            label: PROJECT_STATUS_LABELS[value],
            icon: PROJECT_STATUS_ICONS[value],
          })),
          owner.status,
          (value) => this.options.onEditProjectStatus(owner.id, value),
        );
      });
      meta.createSpan({ text: `${owner.cycles.length} 个阶段` });
    } else {
      meta.createSpan({ text: owner.title });
    }
    const relation = this.options.snapshot.relations.find(
      (item) => item.toCycleId === node.entityId,
    );
    const relationMeta = card.createDiv({ cls: "helix-lineage-card-relations" });
    if (relation) {
      relationMeta.createSpan({ text: CYCLE_RELATION_LABELS[relation.kind] });
      relationMeta.createSpan({ text: `入 ${relation.fromCycleIds.length}` });
    } else if (node.kind === "cycle") {
      relationMeta.createSpan({ text: "起始阶段" });
    }
    if (!graph) {
      const outgoing = this.options.snapshot.relations.filter((item) =>
        item.fromCycleIds.includes(node.entityId)).length;
      relationMeta.createSpan({ text: `出 ${outgoing}` });
    }
    const collapsedCount = this.collapseCountByHead.get(node.entityId);
    if (collapsedCount) {
      const fold = relationMeta.createEl("button", {
        cls: "helix-lineage-fold-summary",
        text: `已折叠 ${collapsedCount} 个完成阶段`,
        attr: { title: "展开这些完成阶段" },
      });
      fold.addEventListener("click", (event) => {
        event.stopPropagation();
        this.options.onToggleCompletedCollapse(node.projectId, false);
      });
    }
  }

  private openStatusPopover<T extends string>(
    anchor: HTMLButtonElement,
    options: ReadonlyArray<LineageStatusOption<T>>,
    current: T,
    onSelect: (value: T) => void,
  ): void {
    if (this.statusPopoverAnchor === anchor && this.statusPopover) return;
    this.closeStatusPopover();
    const ownerDocument = anchor.ownerDocument;
    const popover = ownerDocument.body.createDiv({
      cls: "helix-lineage-status-popover",
      attr: { role: "menu", "aria-label": "选择状态" },
    });
    this.statusPopover = popover;
    this.statusPopoverAnchor = anchor;
    this.options.onStatusPopoverChange?.(true);
    anchor.setAttribute("aria-expanded", "true");
    const abort = new AbortController();
    this.statusPopoverAbort = abort;
    const optionButtons: HTMLButtonElement[] = [];
    for (const option of options) {
      const button = popover.createEl("button", {
        cls: `helix-lineage-status-popover-option is-${option.value}${
          option.value === current ? " is-current" : ""
        }`,
        attr: {
          role: "menuitemradio",
          "aria-checked": String(option.value === current),
        },
      });
      const icon = button.createSpan({ cls: "helix-lineage-status-popover-icon" });
      setIcon(icon, option.icon);
      button.createSpan({ text: option.label });
      if (option.value === current) {
        const check = button.createSpan({ cls: "helix-lineage-status-popover-check" });
        setIcon(check, "check");
      }
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closeStatusPopover();
        if (option.value !== current) onSelect(option.value);
      });
      optionButtons.push(button);
    }
    popover.addEventListener("pointerdown", (event) => event.stopPropagation());
    popover.addEventListener("click", (event) => event.stopPropagation());
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = popover.getBoundingClientRect();
    const viewportWidth = ownerDocument.documentElement.clientWidth;
    const viewportHeight = ownerDocument.documentElement.clientHeight;
    const left = Math.min(
      Math.max(8, anchorRect.right - menuRect.width),
      viewportWidth - menuRect.width - 8,
    );
    const belowTop = anchorRect.bottom + 6;
    const top = belowTop + menuRect.height <= viewportHeight - 8
      ? belowTop
      : Math.max(8, anchorRect.top - menuRect.height - 6);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeStatusPopover(true);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const focused = optionButtons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? optionButtons.length - 1
          : event.key === "ArrowDown"
            ? (focused + 1 + optionButtons.length) % optionButtons.length
            : (focused - 1 + optionButtons.length) % optionButtons.length;
      optionButtons[next]?.focus();
    };
    ownerDocument.addEventListener("keydown", onKeyDown, { signal: abort.signal });
    this.statusPopoverListenerTimer = window.setTimeout(() => {
      this.statusPopoverListenerTimer = null;
      ownerDocument.addEventListener("pointerdown", (event) => {
        if (popover.contains(event.target as Node) || anchor.contains(event.target as Node)) return;
        this.closeStatusPopover();
      }, { capture: true, signal: abort.signal });
    }, 0);
    (optionButtons.find((button) => button.classList.contains("is-current")) ??
      optionButtons[0])?.focus({ preventScroll: true });
  }

  private closeStatusPopover(restoreFocus = false): void {
    const wasOpen = this.statusPopover !== null;
    if (this.statusPopoverListenerTimer !== null) {
      window.clearTimeout(this.statusPopoverListenerTimer);
      this.statusPopoverListenerTimer = null;
    }
    this.statusPopoverAbort?.abort();
    this.statusPopoverAbort = null;
    this.statusPopover?.remove();
    this.statusPopover = null;
    const anchor = this.statusPopoverAnchor;
    this.statusPopoverAnchor = null;
    anchor?.setAttribute("aria-expanded", "false");
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
    if (wasOpen) this.options.onStatusPopoverChange?.(false);
  }

  private renderCycleActions(
    card: HTMLElement,
    node: ProjectWorkspaceCanvasNode,
  ): void {
    const actions = card.createDiv({
      cls: "helix-lineage-card-actions",
      attr: { "aria-label": "阶段操作" },
    });
    const add = actions.createEl("button", {
      cls: "helix-lineage-add-child",
      attr: {
        "aria-label": `从 ${node.title} 添加子阶段`,
        title: "添加子阶段",
      },
    });
    setIcon(add, "plus");
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onCreateCycle(node.projectId, this.creationSources(node));
    });
    this.updateCreateActionLabel(card, node);
    add.createSpan({ text: "新增" });
    const connector = actions.createEl("button", {
      cls: "helix-lineage-connector",
      attr: {
        "aria-label": `从 ${node.title} 连接到已有阶段`,
        title: "拖到另一阶段建立连接；点击可选择目标",
      },
    });
    setIcon(connector, "git-branch");
    connector.createSpan({ text: "连接" });
    connector.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.suppressConnectorClick) return;
      this.options.onChooseConnectionTarget(
        node.entityId,
        lineageConnectionTargetIds(
          this.options.snapshot,
          node.entityId,
          {
            hiddenByCollapseHead: this.hiddenByCollapseHead,
            collapseHeadByMember: this.collapseHeadByMember,
            collapseCountByHead: this.collapseCountByHead,
          },
        ),
      );
    });
    connector.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.connectionDrag = {
        pointerId: event.pointerId,
        sourceId: node.entityId,
        moved: false,
        startX: event.clientX,
        startY: event.clientY,
      };
      connector.setPointerCapture(event.pointerId);
      card.addClass("is-connecting");
    });
    connector.addEventListener("pointermove", (event) => {
      const drag = this.connectionDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 5) {
        drag.moved = true;
      }
      this.updateConnectionTarget(event.clientX, event.clientY, drag.sourceId);
      const rect = this.surface?.getBoundingClientRect();
      if (rect) {
        this.connectionPreview = {
          sourceId: drag.sourceId,
          point: {
            x: (event.clientX - rect.left) / this.zoom,
            y: (event.clientY - rect.top) / this.zoom,
          },
        };
        this.renderEdges();
      }
    });
    const finishConnection = (event: PointerEvent): void => {
      const drag = this.connectionDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const target = this.connectionTargetAt(event.clientX, event.clientY, drag.sourceId);
      this.clearConnectionTarget();
      this.connectionPreview = null;
      this.renderEdges();
      this.connectionDrag = null;
      card.removeClass("is-connecting");
      if (connector.hasPointerCapture(event.pointerId)) {
        connector.releasePointerCapture(event.pointerId);
      }
      if (drag.moved) {
        this.suppressConnectorClick = true;
        window.setTimeout(() => {
          this.suppressConnectorClick = false;
        }, 0);
      }
      const targetId = lineageConnectionDropTarget(
        drag.moved,
        false,
        target?.entityId,
      );
      if (targetId) {
        event.preventDefault();
        event.stopPropagation();
        this.options.onConnectCycles(drag.sourceId, targetId);
      }
    };
    const cancelConnection = (event: PointerEvent): void => {
      const drag = this.connectionDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.clearConnectionTarget();
      this.connectionPreview = null;
      this.renderEdges();
      this.connectionDrag = null;
      card.removeClass("is-connecting");
      if (connector.hasPointerCapture(event.pointerId)) {
        connector.releasePointerCapture(event.pointerId);
      }
      this.suppressConnectorClick = true;
      window.setTimeout(() => {
        this.suppressConnectorClick = false;
      }, 0);
      event.preventDefault();
      event.stopPropagation();
    };
    connector.addEventListener("pointerup", finishConnection);
    connector.addEventListener("pointercancel", cancelConnection);
    connector.addEventListener("lostpointercapture", cancelConnection);
    const owner = this.projectFor(node.projectId);
    const fold = actions.createEl("button", {
      cls: "helix-lineage-fold-node",
      attr: {
        "aria-label": `折叠 ${owner.title} 的已完成阶段`,
        title: "折叠已完成阶段",
      },
    });
    setIcon(fold, "fold-vertical");
    fold.createSpan({ text: "折叠" });
    fold.disabled = !this.hasCollapsibleCompleted(owner);
    fold.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onToggleCompletedCollapse(owner.id, true);
    });
    const remove = actions.createEl("button", {
      cls: "helix-lineage-delete-node",
      attr: {
        "aria-label": `删除阶段 ${node.title}`,
        title: "删除阶段",
      },
    });
    setIcon(remove, "trash-2");
    remove.createSpan({ text: "删除" });
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onDeleteCycle(node.entityId);
    });
  }

  private creationSources(
    clicked: ProjectWorkspaceCanvasNode,
  ): string[] {
    return creationSourcesFromSelection(
      clicked.entityId,
      [...this.selected].filter((entityId) =>
        !this.hiddenByCollapseHead.has(entityId) &&
        !this.collapseCountByHead.has(entityId)),
      this.options.snapshot.canvasNodes,
      this.layout,
    );
  }

  private updateCreateActionLabel(
    card: HTMLElement,
    node: ProjectWorkspaceCanvasNode,
  ): void {
    const add = card.querySelector<HTMLElement>(".helix-lineage-add-child");
    if (!add) return;
    const sources = this.creationSources(node);
    const label = sources.length > 1
      ? `合并所选 ${sources.length} 个阶段`
      : `从 ${node.title} 添加子阶段`;
    add.setAttribute("aria-label", label);
    add.setAttribute("title", label);
  }

  private renderEdges(): void {
    if (!this.svg) return;
    this.svg.replaceChildren();
    this.svg.setAttribute("width", String(this.width));
    this.svg.setAttribute("height", String(this.height));
    this.svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    for (const kind of ["inherit", "branch", "merge"] as const) {
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
      marker.id = `${this.markerId}-${kind}`;
      marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "9");
      marker.setAttribute("refY", "5");
      marker.setAttribute("markerWidth", "7");
      marker.setAttribute("markerHeight", "7");
      marker.setAttribute("orient", "auto-start-reverse");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
      marker.appendChild(path);
      defs.appendChild(marker);
    }
    this.svg.appendChild(defs);
    const projection: LineageCompletedProjection = {
      hiddenByCollapseHead: this.hiddenByCollapseHead,
      collapseHeadByMember: this.collapseHeadByMember,
      collapseCountByHead: this.collapseCountByHead,
    };
    for (const item of projectedLineageRelations(this.options.snapshot, projection)) {
      const relation = item.relation;
      const target = this.layout.get(item.targetId);
      const targetNode = this.nodeByEntity.get(item.targetId);
      if (!target || !targetNode) continue;
      {
        const source = this.layout.get(item.sourceId);
        const sourceNode = this.nodeByEntity.get(item.sourceId);
        if (!source || !sourceNode) continue;
        const { start, end } = lineageGraphEdgeAnchors(
          sourceNode,
          source,
          targetNode,
          target,
        );
        const bend = Math.max(54, Math.abs(end.x - start.x) * 0.45);
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.classList.add(
          "helix-lineage-edge",
          `is-${relation.kind}`,
          ...(this.selectedRelationId === relation.id ? ["is-selected"] : []),
          ...(this.isProjectedEdgeOutsideSelection(item.sourceId, item.targetId)
            ? ["is-other-project"]
            : []),
        );
        path.setAttribute("data-relation-id", item.aggregate ? "" : relation.id);
        path.setAttribute("data-source-id", item.sourceId);
        path.setAttribute("data-target-id", item.targetId);
        path.setAttribute("role", "button");
        path.setAttribute("tabindex", "0");
        path.setAttribute(
          "aria-label",
          item.aggregate
            ? `展开后查看 ${item.count} 条聚合关系`
            : `管理${CYCLE_RELATION_LABELS[relation.kind]}关系`,
        );
        const pathData = `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${
          end.x - bend
        } ${end.y}, ${end.x} ${end.y}`;
        path.setAttribute("d", pathData);
        path.setAttribute("marker-end", `url(#${this.markerId}-${relation.kind})`);
        const selectEdge = (event: Event): void => {
          event.stopPropagation();
          if (item.aggregate) this.expandProjectedRelation(item.foldedProjectIds);
          else this.selectRelation(relation.id);
        };
        if (!item.aggregate) {
          const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
          hitPath.classList.add("helix-lineage-edge-hit");
          hitPath.setAttribute("d", pathData);
          hitPath.setAttribute("data-source-id", item.sourceId);
          hitPath.setAttribute("data-target-id", item.targetId);
          hitPath.addEventListener("click", selectEdge);
          this.svg.appendChild(hitPath);
        }
        path.addEventListener("click", selectEdge);
        path.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          if (item.aggregate) this.expandProjectedRelation(item.foldedProjectIds);
          else this.selectRelation(relation.id);
        });
        this.svg.appendChild(path);
        if (!item.aggregate) {
          const insert = document.createElementNS("http://www.w3.org/2000/svg", "g");
          insert.classList.add("helix-lineage-edge-insert");
          insert.setAttribute("role", "button");
          insert.setAttribute("tabindex", "0");
          insert.setAttribute("aria-label", "在这条关系中插入新阶段");
          insert.setAttribute("data-source-id", item.sourceId);
          insert.setAttribute("data-target-id", item.targetId);
          insert.setAttribute("transform", `translate(${(start.x + end.x) / 2} ${(start.y + end.y) / 2})`);
          const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          circle.setAttribute("r", "9");
          insert.appendChild(circle);
          for (const d of ["M -3.5 0 H 3.5", "M 0 -3.5 V 3.5"]) {
            const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
            line.setAttribute("d", d);
            insert.appendChild(line);
          }
          const activate = (event: Event): void => {
            event.preventDefault();
            event.stopPropagation();
            this.options.onInsertCycle(
              relation.id,
              item.sourceId,
              item.targetId,
              targetNode.projectId,
            );
          };
          insert.addEventListener("click", activate);
          insert.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") activate(event);
          });
          this.svg.appendChild(insert);
        }
      }
    }
    if (this.connectionPreview) {
      const sourceNode = this.nodeByEntity.get(this.connectionPreview.sourceId);
      const sourcePoint = this.layout.get(this.connectionPreview.sourceId);
      if (sourceNode && sourcePoint) {
        const start = lineageGraphBox(sourceNode, sourcePoint);
        const preview = document.createElementNS("http://www.w3.org/2000/svg", "path");
        preview.classList.add("helix-lineage-edge", "is-connection-preview");
        preview.setAttribute(
          "d",
          `M ${start.right} ${start.centerY} C ${start.right + 70} ${start.centerY}, ${
            this.connectionPreview.point.x - 70
          } ${this.connectionPreview.point.y}, ${this.connectionPreview.point.x} ${
            this.connectionPreview.point.y
          }`,
        );
        this.svg.appendChild(preview);
      }
    }
    for (const guide of this.alignmentGuides) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.classList.add("helix-lineage-alignment-guide", `is-${guide.axis}`);
      line.setAttribute("x1", String(guide.start.x));
      line.setAttribute("y1", String(guide.start.y));
      line.setAttribute("x2", String(guide.end.x));
      line.setAttribute("y2", String(guide.end.y));
      this.svg.appendChild(line);
    }
    this.updateLineageHoverFocus();
  }

  private updateLineageHoverFocus(): void {
    if (!this.nodeLayer || !this.svg) return;
    const projection: LineageCompletedProjection = {
      hiddenByCollapseHead: this.hiddenByCollapseHead,
      collapseHeadByMember: this.collapseHeadByMember,
      collapseCountByHead: this.collapseCountByHead,
    };
    const highlight = this.hoveredStageId
      ? lineageAncestorHighlight(
          this.hoveredStageId,
          projectedLineageRelations(this.options.snapshot, projection),
        )
      : null;
    for (const card of this.nodeLayer.querySelectorAll<HTMLElement>(
      ".helix-lineage-card[data-entity-id]",
    )) {
      card.toggleClass(
        "is-lineage-dimmed",
        Boolean(highlight && !highlight.entityIds.has(card.dataset.entityId ?? "")),
      );
    }
    for (const edge of this.svg.querySelectorAll<SVGElement>(
      ".helix-lineage-edge, .helix-lineage-edge-hit, .helix-lineage-edge-insert",
    )) {
      const key = lineageProjectedEdgeKey(
        edge.dataset.sourceId ?? "",
        edge.dataset.targetId ?? "",
      );
      edge.classList.toggle(
        "is-lineage-dimmed",
        Boolean(highlight && !highlight.edgeKeys.has(key)),
      );
    }
  }

  private renderCardGrid(parent: HTMLElement): void {
    const grid = parent.createDiv({ cls: "helix-lineage-grid" });
    for (const node of this.visibleNodes().filter((candidate) =>
      !this.options.selectedProjectId ||
      candidate.projectId === this.options.selectedProjectId)) {
      const card = grid.createDiv({
        cls: `helix-lineage-card is-grid is-${node.kind}${
          node.projectId === this.options.selectedProjectId ? " is-current-project" : ""
        }`,
      });
      card.style.setProperty("--helix-project-color", this.projectColor(
        this.projectFor(node.projectId),
      ));
      this.fillCard(card, node, false);
      if (node.kind === "cycle" && !this.collapseCountByHead.has(node.entityId)) {
        this.renderCycleActions(card, node);
      }
      card.addEventListener("click", () => this.options.onOpenNote(node.notePath));
    }
  }

  private renderKanban(parent: HTMLElement): void {
    const board = parent.createDiv({ cls: "helix-lineage-kanban" });
    const boardNodes = this.boardStageNodes();
    for (const status of STAGE_BOARD_COLUMNS) {
      const presentation = STAGE_STATUS_PRESENTATION[status];
      const column = board.createDiv({
        cls: `helix-lineage-column is-${status}`,
        attr: { "data-stage-status": status },
      });
      const heading = column.createDiv({ cls: "helix-lineage-column-heading" });
      const title = heading.createEl("h3");
      const icon = title.createSpan({ cls: "helix-lineage-column-icon" });
      setIcon(icon, presentation.icon);
      title.createSpan({ text: presentation.label });
      const nodes = boardNodes.filter((node) => {
        const owner = this.projectFor(node.projectId);
        return owner.cycles.find((cycle) => cycle.id === node.entityId)?.status === status;
      });
      heading.createSpan({ text: String(nodes.length) });
      const list = column.createDiv({ cls: "helix-lineage-column-list" });
      for (const node of nodes) {
        const card = list.createDiv({ cls: "helix-lineage-card is-kanban is-cycle" });
        card.style.setProperty("--helix-project-color", this.projectColor(
          this.projectFor(node.projectId),
        ));
        this.fillCard(card, node, false);
        if (!this.collapseCountByHead.has(node.entityId)) {
          this.renderCycleActions(card, node);
        }
        this.bindKanbanCard(card, node, status);
        if (node.entityId === this.options.arrivalCycleId) {
          card.addClass("is-status-arrived");
          window.setTimeout(() => {
            if (!this.destroyed) card.removeClass("is-status-arrived");
          }, 260);
        }
      }
    }
  }

  private bindKanbanCard(
    card: HTMLElement,
    node: ProjectWorkspaceCanvasNode,
    status: ProjectWorkspaceCycle["status"],
  ): void {
    card.dataset.helixStageStatus = status;
    card.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button") ||
          this.boardMoves.isPending(node.entityId)) return;
      this.boardDrag = {
        card,
        cycleId: node.entityId,
        pointerId: event.pointerId,
        sourceStatus: card.dataset.helixStageStatus as ProjectWorkspaceCycle["status"],
      };
      card.dataset.helixPointerX = String(event.clientX);
      card.dataset.helixPointerY = String(event.clientY);
      card.setPointerCapture(event.pointerId);
      this.boardEscapeListener = (keyEvent) => {
        if (keyEvent.key !== "Escape") return;
        keyEvent.preventDefault();
        this.cancelBoardDrag();
      };
      document.addEventListener("keydown", this.boardEscapeListener, true);
    });
    card.addEventListener("pointermove", (event) => {
      const drag = this.boardDrag;
      if (!drag || drag.card !== card) return;
      const startX = Number(card.dataset.helixPointerX);
      const startY = Number(card.dataset.helixPointerY);
      if (!card.hasClass("is-dragging") && Math.hypot(event.clientX - startX, event.clientY - startY) < 7) return;
      event.preventDefault();
      card.addClass("is-dragging");
      card.style.setProperty("--helix-drag-x", `${event.clientX - startX}px`);
      card.style.setProperty("--helix-drag-y", `${event.clientY - startY}px`);
      const target = document.elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(".helix-lineage-column[data-stage-status]");
      this.clearKanbanDropState(card.closest(".helix-lineage-kanban"));
      target?.addClass("is-drop-target");
      this.previewKanbanCounts(card.closest(".helix-lineage-kanban"), target?.dataset.stageStatus as ProjectWorkspaceCycle["status"] | undefined);
    });
    const finishPointer = (event: PointerEvent, canceled = false) => {
      const drag = this.boardDrag;
      if (!drag || drag.card !== card) return;
      const moved = card.hasClass("is-dragging");
      card.removeClass("is-dragging");
      card.style.removeProperty("--helix-drag-x");
      card.style.removeProperty("--helix-drag-y");
      this.clearKanbanDropState(card.closest(".helix-lineage-kanban"));
      this.boardDrag = null;
      this.clearBoardEscapeListener();
      const column = document.elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(".helix-lineage-column[data-stage-status]");
      const targetStatus = column?.dataset.stageStatus as ProjectWorkspaceCycle["status"] | undefined;
      const pointerDecision = stageBoardPointerDecision(
        moved ? 7 : 0,
        drag.sourceStatus,
        targetStatus,
        canceled,
      );
      if (pointerDecision.suppressOpen) {
        card.dataset.helixSuppressOpen = "true";
        window.setTimeout(() => delete card.dataset.helixSuppressOpen, 0);
      }
      if (pointerDecision.move !== "commit" || !targetStatus || !column) return;
      const targetList = column.querySelector<HTMLElement>(".helix-lineage-column-list");
      if (!targetList) return;
      this.commitKanbanMove(drag, targetStatus, targetList);
    };
    card.addEventListener("pointerup", (event) => finishPointer(event));
    card.addEventListener("pointercancel", (event) => finishPointer(event, true));
    card.addEventListener("lostpointercapture", (event) => finishPointer(event, true));
    card.addEventListener("click", () => {
      if (card.dataset.helixSuppressOpen === "true") return;
      this.options.onOpenNote(node.notePath);
    });
  }

  private commitKanbanMove(
    drag: NonNullable<ProjectLineageWorkbench["boardDrag"]>,
    targetStatus: ProjectWorkspaceCycle["status"],
    list: HTMLElement,
  ): void {
      if (drag.sourceStatus === targetStatus) return;
      if (!this.boardMoves.tryBegin(drag.cycleId)) return;
      const decision = stageBoardMoveDecision(drag.sourceStatus, targetStatus, false);
      if (decision !== "commit") {
        this.boardMoves.finish(drag.cycleId, !this.destroyed);
        return;
      }
      drag.card.addClass("is-status-pending");
      void this.options.requestCycleStatusChange(drag.cycleId, drag.sourceStatus, targetStatus)
        .then(() => {
          // 提交器已经基于 Markdown 新快照重渲染；旧实例不得保留局部伪状态。
        })
        .catch((error) => {
          this.options.onError(error);
        })
        .finally(() => {
          const alive = this.boardMoves.finish(drag.cycleId, !this.destroyed);
          if (alive) drag.card.removeClass("is-status-pending");
        });
  }

  private cancelBoardDrag(): void {
    const drag = this.boardDrag;
    if (!drag) return;
    if (drag.card.hasClass("is-dragging")) {
      drag.card.dataset.helixSuppressOpen = "true";
      window.setTimeout(() => delete drag.card.dataset.helixSuppressOpen, 0);
    }
    drag.card.removeClass("is-dragging");
    if (drag.card.hasPointerCapture(drag.pointerId)) drag.card.releasePointerCapture(drag.pointerId);
    drag.card.style.removeProperty("--helix-drag-x");
    drag.card.style.removeProperty("--helix-drag-y");
    this.clearKanbanDropState(drag.card.closest(".helix-lineage-kanban"));
    this.boardDrag = null;
    this.clearBoardEscapeListener();
  }

  private clearBoardEscapeListener(): void {
    if (!this.boardEscapeListener) return;
    document.removeEventListener("keydown", this.boardEscapeListener, true);
    this.boardEscapeListener = null;
  }

  private boardStageNodes(): ProjectWorkspaceCanvasNode[] {
    const visibleIds = new Set(stageBoardCycleIds(
      this.options.snapshot.projects,
      this.options.selectedProjectId,
    ));
    return this.options.snapshot.projects.flatMap((project) =>
      project.cycles.flatMap((cycle) => !visibleIds.has(cycle.id) ? [] : [
        this.nodeByEntity.get(cycle.id) ?? ({
          nodeId: `helix-board-${cycle.id}`,
          entityId: cycle.id,
          projectId: project.id,
          kind: "cycle" as const,
          notePath: cycle.notePath,
          title: cycle.title,
          x: 0,
          y: 0,
          width: GRAPH_CARD_WIDTH,
          height: GRAPH_CARD_HEIGHT,
        }),
      ]),
    );
  }

  private clearKanbanDropState(board: Element | null): void {
    board?.querySelectorAll(".helix-lineage-column.is-drop-target")
      .forEach((column) => column.removeClass("is-drop-target"));
    this.previewKanbanCounts(board, undefined);
  }

  private previewKanbanCounts(
    board: Element | null,
    targetStatus: ProjectWorkspaceCycle["status"] | undefined,
  ): void {
    if (!board) return;
    for (const column of board.querySelectorAll<HTMLElement>(".helix-lineage-column[data-stage-status]")) {
      const status = column.dataset.stageStatus as ProjectWorkspaceCycle["status"];
      let count = column.querySelectorAll(".helix-lineage-card.is-kanban").length;
      if (this.boardDrag && targetStatus && targetStatus !== this.boardDrag.sourceStatus) {
        if (status === this.boardDrag.sourceStatus) count -= 1;
        if (status === targetStatus) count += 1;
      }
      column.querySelector<HTMLElement>(".helix-lineage-column-heading > span:last-child")
        ?.setText(String(Math.max(0, count)));
    }
  }

  private bindNavigation(viewport: HTMLElement): void {
    viewport.addEventListener("keydown", (event) => {
      if (event.code === "Space") {
        event.preventDefault();
        this.spaceHeld = true;
        viewport.addClass("is-pan-ready");
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        this.selected.clear();
        for (const node of this.structuralNodes()) this.selected.add(node.entityId);
        this.updateSelection();
      } else if (event.key === "Escape") {
        if (this.lasso) {
          event.preventDefault();
          this.cancelLasso(viewport);
          return;
        }
        this.selected.clear();
        this.selectedRelationId = null;
        this.updateSelection();
        this.renderEdges();
        this.updateRelationPanel();
      } else if (event.shiftKey && event.code === "Digit1") {
        event.preventDefault();
        this.zoomToFit();
      }
    });
    viewport.addEventListener("keyup", (event) => {
      if (event.code !== "Space") return;
      this.spaceHeld = false;
      viewport.removeClass("is-pan-ready");
    });
    viewport.addEventListener("wheel", (event) => {
      if (!event.metaKey && !event.ctrlKey && !this.spaceHeld) return;
      event.preventDefault();
      this.setZoom(this.zoom * Math.exp(-event.deltaY * 0.002), true);
    }, { passive: false });
    viewport.addEventListener("scroll", () => {
      if (!this.suppressVirtualExpansion) this.expandVirtualPlane();
    });
    viewport.addEventListener("dblclick", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(
        "button, .helix-lineage-card, .helix-lineage-edge, " +
          ".helix-lineage-project-container-header",
      )) return;
      const projectId = this.projectIdAtPoint(
        this.viewportLogicalPoint(event, viewport),
      );
      if (!projectId) return;
      event.preventDefault();
      event.stopPropagation();
      this.options.onSelectProject(projectId);
    });
    viewport.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const projectId = this.projectIdAtPoint(
        this.viewportLogicalPoint(event, viewport),
      );
      const surface: LineagePointerSurface = target?.closest("button")
        ? "button"
        : target?.closest(".helix-lineage-edge")
          ? "edge"
          : target?.closest(".helix-lineage-card")
            ? "card"
            : target?.closest(".helix-lineage-project-container-header")
              ? "project-header"
              : target?.closest(".helix-lineage-project-container")
                ? "project-container"
                : projectId
                  ? "project-container"
                  : "blank";
      const intent = lineageViewportPointerIntent(
        event.button,
        this.spaceHeld,
        surface,
      );
      if (intent === "pan") {
        event.preventDefault();
        viewport.focus({ preventScroll: true });
        this.pan = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: viewport.scrollLeft,
          top: viewport.scrollTop,
        };
        viewport.setPointerCapture(event.pointerId);
        viewport.addClass("is-panning");
        return;
      }
      if (intent === "lasso") {
        event.preventDefault();
        viewport.focus({ preventScroll: true });
        const start = this.viewportLogicalPoint(event, viewport);
        const overlay = this.surface?.createDiv({ cls: "helix-lineage-lasso" });
        if (!overlay) return;
        overlay.style.left = `${start.x}px`;
        overlay.style.top = `${start.y}px`;
        overlay.style.width = "0";
        overlay.style.height = "0";
        this.lasso = {
          pointerId: event.pointerId,
          start,
          baseSelection: new Set(this.selected),
          baseRelationId: this.selectedRelationId,
          additive: event.shiftKey,
          moved: false,
          overlay,
        };
        this.selectedRelationId = null;
        this.renderEdges();
        this.updateRelationPanel();
        viewport.setPointerCapture(event.pointerId);
        viewport.addClass("is-lassoing");
      }
    });
    viewport.addEventListener("pointermove", (event) => {
      if (this.pan?.pointerId === event.pointerId) {
        viewport.scrollLeft = this.pan.left - (event.clientX - this.pan.x);
        viewport.scrollTop = this.pan.top - (event.clientY - this.pan.y);
        return;
      }
      if (this.lasso?.pointerId === event.pointerId) {
        this.updateLasso(event, viewport);
      }
    });
    const finishPan = (event: PointerEvent): void => {
      if (!this.pan || this.pan.pointerId !== event.pointerId) return;
      this.pan = null;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      viewport.removeClass("is-panning");
    };
    viewport.addEventListener("pointerup", (event) => {
      finishPan(event);
      this.finishLasso(event, viewport);
    });
    viewport.addEventListener("pointercancel", (event) => {
      finishPan(event);
      if (this.lasso?.pointerId === event.pointerId) this.cancelLasso(viewport);
    });
    viewport.addEventListener("lostpointercapture", (event) => {
      if (this.pan?.pointerId === event.pointerId) {
        this.pan = null;
        viewport.removeClass("is-panning");
      }
      if (this.lasso?.pointerId === event.pointerId) this.cancelLasso(viewport);
    });
  }

  private viewportLogicalPoint(
    event: Pick<PointerEvent, "clientX" | "clientY">,
    viewport: HTMLElement,
  ): LineagePoint {
    const rect = viewport.getBoundingClientRect();
    return {
      x: (viewport.scrollLeft + event.clientX - rect.left) /
        Math.max(MIN_FIT_ZOOM, this.zoom),
      y: (viewport.scrollTop + event.clientY - rect.top) /
        Math.max(MIN_FIT_ZOOM, this.zoom),
    };
  }

  private projectIdAtPoint(point: LineagePoint): string | undefined {
    return [...this.options.snapshot.projects]
      .reverse()
      .find((project) => {
        const box = this.projectContainerBox(project.id);
        return box && point.x >= box.x && point.x <= box.right &&
          point.y >= box.y && point.y <= box.bottom;
      })?.id;
  }

  private updateLasso(event: PointerEvent, viewport: HTMLElement): void {
    const lasso = this.lasso;
    if (!lasso || lasso.pointerId !== event.pointerId) return;
    const current = this.viewportLogicalPoint(event, viewport);
    const screenDistance = (
      Math.abs(current.x - lasso.start.x) +
      Math.abs(current.y - lasso.start.y)
    ) * this.zoom;
    if (screenDistance > 4) lasso.moved = true;
    if (!lasso.moved) return;
    const box = lineageSelectionBox(lasso.start, current);
    lasso.overlay.style.left = `${box.x}px`;
    lasso.overlay.style.top = `${box.y}px`;
    lasso.overlay.style.width = `${box.right - box.x}px`;
    lasso.overlay.style.height = `${box.bottom - box.y}px`;
    const next = lineageLassoSelectionState(
      lasso.baseSelection,
      lasso.baseRelationId,
      lineageEntitiesInSelection(
      this.structuralNodes(),
      this.layout,
      box,
      ),
      lasso.additive ? "add" : "replace",
    );
    this.applyLassoSelectionState(next);
  }

  private finishLasso(event: PointerEvent, viewport: HTMLElement): void {
    const lasso = this.lasso;
    if (!lasso || lasso.pointerId !== event.pointerId) return;
    this.lasso = null;
    lasso.overlay.remove();
    viewport.removeClass("is-lassoing");
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
    if (!lasso.moved) {
      this.applyLassoSelectionState(lineageLassoSelectionState(
        lasso.baseSelection,
        lasso.baseRelationId,
        [],
        lasso.additive ? "cancel" : "clear",
      ));
    }
  }

  private cancelLasso(viewport: HTMLElement): void {
    const lasso = this.lasso;
    if (!lasso) return;
    this.lasso = null;
    lasso.overlay.remove();
    viewport.removeClass("is-lassoing");
    if (viewport.hasPointerCapture(lasso.pointerId)) {
      viewport.releasePointerCapture(lasso.pointerId);
    }
    this.applyLassoSelectionState(lineageLassoSelectionState(
      lasso.baseSelection,
      lasso.baseRelationId,
      [],
      "cancel",
    ));
  }

  private applyLassoSelectionState(state: LineageLassoSelectionState): void {
    this.selected.clear();
    for (const entityId of state.entityIds) this.selected.add(entityId);
    this.selectedRelationId = state.relationId;
    this.updateSelection();
    this.renderEdges();
    this.updateRelationPanel();
  }

  private renderZoomControls(root: HTMLElement): void {
    const controls = root.createDiv({ cls: "helix-lineage-zoom" });
    const button = (icon: string, label: string, action: () => void): void => {
      const element = controls.createEl("button", { attr: { "aria-label": label, title: label } });
      setIcon(element, icon);
      element.addEventListener("click", action);
    };
    button("minus", "缩小", () => this.setZoom(this.zoom / 1.2, true));
    const label = controls.createEl("button", {
      cls: "helix-lineage-zoom-label",
      text: "100%",
      attr: { "aria-label": "重置缩放" },
    });
    label.addEventListener("click", () => this.setZoom(1, true));
    button("plus", "放大", () => this.setZoom(this.zoom * 1.2, true));
    button("maximize", "适应全部卡片", () => this.zoomToFit());
  }

  private setZoom(value: number, preserveViewportCenter = false): void {
    const previousZoom = this.zoom;
    const nextZoom = lineageClampedZoom(value);
    const viewport = this.viewport;
    if (preserveViewportCenter && viewport) {
      const rawCenterX = (
        viewport.scrollLeft + viewport.clientWidth / 2
      ) / Math.max(MIN_FIT_ZOOM, previousZoom) - this.canvasOffset.x;
      const rawCenterY = (
        viewport.scrollTop + viewport.clientHeight / 2
      ) / Math.max(MIN_FIT_ZOOM, previousZoom) - this.canvasOffset.y;
      const plan = lineageCenteredZoomPlan(
        viewport,
        previousZoom,
        nextZoom,
        this.width,
        this.height,
      );
      this.beginProgrammaticScroll({
        zoom: nextZoom,
        rawCenterX,
        rawCenterY,
      });
      this.applyViewportPlanGeometry(plan);
      this.zoom = nextZoom;
      this.applyScale();
      viewport.scrollTo({ left: plan.left, top: plan.top, behavior: "auto" });
      this.scheduleProgrammaticScrollEnd(48);
      return;
    }
    this.zoom = nextZoom;
    this.applyScale();
  }

  private zoomToFit(): void {
    if (!this.viewport) return;
    const bounds = this.contentBounds();
    const scale = lineageFitScale(
      this.viewport.clientWidth,
      this.viewport.clientHeight,
      bounds.width,
      bounds.height,
    );
    this.zoom = scale;
    this.applyScale();
    this.centerPlanePoint({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    }, "auto");
  }

  private applyScale(): void {
    if (!this.surface || !this.plane) return;
    this.surface.style.width = `${this.width}px`;
    this.surface.style.height = `${this.height}px`;
    this.surface.style.transform = `scale(${this.zoom})`;
    this.plane.style.width = `${this.width * this.zoom}px`;
    this.plane.style.height = `${this.height * this.zoom}px`;
    this.plane.style.setProperty("--helix-lineage-grid", `${GRID_SIZE * this.zoom}px`);
    const label = this.surface.closest(".helix-lineage-graph")
      ?.querySelector<HTMLElement>(".helix-lineage-zoom-label");
    if (label) label.textContent = lineageZoomLabel(this.zoom);
  }

  private applyViewportPlanGeometry(plan: LineageViewportPlan): void {
    if (plan.shiftX || plan.shiftY) {
      for (const point of this.layout.values()) {
        point.x += plan.shiftX;
        point.y += plan.shiftY;
      }
      this.canvasOffset.x += plan.shiftX;
      this.canvasOffset.y += plan.shiftY;
      this.width += plan.shiftX;
      this.height += plan.shiftY;
      if (this.nodeLayer) {
        for (const card of this.nodeLayer.querySelectorAll<HTMLElement>(
          ".helix-lineage-card[data-entity-id]",
        )) {
          const point = card.dataset.entityId
            ? this.layout.get(card.dataset.entityId)
            : undefined;
          if (!point) continue;
          card.style.left = `${point.x}px`;
          card.style.top = `${point.y}px`;
        }
      }
      this.updateProjectContainerGeometry();
    }
    this.width += plan.growRightBy;
    this.height += plan.growBottomBy;
    if (
      plan.shiftX ||
      plan.shiftY ||
      plan.growRightBy ||
      plan.growBottomBy
    ) this.renderEdges();
  }

  private beginProgrammaticScroll(camera: LineageCamera): void {
    if (this.programmaticScrollTimer !== null) {
      window.clearTimeout(this.programmaticScrollTimer);
      this.programmaticScrollTimer = null;
    }
    if (this.programmaticScrollFrame !== null) {
      window.cancelAnimationFrame(this.programmaticScrollFrame);
      this.programmaticScrollFrame = null;
    }
    this.suppressVirtualExpansion = true;
    this.pendingCamera = camera;
  }

  private scheduleProgrammaticScrollEnd(delay: number): void {
    this.programmaticScrollTimer = window.setTimeout(() => {
      this.programmaticScrollTimer = null;
      this.endProgrammaticScroll();
    }, delay);
  }

  private endProgrammaticScroll(): void {
    this.pendingCamera = null;
    this.suppressVirtualExpansion = false;
    this.programmaticScrollFrame = null;
    this.expandVirtualPlane();
  }

  private animateViewportCamera(
    targetZoom: number,
    targetCenter: LineagePoint,
    duration = 420,
  ): void {
    const viewport = this.viewport;
    if (!viewport) return;
    const startZoom = this.zoom;
    const startCenter = {
      x: (viewport.scrollLeft + viewport.clientWidth / 2) /
        Math.max(MIN_FIT_ZOOM, startZoom),
      y: (viewport.scrollTop + viewport.clientHeight / 2) /
        Math.max(MIN_FIT_ZOOM, startZoom),
    };
    const startTime = performance.now();
    const step = (now: number): void => {
      if (this.destroyed || !this.viewport) return;
      const frame = lineageCameraFrame(
        startCenter,
        targetCenter,
        startZoom,
        targetZoom,
        (now - startTime) / duration,
        viewport,
      );
      this.zoom = frame.zoom;
      this.applyScale();
      viewport.scrollLeft = frame.left;
      viewport.scrollTop = frame.top;
      if (now - startTime < duration) {
        this.programmaticScrollFrame = window.requestAnimationFrame(step);
      } else {
        this.zoom = lineageClampedZoom(targetZoom);
        this.applyScale();
        viewport.scrollLeft = targetCenter.x * this.zoom -
          viewport.clientWidth / 2;
        viewport.scrollTop = targetCenter.y * this.zoom -
          viewport.clientHeight / 2;
        this.endProgrammaticScroll();
      }
    };
    this.programmaticScrollFrame = window.requestAnimationFrame(step);
  }

  private focusPlaneBox(
    box: { x: number; y: number; width: number; height: number },
    targetZoom: number,
    behavior: ScrollBehavior,
    rawCenter: LineagePoint = {
      x: box.x + box.width / 2 - this.canvasOffset.x,
      y: box.y + box.height / 2 - this.canvasOffset.y,
    },
  ): void {
    const viewport = this.viewport;
    if (!viewport) return;
    const center = {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
    const zoom = lineageClampedZoom(targetZoom);
    const plan = lineageCenteredPointPlan(
      center,
      zoom,
      viewport,
      this.width,
      this.height,
    );
    const startZoom = this.zoom;
    const startLeft = viewport.scrollLeft;
    const startTop = viewport.scrollTop;
    this.beginProgrammaticScroll({
      zoom,
      rawCenterX: rawCenter.x,
      rawCenterY: rawCenter.y,
    });
    this.applyViewportPlanGeometry(plan);
    this.applyScale();
    viewport.scrollLeft = startLeft + plan.shiftX * startZoom;
    viewport.scrollTop = startTop + plan.shiftY * startZoom;
    const shiftedCenter = {
      x: center.x + plan.shiftX,
      y: center.y + plan.shiftY,
    };
    if (behavior === "smooth") {
      this.animateViewportCamera(zoom, shiftedCenter);
    } else {
      this.zoom = zoom;
      this.applyScale();
      viewport.scrollTo({ left: plan.left, top: plan.top, behavior: "auto" });
      this.scheduleProgrammaticScrollEnd(48);
    }
  }

  private focusGraphCard(node: ProjectWorkspaceCanvasNode): void {
    const point = this.layout.get(node.entityId);
    const viewport = this.viewport;
    if (!point || !viewport) return;
    const box = lineageGraphBox(node, point);
    const targetZoom = lineageFocusScale(
      viewport.clientWidth,
      viewport.clientHeight,
      box.width,
      box.height,
    );
    const reducedMotion = typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.focusPlaneBox(box, targetZoom, lineageFocusBehavior(reducedMotion));
    const card = this.nodeLayer?.querySelector<HTMLElement>(
      `.helix-lineage-card[data-entity-id="${CSS.escape(node.entityId)}"]`,
    );
    card?.addClass("is-operation-focus");
    if (card) window.setTimeout(() => card.removeClass("is-operation-focus"), 1_600);
  }

  private focusGraphBox(box: { x: number; y: number; width: number; height: number }): void {
    const viewport = this.viewport;
    if (!viewport) return;
    const reducedMotion = typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.focusPlaneBox(
      box,
      lineageFocusScale(viewport.clientWidth, viewport.clientHeight, box.width, box.height),
      lineageFocusBehavior(reducedMotion),
    );
  }

  private centerPlanePoint(
    point: LineagePoint,
    behavior: ScrollBehavior,
    rawPoint: LineagePoint = {
      x: point.x - this.canvasOffset.x,
      y: point.y - this.canvasOffset.y,
    },
  ): void {
    this.focusPlaneBox(
      { x: point.x, y: point.y, width: 0, height: 0 },
      this.zoom,
      behavior,
      rawPoint,
    );
  }

  private updateSelection(): void {
    if (!this.nodeLayer) return;
    for (const card of this.nodeLayer.querySelectorAll<HTMLElement>(".helix-lineage-card")) {
      const selected = Boolean(card.dataset.entityId && this.selected.has(card.dataset.entityId));
      card.toggleClass("is-selected", selected);
      card.setAttribute("aria-selected", String(selected));
      const node = card.dataset.entityId
        ? this.nodeByEntity.get(card.dataset.entityId)
        : undefined;
      if (node?.kind === "cycle") this.updateCreateActionLabel(card, node);
    }
    this.updateLayoutControls();
  }

  private captureRawLayout(): LineageLayoutSnapshot {
    return Object.fromEntries([...this.layout].map(([entityId, point]) => [
      entityId,
      {
        x: point.x - this.canvasOffset.x,
        y: point.y - this.canvasOffset.y,
      },
    ]));
  }

  private sameLayoutEntities(snapshot: LineageLayoutSnapshot): boolean {
    const expected = [...this.layout.keys()].sort();
    const actual = Object.keys(snapshot).sort();
    return expected.length === actual.length && expected.every((id, index) => id === actual[index]);
  }

  private applyRawLayout(snapshot: LineageLayoutSnapshot): void {
    for (const [entityId, point] of Object.entries(snapshot)) {
      if (!this.layout.has(entityId)) continue;
      this.layout.set(entityId, {
        x: point.x + this.canvasOffset.x,
        y: point.y + this.canvasOffset.y,
      });
    }
  }

  private renderLayoutPositions(): void {
    if (this.nodeLayer) {
      for (const card of this.nodeLayer.querySelectorAll<HTMLElement>(
        ".helix-lineage-card[data-entity-id]",
      )) {
        const point = card.dataset.entityId
          ? this.layout.get(card.dataset.entityId)
          : undefined;
        if (!point) continue;
        card.style.left = `${point.x}px`;
        card.style.top = `${point.y}px`;
      }
    }
    const bounds = this.measure();
    this.width = bounds.width;
    this.height = bounds.height;
    this.applyScale();
    this.updateProjectContainerGeometry();
    this.renderEdges();
  }

  private layoutsEqual(left: LineageLayoutSnapshot, right: LineageLayoutSnapshot): boolean {
    return this.sameLayoutEntities(left) && Object.entries(left).every(([id, point]) =>
      right[id]?.x === point.x && right[id]?.y === point.y);
  }

  private recordLayoutChange(before: LineageLayoutSnapshot): void {
    const after = this.captureRawLayout();
    if (this.layoutsEqual(before, after)) return;
    this.layoutUndo.push(cloneLayoutSnapshot(before));
    if (this.layoutUndo.length > 50) this.layoutUndo.shift();
    this.layoutRedo = [];
    this.layoutDirty = !this.layoutsEqual(after, this.persistedLayout);
    this.updateLayoutControls();
  }

  private undoLayout(): void {
    const previous = this.layoutUndo.pop();
    if (!previous) return;
    this.layoutRedo.push(this.captureRawLayout());
    this.applyRawLayout(previous);
    this.layoutDirty = !this.layoutsEqual(this.captureRawLayout(), this.persistedLayout);
    this.renderLayoutPositions();
    this.updateLayoutControls();
  }

  private redoLayout(): void {
    const next = this.layoutRedo.pop();
    if (!next) return;
    this.layoutUndo.push(this.captureRawLayout());
    this.applyRawLayout(next);
    this.layoutDirty = !this.layoutsEqual(this.captureRawLayout(), this.persistedLayout);
    this.renderLayoutPositions();
    this.updateLayoutControls();
  }

  private restoreSavedLayout(): void {
    const before = this.captureRawLayout();
    if (this.layoutsEqual(before, this.persistedLayout)) return;
    this.layoutUndo.push(cloneLayoutSnapshot(before));
    if (this.layoutUndo.length > 50) this.layoutUndo.shift();
    this.layoutRedo = [];
    this.applyRawLayout(this.persistedLayout);
    this.layoutDirty = false;
    this.renderLayoutPositions();
    this.updateLayoutControls();
  }

  private currentArrangeScope(): LineageArrangeScope {
    return lineageArrangeScope(
      [...this.selected],
      this.options.selectedProjectId,
      this.options.snapshot.canvasNodes,
    );
  }

  private arrangeCurrentScope(): void {
    const scope = this.currentArrangeScope();
    if (scope.kind === "disabled") return;
    const before = this.captureRawLayout();
    const stages = this.options.snapshot.canvasNodes
      .filter((node) => node.kind === "cycle")
      .map((node) => {
        const point = before[node.entityId] ?? { x: node.x, y: node.y };
        const cycle = this.options.snapshot.projects
          .flatMap((project) => project.cycles)
          .find((candidate) => candidate.id === node.entityId);
        return {
          id: node.entityId,
          projectId: node.projectId,
          sequence: cycle?.sequence ?? Number.MAX_SAFE_INTEGER,
          x: point.x,
          y: point.y,
        };
      });
    const planned = planProjectGraphLayout(
      this.options.snapshot.projects.map((project) => ({ id: project.id, x: 0, y: 0 })),
      stages,
      this.physicalEdges(),
      new Set(scope.entityIds),
    );
    const arranged = scope.kind === "selection"
      ? lineageAnchoredSelectionLayout(
          scope.entityIds,
          stages.map((stage) => ({
            entityId: stage.id,
            projectId: stage.projectId,
            x: stage.x,
            y: stage.y,
          })),
          planned.stages,
          this.physicalEdges(),
        )
      : Object.fromEntries(planned.stages.map((stage) => [stage.id, {
          x: stage.x,
          y: stage.y,
        }]));
    for (const stage of planned.stages) {
      if (!scope.entityIds.includes(stage.id)) continue;
      const point = arranged[stage.id];
      if (!point) continue;
      this.layout.set(stage.id, {
        x: point.x + this.canvasOffset.x,
        y: point.y + this.canvasOffset.y,
      });
    }
    this.recordLayoutChange(before);
    this.renderLayoutPositions();
  }

  private async saveCurrentLayout(): Promise<void> {
    if (!this.layoutDirty || this.layoutSavePending) return;
    const moves = this.options.snapshot.canvasNodes
      .filter((node) => node.kind === "cycle")
      .flatMap((node) => {
        const point = this.layout.get(node.entityId);
        return point ? [lineageMovePayload(node, point, this.canvasOffset)] : [];
      });
    this.layoutSavePending = true;
    this.updateLayoutControls();
    try {
      await this.options.onSaveLayout(moves);
    } catch (error) {
      this.layoutSavePending = false;
      this.updateLayoutControls();
      this.options.onError(error);
    }
  }

  private updateLayoutControls(): void {
    if (this.undoButton) this.undoButton.disabled = this.layoutUndo.length === 0;
    if (this.redoButton) this.redoButton.disabled = this.layoutRedo.length === 0;
    if (this.restoreLayoutButton) {
      this.restoreLayoutButton.disabled = this.layoutsEqual(
        this.captureRawLayout(),
        this.persistedLayout,
      );
    }
    const scope = this.currentArrangeScope();
    if (this.arrangeButton) {
      this.arrangeButton.disabled = scope.kind === "disabled";
      this.arrangeButton.title = scope.kind === "disabled"
        ? scope.reason === "cross-project"
          ? "跨项目选择不能自动整理"
          : "请先选择一个项目或同一项目内的阶段"
        : scope.kind === "project"
          ? "仅整理当前项目"
          : "仅整理当前项目内选中的阶段";
    }
    if (this.saveLayoutButton) {
      this.saveLayoutButton.disabled = !this.layoutDirty || this.layoutSavePending;
      this.saveLayoutButton.textContent = this.layoutSavePending ? "正在保存…" : "保存当前布局";
    }
  }

  private measure(): { width: number; height: number } {
    let width = VIRTUAL_MARGIN * 2;
    let height = VIRTUAL_MARGIN * 2;
    for (const project of this.options.snapshot.projects) {
      const box = this.projectContainerBox(project.id);
      if (!box) continue;
      width = Math.max(width, box.right + VIRTUAL_MARGIN);
      height = Math.max(height, box.bottom + VIRTUAL_MARGIN);
    }
    return { width, height };
  }

  private ensureBounds(
    point: LineagePoint,
    node: ProjectWorkspaceCanvasNode,
  ): void {
    const box = lineageGraphBox(node, point);
    this.width = Math.max(this.width, box.right + PADDING);
    this.height = Math.max(this.height, box.bottom + PADDING);
    this.applyScale();
  }

  private selectRelation(relationId: string): void {
    this.selectedRelationId = relationId;
    this.selected.clear();
    this.updateSelection();
    this.renderEdges();
    this.updateRelationPanel();
  }

  private updateRelationPanel(): void {
    if (!this.relationPanel) return;
    this.relationPanel.empty();
    const relation = this.options.snapshot.relations.find(
      (candidate) => candidate.id === this.selectedRelationId,
    );
    this.relationPanel.toggleClass("is-visible", Boolean(relation));
    if (!relation) return;
    const copy = this.relationPanel.createDiv();
    copy.createEl("strong", { text: CYCLE_RELATION_LABELS[relation.kind] });
    copy.createSpan({ text: this.relationSummary(relation) });
    const manage = this.relationPanel.createEl("button", {
      cls: "helix-primary-button",
      text: "修改或删除",
    });
    manage.addEventListener("click", () => this.options.onManageRelation(relation.id));
    const close = this.relationPanel.createEl("button", {
      cls: "helix-icon-button",
      attr: { "aria-label": "关闭关系操作", title: "关闭" },
    });
    setIcon(close, "x");
    close.addEventListener("click", () => {
      this.selectedRelationId = null;
      this.renderEdges();
      this.updateRelationPanel();
    });
  }

  private relationSummary(relation: CycleRelation): string {
    const cycleTitle = (id: string): string =>
      this.options.snapshot.projects
        .flatMap((project) => project.cycles)
        .find((cycle) => cycle.id === id)?.title ?? id;
    return `${relation.fromCycleIds.map(cycleTitle).join(" + ")} → ${
      cycleTitle(relation.toCycleId)
    }`;
  }

  private prepareCompletedProjection(): void {
    const projection = completedLineageProjection(this.options.snapshot);
    for (const [key, value] of projection.hiddenByCollapseHead) {
      this.hiddenByCollapseHead.set(key, value);
    }
    for (const [key, value] of projection.collapseHeadByMember) {
      this.collapseHeadByMember.set(key, value);
    }
    for (const [key, value] of projection.collapseCountByHead) {
      this.collapseCountByHead.set(key, value);
    }
  }

  private hasCollapsibleCompleted(project: ProjectWorkspaceProject): boolean {
    const projection = completedLineageProjection({
      ...this.options.snapshot,
      collapsedCompletedProjectIds: [
        ...new Set([
          ...this.options.snapshot.collapsedCompletedProjectIds,
          project.id,
        ]),
      ],
    });
    return project.cycles.some((cycle) =>
      projection.collapseCountByHead.has(cycle.id));
  }

  private physicalEdges(): ProjectGraphEdge[] {
    return this.options.snapshot.relations.flatMap((relation) =>
      relation.fromCycleIds.map((fromCycleId, index) => ({
        id: relation.kind === "merge" ? `${relation.id}:${index}` : relation.id,
        fromCycleId,
        toCycleId: relation.toCycleId,
      })));
  }

  private visibleNodes(): ProjectWorkspaceCanvasNode[] {
    return this.options.snapshot.canvasNodes.filter((node) =>
      !this.hiddenByCollapseHead.has(node.entityId));
  }

  private visibleStageNodes(): ProjectWorkspaceCanvasNode[] {
    return this.visibleNodes().filter((node) => node.kind === "cycle");
  }

  private projectContainerBox(projectId: string): LineageProjectContainerBox | undefined {
    const nodes = (this.visibleStageIdsByProject.get(projectId) ?? [])
      .flatMap((entityId) => {
        const node = this.nodeByEntity.get(entityId);
        return node ? [node] : [];
      });
    return lineageProjectContainerBox(projectId, nodes, this.layout);
  }

  private structuralNodes(): ProjectWorkspaceCanvasNode[] {
    const structuralIds = new Set(lineageStructuralEntityIds(
      this.options.snapshot,
      {
        hiddenByCollapseHead: this.hiddenByCollapseHead,
        collapseHeadByMember: this.collapseHeadByMember,
        collapseCountByHead: this.collapseCountByHead,
      },
    ));
    return this.options.snapshot.canvasNodes.filter((node) =>
      structuralIds.has(node.entityId));
  }

  private expandProjectedRelation(projectIds: readonly string[]): void {
    if (projectIds.length > 0) {
      this.options.onExpandCompletedProjects([...projectIds]);
    }
  }

  private isProjectedEdgeOutsideSelection(sourceId: string, targetId: string): boolean {
    if (!this.options.selectedProjectId) return false;
    return this.nodeByEntity.get(sourceId)?.projectId !== this.options.selectedProjectId &&
      this.nodeByEntity.get(targetId)?.projectId !== this.options.selectedProjectId;
  }

  private projectColor(project: ProjectWorkspaceProject): string {
    if (project.color) return project.color;
    const palette = ["#5870A8", "#4D8275", "#8A6E9E", "#A16F54", "#667B52", "#526F86"];
    let hash = 0;
    for (const char of project.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return palette[hash % palette.length]!;
  }

  private connectionTargetAt(
    clientX: number,
    clientY: number,
    sourceId: string,
  ): ProjectWorkspaceCanvasNode | undefined {
    const element = document.elementFromPoint(clientX, clientY);
    const card = element?.closest<HTMLElement>(".helix-lineage-card[data-entity-id]");
    const entityId = card?.dataset.entityId;
    const node = entityId ? this.nodeByEntity.get(entityId) : undefined;
    return node?.kind === "cycle" &&
      node.entityId !== sourceId &&
      !this.collapseCountByHead.has(node.entityId)
      ? node
      : undefined;
  }

  private updateConnectionTarget(clientX: number, clientY: number, sourceId: string): void {
    this.clearConnectionTarget();
    const target = this.connectionTargetAt(clientX, clientY, sourceId);
    if (!target || !this.nodeLayer) return;
    this.nodeLayer.querySelector<HTMLElement>(
      `.helix-lineage-card[data-entity-id="${CSS.escape(target.entityId)}"]`,
    )?.addClass("is-connection-target");
  }

  private clearConnectionTarget(): void {
    this.nodeLayer?.querySelectorAll<HTMLElement>(".is-connection-target")
      .forEach((element) => element.removeClass("is-connection-target"));
  }

  private contentBounds(): { x: number; y: number; width: number; height: number } {
    const boxes = this.options.snapshot.projects.flatMap((project) => {
      const box = this.projectContainerBox(project.id);
      return box ? [box] : [];
    });
    if (boxes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.right));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  private centerInitialContent(): void {
    if (!this.viewport || this.destroyed) return;
    const requestedFocusId = this.options.focusEntityId;
    const focusAllProjects = requestedFocusId === LINEAGE_ALL_PROJECTS_FOCUS_ID;
    const resolvedFocusId = requestedFocusId && !focusAllProjects
      ? this.hiddenByCollapseHead.get(requestedFocusId) ?? requestedFocusId
      : undefined;
    if (this.options.initialCamera) {
      this.zoom = lineageClampedZoom(this.options.initialCamera.zoom);
      this.applyScale();
      this.centerPlanePoint({
        x: this.options.initialCamera.rawCenterX + this.canvasOffset.x,
        y: this.options.initialCamera.rawCenterY + this.canvasOffset.y,
      }, "auto", {
        x: this.options.initialCamera.rawCenterX,
        y: this.options.initialCamera.rawCenterY,
      });
    }
    const bounds = this.contentBounds();
    const focusedNode = resolvedFocusId
      ? this.nodeByEntity.get(resolvedFocusId)
      : undefined;
    const focusedPoint = focusedNode?.kind === "cycle"
      ? this.layout.get(focusedNode.entityId)
      : undefined;
    const focusedStageBox = focusedNode && focusedPoint
      ? lineageGraphBox(focusedNode, focusedPoint)
      : undefined;
    const focusedProjectBox = !focusedStageBox && resolvedFocusId
      ? this.projectContainerBox(resolvedFocusId)
      : undefined;
    const focusedBox = lineageRequestedFocusBox(
      requestedFocusId,
      focusedStageBox,
      focusedProjectBox,
      bounds,
    );
    if (!focusedBox && !requestedFocusId && this.options.initialCamera) return;
    const selected = !focusedBox && this.options.selectedProjectId
      ? this.projectContainerBox(this.options.selectedProjectId)
      : undefined;
    const center = {
      x: focusedBox
        ? focusedBox.x + focusedBox.width / 2
        : selected?.centerX ?? bounds.x + bounds.width / 2,
      y: focusedBox
        ? focusedBox.y + focusedBox.height / 2
        : selected?.centerY ?? bounds.y + bounds.height / 2,
    };
    const reducedMotion = typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const targetZoom = focusedProjectBox || focusAllProjects
      ? lineageFocusScale(
        this.viewport.clientWidth,
        this.viewport.clientHeight,
        focusedBox?.width ?? bounds.width,
        focusedBox?.height ?? bounds.height,
      )
      : this.zoom;
    if (focusedBox) {
      this.focusPlaneBox(
        focusedBox,
        targetZoom,
        lineageFocusBehavior(reducedMotion),
      );
    } else {
      this.centerPlanePoint(center, "auto");
    }
    if (requestedFocusId) this.options.onFocusApplied?.(requestedFocusId);
    if (focusedNode?.kind === "cycle") {
      const card = this.nodeLayer?.querySelector<HTMLElement>(
        `.helix-lineage-card[data-entity-id="${CSS.escape(focusedNode.entityId)}"]`,
      );
      card?.addClass("is-operation-focus");
      if (card) window.setTimeout(() => card.removeClass("is-operation-focus"), 1_600);
    } else if (resolvedFocusId) {
      const container = this.projectLayer?.querySelector<HTMLElement>(
        `.helix-lineage-project-container[data-project-id="${
          CSS.escape(resolvedFocusId)
        }"]`,
      );
      const header = this.projectHeaderLayer?.querySelector<HTMLElement>(
        `.helix-lineage-project-container-header[data-project-id="${
          CSS.escape(resolvedFocusId)
        }"]`,
      );
      container?.addClass("is-operation-focus");
      header?.addClass("is-operation-focus");
      if (container || header) {
        window.setTimeout(() => {
          container?.removeClass("is-operation-focus");
          header?.removeClass("is-operation-focus");
        }, 1_600);
      }
    }
  }

  private expandVirtualPlane(): void {
    const viewport = this.viewport;
    if (!viewport || this.destroyed || this.suppressVirtualExpansion) return;
    const {
      shiftX,
      shiftY,
      growRightBy,
      growBottomBy,
    } = lineageVirtualExpansionPlan(viewport, this.zoom);
    if (!shiftX && !shiftY && !growRightBy && !growBottomBy) return;
    const previousLeft = viewport.scrollLeft;
    const previousTop = viewport.scrollTop;
    this.applyViewportPlanGeometry({
      shiftX,
      shiftY,
      growRightBy,
      growBottomBy,
      left: 0,
      top: 0,
    });
    this.applyScale();
    if (shiftX || shiftY) {
      viewport.scrollLeft = previousLeft + shiftX * this.zoom;
      viewport.scrollTop = previousTop + shiftY * this.zoom;
    }
  }

  private projectFor(projectId: string): ProjectWorkspaceProject {
    const project = this.options.snapshot.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`找不到项目：${projectId}`);
    return project;
  }
}

function physicalEdgesFromSnapshot(
  snapshot: ProjectWorkspaceSnapshot,
): ProjectGraphEdge[] {
  return snapshot.relations.flatMap((relation) =>
    relation.fromCycleIds.map((fromCycleId, index) => ({
      id: relation.kind === "merge" ? `${relation.id}:${index}` : relation.id,
      fromCycleId,
      toCycleId: relation.toCycleId,
    })));
}

function cloneLayoutSnapshot(snapshot: LineageLayoutSnapshot): LineageLayoutSnapshot {
  return Object.fromEntries(Object.entries(snapshot).map(([entityId, point]) => [
    entityId,
    { ...point },
  ]));
}

function sameLineagePoint(left: LineagePoint, right: LineagePoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function sameLineageLayout(
  left: LineageLayoutSnapshot,
  right: LineageLayoutSnapshot,
): boolean {
  const leftIds = Object.keys(left);
  return leftIds.length === Object.keys(right).length && leftIds.every((id) =>
    right[id] !== undefined && sameLineagePoint(left[id]!, right[id]!));
}

function rebaseAddedLineageTargets(
  positions: LineageLayoutSnapshot,
  currentPositions: LineageLayoutSnapshot,
  addedIds: ReadonlySet<string>,
  relations: readonly CycleRelation[],
): void {
  for (const relation of relations) {
    if (!addedIds.has(relation.toCycleId)) continue;
    const currentTarget = currentPositions[relation.toCycleId];
    const currentSources = relation.fromCycleIds
      .map((id) => currentPositions[id])
      .filter((point): point is LineagePoint => point !== undefined);
    const nextSources = relation.fromCycleIds
      .map((id) => positions[id])
      .filter((point): point is LineagePoint => point !== undefined);
    if (!currentTarget || currentSources.length !== relation.fromCycleIds.length ||
      nextSources.length !== relation.fromCycleIds.length) continue;
    const currentRight = Math.max(...currentSources.map((point) => point.x));
    const nextRight = Math.max(...nextSources.map((point) => point.x));
    const currentAverageY = currentSources.reduce((sum, point) => sum + point.y, 0) /
      currentSources.length;
    const nextAverageY = nextSources.reduce((sum, point) => sum + point.y, 0) /
      nextSources.length;
    positions[relation.toCycleId] = {
      x: currentTarget.x + nextRight - currentRight,
      y: currentTarget.y + nextAverageY - currentAverageY,
    };
  }
}
