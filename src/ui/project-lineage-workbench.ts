import { setIcon } from "obsidian";
import {
  CYCLE_RELATION_LABELS,
  type CycleRelation,
} from "../domain/cycle-graph";
import {
  collapsedClosedComponents,
  projectedGraphIsAcyclic,
  type ProjectGraphEdge,
} from "../domain/project-graph";
import type {
  ProjectWorkspaceCanvasNode,
  ProjectWorkspaceNodeMove,
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

interface WorkbenchOptions {
  snapshot: ProjectWorkspaceSnapshot;
  selectedProjectId: string | null;
  focusEntityId?: string;
  initialCamera?: LineageCamera;
  onFocusApplied?: (entityId: string) => void;
  mode: ProjectLineageViewMode;
  onModeChange: (mode: ProjectLineageViewMode) => void;
  onSelectProject: (projectId: string | null) => void;
  onCreateProject: () => void;
  onCreateCycle: (projectId: string, sourceCycleIds: string[]) => void;
  onDeleteCycle: (cycleId: string) => void;
  onOpenNote: (path: string) => void;
  onMoveNodes: (moves: ProjectWorkspaceNodeMove[]) => Promise<void>;
  onManageRelation: (relationId: string) => void;
  onConnectCycles: (sourceCycleId: string, targetCycleId: string) => void;
  onChooseConnectionTarget: (
    sourceCycleId: string,
    allowedTargetIds: string[],
  ) => void;
  onEditProjectColor: (projectId: string, color: string) => void;
  onEditProjectStatus: (projectId: string) => void;
  onEditCycleStatus: (cycleId: string) => void;
  onToggleCompletedCollapse: (projectId: string, collapsed: boolean) => void;
  onExpandCompletedProjects: (projectIds: string[]) => void;
  onAutoLayout: () => void;
  onError: (error: unknown) => void;
}

const PADDING = 64;
const GRID_SIZE = 28;
const MAX_ZOOM = 1.2;
const MIN_FIT_ZOOM = 0.0001;
const GRAPH_CARD_WIDTH = 248;
const GRAPH_CARD_HEIGHT = 128;
const PROJECT_CONTAINER_SIDE_PADDING = 28;
const PROJECT_CONTAINER_TOP_PADDING = 58;
const PROJECT_CONTAINER_BOTTOM_PADDING = 28;
const VIRTUAL_MARGIN = 2400;
const VIRTUAL_EXPAND = 1800;
const VIEWPORT_SAFE_MARGIN = 400;
export const LINEAGE_ALL_PROJECTS_FOCUS_ID = "helix:all-projects";

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
  "blank" | "card" | "project-header" | "edge" | "button";

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
        .filter((cycle) => cycle.status === "closed")
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
  private readonly layout = new Map<string, LineagePoint>();
  private readonly nodeByEntity = new Map<string, ProjectWorkspaceCanvasNode>();
  private readonly selected = new Set<string>();
  private canvasOffset: LineagePoint;
  private readonly hiddenByCollapseHead = new Map<string, string>();
  private readonly collapseHeadByMember = new Map<string, string>();
  private readonly collapseCountByHead = new Map<string, number>();
  private readonly visibleStageIdsByProject = new Map<string, string[]>();
  private readonly markerId = `helix-lineage-arrow-${crypto.randomUUID()}`;
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
    this.moveVersion += 1;
    this.selected.clear();
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

  render(parent: HTMLElement): void {
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
    const selectedProject = this.options.snapshot.projects.find((project) =>
      project.id === this.options.selectedProjectId);
    const selectedCollapsed = selectedProject
      ? this.options.snapshot.collapsedCompletedProjectIds.includes(selectedProject.id)
      : false;
    if (
      this.options.mode !== "graph" &&
      selectedProject &&
      (selectedCollapsed || this.hasCollapsibleCompleted(selectedProject))
    ) {
      const collapsed = selectedCollapsed;
      const fold = actions.createEl("button", {
        cls: "helix-secondary-button",
        text: collapsed ? "展开已完成" : "折叠已完成",
      });
      fold.addEventListener("click", () =>
        this.options.onToggleCompletedCollapse(selectedProject.id, !collapsed));
    }
    const arrange = actions.createEl("button", {
      cls: "helix-secondary-button",
      text: "整理全部",
      attr: { title: "按项目泳道整理全部 Helix 卡片" },
    });
    arrange.addEventListener("click", this.options.onAutoLayout);
    const addProject = actions.createEl("button", {
      cls: "helix-secondary-button",
      text: "新建项目",
    });
    addProject.addEventListener("click", this.options.onCreateProject);
  }

  private renderProjectStrip(parent: HTMLElement): void {
    const strip = parent.createDiv({ cls: "helix-lineage-project-strip" });
    const allChoice = strip.createDiv({
      cls: `helix-lineage-project-choice is-all${
        this.options.selectedProjectId === null ? " is-active" : ""
      }`,
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
          "aria-label": `${project.title}，${projectStatusLabel(project.status)}，${
            project.cycles.filter((cycle) => cycle.status === "active").length
          } 个进行中阶段`,
        },
      });
      button.createSpan({ cls: "helix-lineage-project-name", text: project.title });
      button.createEl("small", {
        text: `${projectStatusLabel(project.status)} · ${
          project.cycles.filter((cycle) => cycle.status === "active").length
        } 个进行中阶段`,
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
      };
      card.setPointerCapture(event.pointerId);
    });
    card.addEventListener("pointermove", (event) => {
      if (this.destroyed || !drag || drag.pointerId !== event.pointerId) return;
      const dx = (event.clientX - drag.clientX) / this.zoom;
      const dy = (event.clientY - drag.clientY) / this.zoom;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      for (const item of drag.starts) {
        const next = {
          x: Math.max(16, item.point.x + dx),
          y: Math.max(16, item.point.y + dy),
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
      if (!completed.moved || this.destroyed || this.movePending) return;
      const moves = completed.starts.map((item) => {
        const next = this.layout.get(item.node.entityId)!;
        return lineageMovePayload(item.node, next, this.canvasOffset);
      });
      this.movePending = true;
      const moveVersion = ++this.moveVersion;
      void this.options.onMoveNodes(moves).then(() => {
        if (this.destroyed || moveVersion !== this.moveVersion) return;
        this.movePending = false;
      }).catch((error) => {
        if (this.destroyed || moveVersion !== this.moveVersion) return;
        this.movePending = false;
        for (const item of completed.starts) {
          this.layout.set(item.node.entityId, item.point);
          item.el.style.left = `${item.point.x}px`;
          item.el.style.top = `${item.point.y}px`;
        }
        this.updateProjectContainerGeometry(
          new Set(completed.starts.map((item) => item.node.projectId)),
        );
        this.renderEdges();
        this.options.onError(error);
      });
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
      const header = this.projectHeaderLayer.createDiv({
        cls: `helix-lineage-project-container-header${
          project.id === this.options.selectedProjectId ? " is-current-project" : ""
        }${this.options.selectedProjectId &&
          project.id !== this.options.selectedProjectId ? " is-other-project" : ""}`,
        attr: { "data-project-id": project.id },
      });
      header.style.setProperty("--helix-project-color", this.projectColor(project));
      this.applyProjectHeaderBox(header, box);
      const open = header.createEl("button", {
        cls: "helix-lineage-project-container-title",
        attr: { "aria-label": `打开项目 ${project.title}` },
      });
      open.createSpan({ cls: "helix-lineage-project-container-swatch" });
      open.createSpan({ text: project.title });
      open.addEventListener("click", () => this.options.onOpenNote(project.notePath));
      const status = header.createEl("button", {
        cls: `helix-lineage-project-container-status is-${project.status}`,
        text: projectStatusLabel(project.status),
        attr: {
          "aria-label": `修改 ${project.title} 的项目状态，当前${
            projectStatusLabel(project.status)
          }`,
          title: "修改项目状态",
        },
      });
      status.addEventListener("click", () => this.options.onEditProjectStatus(project.id));
      header.createSpan({
        cls: "helix-lineage-project-container-count",
        text: `${project.cycles.length} 阶段`,
      });
      const completedCount = project.cycles.filter((cycle) => cycle.status === "closed").length;
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
    }
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
        owner.cycles.find((cycle) => cycle.id === node.entityId)?.sequence ?? ""
      }`,
    });
    const open = top.createEl("button", {
      cls: "helix-lineage-card-title",
      text: node.title,
      attr: { "aria-label": `打开 ${node.title}` },
    });
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onOpenNote(node.notePath);
    });
    const meta = card.createDiv({ cls: "helix-lineage-card-meta" });
    if (node.kind === "project") {
      const status = meta.createEl("button", {
        cls: `helix-lineage-status-button is-project is-${owner.status}`,
        text: projectStatusLabel(owner.status),
        attr: {
          "aria-label": `修改 ${owner.title} 的项目状态，当前${
            projectStatusLabel(owner.status)
          }`,
          title: "修改项目状态",
        },
      });
      status.addEventListener("click", (event) => {
        event.stopPropagation();
        this.options.onEditProjectStatus(owner.id);
      });
      meta.createSpan({ text: `${owner.cycles.length} 个阶段` });
    } else {
      const cycle = owner.cycles.find((item) => item.id === node.entityId)!;
      const status = meta.createEl("button", {
        cls: `helix-lineage-status-button is-${cycle.status}`,
        text: cycle.status === "active"
          ? "进行中"
          : cycle.status === "closed"
            ? "已完成"
            : "计划中",
        attr: {
          "aria-label": `修改 ${cycle.title} 的阶段状态，当前${
            cycle.status === "active"
              ? "进行中"
              : cycle.status === "closed"
                ? "已完成"
                : "计划中"
          }`,
          title: "修改阶段状态",
        },
      });
      status.addEventListener("click", (event) => {
        event.stopPropagation();
        this.options.onEditCycleStatus(cycle.id);
      });
      if (cycle.status === "closed") {
        const check = status.createSpan({ cls: "helix-lineage-complete-check" });
        setIcon(check, "circle-check-big");
      }
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

  private renderCycleActions(
    card: HTMLElement,
    node: ProjectWorkspaceCanvasNode,
  ): void {
    const add = card.createEl("button", {
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
    const connector = card.createEl("button", {
      cls: "helix-lineage-connector",
      attr: {
        "aria-label": `从 ${node.title} 连接到已有阶段`,
        title: "拖到另一阶段建立连接；点击可选择目标",
      },
    });
    setIcon(connector, "git-branch");
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
    const remove = card.createEl("button", {
      cls: "helix-lineage-delete-node",
      attr: {
        "aria-label": `删除阶段 ${node.title}`,
        title: "删除阶段",
      },
    });
    setIcon(remove, "trash-2");
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
        path.setAttribute("role", "button");
        path.setAttribute("tabindex", "0");
        path.setAttribute(
          "aria-label",
          item.aggregate
            ? `展开后查看 ${item.count} 条聚合关系`
            : `管理${CYCLE_RELATION_LABELS[relation.kind]}关系`,
        );
        path.setAttribute(
          "d",
          `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${
            end.x - bend
          } ${end.y}, ${end.x} ${end.y}`,
        );
        path.setAttribute("marker-end", `url(#${this.markerId}-${relation.kind})`);
        path.addEventListener("click", (event) => {
          event.stopPropagation();
          if (item.aggregate) this.expandProjectedRelation(item.foldedProjectIds);
          else this.selectRelation(relation.id);
        });
        path.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          if (item.aggregate) this.expandProjectedRelation(item.foldedProjectIds);
          else this.selectRelation(relation.id);
        });
        this.svg.appendChild(path);
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.classList.add(
          "helix-lineage-edge-label",
          `is-${relation.kind}`,
          ...(this.selectedRelationId === relation.id ? ["is-selected"] : []),
          ...(this.isProjectedEdgeOutsideSelection(item.sourceId, item.targetId)
            ? ["is-other-project"]
            : []),
        );
        label.setAttribute("data-relation-id", item.aggregate ? "" : relation.id);
        label.setAttribute("role", "button");
        label.setAttribute("tabindex", "0");
        label.setAttribute(
          "aria-label",
          item.aggregate
            ? `展开后查看 ${item.count} 条聚合关系`
            : `管理${CYCLE_RELATION_LABELS[relation.kind]}关系`,
        );
        label.setAttribute("x", String((start.x + end.x) / 2));
        label.setAttribute("y", String((start.y + end.y) / 2 - 10));
        label.textContent = `${CYCLE_RELATION_LABELS[relation.kind]}${
          item.aggregate && item.count > 1 ? ` ×${item.count}` : ""
        }`;
        label.addEventListener("click", (event) => {
          event.stopPropagation();
          if (item.aggregate) this.expandProjectedRelation(item.foldedProjectIds);
          else this.selectRelation(relation.id);
        });
        label.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          if (item.aggregate) this.expandProjectedRelation(item.foldedProjectIds);
          else this.selectRelation(relation.id);
        });
        this.svg.appendChild(label);
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
    for (const status of [
      { id: "planned" as const, label: "计划中" },
      { id: "active" as const, label: "进行中" },
      { id: "closed" as const, label: "已关闭" },
    ]) {
      const column = board.createDiv({ cls: `helix-lineage-column is-${status.id}` });
      const heading = column.createDiv({ cls: "helix-lineage-column-heading" });
      heading.createEl("h3", { text: status.label });
      const nodes = this.visibleNodes().filter((node) => {
        if (node.kind !== "cycle") return false;
        if (
          this.options.selectedProjectId &&
          node.projectId !== this.options.selectedProjectId
        ) return false;
        const owner = this.projectFor(node.projectId);
        return owner.cycles.find((cycle) => cycle.id === node.entityId)?.status === status.id;
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
        card.addEventListener("click", () => this.options.onOpenNote(node.notePath));
      }
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
    viewport.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const surface: LineagePointerSurface = target?.closest("button")
        ? "button"
        : target?.closest(".helix-lineage-edge, .helix-lineage-edge-label")
          ? "edge"
          : target?.closest(".helix-lineage-card")
            ? "card"
            : target?.closest(".helix-lineage-project-container-header")
              ? "project-header"
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

function projectStatusLabel(status: ProjectWorkspaceProject["status"]): string {
  return {
    planned: "计划中",
    active: "进行中",
    paused: "已暂停",
    completed: "已完成",
    archived: "已归档",
  }[status];
}
