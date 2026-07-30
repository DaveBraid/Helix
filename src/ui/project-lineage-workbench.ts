import { setIcon } from "obsidian";
import {
  CYCLE_RELATION_LABELS,
  type CycleRelation,
} from "../domain/cycle-graph";
import type {
  ProjectWorkspaceCanvasNode,
  ProjectWorkspaceNodeMove,
  ProjectWorkspaceProject,
  ProjectWorkspaceSnapshot,
} from "../services/project-workspace";

export type ProjectLineageViewMode = "graph" | "cards" | "kanban";

interface Point {
  x: number;
  y: number;
}

interface WorkbenchOptions {
  snapshot: ProjectWorkspaceSnapshot;
  selectedProjectId: string;
  mode: ProjectLineageViewMode;
  onModeChange: (mode: ProjectLineageViewMode) => void;
  onSelectProject: (projectId: string) => void;
  onCreateProject: () => void;
  onCreateCycle: (projectId: string, sourceCycleIds: string[]) => void;
  onDeleteCycle: (cycleId: string) => void;
  onOpenNote: (path: string) => void;
  onMoveNodes: (moves: ProjectWorkspaceNodeMove[]) => Promise<void>;
  onManageRelation: (relationId: string) => void;
  onError: (error: unknown) => void;
}

const PADDING = 64;
const GRID_SIZE = 28;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

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

export class ProjectLineageWorkbench {
  private readonly layout = new Map<string, Point>();
  private readonly nodeByEntity = new Map<string, ProjectWorkspaceCanvasNode>();
  private readonly selected = new Set<string>();
  private readonly canvasOffset: Point;
  private readonly markerId = `helix-lineage-arrow-${crypto.randomUUID()}`;
  private zoom = 1;
  private viewport: HTMLElement | null = null;
  private plane: HTMLElement | null = null;
  private surface: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private nodeLayer: HTMLElement | null = null;
  private relationPanel: HTMLElement | null = null;
  private selectedRelationId: string | null = null;
  private width = 960;
  private height = 640;
  private pan:
    | { pointerId: number; x: number; y: number; left: number; top: number }
    | null = null;
  private spaceHeld = false;
  private destroyed = false;
  private movePending = false;
  private moveVersion = 0;

  constructor(private readonly options: WorkbenchOptions) {
    const minimumX = Math.min(0, ...options.snapshot.canvasNodes.map((node) => node.x));
    const minimumY = Math.min(0, ...options.snapshot.canvasNodes.map((node) => node.y));
    this.canvasOffset = {
      x: minimumX < PADDING ? PADDING - minimumX : 0,
      y: minimumY < PADDING ? PADDING - minimumY : 0,
    };
    for (const node of options.snapshot.canvasNodes) {
      this.nodeByEntity.set(node.entityId, node);
      this.layout.set(node.entityId, {
        x: node.x + this.canvasOffset.x,
        y: node.y + this.canvasOffset.y,
      });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.moveVersion += 1;
    this.selected.clear();
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
    const addProject = actions.createEl("button", {
      cls: "helix-secondary-button",
      text: "新建项目",
    });
    addProject.addEventListener("click", this.options.onCreateProject);
  }

  private renderProjectStrip(parent: HTMLElement): void {
    const strip = parent.createDiv({ cls: "helix-lineage-project-strip" });
    for (const project of this.options.snapshot.projects) {
      const button = strip.createEl("button", {
        cls: project.id === this.options.selectedProjectId ? "is-active" : "",
      });
      button.createSpan({ text: project.title });
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
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("helix-lineage-edges");
    surface.appendChild(svg);
    const layer = surface.createDiv({ cls: "helix-lineage-node-layer" });
    this.viewport = viewport;
    this.plane = plane;
    this.surface = surface;
    this.svg = svg;
    this.nodeLayer = layer;
    this.applyScale();
    this.renderEdges();
    for (const node of this.options.snapshot.canvasNodes) this.renderGraphCard(node);
    this.bindNavigation(viewport);
    this.renderZoomControls(root);
    this.relationPanel = root.createDiv({ cls: "helix-lineage-relation-panel" });
    this.updateRelationPanel();
  }

  private renderGraphCard(node: ProjectWorkspaceCanvasNode): void {
    if (!this.nodeLayer) return;
    const point = this.layout.get(node.entityId);
    if (!point) return;
    const card = this.nodeLayer.createDiv({
      cls: `helix-lineage-card is-${node.kind}${
        node.projectId === this.options.selectedProjectId ? " is-current-project" : ""
      }`,
      attr: {
        "data-entity-id": node.entityId,
        "aria-selected": "false",
      },
    });
    card.style.left = `${point.x}px`;
    card.style.top = `${point.y}px`;
    card.style.width = `${node.width}px`;
    card.style.height = `${node.height}px`;
    this.fillCard(card, node, true);
    if (node.kind === "cycle") this.renderCycleActions(card, node);
    let drag:
      | {
          pointerId: number;
          clientX: number;
          clientY: number;
          starts: Array<{ node: ProjectWorkspaceCanvasNode; el: HTMLElement; point: Point }>;
          moved: boolean;
        }
      | null = null;
    card.addEventListener("pointerdown", (event) => {
      if (this.destroyed || this.movePending || event.button !== 0 || this.spaceHeld) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button")) return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey || event.shiftKey) {
        if (this.selected.has(node.entityId)) this.selected.delete(node.entityId);
        else this.selected.add(node.entityId);
      } else if (!this.selected.has(node.entityId)) {
        this.selected.clear();
        this.selected.add(node.entityId);
      }
      this.updateSelection();
      const starts = [...this.selected].flatMap((entityId) => {
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
        return {
          nodeId: item.node.nodeId,
          x: next.x - this.canvasOffset.x,
          y: next.y - this.canvasOffset.y,
        };
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
        this.renderEdges();
        this.options.onError(error);
      });
    };
    card.addEventListener("pointerup", finish);
    card.addEventListener("pointercancel", finish);
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
      meta.createSpan({
        cls: `is-project is-${owner.status}`,
        text: projectStatusLabel(owner.status),
      });
      meta.createSpan({ text: `${owner.cycles.length} 个阶段` });
    } else {
      const cycle = owner.cycles.find((item) => item.id === node.entityId)!;
      meta.createSpan({
        cls: `is-${cycle.status}`,
        text: cycle.status === "active"
          ? "进行中"
          : cycle.status === "closed"
            ? "已关闭"
            : "计划中",
      });
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
      this.selected,
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
    for (const relation of this.options.snapshot.relations) {
      const target = this.layout.get(relation.toCycleId);
      const targetNode = this.nodeByEntity.get(relation.toCycleId);
      if (!target || !targetNode) continue;
      for (const sourceId of relation.fromCycleIds) {
        const source = this.layout.get(sourceId);
        const sourceNode = this.nodeByEntity.get(sourceId);
        if (!source || !sourceNode) continue;
        const start = {
          x: source.x + sourceNode.width,
          y: source.y + sourceNode.height / 2,
        };
        const end = {
          x: target.x,
          y: target.y + targetNode.height / 2,
        };
        const bend = Math.max(54, Math.abs(end.x - start.x) * 0.45);
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.classList.add(
          "helix-lineage-edge",
          `is-${relation.kind}`,
          ...(this.selectedRelationId === relation.id ? ["is-selected"] : []),
        );
        path.setAttribute("data-relation-id", relation.id);
        path.setAttribute("role", "button");
        path.setAttribute("tabindex", "0");
        path.setAttribute("aria-label", `管理${CYCLE_RELATION_LABELS[relation.kind]}关系`);
        path.setAttribute(
          "d",
          `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${
            end.x - bend
          } ${end.y}, ${end.x} ${end.y}`,
        );
        path.setAttribute("marker-end", `url(#${this.markerId}-${relation.kind})`);
        path.addEventListener("click", (event) => {
          event.stopPropagation();
          this.selectRelation(relation.id);
        });
        path.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          this.selectRelation(relation.id);
        });
        this.svg.appendChild(path);
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.classList.add(
          "helix-lineage-edge-label",
          `is-${relation.kind}`,
          ...(this.selectedRelationId === relation.id ? ["is-selected"] : []),
        );
        label.setAttribute("data-relation-id", relation.id);
        label.setAttribute("role", "button");
        label.setAttribute("tabindex", "0");
        label.setAttribute("aria-label", `管理${CYCLE_RELATION_LABELS[relation.kind]}关系`);
        label.setAttribute("x", String((start.x + end.x) / 2));
        label.setAttribute("y", String((start.y + end.y) / 2 - 10));
        label.textContent = CYCLE_RELATION_LABELS[relation.kind];
        label.addEventListener("click", (event) => {
          event.stopPropagation();
          this.selectRelation(relation.id);
        });
        label.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          this.selectRelation(relation.id);
        });
        this.svg.appendChild(label);
      }
    }
  }

  private renderCardGrid(parent: HTMLElement): void {
    const grid = parent.createDiv({ cls: "helix-lineage-grid" });
    for (const node of this.options.snapshot.canvasNodes) {
      const card = grid.createDiv({
        cls: `helix-lineage-card is-grid is-${node.kind}${
          node.projectId === this.options.selectedProjectId ? " is-current-project" : ""
        }`,
      });
      this.fillCard(card, node, false);
      if (node.kind === "cycle") this.renderCycleActions(card, node);
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
      const nodes = this.options.snapshot.canvasNodes.filter((node) => {
        if (node.kind !== "cycle") return false;
        const owner = this.projectFor(node.projectId);
        return owner.cycles.find((cycle) => cycle.id === node.entityId)?.status === status.id;
      });
      heading.createSpan({ text: String(nodes.length) });
      const list = column.createDiv({ cls: "helix-lineage-column-list" });
      for (const node of nodes) {
        const card = list.createDiv({ cls: "helix-lineage-card is-kanban is-cycle" });
        this.fillCard(card, node, false);
        this.renderCycleActions(card, node);
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
        for (const node of this.options.snapshot.canvasNodes) this.selected.add(node.entityId);
        this.updateSelection();
      } else if (event.key === "Escape") {
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
      this.setZoom(this.zoom * Math.exp(-event.deltaY * 0.002));
    }, { passive: false });
    viewport.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".helix-lineage-card, .helix-lineage-edge, .helix-lineage-edge-label, button")) {
        return;
      }
      if (event.button === 1 || (event.button === 0 && this.spaceHeld)) {
        this.pan = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: viewport.scrollLeft,
          top: viewport.scrollTop,
        };
        viewport.setPointerCapture(event.pointerId);
        viewport.addClass("is-panning");
      } else if (event.button === 0) {
        this.selected.clear();
        this.selectedRelationId = null;
        this.updateSelection();
        this.renderEdges();
        this.updateRelationPanel();
      }
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!this.pan || this.pan.pointerId !== event.pointerId) return;
      viewport.scrollLeft = this.pan.left - (event.clientX - this.pan.x);
      viewport.scrollTop = this.pan.top - (event.clientY - this.pan.y);
    });
    const finish = (event: PointerEvent): void => {
      if (!this.pan || this.pan.pointerId !== event.pointerId) return;
      this.pan = null;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      viewport.removeClass("is-panning");
    };
    viewport.addEventListener("pointerup", finish);
    viewport.addEventListener("pointercancel", finish);
  }

  private renderZoomControls(root: HTMLElement): void {
    const controls = root.createDiv({ cls: "helix-lineage-zoom" });
    const button = (icon: string, label: string, action: () => void): void => {
      const element = controls.createEl("button", { attr: { "aria-label": label, title: label } });
      setIcon(element, icon);
      element.addEventListener("click", action);
    };
    button("minus", "缩小", () => this.setZoom(this.zoom / 1.2));
    const label = controls.createEl("button", {
      cls: "helix-lineage-zoom-label",
      text: "100%",
      attr: { "aria-label": "重置缩放" },
    });
    label.addEventListener("click", () => this.setZoom(1));
    button("plus", "放大", () => this.setZoom(this.zoom * 1.2));
    button("maximize", "适应全部卡片", () => this.zoomToFit());
  }

  private setZoom(value: number): void {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    this.applyScale();
  }

  private zoomToFit(): void {
    if (!this.viewport) return;
    const scale = Math.min(
      1,
      (this.viewport.clientWidth - 48) / this.width,
      (this.viewport.clientHeight - 48) / this.height,
    );
    this.setZoom(scale);
    this.viewport.scrollTo({ left: 0, top: 0 });
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
    if (label) label.textContent = `${Math.round(this.zoom * 100)}%`;
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
    let width = 960;
    let height = 640;
    for (const [entityId, point] of this.layout) {
      const node = this.nodeByEntity.get(entityId);
      if (!node) continue;
      width = Math.max(width, point.x + node.width + PADDING);
      height = Math.max(height, point.y + node.height + PADDING);
    }
    return { width, height };
  }

  private ensureBounds(point: Point, node: ProjectWorkspaceCanvasNode): void {
    this.width = Math.max(this.width, point.x + node.width + PADDING);
    this.height = Math.max(this.height, point.y + node.height + PADDING);
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

  private projectFor(projectId: string): ProjectWorkspaceProject {
    const project = this.options.snapshot.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`找不到项目：${projectId}`);
    return project;
  }
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
