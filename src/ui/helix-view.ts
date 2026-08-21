import {
  ItemView,
  Menu,
  Modal,
  Notice,
  Setting,
  WorkspaceLeaf,
  setIcon,
  type IconName,
} from "obsidian";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { DidaProject, DidaTask } from "../domain/entities";
import type {
  TaskDetailAdapter,
  TaskDetailCapabilities,
  TaskDetailDraft,
  TaskDetailPriority,
  TaskDetailStatus,
  TaskDetailSubtaskDraft,
} from "../domain/task-detail";
import {
  commitInlineTaskTitle,
  inlineTaskTitleKeyIntent,
  TaskSubmissionGate,
} from "../domain/task-interactions";
import {
  commitTaskBoardMove,
  taskBoardColumnLabels,
  taskBoardDropTarget,
  taskBoardKeyboardTarget,
  taskBoardMoveAvailability,
} from "../domain/task-board-move";
import { CYCLE_RELATION_LABELS } from "../domain/cycle-graph";
import {
  WORKBENCH_NAVIGATION,
  type WorkbenchSection,
} from "../domain/workbench-navigation";
import type { HelixEvent } from "../domain/events";
import { aggregateAnalytics } from "../domain/analytics";
import { localDateKey, localDateKeyFromInstant } from "../domain/local-date";
import {
  challengeClaimed,
  challengeContributions,
  challengeProgress,
  deriveProgress,
  rotatingChallenges,
  type ChallengeDefinition,
} from "../domain/gamification";
import {
  buildYearHeatmap,
  type HeatmapMetric,
} from "../domain/month-heatmap";
import {
  assertTimeZone,
  instantToWallDateTime,
  wallDateTimeToInstant,
} from "../domain/task-datetime";
import { sideBySideTextDiff } from "../domain/text-diff";
import {
  taskScheduleEditorMode,
  taskScheduleForSubmission,
  type TaskScheduleMode,
} from "../domain/task-schedule";
import { taskEditWriteFields } from "../domain/task-edit-fields";
import {
  applyTaskQuickSuggestion,
  parseTaskQuickEntry,
  shouldSubmitTaskQuickEntryOnKey,
  taskQuickSuggestions,
  type TaskQuickSuggestion,
} from "../domain/task-quick-entry";
import {
  buildTaskBoard,
  buildTaskDateRange,
  buildTaskMatrix,
  buildTaskTimeBlocks,
  buildTaskYearSummary,
  filterTaskCollection,
  groupTasksByViewDay,
  todayOpenTasks,
  type TaskCollectionFilters,
  type TaskDateRange,
  type TaskMatrixRules,
  type TaskViewMode,
} from "../domain/task-views";
import { homeGreeting } from "../domain/home-dashboard";
import {
  canReparentTask,
  completionLast,
  flattenTaskTree,
  isTaskCompleted,
  type TaskTreeRow,
  withTaskDescendants,
} from "../domain/task-tree";
import { stableHash } from "../domain/stable";
import { requestStageBoardStatusChange } from "../domain/stage-board";
import type {
  ProjectionProjectReadModel,
} from "../services/dida-project-projection";
import type { ProjectionActionState } from "../domain/dida-project-projection";
import {
  localProjectTaskPresentationTasks,
  type LocalProjectTask,
  type LocalProjectTaskDraft,
  type LocalProjectTaskSnapshot,
  type LocalProjectStageTaskParent,
} from "../services/local-project-tasks";
import type {
  DidaProjectViewModeSyncStatus,
  HelixRuntimeState,
} from "../services/helix-service";
import { HelixService, isProjectionQueueOperation } from "../services/helix-service";
import {
  canSilentlyRepairProjectCanvas,
  type ProjectConnectionPlan,
  type ProjectWorkspaceCycleStatusUpdatePlan,
  type ProjectWorkspaceCycleStatus,
  type ProjectWorkspaceFocusConflict,
  type ProjectWorkspaceNativeRelationAdoptionPlan,
  type ProjectWorkspaceNativeRelationCandidate,
  type ProjectWorkspaceProject,
  type ProjectWorkspaceProjectStatusUpdatePlan,
  type ProjectWorkspaceProjectStatus,
  type ProjectWorkspaceService,
  type ProjectWorkspaceSnapshot,
} from "../services/project-workspace";
import { HelixDataStore } from "../storage/data-store";
import type { ConflictField, ResolutionAuditEntry, ResolutionChoice, SyncConflict } from "../sync/types";
import { analyticsChartSeries } from "./chart-series";
import { inProgressPresentation } from "./in-progress-presentation";
import { UnifiedTaskDetailModal } from "./unified-task-detail-modal";
import {
  LINEAGE_ALL_PROJECTS_FOCUS_ID,
  ProjectLineageWorkbench,
  type LineageCamera,
  type LineageLayoutDraft,
  type ProjectLineageViewMode,
} from "./project-lineage-workbench";
import {
  ProjectionUiActionCoordinator,
  conflictCenterIsEmpty,
  loadProjectionConflictModels,
} from "./project-projection-presenter";
import {
  DIDA_READ_AVAILABLE,
  DIDA_TASK_WRITE_AVAILABLE,
  PROJECT_DIDA_PROJECTION_AVAILABLE,
} from "../release-capabilities";

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export const HELIX_VIEW_TYPE = "helix-productivity-workbench";
type Section = WorkbenchSection;

const NAV_ICONS: Record<Section, IconName> = {
  today: "sun",
  projects: "folder-kanban",
  tasks: "circle-check-big",
  reviews: "notebook-pen",
  challenges: "trophy",
  conflicts: "git-compare-arrows",
};

const NAV: Array<{ id: Section; label: string; icon: IconName }> = WORKBENCH_NAVIGATION
  .map((item) => ({ ...item, icon: NAV_ICONS[item.id] }));

export const PROJECT_STATUS_OPTIONS: Array<{
  value: ProjectWorkspaceProjectStatus;
  label: string;
}> = [
  { value: "planned", label: "计划中" },
  { value: "active", label: "进行中" },
  { value: "paused", label: "已暂停" },
  { value: "completed", label: "已完成" },
  { value: "terminated", label: "已终止" },
];

export const CYCLE_STATUS_OPTIONS: Array<{
  value: ProjectWorkspaceCycleStatus;
  label: string;
}> = [
  { value: "idea", label: "想法" },
  { value: "active", label: "进行中" },
  { value: "completed", label: "已完成" },
  { value: "paused", label: "已暂停" },
  { value: "terminated", label: "已终止" },
];

const SAMPLE_PROJECTS: DidaProject[] = [
  { id: "sample-a", name: "强化学习论文实验", color: "#3659d9" },
  { id: "sample-b", name: "Helix 产品设计", color: "#26a17b" },
  { id: "sample-c", name: "研究方法课程", color: "#e29b3c" },
];

const sampleInstant = (hour: number, minute = 0): string => {
  const value = new Date();
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
};

const SAMPLE_TASKS: DidaTask[] = [
  { id: "sample-1", projectId: "sample-a", title: "复现实验基线并核对指标", status: 0, priority: 5, startDate: sampleInstant(9), dueDate: sampleInstant(10, 30), tags: ["科研", "实验"] },
  { id: "sample-2", projectId: "sample-b", title: "整理冲突合并真值表", status: 0, priority: 3, startDate: sampleInstant(10), dueDate: sampleInstant(11), tags: ["Helix"] },
  { id: "sample-3", projectId: "sample-c", title: "完成本周阅读笔记", status: 0, priority: 1, dueDate: sampleInstant(14), tags: ["阅读"] },
  { id: "sample-4", projectId: "sample-a", title: "补充消融实验计划", status: 0, priority: 3, startDate: sampleInstant(15), dueDate: sampleInstant(16, 30), tags: ["科研", "实验"] },
];

export class HelixView extends ItemView {
  private section: Section = "today";
  private expandedInProgress = false;
  private taskFilter: "all" | ProjectionActionState = "all";
  private hideCompletedTasks = false;
  private taskViewMode: TaskViewMode = "list";
  private taskViewModeSyncStatus: DidaProjectViewModeSyncStatus | null = null;
  private taskViewModeSyncingProjectId: string | null = null;
  private taskViewDate = new Date();
  private taskCollectionFilters: TaskCollectionFilters = { date: "all" };
  private advancedTaskFiltersExpanded = false;
  private taskSearchTimer: number | null = null;
  private selectedProjectId: string | null | undefined;
  private projectLineageMode: ProjectLineageViewMode = "graph";
  private projectWorkbench: ProjectLineageWorkbench | null = null;
  private lastGoodProjectWorkspace: ProjectWorkspaceSnapshot | null = null;
  private localProjectTaskSnapshot: LocalProjectTaskSnapshot | null = null;
  private lineageCamera: LineageCamera | undefined;
  private lineageLayoutDraft: LineageLayoutDraft | undefined;
  private lineageFocusRequest: { entityId: string; generation: number } | null = null;
  private pendingKanbanArrivalCycleId: string | null = null;
  private viewGeneration = 0;
  private closed = true;
  private renderToken = 0;
  private heatmapMetric: HeatmapMetric = "tasks";
  private heatmapMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  private previewProjects = SAMPLE_PROJECTS.map((project) => ({ ...project }));
  private previewTasks = SAMPLE_TASKS.map((task) => ({ ...task }));
  private previewInProgress = new Set(SAMPLE_TASKS.map((task) => task.id));
  private state: HelixRuntimeState | null = null;
  private unsubscribe: (() => void) | null = null;
  private renderPendingWhileInactive = false;
  private renderPendingWhileProjectPopover = false;
  private serviceRenderFrame: number | null = null;
  private lastServicePresentationSignature: string | null = null;
  private committedSection: Section | null = null;
  private charts: echarts.ECharts[] = [];
  private chartObservers: ResizeObserver[] = [];
  private taskBoardDrag: { taskId: string; sourceColumnId?: string | null } | null = null;
  private taskTreeDrag: { taskId: string } | null = null;
  private taskTreeSource: DidaTask[] = [];
  private readonly collapsedTaskTreeIds = new Set<string>();
  private readonly taskTreeRows = new Map<string, { element: HTMLElement; signature: string }>();
  private focusBridgeConflictCount = 0;
  private conflictSearch = "";
  private conflictTypeFilter: "all" | "project" | "task" | "focus" = "all";
  private selectedConflictCenterItemId: string | null = null;
  private readonly selectedConflictCenterItemIds = new Set<string>();
  private conflictDiffMode: "split" | "unified" = "split";
  private readonly projectionUiActions = new ProjectionUiActionCoordinator();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly service: HelixService,
    private readonly store: HelixDataStore,
    private readonly actions: {
      openReview: (period: "daily" | "weekly" | "monthly" | "yearly") => Promise<void>;
      createProject: (onCreated?: (projectId: string) => void) => void;
      createCycle: (
        projectId: string,
        sourceCycleIds: string[],
        onCreated?: (cycleId: string) => void,
      ) => void;
      insertCycle: (
        relationId: string,
        sourceCycleId: string,
        targetCycleId: string,
        projectId: string,
        onCreated?: (cycleId: string) => void,
      ) => void;
      deleteCycle: (cycleId: string, onDeleted?: (focusEntityId: string) => void) => void;
      deleteProject: (projectId: string, onDeleted?: () => void) => void;
      renameProject: (
        projectId: string,
        currentTitle: string,
        currentColor: string,
        onRenamed?: () => void,
      ) => void;
      renameCycle: (
        cycleId: string,
        currentTitle: string,
        onRenamed?: () => void,
      ) => void;
      manageRelation: (
        relationId: string,
        onChanged?: (focusEntityId: string) => void,
      ) => void;
      openProjectFile: (path: string) => Promise<void>;
      projectWorkspace: ProjectWorkspaceService;
      readLocalProjectTasks: () => Promise<LocalProjectTaskSnapshot>;
      createLocalProjectTask: (input: {
        projectId: string;
        stageId: string;
        title: string;
        parentUuid?: string;
      }) => Promise<string>;
      updateLocalProjectTask: (input: {
        projectId: string;
        stageId: string;
        uuid: string;
        expectedHash: string;
        title?: string;
        state?: ProjectionActionState;
      }) => Promise<void>;
      saveLocalProjectTask: (input: {
        projectId: string;
        stageId: string;
        uuid: string;
        expectedHash: string;
        draft: LocalProjectTaskDraft;
      }) => Promise<void>;
      deleteLocalProjectTask: (input: {
        projectId: string;
        stageId: string;
        uuid: string;
        expectedHash: string;
      }) => Promise<void>;
      readFocusBridgeConflictCount: () => number;
      readProjectViewRevision: () => number;
      readProjectWorkspace: <T>(operation: () => Promise<T>) => Promise<T>;
      mutateProjectWorkspace: <T>(operation: () => Promise<T>) => Promise<T>;
      repairProjectCanvas: () => Promise<void>;
      updateProjectStatus: (
        plan: ProjectWorkspaceProjectStatusUpdatePlan,
        status: ProjectWorkspaceProjectStatus,
      ) => Promise<void>;
      updateCycleStatus: (
        plan: ProjectWorkspaceCycleStatusUpdatePlan,
        status: ProjectWorkspaceCycleStatus,
      ) => Promise<void>;
      reviewLegacyMigration: () => void;
      getTaskMatrixRules: () => TaskMatrixRules;
      updateTaskMatrixRules: (rules: TaskMatrixRules) => Promise<void>;
      readProjectProjection: (projectId: string) => Promise<ProjectionProjectReadModel>;
      reconcileProjectProjectionFrozen: (input:
        | { kind: "action"; projectId: string; stageId: string; uuid: string }
        | { kind: "parent"; projectId: string; stageId: string }) => Promise<void>;
      recoverPendingProjectProjectionReceiptCleanup: () => Promise<void>;
      removeResolvedProjectProjectionReceipt: (operationId: string) => Promise<void>;
      reconcileProjectProjectionColumn: () => Promise<void>;
    },
  ) {
    super(leaf);
  }

  getViewType(): string {
    return HELIX_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Helix";
  }

  getIcon(): IconName {
    return "orbit";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.viewGeneration += 1;
    this.contentEl.addClass("helix-root");
    this.unsubscribe = this.service.subscribe((state) => {
      const signature = stableHash({
        state,
        projectViewRevision: this.actions.readProjectViewRevision(),
        focusBridgeConflictCount: this.actions.readFocusBridgeConflictCount(),
      });
      if (signature === this.lastServicePresentationSignature) return;
      this.lastServicePresentationSignature = signature;
      this.state = state;
      if (this.app.workspace.activeLeaf === this.leaf) {
        this.renderPendingWhileInactive = false;
        this.requestServiceRender();
      } else {
        this.renderPendingWhileInactive = true;
      }
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf !== this.leaf || !this.renderPendingWhileInactive) return;
      this.renderPendingWhileInactive = false;
      this.requestServiceRender();
    }));
    // 工作区恢复时 active-leaf-change 可能早于 ItemView.onOpen；下一帧补一次
    // 当前叶子检查，避免活动的 Helix 标签永远停在空白页。
    const ownerWindow = this.containerEl.ownerDocument.defaultView ?? window;
    ownerWindow.requestAnimationFrame(() => {
      if (this.closed || this.app.workspace.activeLeaf !== this.leaf ||
          !this.renderPendingWhileInactive) return;
      this.renderPendingWhileInactive = false;
      this.requestServiceRender();
    });
  }

  private requestServiceRender(): void {
    if (this.closed || this.serviceRenderFrame !== null) return;
    if (this.section === "projects" && this.projectWorkbench?.hasOpenStatusPopover()) {
      this.renderPendingWhileProjectPopover = true;
      return;
    }
    const ownerWindow = this.containerEl.ownerDocument.defaultView ?? window;
    this.serviceRenderFrame = ownerWindow.requestAnimationFrame(() => {
      this.serviceRenderFrame = null;
      if (this.closed || this.app.workspace.activeLeaf !== this.leaf) {
        this.renderPendingWhileInactive = true;
        return;
      }
      void this.render();
    });
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.renderPendingWhileInactive = false;
    this.lastServicePresentationSignature = null;
    this.viewGeneration += 1;
    this.renderToken += 1;
    if (this.serviceRenderFrame !== null) {
      const ownerWindow = this.containerEl.ownerDocument.defaultView ?? window;
      ownerWindow.cancelAnimationFrame(this.serviceRenderFrame);
      this.serviceRenderFrame = null;
    }
    this.unsubscribe?.();
    if (this.taskSearchTimer !== null) {
      window.clearTimeout(this.taskSearchTimer);
      this.taskSearchTimer = null;
    }
    this.lineageFocusRequest = null;
    this.pendingKanbanArrivalCycleId = null;
    this.lineageCamera = undefined;
    this.projectWorkbench?.destroy();
    this.projectWorkbench = null;
    this.taskTreeDrag = null;
    this.taskTreeSource = [];
    this.taskTreeRows.clear();
    this.disposeCharts();
  }

  private async render(): Promise<void> {
    if (!this.state || this.closed) return;
    const token = ++this.renderToken;
    this.focusBridgeConflictCount = this.actions.readFocusBridgeConflictCount();
    await this.refreshLocalProjectTaskSnapshot(token);
    if (token !== this.renderToken || this.closed) return;
    if (this.section === "projects") {
      this.lineageCamera = this.projectWorkbench?.camera() ?? this.lineageCamera;
      if (this.projectWorkbench) this.lineageLayoutDraft = this.projectWorkbench.layoutDraft();
      const previousWorkbench = this.projectWorkbench;
      const shell = this.contentEl.ownerDocument.createElement("div");
      shell.addClass("helix-shell");
      this.renderSidebar(shell);
      const main = shell.createDiv({ cls: "helix-main" });
      this.renderHeader(main);
      const content = main.createDiv({ cls: "helix-content" });
      const nextWorkbench = await this.renderProjects(content, token);
      if (token !== this.renderToken || this.closed) {
        nextWorkbench?.destroy();
        return;
      }
      previousWorkbench?.destroy();
      this.projectWorkbench = nextWorkbench;
      this.disposeCharts();
      this.contentEl.replaceChildren(shell);
      this.committedSection = this.section;
      return;
    }
    const previousWorkbench = this.projectWorkbench;
    const previousContent = this.contentEl.querySelector<HTMLElement>(".helix-content");
    const preserveScroll = this.committedSection === this.section;
    const previousScrollTop = preserveScroll ? previousContent?.scrollTop ?? 0 : 0;
    const previousScrollLeft = preserveScroll ? previousContent?.scrollLeft ?? 0 : 0;
    // 复盘页需要在已挂载节点内初始化 ECharts；其他页面先离屏完整构建，
    // 异步读取期间继续显示旧页面，完成后一次替换，避免短暂空白闪烁。
    const atomic = this.section !== "reviews";
    if (!atomic) {
      previousWorkbench?.destroy();
      this.projectWorkbench = null;
      this.disposeCharts();
      this.contentEl.empty();
    }
    const shell = atomic
      ? this.contentEl.ownerDocument.createElement("div")
      : this.contentEl.createDiv({ cls: "helix-shell" });
    if (atomic) shell.addClass("helix-shell");
    this.renderSidebar(shell);
    const main = shell.createDiv({ cls: "helix-main" });
    this.renderHeader(main);
    const content = main.createDiv({ cls: "helix-content" });
    if (this.section === "today") await this.renderToday(content, token);
    else if (this.section === "tasks") await this.renderTasks(content, token);
    else if (this.section === "reviews") this.renderReviews(content);
    else if (this.section === "challenges") this.renderChallenges(content);
    else await this.renderConflicts(content, token);
    if (token !== this.renderToken || this.closed) return;
    if (atomic) {
      previousWorkbench?.destroy();
      this.projectWorkbench = null;
      this.disposeCharts();
      this.contentEl.replaceChildren(shell);
      content.scrollTop = previousScrollTop;
      content.scrollLeft = previousScrollLeft;
    }
    this.committedSection = this.section;
  }

  private renderSidebar(shell: HTMLElement): void {
    const sidebar = shell.createDiv({ cls: "helix-sidebar" });
    const brand = sidebar.createDiv({ cls: "helix-brand" });
    const mark = brand.createSpan({ cls: "helix-brand-mark" });
    setIcon(mark, "orbit");
    brand.createSpan({ text: "HELIX" });
    const nav = sidebar.createDiv({ cls: "helix-nav" });
    for (const item of NAV) {
      const button = nav.createEl("button", {
        cls: `helix-nav-item${this.section === item.id ? " is-active" : ""}`,
        attr: { "aria-label": item.label },
      });
      const icon = button.createSpan();
      setIcon(icon, item.icon);
      button.createSpan({ text: item.label });
      if (item.id === "conflicts") {
        const count = (this.state?.attentionCount ?? 0) + this.focusBridgeConflictCount;
        if (count > 0) button.createSpan({ cls: "helix-nav-badge", text: String(count) });
      }
      button.addEventListener("click", () => {
        this.section = item.id;
        void this.render();
      });
    }
    const showDemoSidebar = DIDA_READ_AVAILABLE && this.state?.demoMode &&
      (this.localProjectTaskSnapshot?.destinations.length ?? 0) === 0;
    const sidebarProjects = showDemoSidebar
      ? this.previewProjects
      : DIDA_READ_AVAILABLE ? (this.state?.projects ?? []) : [];
    const sidebarRemoteTasks = showDemoSidebar
      ? this.previewTasks
      : DIDA_READ_AVAILABLE ? (this.state?.tasks ?? []) : [];
    const sidebarTasks = mergeProjectTaskCollections(
      sidebarRemoteTasks,
      this.localProjectTaskDidaTasks(),
    );
    const projectSection = sidebar.createDiv({ cls: "helix-sidebar-lists" });
    const projectHeading = projectSection.createDiv({ cls: "helix-sidebar-lists-head" });
    projectHeading.createSpan({ text: "清单" });
    const listHeadActions = projectHeading.createDiv({ cls: "helix-sidebar-lists-actions" });
    listHeadActions.createSpan({ text: String(sidebarProjects.length) });
    if (DIDA_TASK_WRITE_AVAILABLE && (this.state?.connected || showDemoSidebar)) {
      const addList = listHeadActions.createEl("button", { attr: { "aria-label": "创建清单" } });
      setIcon(addList, "plus");
      addList.addEventListener("click", () => this.openCreateDidaProjectModal());
    }
    const allLists = projectSection.createEl("button", {
      cls: `helix-sidebar-list${this.section === "tasks" && !this.taskCollectionFilters.didaProjectId ? " is-active" : ""}`,
      attr: {
        "aria-label": "显示全部清单中的任务",
        "aria-current": this.section === "tasks" && !this.taskCollectionFilters.didaProjectId
          ? "page"
          : "false",
      },
    });
    const allIcon = allLists.createSpan({ cls: "helix-sidebar-list-icon" });
    setIcon(allIcon, "inbox");
    allLists.createSpan({ cls: "helix-sidebar-list-name", text: "全部任务" });
    allLists.createSpan({
      cls: "helix-sidebar-list-count",
      text: String(sidebarTasks.filter((task) => task.status !== 2).length),
    });
    allLists.addEventListener("click", () => {
      this.section = "tasks";
      this.taskCollectionFilters.didaProjectId = undefined;
      if (this.taskViewMode === "kanban") this.taskViewMode = "list";
      void this.render();
    });
    for (const project of sidebarProjects) {
      const button = projectSection.createEl("button", {
        cls: `helix-sidebar-list${this.section === "tasks" && this.taskCollectionFilters.didaProjectId === project.id ? " is-active" : ""}`,
        attr: {
          "aria-label": project.id.startsWith("local-project-")
            ? `筛选待核对清单 ${project.name}`
            : `筛选清单 ${project.name}`,
          "aria-current": this.section === "tasks" && this.taskCollectionFilters.didaProjectId === project.id
            ? "page"
            : "false",
        },
      });
      const dot = button.createSpan({ cls: "helix-project-dot" });
      dot.style.backgroundColor = project.color ?? "#5268d4";
      button.createSpan({ cls: "helix-sidebar-list-name", text: project.name });
      if (project.id.startsWith("local-project-")) {
        button.createSpan({ cls: "helix-sidebar-list-pending", text: "待核对" });
      }
      button.createSpan({
        cls: "helix-sidebar-list-count",
        text: String(sidebarTasks.filter((task) => task.projectId === project.id && task.status !== 2).length),
      });
      button.addEventListener("click", () => {
        this.section = "tasks";
        this.taskCollectionFilters.didaProjectId = project.id;
        this.taskViewMode = project.viewMode === "kanban" ? "kanban" : "list";
        void this.render();
      });
    }
    const foot = sidebar.createDiv({ cls: "helix-sidebar-foot" });
    const progress = deriveProgress(this.state?.events ?? []);
    foot.createDiv({ cls: "helix-level-label", text: `LEVEL ${progress.level}` });
    const meter = foot.createDiv({ cls: "helix-level-meter" });
    const fill = meter.createDiv({ cls: "helix-level-fill" });
    const ratio = progress.nextLevelXp > 0
      ? Math.min(100, Math.round((progress.currentLevelXp / progress.nextLevelXp) * 100))
      : 0;
    fill.style.width = `${ratio}%`;
    foot.createDiv({
      cls: "helix-level-copy",
      text: `${progress.currentLevelXp} / ${progress.nextLevelXp} XP`,
    });
  }

  private renderHeader(main: HTMLElement): void {
    const header = main.createDiv({ cls: "helix-header" });
    const title = NAV.find((item) => item.id === this.section)?.label ?? "Helix";
    header.createEl("h1", { text: title });
    const actions = header.createDiv({ cls: "helix-header-actions" });
    const status = actions.createDiv({
      cls: `helix-sync-status ${DIDA_READ_AVAILABLE && this.state?.connected ? "is-online" : "is-offline"}`,
      attr: {
        title: this.state?.syncWarnings.join("；") || this.state?.error || "",
      },
    });
    status.createSpan();
    status.createSpan({
      text: !DIDA_READ_AVAILABLE
        ? "本地模式"
        : this.state?.loading
        ? "正在同步"
        : this.state?.connected
        ? this.state.syncWarnings.length > 0
          ? "滴答已连接 · 部分数据暂不可用"
          : "滴答已连接"
        : (this.localProjectTaskSnapshot?.destinations.length ?? 0) > 0
          ? "本地模式"
        : this.state?.demoMode
          ? "演示数据"
          : this.state?.authorizationConfigured
            ? this.state?.error
              ? this.state?.lastSyncAt
                ? "同步失败 · 显示缓存"
                : "同步失败"
              : this.state?.lastSyncAt
                ? "离线缓存"
                : "等待首次同步"
            : "未配置滴答",
    });
    if (!DIDA_READ_AVAILABLE) return;
    const sync = actions.createEl("button", {
      cls: "helix-icon-button",
      attr: { "aria-label": "立即同步", title: "立即同步" },
    });
    setIcon(sync, "refresh-cw");
    if (this.state?.loading) sync.addClass("is-spinning");
    sync.disabled = !this.state?.authorizationConfigured || Boolean(this.state?.loading);
    sync.addEventListener("click", () => {
      void this.service.sync().catch((error) => this.service.notifySyncError(error));
    });
  }

  private openCreateDidaProjectModal(): void {
    if (!DIDA_TASK_WRITE_AVAILABLE) return;
    new DidaProjectCreateModal(this.app, async (name, color) => {
      if (this.state?.demoMode) {
        if (this.previewProjects.some((project) => project.name === name)) {
          throw new Error("已经存在同名清单");
        }
        const project: DidaProject = {
          id: `sample-project-${crypto.randomUUID()}`,
          name,
          color,
        };
        this.previewProjects = [...this.previewProjects, project];
        this.section = "tasks";
        this.taskCollectionFilters.didaProjectId = project.id;
        await this.render();
        return;
      }
      await this.service.createDidaProject(name, color);
      const project = this.service.snapshot().projects.find((candidate) => candidate.name === name);
      this.section = "tasks";
      this.taskCollectionFilters.didaProjectId = project?.id;
      await this.render();
    }).open();
  }

  private async renderToday(content: HTMLElement, token: number): Promise<void> {
    const state = this.displayState();
    const localTasks = this.localProjectTaskDidaTasks();
    const localWorkspace = (this.localProjectTaskSnapshot?.destinations.length ?? 0) > 0;
    const remoteTasks = this.state?.demoMode && localWorkspace ? this.state.tasks : state.tasks;
    const remoteProjects = this.state?.demoMode && localWorkspace ? this.state.projects : state.projects;
    const tasks = mergeProjectTaskCollections(remoteTasks, localTasks);
    const projects: DidaProject[] = [
      ...remoteProjects,
      ...(this.localProjectTaskSnapshot?.destinations ?? []).map((project) => ({
        id: `helix-project:${project.projectId}`,
        name: project.projectTitle,
        ...(project.projectColor ? { color: project.projectColor } : {}),
      })),
    ];
    const now = new Date();
    const hero = content.createDiv({ cls: "helix-today-heading" });
    const copy = hero.createDiv();
    copy.createEl("p", { cls: "helix-eyebrow", text: formatFullDate(now) });
    copy.createEl("h2", { text: homeGreeting(now) });
    const score = hero.createDiv({ cls: "helix-score" });
    const today = localDateKey(now);
    const activity = aggregateAnalytics(this.state?.events ?? [], {
      from: today,
      to: today,
    }).daily[0]?.activity ?? 0;
    score.createSpan({ cls: "helix-score-value", text: String(activity) });
    score.createSpan({ text: "今日活跃度" });

    const grid = content.createDiv({ cls: "helix-dashboard-grid" });
    const primary = grid.createDiv({ cls: "helix-dashboard-primary" });
    this.renderInProgress(primary, tasks, projects);
    this.renderTodayTasks(primary, tasks, projects, now);
    const rail = grid.createDiv({ cls: "helix-dashboard-rail" });
    this.renderTimeline(rail, tasks, projects);
    const lower = content.createDiv({ cls: "helix-dashboard-lower" });
    this.renderProjectPulse(lower, projects, tasks);
    this.renderWeeklyOverview(lower);
    this.renderWeeklyChallengeCard(lower);
    const conflicts = await this.store.list();
    if (token !== this.renderToken) return;
    const totalConflicts = conflicts.length + this.focusBridgeConflictCount;
    if (totalConflicts > 0) {
      const warning = content.createDiv({ cls: "helix-card helix-conflict-warning" });
      const icon = warning.createSpan();
      setIcon(icon, "git-compare-arrows");
      const body = warning.createDiv();
      body.createEl("strong", { text: `${totalConflicts} 项等待手动合并` });
      body.createEl("p", { text: "Helix 不会静默覆盖竞争修改。" });
      warning.addEventListener("click", () => {
        this.section = "conflicts";
        void this.render();
      });
    }
  }

  private renderInProgress(
    parent: HTMLElement,
    tasks: DidaTask[],
    projects: DidaProject[],
  ): void {
    const card = parent.createDiv({ cls: "helix-card helix-in-progress" });
    const localItems = (this.localProjectTaskSnapshot?.roots ?? [])
      .filter((task) => task.state === "active")
      .flatMap((task) => {
        const rendered = tasks.find((candidate) => candidate.id === task.id);
        if (!rendered) return [];
        return [{
          task: rendered,
          project: projects.find((project) => project.id === rendered.projectId),
        }];
      });
    const localItemIds = new Set(localItems.map((item) => item.task.id));
    const allRealItems = [
      ...localItems,
      ...this.service.visibleInProgress(true).filter((item) => !localItemIds.has(item.task.id)).map((item) => ({
        task: item.task,
        project: item.project,
      })),
    ];
    const realPresentation = inProgressPresentation(
      allRealItems,
      this.expandedInProgress,
    );
    const realItems = realPresentation.visible;
    const items = realItems.length > 0
      ? realItems
      : this.state?.demoMode
        ? tasks
          .filter((task) => this.previewInProgress.has(task.id))
          .slice(0, this.expandedInProgress ? tasks.length : 3)
          .map((task) => ({
            task,
            project: projects.find((project) => project.id === task.projectId),
          }))
        : [];
    const totalItems = realItems.length > 0
      ? allRealItems.length
      : this.state?.demoMode
        ? tasks.filter((task) => this.previewInProgress.has(task.id)).length
        : 0;
    const canExpand = totalItems > 3;
    const listId = "helix-in-progress-list";
    const header = card.createDiv({ cls: "helix-section-header" });
    header.createEl("h3", { text: "正在进行" });
    if (canExpand) {
      const disclosure = header.createEl("button", {
        cls: "helix-disclosure",
        attr: {
          "aria-expanded": String(this.expandedInProgress),
          "aria-controls": listId,
        },
      });
      disclosure.createSpan({
        text: this.expandedInProgress ? "收起" : `查看全部 ${totalItems} 项`,
      });
      const icon = disclosure.createSpan();
      setIcon(icon, this.expandedInProgress ? "chevron-up" : "chevron-down");
      disclosure.addEventListener("click", () => {
        this.expandedInProgress = !this.expandedInProgress;
        void this.render();
      });
    }
    if (items.length === 0) {
      card.createDiv({ cls: "helix-empty", text: "还没有标记正在进行的任务。" });
      return;
    }
    const list = card.createDiv({
      cls: "helix-task-list",
      attr: { id: listId },
    });
    for (const item of items) this.renderTaskRow(list, item.task, item.project, true);
  }

  private renderTodayTasks(
    parent: HTMLElement,
    tasks: DidaTask[],
    projects: DidaProject[],
    now: Date,
  ): void {
    const card = parent.createDiv({ cls: "helix-card" });
    const header = card.createDiv({ cls: "helix-section-header" });
    const title = header.createDiv();
    title.createEl("h3", { text: "今日任务" });
    const todayTasks = todayOpenTasks(tasks, now);
    title.createEl("p", { text: `${todayTasks.length} 项待推进` });
    if (todayTasks.length === 0) {
      card.createDiv({ cls: "helix-empty", text: "今天没有待推进任务，留一点空间给真正重要的事。" });
      return;
    }
    const list = card.createDiv({ cls: "helix-task-list" });
    for (const task of todayTasks.slice(0, 6)) {
      this.renderTaskRow(
        list,
        task,
        projects.find((project) => project.id === task.projectId),
        false,
      );
    }
  }

  private renderTaskRow(
    parent: HTMLElement,
    task: DidaTask,
    project: DidaProject | undefined,
    prominent: boolean,
    depth = 0,
    tree?: TaskTreeRow,
  ): HTMLElement {
    const localTask = this.localProjectTaskSnapshot?.byId.get(task.id);
    const stageParent = this.localProjectTaskSnapshot?.byRemoteParentTaskId.get(task.id);
    const summary = taskSummary(task, Boolean(localTask));
    const row = parent.createDiv({
      cls: `helix-task-row${prominent ? " is-prominent" : ""}${summary ? " has-summary" : ""}`,
      attr: { "data-task-id": task.id },
    });
    row.style.setProperty("--depth", String(depth));
    row.style.setProperty(
      "--helix-task-indent",
      `${Math.min(depth, 6) * 18 + Math.max(0, Math.min(depth - 6, 5)) * 10}px`,
    );
    if (localTask) row.addClass("is-local-project-task");
    if (depth > 0) row.addClass("is-subtask");
    const completed = localTask
      ? localTask.state === "completed" || localTask.state === "terminated"
      : stageParent
        ? stageParent.stageStatus === "completed" || stageParent.stageStatus === "terminated"
        : task.status === 2;
    const completionIsDerived = Boolean(stageParent || (localTask && tree?.hasChildren));
    const leading = row.createDiv({ cls: "helix-task-tree-leading" });
    const check = leading.createEl("button", {
      cls: `${tree?.hasChildren ? "helix-task-tree-progress" : "helix-task-check"}${completed ? " is-completed" : ""}`,
      attr: {
        "aria-label": completionIsDerived
          ? `${task.title}：完成状态由子任务自动决定`
          : tree?.hasChildren
            ? `${task.title}：直属子任务完成 ${tree.completedDirectChildCount}/${tree.directChildCount}；${completed ? "重新打开父任务" : "完成父任务"}`
          : completed ? `重新打开 ${task.title}` : `完成 ${task.title}`,
        title: completionIsDerived
          ? "子任务全部完成后自动完成主任务"
          : tree?.hasChildren
            ? `直属子任务 ${tree.completedDirectChildCount}/${tree.directChildCount}；点击只切换父任务本身`
          : completed ? "重新打开任务" : "完成任务",
      },
    });
    if (completionIsDerived) check.disabled = true;
    if (tree?.hasChildren) {
      const childRatio = tree.directChildCount > 0
        ? tree.completedDirectChildCount / tree.directChildCount
        : 0;
      check.style.setProperty(
        "--helix-task-progress-angle",
        `${Math.round((completed ? 1 : childRatio) * 360)}deg`,
      );
      if (completed) setIcon(check, "check");
      else check.createSpan({ text: `${tree.completedDirectChildCount}/${tree.directChildCount}` });
    } else if (completed) setIcon(check, "check");
    const body = row.createDiv({ cls: "helix-task-copy" });
    const title = body.createDiv({
      cls: "helix-task-title",
      text: task.title,
      attr: {
        role: "button",
        tabindex: "0",
        draggable: "false",
        title: "单击修改任务标题",
        "aria-label": `修改任务标题：${task.title}`,
      },
    });
    const startTitleEdit = () => this.startInlineTaskTitleEdit(title, task);
    title.addEventListener("click", startTitleEdit);
    title.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      startTitleEdit();
    });
    if (summary) body.createDiv({ cls: "helix-task-summary", text: summary });
    const meta = body.createDiv({ cls: "helix-task-meta" });
    const dot = meta.createSpan({ cls: "helix-project-dot" });
    dot.style.backgroundColor =
      localTask?.projectColor ?? project?.color ?? "#8891a7";
    if (localTask) {
      meta.createSpan({ text: localTask.projectTitle });
      meta.createSpan({ text: `阶段 ${localTask.stageCode} · ${localTask.stageTitle}` });
      meta.createSpan({
        cls: `helix-chip is-soft is-${localTask.state}`,
        text: localTaskStateLabel(localTask.state),
      });
    } else if (stageParent) {
      meta.createSpan({ text: stageParent.projectTitle });
      meta.createSpan({ text: `阶段 ${stageParent.stageCode} · ${stageParent.stageTitle}` });
      meta.createSpan({
        cls: `helix-chip is-soft is-${stageParent.stageStatus}`,
        text: localTaskStateLabel(stageParent.stageStatus as ProjectionActionState),
      });
    } else {
      meta.createSpan({ text: `滴答 · ${project?.name ?? "未归档清单"}` });
    }
    if (task.tags?.length) meta.createSpan({ text: task.tags.map((tag) => `#${tag}`).join(" ") });
    if (task.dueDate) meta.createSpan({ text: formatShortTime(task.dueDate) });
    if (tree?.hasChildren) {
      const toggle = row.createEl("button", {
        cls: "helix-task-tree-toggle",
        attr: {
          "aria-label": `${tree.expanded ? "收起" : "展开"} ${task.title} 的子任务`,
          "aria-expanded": String(tree.expanded),
          title: tree.expanded ? "收起子任务" : "展开子任务",
        },
      });
      setIcon(toggle, tree.expanded ? "chevron-down" : "chevron-right");
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (tree.expanded) this.collapsedTaskTreeIds.add(task.id);
        else this.collapsedTaskTreeIds.delete(task.id);
        void this.render();
      });
    }
    let editTask: (() => void) | undefined;
    let toggleActive: (() => void) | undefined;
    if (localTask) {
      if (!completionIsDerived) {
        check.addEventListener("click", () => {
          check.disabled = true;
          void this.actions.updateLocalProjectTask({
            projectId: localTask.projectId,
            stageId: localTask.stageId,
            uuid: localTask.uuid,
            expectedHash: localTask.revisionHash,
            state: completed ? "idea" : "completed",
          }).then(() => this.render()).catch((error) => {
            check.disabled = false;
            new Notice(messageOf(error), 8_000);
          });
        });
      }
      toggleActive = () => {
        void this.actions.updateLocalProjectTask({
          projectId: localTask.projectId,
          stageId: localTask.stageId,
          uuid: localTask.uuid,
          expectedHash: localTask.revisionHash,
          state: localTask.state === "active" ? "idea" : "active",
        }).then(() => this.render()).catch((error) => new Notice(messageOf(error), 8_000));
      };
      editTask = () => {
        const editorTask = localTask.parentUuid
          ? this.localProjectTaskSnapshot?.byUuid.get(localTask.parentUuid)
          : localTask;
        if (editorTask) this.openLocalProjectTaskEditor(editorTask);
      };
    } else if (stageParent) {
      toggleActive = () => {
        void this.actions.readProjectWorkspace(() =>
          this.actions.projectWorkspace.prepareCycleStatusUpdate(stageParent.stageId))
          .then((plan) => this.actions.updateCycleStatus(
            plan,
            stageParent.stageStatus === "active" ? "idea" : "active",
          ))
          .then(() => this.render())
          .catch((error) => new Notice(messageOf(error), 8_000));
      };
      editTask = () => this.openStageProjectionTaskEditor(task, stageParent, []);
    } else if (!task.id.startsWith("sample-")) {
      const canWriteTask = DIDA_TASK_WRITE_AVAILABLE && (this.state?.taskCrudVerified ?? false);
      if (!canWriteTask) {
        check.disabled = true;
        const reason = DIDA_TASK_WRITE_AVAILABLE
          ? "滴答写入能力尚未通过当前版本合同核验"
          : "当前阶段仅开放滴答读取";
        check.title = reason;
      }
      check.addEventListener("click", () => {
        if (!canWriteTask) return;
        check.disabled = true;
        check.addClass(task.status === 2 ? "is-reopening" : "is-completing");
        if (task.status !== 2) {
          check.addClass("is-completed");
          if (!tree?.hasChildren) setIcon(check, "check");
        }
        const request = task.status === 2
          ? this.service.reopenTask(task.id)
          : this.service.completeTask(task.id);
        void request
          .then(() => {
            check.addClass("is-success");
            globalThis.setTimeout(() => void this.render(), 220);
          })
          .catch((error) => {
            new Notice(error instanceof Error ? error.message : String(error), 8_000);
            void this.render();
          });
      });
      toggleActive = () => {
        void this.service.toggleInProgress(task.id).catch((error) => {
          new Notice(error instanceof Error ? error.message : String(error));
        });
      };
      editTask = () => {
        if (!DIDA_TASK_WRITE_AVAILABLE) return;
        void this.openTaskEditor(task, this.state?.projects ?? []);
      };
    } else {
      check.addEventListener("click", () => {
        this.previewTasks = this.previewTasks.map((candidate) =>
          candidate.id === task.id
            ? {
              ...candidate,
              status: 2,
              completedTime: new Date().toISOString(),
            }
            : candidate,
        );
        this.previewInProgress.delete(task.id);
        void this.render();
      });
      toggleActive = () => {
        if (this.previewInProgress.has(task.id)) this.previewInProgress.delete(task.id);
        else this.previewInProgress.add(task.id);
        void this.render();
      };
      editTask = () => {
        this.openPreviewTaskEditor(task);
      };
    }
    const more = row.createEl("button", {
      cls: "helix-task-row-more",
      attr: { "aria-label": `${task.title} 的更多操作`, title: "更多操作" },
    });
    setIcon(more, "ellipsis");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = new Menu();
      if (editTask) {
        menu.addItem((item) => item
          .setTitle(DIDA_TASK_WRITE_AVAILABLE || localTask || task.id.startsWith("sample-") ? "编辑任务" : "查看详情")
          .setIcon("pencil")
          .onClick(editTask));
      }
      if (toggleActive) {
        menu.addItem((item) => item
          .setTitle(localTask?.state === "active" || prominent ? "取消正在进行" : "设为正在进行")
          .setIcon(localTask?.state === "active" || prominent ? "pin-off" : "play")
          .onClick(toggleActive));
      }
      menu.showAtMouseEvent(event);
    });
    if (task.status === 2 && !localTask && !stageParent &&
      (task.id.startsWith("sample-") || !this.state?.taskReopenVerified)) {
      check.disabled = true;
      if (!localTask && !task.id.startsWith("sample-") && !this.state?.taskReopenVerified) {
        check.title = "当前账号尚未通过任务重开核验";
      }
    }
    return row;
  }

  private startInlineTaskTitleEdit(container: HTMLElement, task: DidaTask): void {
    if (container.querySelector("input")) return;
    container.empty();
    container.removeAttribute("role");
    container.removeAttribute("tabindex");
    const input = container.createEl("input", {
      cls: "helix-task-title-input",
      type: "text",
      value: task.title,
      attr: { "aria-label": "任务标题", draggable: "false" },
    });
    let settled = false;
    const restore = () => {
      container.empty();
      container.setText(task.title);
      container.setAttribute("role", "button");
      container.setAttribute("tabindex", "0");
    };
    const save = async () => {
      if (settled) return;
      settled = true;
      input.disabled = true;
      try {
        const result = await commitInlineTaskTitle(task.title, input.value, async (title) => {
          const localTask = this.localProjectTaskSnapshot?.byId.get(task.id);
          if (localTask) {
            await this.actions.updateLocalProjectTask({
              projectId: localTask.projectId,
              stageId: localTask.stageId,
              uuid: localTask.uuid,
              expectedHash: localTask.revisionHash,
              title,
            });
          } else if (task.id.startsWith("sample-")) {
            this.previewTasks = this.previewTasks.map((candidate) =>
              candidate.id === task.id ? { ...candidate, title } : candidate);
          } else {
            await this.service.queueTaskUpdate({ ...task, title }, "update", ["title"]);
            new Notice("任务标题已加入同步队列");
          }
        });
        if (result === "unchanged") {
          restore();
          return;
        }
        await this.render();
      } catch (error) {
        settled = false;
        input.disabled = false;
        new Notice(messageOf(error), 8_000);
        input.focus();
      }
    };
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      const intent = inlineTaskTitleKeyIntent(event.key);
      if (intent === "commit") {
        event.preventDefault();
        input.blur();
      } else if (intent === "cancel") {
        event.preventDefault();
        settled = true;
        restore();
        container.focus();
      }
    });
    input.addEventListener("blur", () => { void save(); });
    input.focus();
    input.select();
  }

  private async refreshLocalProjectTaskSnapshot(token: number): Promise<void> {
    try {
      const snapshot = await this.actions.readLocalProjectTasks();
      if (token === this.renderToken) this.localProjectTaskSnapshot = snapshot;
    } catch (error) {
      if (token !== this.renderToken) return;
      this.localProjectTaskSnapshot = {
        tasks: [],
        roots: [],
        issues: [messageOf(error)],
        byId: new Map(),
        byUuid: new Map(),
        stageParents: [],
        byRemoteParentTaskId: new Map(),
        destinations: [],
      };
    }
  }

  private localProjectTaskDidaTasks(): DidaTask[] {
    const snapshot = this.localProjectTaskSnapshot;
    if (!snapshot) return [];
    return localProjectTaskPresentationTasks(snapshot, this.state?.tasks ?? []);
  }

  private async openTaskEditor(
    task: DidaTask,
    didaProjects: DidaProject[],
  ): Promise<void> {
    const childIds = new Set(task.childIds ?? []);
    const childTasks = (this.state?.tasks ?? []).filter((candidate) =>
      candidate.parentId === task.id || childIds.has(candidate.id));
    const stageParent = this.localProjectTaskSnapshot?.byRemoteParentTaskId.get(task.id);
    if (stageParent) {
      this.openStageProjectionTaskEditor(task, stageParent, childTasks);
      return;
    }
    const scheduleMode = this.state?.taskScheduleMode ?? "unknown";
    const initial = didaTaskDetailDraft(task, didaProjects, childTasks, "dida");
    const capabilities = didaTaskDetailCapabilities(
      didaProjects,
      this.state?.reminderWriteVerified ?? false,
      this.state?.repeatWriteVerified ?? false,
      childTasks.length > 0,
    );
    const adapter: TaskDetailAdapter = {
      read: async () => ({ draft: initial, capabilities }),
      save: async (draft) => {
        await this.saveDidaTaskDetail(task, draft, scheduleMode, childTasks);
        await this.render();
      },
      delete: async () => {
        await this.service.deleteTask(task.id);
        await this.render();
      },
    };
    new UnifiedTaskDetailModal(this.app, adapter).open();
  }

  private openLocalProjectTaskEditor(task: LocalProjectTask): void {
    const children = (this.localProjectTaskSnapshot?.tasks ?? [])
      .filter((candidate) => candidate.parentUuid === task.uuid);
    const adapter: TaskDetailAdapter = {
      read: async () => ({
        draft: localTaskDetailDraft(task, children),
        capabilities: localTaskDetailCapabilities(children.length > 0),
      }),
      save: async (draft) => {
        await this.actions.saveLocalProjectTask({
          projectId: task.projectId,
          stageId: task.stageId,
          uuid: task.uuid,
          expectedHash: task.revisionHash,
          draft: localTaskDraftFromDetail(draft, task.content ?? ""),
        });
        await this.render();
      },
      delete: async () => {
        await this.actions.deleteLocalProjectTask({
          projectId: task.projectId,
          stageId: task.stageId,
          uuid: task.uuid,
          expectedHash: task.revisionHash,
        });
        await this.render();
      },
    };
    new UnifiedTaskDetailModal(this.app, adapter).open();
  }

  private openPreviewTaskEditor(task: DidaTask): void {
    const children = this.previewTasks.filter((candidate) => candidate.parentId === task.id);
    const adapter: TaskDetailAdapter = {
      read: async () => ({
        draft: didaTaskDetailDraft(task, this.previewProjects, children, "preview"),
        capabilities: {
          ...didaTaskDetailCapabilities(this.previewProjects, true, true, children.length > 0),
          delete: false,
        },
      }),
      save: async (draft) => {
        const updated = didaTaskFromDetail(task, draft, "duration");
        this.previewTasks = this.previewTasks.map((candidate) =>
          candidate.id === task.id ? updated : candidate);
        await this.render();
      },
    };
    new UnifiedTaskDetailModal(this.app, adapter).open();
  }

  private async saveDidaTaskDetail(
    task: DidaTask,
    draft: TaskDetailDraft,
    scheduleMode: TaskScheduleMode,
    originalChildren: DidaTask[],
  ): Promise<void> {
    const updated = didaTaskFromDetail(task, draft, scheduleMode);
    const writeFields = taskEditWriteFields(
      didaTaskEditableSnapshot(task),
      didaTaskEditableSnapshot(updated),
      {
        reminders: JSON.stringify(task.reminders ?? []) !== JSON.stringify(updated.reminders ?? []),
        repeatFlag: (task.repeatFlag ?? null) !== (updated.repeatFlag ?? null),
      },
    );
    if (draft.listId !== task.projectId || writeFields.length > 0) {
      await this.service.queueTaskUpdate(updated, "update", writeFields);
    }
    if (draft.status === "completed" && task.status !== 2) await this.service.completeTask(task.id);
    if (draft.status !== "completed" && task.status === 2) await this.service.reopenTask(task.id);
    const originals = new Map(originalChildren.map((child) => [child.id, child]));
    for (const child of draft.subtasks) {
      const original = originals.get(child.id);
      if (!original) continue;
      if (original.title !== child.title.trim()) {
        await this.service.queueTaskUpdate({ ...original, title: child.title.trim() }, "update", ["title"]);
      }
      const completed = child.status === "completed";
      if (completed !== (original.status === 2)) {
        if (completed) await this.service.completeTask(original.id);
        else await this.service.reopenTask(original.id);
      }
    }
  }

  private openStageProjectionTaskEditor(
    task: DidaTask,
    stage: LocalProjectStageTaskParent,
    _remoteChildren: DidaTask[],
  ): void {
    const read = async () => {
      const snapshot = await this.actions.readLocalProjectTasks();
      const roots = snapshot.roots.filter((candidate) => candidate.stageId === stage.stageId);
      return {
        draft: stageTaskDetailDraft(stage, roots),
        capabilities: stageTaskDetailCapabilities(),
      };
    };
    const adapter: TaskDetailAdapter = {
      read,
      save: async (draft) => {
        if (draft.title.trim() !== stage.stageTitle) {
          await this.actions.mutateProjectWorkspace(() =>
            this.actions.projectWorkspace.renameCycle(stage.stageId, draft.title.trim()));
        }
        if (draft.status !== stage.stageStatus) {
          const plan = await this.actions.readProjectWorkspace(() =>
            this.actions.projectWorkspace.prepareCycleStatusUpdate(stage.stageId));
          await this.actions.updateCycleStatus(plan, draft.status);
        }
        let snapshot = await this.actions.readLocalProjectTasks();
        const existingRoots = snapshot.roots.filter((candidate) => candidate.stageId === stage.stageId);
        const submittedIds = new Set(draft.subtasks.filter((child) => !child.id.startsWith("new:")).map((child) => child.id));
        for (const existing of existingRoots) {
          if (submittedIds.has(existing.uuid)) continue;
          await this.actions.deleteLocalProjectTask({
            projectId: existing.projectId,
            stageId: existing.stageId,
            uuid: existing.uuid,
            expectedHash: existing.revisionHash,
          });
          snapshot = await this.actions.readLocalProjectTasks();
        }
        for (const child of draft.subtasks) {
          snapshot = await this.actions.readLocalProjectTasks();
          let current = snapshot.byUuid.get(child.id);
          if (!current) {
            const createdId = await this.actions.createLocalProjectTask({
              projectId: stage.projectId,
              stageId: stage.stageId,
              title: child.title.trim(),
            });
            snapshot = await this.actions.readLocalProjectTasks();
            current = snapshot.byId.get(createdId);
          }
          if (!current) throw new Error(`无法重新读取计划行动：${child.title}`);
          const nested = snapshot.tasks.filter((candidate) => candidate.parentUuid === current!.uuid);
          await this.actions.saveLocalProjectTask({
            projectId: current.projectId,
            stageId: current.stageId,
            uuid: current.uuid,
            expectedHash: current.revisionHash,
            draft: localTaskDraftFromDetail({
              ...localTaskDetailDraft(current, nested),
              title: child.title,
              status: child.status,
              priority: child.priority,
              date: child.date,
              startTime: child.startTime,
              endTime: child.endTime,
              timeMode: child.startTime && child.endTime && child.startTime !== child.endTime
                ? "range" : child.startTime ? "point" : "none",
            }, current.content ?? ""),
          });
        }
        await this.render();
      },
    };
    new UnifiedTaskDetailModal(this.app, adapter).open();
  }

  private renderWeeklyChallengeCard(parent: HTMLElement): void {
    const challenge = rotatingChallenges(new Date())[0]!;
    const current = challengeProgress(challenge, this.state?.events ?? []);
    const ratio = Math.min(100, Math.round((current / challenge.target) * 100));
    const card = parent.createDiv({ cls: "helix-challenge-card" });
    const glow = card.createDiv({ cls: "helix-challenge-glow" });
    void glow;
    const top = card.createDiv({ cls: "helix-challenge-top" });
    const label = top.createDiv({ cls: "helix-challenge-kicker" });
    label.createSpan({ text: "本周挑战" });
    label.createSpan({ cls: "helix-live-chip", text: "LIVE" });
    const countdown = top.createSpan({ cls: "helix-countdown" });
    setIcon(countdown, "clock-3");
    countdown.createSpan({ text: daysRemaining(challenge.endsAt) });
    const hero = card.createDiv({ cls: "helix-challenge-hero" });
    hero.createEl("h3", { text: challenge.title });
    hero.createEl("p", { text: challenge.description });
    const progress = card.createDiv({ cls: "helix-challenge-progress" });
    const fill = progress.createDiv({ cls: "helix-challenge-progress-fill" });
    fill.style.width = `${ratio}%`;
    const stats = card.createDiv({ cls: "helix-challenge-stats" });
    const currentStat = stats.createDiv();
    currentStat.createSpan({ text: "进度" });
    currentStat.createEl("strong", { text: `${current} / ${challenge.target}` });
    const reward = stats.createDiv({ cls: "helix-challenge-reward" });
    reward.createSpan({ text: "奖励" });
    reward.createEl("strong", { text: `${challenge.rewardXp} XP` });
    const detail = card.createEl("button", {
      cls: "helix-challenge-cta",
      text: "查看挑战详情",
    });
    detail.addEventListener("click", () => {
      new ChallengeDetailModal(
        this.app,
        challenge,
        this.state?.events ?? [],
      ).open();
    });
  }

  private renderHabitCard(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "helix-card helix-habit-card" });
    const header = card.createDiv({ cls: "helix-section-header" });
    header.createEl("h3", { text: "习惯脉冲" });
    header.createSpan({
      cls: "helix-chip is-soft",
      text: this.state?.demoMode ? "演示" : `${this.state?.habits.length ?? 0} 项`,
    });
    const labels = this.state?.demoMode
      ? ["晨间阅读", "运动", "日复盘"]
      : (this.state?.habits ?? []).map((habit) => habit.name).slice(0, 4);
    if (labels.length === 0) {
      card.createDiv({ cls: "helix-empty", text: "近 31 天没有可展示的习惯。" });
      return;
    }
    for (const label of labels) {
      const row = card.createDiv({ cls: "helix-habit-row" });
      row.createSpan({ text: label });
      const days = row.createDiv({ cls: "helix-habit-days" });
      for (let day = 6; day >= 0; day -= 1) {
        const date = dateDaysAgo(day);
        const done = this.state?.demoMode
          ? day >= 2
          : this.hasHabitCheckin(label, date);
        days.createSpan({ cls: done ? "is-done" : "" });
      }
    }
  }

  private renderTimeline(
    parent: HTMLElement,
    tasks: DidaTask[],
    projects: DidaProject[],
  ): void {
    const card = parent.createDiv({ cls: "helix-card helix-timeline-card" });
    const header = card.createDiv({ cls: "helix-section-header" });
    header.createEl("h3", { text: "今日时间轴" });
    header.createSpan({ cls: "helix-chip is-soft", text: "今天" });
    const today = localDateKey(new Date());
    const timed = tasks
      .filter(
        (task) =>
          task.status !== 2 &&
          (taskDateKey(task.startDate) === today || taskDateKey(task.dueDate) === today),
      )
      .sort((left, right) => (left.startDate ?? left.dueDate ?? "").localeCompare(right.startDate ?? right.dueDate ?? ""));
    const visible = this.state?.demoMode ? tasks.slice(0, 5) : timed;
    if (visible.length === 0) {
      card.createDiv({ cls: "helix-empty", text: "今天没有带时间的任务。" });
      return;
    }
    const list = card.createDiv({ cls: "helix-timeline-list" });
    for (const [index, task] of visible.entries()) {
      const row = list.createDiv({ cls: "helix-timeline-row" });
      row.createSpan({
        cls: "helix-timeline-time",
        text: task.startDate ? formatHour(task.startDate) : `${9 + index * 2}:00`,
      });
      const block = row.createDiv({ cls: "helix-timeline-block" });
      const project = projects.find((candidate) => candidate.id === task.projectId);
      block.style.borderLeftColor = project?.color ?? "#8891a7";
      block.createEl("strong", { text: task.title });
      block.createSpan({ text: project?.name ?? "未归档项目" });
    }
  }

  private renderProjectPulse(
    parent: HTMLElement,
    projects: DidaProject[],
    tasks: DidaTask[],
  ): void {
    const card = parent.createDiv({ cls: "helix-card helix-pulse-card" });
    const header = card.createDiv({ cls: "helix-section-header" });
    header.createEl("h3", { text: "项目脉搏" });
    const body = card.createDiv({ cls: "helix-pulse-grid" });
    for (const project of projects.slice(0, 4)) {
      const projectTasks = tasks.filter((task) => task.projectId === project.id);
      const completed = projectTasks.filter((task) => task.status === 2).length;
      const ratio = projectTasks.length > 0 ? Math.round((completed / projectTasks.length) * 100) : 0;
      const item = body.createDiv({ cls: "helix-pulse-item" });
      const top = item.createDiv();
      const dot = top.createSpan({ cls: "helix-project-dot" });
      dot.style.backgroundColor = project.color ?? "#5268d4";
      top.createEl("strong", { text: project.name });
      item.createSpan({ text: `${completed}/${projectTasks.length} 已完成` });
      const meter = item.createDiv({ cls: "helix-pulse-meter" });
      const fill = meter.createDiv();
      fill.style.width = `${ratio}%`;
      fill.style.backgroundColor = project.color ?? "#5268d4";
    }
  }

  private renderWeeklyOverview(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "helix-card helix-week-card" });
    const header = card.createDiv({ cls: "helix-section-header" });
    header.createEl("h3", { text: "本周概览" });
    const now = new Date();
    const monday = new Date(now);
    const weekday = monday.getDay() || 7;
    monday.setDate(monday.getDate() - weekday + 1);
    const summary = aggregateAnalytics(this.state?.events ?? [], {
      from: localDateKey(monday),
      to: localDateKey(now),
    });
    const metrics = card.createDiv({ cls: "helix-week-metrics" });
    for (const [value, label] of [
      [String(summary.totalTasks), "任务完成"],
      [`${Math.round(summary.totalFocusMinutes / 60)}h`, "专注时长"],
      [String(summary.activeDays), "活跃天"],
    ]) {
      const metric = metrics.createDiv();
      metric.createEl("strong", { text: value });
      metric.createSpan({ text: label });
    }
    const bars = card.createDiv({ cls: "helix-week-bars" });
    for (const item of summary.daily) {
      const bar = bars.createSpan();
      bar.style.height = `${Math.max(8, Math.min(100, item.activity * 9))}%`;
    }
  }

  private async renderTasks(content: HTMLElement, token: number): Promise<void> {
    const displayed = this.displayState();
    const hasLocalWorkspace = (this.localProjectTaskSnapshot?.destinations.length ?? 0) > 0;
    const remoteTasks = this.state?.demoMode && hasLocalWorkspace
      ? (this.state?.tasks ?? [])
      : displayed.tasks;
    const localTasks = this.localProjectTaskDidaTasks();
    const tasks = mergeProjectTaskCollections(remoteTasks, localTasks);
    const projects = this.state?.demoMode && hasLocalWorkspace
      ? (this.state?.projects ?? [])
      : displayed.projects;
    const taskProjects: DidaProject[] = [
      ...projects,
      ...(this.localProjectTaskSnapshot?.destinations ?? []).map((project) => ({
        id: `helix-project:${project.projectId}`,
        name: project.projectTitle,
        ...(project.projectColor ? { color: project.projectColor } : {}),
      })),
    ];
    const writableProjects = projects.filter((project) => !project.id.startsWith("local-project-"));
    this.renderPageTitle(content, "任务总览");
    if ((this.localProjectTaskSnapshot?.issues.length ?? 0) > 0) {
      const diagnostic = content.createDiv({ cls: "helix-card helix-task-reference-diagnostics" });
      diagnostic.createEl("h3", { text: "本地项目任务需要检查" });
      for (const issue of this.localProjectTaskSnapshot!.issues) {
        diagnostic.createDiv({ cls: "helix-task-reference-diagnostic is-blocking", text: issue });
      }
    }
    const localDestinations = this.localProjectTaskSnapshot?.destinations ?? [];
    const canComposeRemote = DIDA_TASK_WRITE_AVAILABLE && writableProjects.length > 0 &&
      (this.state?.connected || (this.state?.demoMode && !hasLocalWorkspace));
    const canCompose = canComposeRemote || localDestinations.some((destination) =>
      destination.stages.length > 0);
    if (canCompose) {
      const composer = content.createDiv({ cls: "helix-card helix-task-composer" });
      const input = composer.createEl("input", {
        type: "text",
        placeholder: this.state?.demoMode ? "新建演示任务…" : "新建任务…",
        attr: { "aria-label": "任务标题" },
      });
      const select = composer.createEl("select", { attr: { "aria-label": "任务归属" } });
      if (localDestinations.length > 0) {
        const group = select.createEl("optgroup", { attr: { label: "Helix 项目阶段" } });
        for (const destination of localDestinations) {
          for (const stage of destination.stages) {
            group.createEl("option", {
              text: `${destination.projectTitle} · 阶段 ${stage.stageCode} ${stage.stageTitle}`,
              value: localTaskDestinationValue(destination.projectId, stage.stageId),
            });
          }
        }
      }
      if (canComposeRemote) {
        const group = select.createEl("optgroup", { attr: { label: "滴答清单" } });
        for (const project of writableProjects) {
          group.createEl("option", { text: project.name, value: `dida:${project.id}` });
        }
      }
      if (this.taskCollectionFilters.didaProjectId &&
        writableProjects.some((project) => project.id === this.taskCollectionFilters.didaProjectId)) {
        select.value = `dida:${this.taskCollectionFilters.didaProjectId}`;
      }
      const submit = composer.createEl("button", {
        cls: "helix-primary-button",
        text: this.state?.demoMode ? "添加演示任务" : "创建任务",
      });
      const preview = composer.createDiv({ cls: "helix-task-quick-preview" });
      let parsingEnabled = true;
      const submission = new TaskSubmissionGate();
      const quickResult = () => parsingEnabled
        ? parseTaskQuickEntry(input.value, writableProjects)
        : {
          title: input.value.trim(),
          projectId: undefined,
          tags: [],
          priority: undefined,
          issues: [],
        };
      const renderQuickPreview = (): void => {
        preview.empty();
        const parsed = quickResult();
        submit.disabled = submission.isWriting || parsed.issues.length > 0;
        if (!input.value.trim()) return;
        if (!parsingEnabled) {
          preview.addClass("is-disabled");
          preview.createSpan({ text: "快捷属性解析已撤销，本次按普通标题创建" });
          const restore = preview.createEl("button", { text: "重新解析" });
          restore.addEventListener("click", () => {
            parsingEnabled = true;
            renderQuickPreview();
          });
          return;
        }
        preview.removeClass("is-disabled");
        const changed = parsed.title !== input.value.trim() || parsed.issues.length > 0;
        if (!changed) return;
        if (parsed.title) preview.createSpan({ cls: "helix-task-quick-title", text: `标题：${parsed.title}` });
        if (parsed.projectId) {
          const project = writableProjects.find((candidate) => candidate.id === parsed.projectId);
          preview.createSpan({ cls: "helix-chip is-soft", text: `清单：${project?.name ?? parsed.projectId}` });
        }
        for (const tag of parsed.tags) {
          preview.createSpan({ cls: "helix-chip is-soft", text: `#${tag}` });
        }
        if (parsed.priority !== undefined) {
          preview.createSpan({
            cls: "helix-chip is-soft",
            text: `优先级：${taskPriorityLabel(parsed.priority)}`,
          });
        }
        for (const issue of parsed.issues) {
          preview.createSpan({ cls: "helix-task-quick-issue", text: issue });
        }
        const undo = preview.createEl("button", {
          text: parsed.issues.length > 0 ? "按普通标题处理" : "撤销解析",
        });
        undo.addEventListener("click", () => {
          parsingEnabled = false;
          renderQuickPreview();
        });
      };
      const create = (): void => {
        if (submission.isWriting) return;
        const parsed = quickResult();
        if (parsed.issues.length > 0) {
          new Notice(parsed.issues.join("；"));
          return;
        }
        const title = parsed.title;
        if (!title) {
          new Notice("任务标题不能为空");
          return;
        }
        const target = parsed.projectId ? `dida:${parsed.projectId}` : select.value;
        const localTarget = parseLocalTaskDestination(target);
        if (localTarget) {
          if (parsed.tags.length > 0 || parsed.priority !== undefined || parsed.projectId) {
            new Notice("本地项目任务的标签、优先级与滴答清单属性请在任务编辑器中设置");
            return;
          }
          submit.disabled = true;
          void submission.run(async () => {
            await this.actions.createLocalProjectTask({
              ...localTarget,
              title,
            });
          })
            .then(() => {
              input.value = "";
              new Notice("任务已写入阶段计划行动");
            })
            .catch((error) => new Notice(messageOf(error), 8_000))
            .finally(() => {
              submit.disabled = false;
              void this.render();
            });
          return;
        }
        const targetProjectId = target.startsWith("dida:") ? target.slice(5) : target;
        if (this.state?.demoMode) {
          this.previewTasks = [
            ...this.previewTasks,
            {
              id: `sample-${crypto.randomUUID()}`,
              projectId: targetProjectId,
              title,
              status: 0,
              priority: parsed.priority ?? 0,
              tags: parsed.tags,
            },
          ];
          input.value = "";
          void this.render();
          return;
        }
        submit.disabled = true;
        void submission.run(() => this.service.createTask(title, targetProjectId, {
          priority: parsed.priority,
          tags: parsed.tags,
        }))
          .then((created) => {
            if (!created) return;
            input.value = "";
            new Notice("任务已安全写入同步队列");
          })
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error), 8_000))
          .finally(() => {
            submit.disabled = false;
            void this.render();
          });
      };
      submit.addEventListener("click", create);
      input.addEventListener("input", renderQuickPreview);
      bindTaskQuickSuggestions(
        input,
        composer,
        writableProjects,
        tasks.flatMap((task) => task.tags ?? []),
        renderQuickPreview,
      );
      input.addEventListener("keydown", (event) => {
        if (shouldSubmitTaskQuickEntryOnKey(event.key, event.isComposing)) create();
      });
    }
    this.renderTaskFilterToolbar(content, tasks, projects);
    if (this.taskViewMode === "kanban" && !this.taskCollectionFilters.didaProjectId) {
      this.taskViewMode = "list";
    }
    const selectedDidaProjectId = this.taskCollectionFilters.didaProjectId;
    this.taskViewModeSyncStatus = selectedDidaProjectId && !this.state?.demoMode
      ? await this.service.getDidaProjectViewModeSyncStatus(selectedDidaProjectId)
      : null;
    if (token !== this.renderToken) return;
    this.renderTaskViewToolbar(content);
    const helixProjectByTaskId = new Map<string, string>();
    for (const task of this.localProjectTaskSnapshot?.tasks ?? []) {
      helixProjectByTaskId.set(task.id, task.projectId);
    }
    let visibleTasks = filterTaskCollection(this.filterTasks(tasks), this.taskCollectionFilters, {
      anchor: new Date(),
      helixProjectByTaskId,
    });
    const taskTreeProgressSource = visibleTasks;
    if (this.hideCompletedTasks) {
      visibleTasks = visibleTasks.filter((task) => !isTaskCompleted(task));
    }
    const panel = content.createDiv({
      cls: "helix-task-view-panel",
      attr: {
        id: "helix-task-view-panel",
        role: "tabpanel",
        "aria-labelledby": `helix-task-view-tab-${this.taskViewMode}`,
      },
    });
    if (this.taskViewMode === "matrix") {
      this.renderTaskMatrix(panel, visibleTasks, taskProjects);
    } else if (this.taskViewMode === "kanban") {
      const project = projects.find(
        (candidate) => candidate.id === this.taskCollectionFilters.didaProjectId,
      );
      if (project) this.renderTaskBoard(panel, project, visibleTasks);
      else panel.createDiv({ cls: "helix-empty", text: "请先选择一个清单再打开看板。" });
    } else if (this.taskViewMode === "year") {
      this.renderTaskYearView(panel, visibleTasks);
    } else if (this.taskViewMode === "list") {
      const card = panel.createDiv({ cls: "helix-card helix-table-card" });
      if (visibleTasks.length === 0) card.createDiv({ cls: "helix-empty", text: "当前筛选没有任务。" });
      else this.renderTaskTree(card, visibleTasks, taskTreeProgressSource, taskProjects);
    } else {
      this.renderTaskCalendar(panel, visibleTasks, taskProjects, this.taskViewMode);
    }
  }

  private renderTaskTree(
    parent: HTMLElement,
    visibleTasks: DidaTask[],
    progressTasks: DidaTask[],
    projects: DidaProject[],
  ): void {
    this.taskTreeSource = progressTasks;
    const tree = parent.createDiv({ cls: "helix-task-tree" });
    const rootDrop = tree.createDiv({
      cls: "helix-task-tree-root-drop",
      text: "移到顶层",
      attr: { role: "button", "aria-label": "把拖动的任务移到顶层" },
    });
    this.bindTaskTreeDropTarget(rootDrop, null);
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const rows = flattenTaskTree(visibleTasks, {
      collapsedIds: this.collapsedTaskTreeIds,
      progressTasks,
    });
    const sourceIds = new Set(progressTasks.map((task) => task.id));
    for (const [taskId, cached] of this.taskTreeRows) {
      if (sourceIds.has(taskId)) continue;
      cached.element.remove();
      this.taskTreeRows.delete(taskId);
      this.collapsedTaskTreeIds.delete(taskId);
    }
    for (const item of rows) {
      const project = projectById.get(item.task.projectId);
      const localTask = this.localProjectTaskSnapshot?.byId.get(item.task.id);
      const stageParent = this.localProjectTaskSnapshot?.byRemoteParentTaskId.get(item.task.id);
      const signature = stableHash({ item, project, localTask, stageParent });
      let cached = this.taskTreeRows.get(item.task.id);
      if (!cached || cached.signature !== signature) {
        const staging = tree.ownerDocument.createElement("div");
        const element = this.renderTaskRow(
          staging,
          item.task,
          project,
          false,
          item.depth,
          item,
        );
        this.bindTaskTreeDrag(element, item.task);
        cached?.element.remove();
        cached = { element, signature };
        this.taskTreeRows.set(item.task.id, cached);
      }
      tree.append(cached.element);
    }
  }

  private bindTaskTreeDrag(row: HTMLElement, task: DidaTask): void {
    const localTask = this.localProjectTaskSnapshot?.byId.get(task.id);
    const projectionParent = this.localProjectTaskSnapshot?.byRemoteParentTaskId.get(task.id);
    const writable = task.id.startsWith("sample-") || (
      !localTask && !projectionParent && DIDA_TASK_WRITE_AVAILABLE &&
      (this.state?.taskCrudVerified ?? false) && (this.state?.taskParentingVerified ?? false)
    );
    if (!writable) return;
    row.draggable = true;
    row.addClass("is-tree-draggable");
    row.setAttribute("title", "拖到另一任务可调整父级；拖到顶部区域可移到顶层");
    row.addEventListener("dragstart", (event) => {
      this.taskTreeDrag = { taskId: task.id };
      row.addClass("is-dragging");
      row.closest(".helix-task-tree")?.addClass("is-reparenting");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
      }
    });
    row.addEventListener("dragend", () => this.finishTaskTreeDrag());
    this.bindTaskTreeDropTarget(row, task.id);
  }

  private bindTaskTreeDropTarget(target: HTMLElement, parentId: string | null): void {
    if (parentId && target.matches(".helix-task-row") &&
      !target.querySelector(".helix-task-tree-drop-label")) {
      target.createSpan({ cls: "helix-task-tree-drop-label", text: "设为此任务的子任务" });
    }
    target.addEventListener("dragover", (event) => {
      const dragged = this.taskTreeDrag;
      if (!dragged || !canReparentTask(this.taskTreeSource, dragged.taskId, parentId)) return;
      event.preventDefault();
      target.addClass("is-task-tree-drop-target");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    target.addEventListener("dragleave", (event) => {
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      target.removeClass("is-task-tree-drop-target");
    });
    target.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      target.removeClass("is-task-tree-drop-target");
      const dragged = this.taskTreeDrag;
      if (!dragged || !canReparentTask(this.taskTreeSource, dragged.taskId, parentId)) return;
      this.finishTaskTreeDrag();
      void this.reparentTask(dragged.taskId, parentId).catch((error) => {
        new Notice(messageOf(error), 8_000);
        void this.render();
      });
    });
  }

  private finishTaskTreeDrag(): void {
    this.taskTreeDrag = null;
    this.contentEl.querySelectorAll(
      ".helix-task-tree.is-reparenting, .is-task-tree-drop-target, .helix-task-row.is-dragging",
    )
      .forEach((element) => {
        element.removeClass("is-reparenting");
        element.removeClass("is-task-tree-drop-target");
        element.removeClass("is-dragging");
      });
  }

  private async reparentTask(taskId: string, parentId: string | null): Promise<void> {
    const task = this.taskTreeSource.find((candidate) => candidate.id === taskId);
    if (!task || !canReparentTask(this.taskTreeSource, taskId, parentId)) {
      new Notice("不能把任务移动到自身或其后代下面", 5_000);
      return;
    }
    if ((task.parentId ?? null) === parentId) return;
    if (task.id.startsWith("sample-")) {
      this.previewTasks = this.previewTasks.map((candidate) =>
        candidate.id === task.id ? { ...candidate, parentId } : candidate);
      await this.render();
      return;
    }
    await this.service.queueTaskUpdate({ ...task, parentId }, "update", ["parentId"]);
    new Notice(parentId ? "子任务层级已加入同步队列" : "任务已移到顶层并加入同步队列");
    await this.render();
  }

  private renderTaskBoard(
    content: HTMLElement,
    project: DidaProject,
    tasks: DidaTask[],
  ): void {
    const boardState = {
      connected: !!this.state?.connected,
      demoMode: !!this.state?.demoMode,
      boardPlacementVerified: !!this.state?.boardPlacementVerified,
    };
    const boardAvailability = taskBoardMoveAvailability(
      boardState,
      project,
      tasks[0]?.columnId,
    );
    const status = content.createDiv({ cls: "helix-task-board-status" });
    const lock = status.createSpan();
    setIcon(lock, project.boardStale ? "cloud-off" : "lock-keyhole");
    status.createSpan({
      text: project.boardStale
        ? `详情已过期 · ${formatBoardCapturedAt(project.boardCapturedAt)} · 看板写入已禁用`
        : boardAvailability.enabled
          ? `已同步滴答分栏 · ${formatBoardCapturedAt(project.boardCapturedAt)} · 拖动卡片即可同步归栏`
          : `已同步滴答分栏 · ${formatBoardCapturedAt(project.boardCapturedAt)} · ${boardAvailability.reason}`,
    });
    const columnLabels = taskBoardColumnLabels(project.columns ?? []);
    const board = content.createDiv({ cls: "helix-task-board" });
    const moveTask = (taskId: string, targetColumnId: string): void => {
      void commitTaskBoardMove(
        targetColumnId,
        (columnId) => this.service.moveTaskToBoardColumn(project.id, taskId, columnId),
        async () => {
          new Notice("任务分栏已与滴答同步");
          await this.render();
        },
      ).catch((error) => {
        new Notice(messageOf(error), 8_000);
      });
    };
    for (const column of buildTaskBoard(project, tasks)) {
      const lane = board.createEl("section", {
        cls: `helix-task-board-column${column.source ? "" : " is-unassigned"}`,
        attr: { "aria-labelledby": `helix-task-board-column-${column.id}` },
      });
      const heading = lane.createDiv({ cls: "helix-task-board-column-head" });
      heading.createEl("h3", {
        text: column.source ? columnLabels.get(column.source.id) ?? column.title : column.title,
        attr: { id: `helix-task-board-column-${column.id}` },
      });
      heading.createSpan({ text: String(column.tasks.length) });
      const items = lane.createDiv({ cls: "helix-task-board-items" });
      const targetColumnId = column.source?.id;
      lane.addEventListener("dragover", (event) => {
        const target = taskBoardDropTarget(this.taskBoardDrag?.sourceColumnId, targetColumnId);
        if (!this.taskBoardDrag || !target) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        lane.addClass("is-drop-target");
      });
      lane.addEventListener("dragleave", (event) => {
        if (event.relatedTarget instanceof Node && lane.contains(event.relatedTarget)) return;
        lane.removeClass("is-drop-target");
      });
      lane.addEventListener("drop", (event) => {
        event.preventDefault();
        lane.removeClass("is-drop-target");
        const dragged = this.taskBoardDrag;
        this.taskBoardDrag = null;
        const target = taskBoardDropTarget(dragged?.sourceColumnId, targetColumnId);
        if (!dragged || !target) return;
        moveTask(dragged.taskId, target);
      });
      if (column.tasks.length === 0) items.createDiv({ cls: "helix-task-board-empty", text: "暂无任务" });
      for (const task of column.tasks) {
        const card = items.createDiv({ cls: "helix-task-board-card" });
        const availability = taskBoardMoveAvailability(
          boardState,
          project,
          task.columnId,
        );
        card.draggable = availability.enabled;
        card.setAttribute("title", availability.reason);
        if (availability.enabled) {
          card.addClass("is-draggable");
          card.setAttribute("role", "group");
          card.setAttribute("tabindex", "0");
          card.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight");
          card.setAttribute(
            "aria-label",
            `任务“${task.title}”，当前${task.columnId
              ? columnLabels.get(task.columnId) ?? "未知分栏"
              : "未分栏"}。可拖动；按 Alt 加左右方向键移动到相邻分栏`,
          );
          card.addEventListener("dragstart", (event) => {
            this.taskBoardDrag = { taskId: task.id, sourceColumnId: task.columnId };
            card.addClass("is-dragging");
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", task.id);
            }
          });
          card.addEventListener("dragend", () => {
            this.taskBoardDrag = null;
            card.removeClass("is-dragging");
            board.querySelectorAll(".is-drop-target")
              .forEach((element) => element.removeClass("is-drop-target"));
          });
          card.addEventListener("keydown", (event) => {
            if (
              event.target !== card ||
              !event.altKey ||
              (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
            ) return;
            event.preventDefault();
            const target = taskBoardKeyboardTarget(
              project.columns ?? [],
              task.columnId,
              event.key === "ArrowLeft" ? "left" : "right",
            );
            if (!target) {
              new Notice(event.key === "ArrowLeft" ? "已经位于最左分栏" : "已经位于最右分栏");
              return;
            }
            moveTask(task.id, target);
          });
        }
        this.renderTaskRow(card, task, project, false);
      }
    }
  }

  private renderTaskFilterToolbar(
    content: HTMLElement,
    tasks: DidaTask[],
    didaProjects: DidaProject[],
  ): void {
    const linkedProjects = [...new Map(
      (this.localProjectTaskSnapshot?.destinations ?? []).map((project) => [
        project.projectId,
        {
          id: project.projectId,
          title: project.projectTitle,
          ...(project.projectColor ? { color: project.projectColor } : {}),
        },
      ] as const),
    ).values()].sort((left, right) => left.title.localeCompare(right.title));
    const tags = [...new Set(tasks.flatMap((task) => task.tags ?? []))]
      .sort((left, right) => left.localeCompare(right));
    const didaProjectIds = new Set(didaProjects.map((project) => project.id));
    const linkedProjectIds = new Set(linkedProjects.map((project) => project.id));
    const availableTags = new Set(tags);
    if (this.taskCollectionFilters.didaProjectId &&
      !didaProjectIds.has(this.taskCollectionFilters.didaProjectId)) {
      this.taskCollectionFilters.didaProjectId = undefined;
    }
    if (this.taskCollectionFilters.helixProjectId &&
      this.taskCollectionFilters.helixProjectId !== "unlinked" &&
      !linkedProjectIds.has(this.taskCollectionFilters.helixProjectId)) {
      this.taskCollectionFilters.helixProjectId = undefined;
    }
    if (this.taskCollectionFilters.tag && !availableTags.has(this.taskCollectionFilters.tag)) {
      this.taskCollectionFilters.tag = undefined;
    }
    const toolbar = content.createDiv({ cls: "helix-task-filter-toolbar" });
    const statuses = toolbar.createDiv({ cls: "helix-filter-row", attr: { role: "group", "aria-label": "任务状态" } });
    for (const [id, label] of [
      ["all", "全部"],
      ["idea", "想法"],
      ["active", "进行中"],
      ["completed", "已完成"],
      ["paused", "已暂停"],
      ["terminated", "已终止"],
    ] as const) {
      const button = statuses.createEl("button", {
        text: label,
        cls: this.taskFilter === id ? "is-active" : "",
        attr: {
          id: `helix-task-status-filter-${id}`,
          "aria-pressed": String(this.taskFilter === id),
        },
      });
      button.addEventListener("click", () => {
        this.taskFilter = id;
        if (id === "completed") this.hideCompletedTasks = false;
        this.renderAndRestoreFocus(`helix-task-status-filter-${id}`);
      });
    }
    const completedVisibility = statuses.createEl("button", {
      cls: this.hideCompletedTasks ? "is-active" : "",
      attr: {
        id: "helix-task-hide-completed",
        "aria-pressed": String(this.hideCompletedTasks),
        title: this.hideCompletedTasks ? "显示已完成任务" : "隐藏已完成任务",
      },
    });
    const completedVisibilityIcon = completedVisibility.createSpan();
    setIcon(completedVisibilityIcon, this.hideCompletedTasks ? "eye" : "eye-off");
    completedVisibility.createSpan({
      text: this.hideCompletedTasks ? "显示已完成" : "隐藏已完成",
    });
    completedVisibility.addEventListener("click", () => {
      this.hideCompletedTasks = !this.hideCompletedTasks;
      this.renderAndRestoreFocus("helix-task-hide-completed");
    });
    const searchWrap = toolbar.createDiv({ cls: "helix-task-search" });
    const searchIcon = searchWrap.createSpan();
    setIcon(searchIcon, "search");
    const search = searchWrap.createEl("input", {
      type: "search",
      value: this.taskCollectionFilters.query ?? "",
      placeholder: "搜索任务和备注",
      attr: { id: "helix-task-search", "aria-label": "搜索任务标题、备注和检查项" },
    });
    let composing = false;
    search.addEventListener("compositionstart", () => { composing = true; });
    search.addEventListener("compositionend", () => {
      composing = false;
      this.taskCollectionFilters.query = search.value || undefined;
      this.scheduleTaskSearchRender();
    });
    search.addEventListener("input", () => {
      this.taskCollectionFilters.query = search.value || undefined;
      if (!composing) this.scheduleTaskSearchRender();
    });
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !search.value) return;
      event.preventDefault();
      this.taskCollectionFilters.query = undefined;
      this.renderAndRestoreFocus("helix-task-search");
    });
    const advancedCount = this.taskAdvancedFilterCount();
    const advanced = toolbar.createEl("button", {
      cls: `helix-task-advanced-toggle${this.advancedTaskFiltersExpanded ? " is-active" : ""}`,
      attr: {
        id: "helix-task-advanced-toggle",
        "aria-expanded": String(this.advancedTaskFiltersExpanded),
        "aria-controls": "helix-task-advanced-filters",
      },
    });
    const advancedIcon = advanced.createSpan();
    setIcon(advancedIcon, "sliders-horizontal");
    advanced.createSpan({ text: "高级筛选" });
    if (advancedCount > 0) advanced.createSpan({ cls: "helix-task-filter-count", text: String(advancedCount) });
    advanced.addEventListener("click", () => {
      this.advancedTaskFiltersExpanded = !this.advancedTaskFiltersExpanded;
      this.renderAndRestoreFocus("helix-task-advanced-toggle");
    });
    if (!this.advancedTaskFiltersExpanded) return;
    const bar = content.createDiv({
      cls: "helix-task-filter-bar",
      attr: { id: "helix-task-advanced-filters" },
    });
    this.renderTaskFilterSelect(bar, "helix-task-filter-helix", "Helix 项目", this.taskCollectionFilters.helixProjectId ?? "", [
      ["", "全部项目"],
      ...linkedProjects.map((project): [string, string] => [project.id, project.title]),
      ["unlinked", "未关联"],
    ], (value) => {
      this.taskCollectionFilters.helixProjectId = value || undefined;
    });
    this.renderTaskFilterSelect(bar, "helix-task-filter-tag", "标签", this.taskCollectionFilters.tag ?? "", [
      ["", "全部标签"],
      ...tags.map((tag): [string, string] => [tag, `# ${tag}`]),
    ], (value) => {
      this.taskCollectionFilters.tag = value || undefined;
    });
    this.renderTaskFilterSelect(bar, "helix-task-filter-priority", "优先级", this.taskCollectionFilters.priority ?? "", [
      ["", "全部优先级"],
      ["5", "高优先级"],
      ["3", "中优先级"],
      ["1", "低优先级"],
      ["0", "无优先级"],
    ], (value) => {
      this.taskCollectionFilters.priority = value
        ? value as TaskCollectionFilters["priority"]
        : undefined;
    });
    this.renderTaskFilterSelect(bar, "helix-task-filter-date", "日期", this.taskCollectionFilters.date, [
      ["all", "全部日期"],
      ["overdue", "已逾期"],
      ["today", "今天"],
      ["next-seven-days", "未来 7 天（含今天）"],
      ["undated", "无日期"],
    ], (value) => {
      this.taskCollectionFilters.date = value as TaskCollectionFilters["date"];
    });
    if (advancedCount > 0) {
      const clear = bar.createEl("button", { cls: "helix-task-filter-clear", text: "清除高级筛选" });
      clear.addEventListener("click", () => {
        this.taskCollectionFilters = {
          didaProjectId: this.taskCollectionFilters.didaProjectId,
          query: this.taskCollectionFilters.query,
          date: "all",
        };
        this.renderAndRestoreFocus("helix-task-advanced-toggle");
      });
    }
  }

  private taskAdvancedFilterCount(): number {
    return Number(Boolean(this.taskCollectionFilters.helixProjectId)) +
      Number(Boolean(this.taskCollectionFilters.tag)) +
      Number(this.taskCollectionFilters.priority !== undefined) +
      Number(this.taskCollectionFilters.date !== "all");
  }

  private scheduleTaskSearchRender(): void {
    if (this.taskSearchTimer !== null) window.clearTimeout(this.taskSearchTimer);
    this.taskSearchTimer = window.setTimeout(() => {
      this.taskSearchTimer = null;
      this.renderAndRestoreFocus("helix-task-search");
    }, 160);
  }

  private renderTaskFilterSelect(
    parent: HTMLElement,
    id: string,
    label: string,
    value: string,
    options: Array<[string, string]>,
    onChange: (value: string) => void,
  ): void {
    const field = parent.createEl("label", { cls: "helix-task-filter-field" });
    field.createSpan({ text: label });
    const select = field.createEl("select", { attr: { id, "aria-label": label } });
    for (const [optionValue, optionLabel] of options) {
      select.createEl("option", { value: optionValue, text: optionLabel });
    }
    select.value = value;
    select.addEventListener("change", () => {
      onChange(select.value);
      this.renderAndRestoreFocus(id);
    });
  }

  private renderAndRestoreFocus(id: string): void {
    void this.render().then(() => {
      const element = this.containerEl.querySelector<HTMLElement>(`#${id}`);
      element?.focus();
      if (element instanceof HTMLInputElement) {
        element.setSelectionRange(element.value.length, element.value.length);
      }
    });
  }

  private renderTaskViewToolbar(content: HTMLElement): void {
    const toolbar = content.createDiv({ cls: "helix-task-view-toolbar" });
    const modes: Array<{ id: TaskViewMode; label: string }> = [
      { id: "list", label: "列表" },
      ...(this.taskCollectionFilters.didaProjectId
        ? [{ id: "kanban" as const, label: "看板" }]
        : []),
      { id: "day", label: "日" },
      { id: "three-day", label: "3 日" },
      { id: "week", label: "周" },
      { id: "month", label: "月" },
      { id: "year", label: "年" },
      { id: "matrix", label: "四象限" },
    ];
    const tabs = toolbar.createDiv({
      cls: "helix-task-view-tabs",
      attr: { role: "tablist", "aria-label": "任务视图" },
    });
    for (const [index, mode] of modes.entries()) {
      const button = tabs.createEl("button", {
        text: mode.label,
        cls: this.taskViewMode === mode.id ? "is-active" : "",
        attr: {
          id: `helix-task-view-tab-${mode.id}`,
          role: "tab",
          "aria-selected": String(this.taskViewMode === mode.id),
          "aria-controls": "helix-task-view-panel",
          tabindex: this.taskViewMode === mode.id ? "0" : "-1",
        },
      });
      button.addEventListener("click", () => {
        this.activateTaskViewMode(mode.id);
      });
      button.addEventListener("keydown", (event) => {
        const targetIndex = event.key === "ArrowRight"
          ? (index + 1) % modes.length
          : event.key === "ArrowLeft"
            ? (index - 1 + modes.length) % modes.length
            : event.key === "Home" ? 0 : event.key === "End" ? modes.length - 1 : undefined;
        if (targetIndex === undefined) return;
        event.preventDefault();
        this.activateTaskViewMode(modes[targetIndex]!.id);
      });
    }
    const project = this.state?.projects.find(
      (candidate) => candidate.id === this.taskCollectionFilters.didaProjectId,
    );
    if ((this.taskViewMode === "list" || this.taskViewMode === "kanban") && project && !this.state?.demoMode) {
      this.renderDidaViewModeSyncControl(toolbar, project, this.taskViewMode);
    }
    if (this.taskViewMode === "list" || this.taskViewMode === "kanban" || this.taskViewMode === "matrix") return;
    const navigation = toolbar.createDiv({ cls: "helix-task-view-navigation" });
    const previous = navigation.createEl("button", { attr: { "aria-label": "上一时间段" } });
    setIcon(previous, "chevron-left");
    previous.addEventListener("click", () => this.shiftTaskViewDate(-1));
    navigation.createEl("button", { text: "今天" }).addEventListener("click", () => {
      this.taskViewDate = new Date();
      void this.render();
    });
    const next = navigation.createEl("button", { attr: { "aria-label": "下一时间段" } });
    setIcon(next, "chevron-right");
    next.addEventListener("click", () => this.shiftTaskViewDate(1));
  }

  private activateTaskViewMode(mode: TaskViewMode): void {
    this.taskViewMode = mode;
    void this.render().then(() => {
      this.contentEl.querySelector<HTMLElement>(`#helix-task-view-tab-${mode}`)?.focus();
    });
  }

  private renderDidaViewModeSyncControl(
    toolbar: HTMLElement,
    project: DidaProject,
    mode: "list" | "kanban",
  ): void {
    if (!DIDA_TASK_WRITE_AVAILABLE) return;
    const status = this.taskViewModeSyncStatus;
    const syncing = this.taskViewModeSyncingProjectId === project.id;
    const matchesRemote = project.viewMode === mode;
    const permissionDenied = !!project.permission && project.permission !== "write";
    const disabled = syncing || permissionDenied || !!project.boardStale ||
      project.id.startsWith("local-project-") || status === "pending" ||
      status === "conflict" || status === "attention";
    const label = syncing
      ? "正在同步…"
      : status === "pending"
        ? "等待联网同步"
        : status === "conflict"
          ? "默认视图有冲突"
          : status === "attention"
            ? "同步需要处理"
            : matchesRemote
              ? "滴答默认视图"
              : "设为滴答默认";
    const button = toolbar.createEl("button", {
      cls: `helix-task-view-remote${matchesRemote && status === "synced" ? " is-synced" : ""}`,
      text: label,
      attr: {
        "aria-label": `${label}：${mode === "kanban" ? "看板" : "列表"}`,
        title: permissionDenied
          ? "该清单没有写入权限"
          : project.boardStale
            ? "清单详情已过期，请先同步"
            : status === "conflict" || status === "attention"
              ? "请在冲突页处理后再试"
              : "",
      },
    });
    button.disabled = disabled || (matchesRemote && status === "synced");
    if (button.disabled) return;
    button.addEventListener("click", () => {
      this.taskViewModeSyncingProjectId = project.id;
      void this.service.setDidaProjectViewMode(project.id, mode)
        .then(() => {
          new Notice(this.state?.connected ? "已同步滴答默认视图" : "已加入队列，将在联网后同步");
        })
        .catch((error) => new Notice(error instanceof Error ? error.message : String(error), 8_000))
        .finally(() => {
          this.taskViewModeSyncingProjectId = null;
          void this.render();
        });
    });
  }

  private shiftTaskViewDate(direction: -1 | 1): void {
    const next = new Date(this.taskViewDate);
    if (this.taskViewMode === "year") next.setFullYear(next.getFullYear() + direction, 0, 1);
    else if (this.taskViewMode === "month") next.setMonth(next.getMonth() + direction, 1);
    else if (this.taskViewMode === "week") next.setDate(next.getDate() + direction * 7);
    else if (this.taskViewMode === "three-day") next.setDate(next.getDate() + direction * 3);
    else next.setDate(next.getDate() + direction);
    this.taskViewDate = next;
    void this.render();
  }

  private renderTaskCalendar(
    content: HTMLElement,
    tasks: DidaTask[],
    projects: DidaProject[],
    mode: Extract<TaskViewMode, "day" | "three-day" | "week" | "month">,
  ): void {
    if (mode === "day" || mode === "three-day") {
      this.renderTaskTimeGrid(content, tasks, projects, mode);
      return;
    }
    const range = buildTaskDateRange(mode, this.taskViewDate);
    const grouped = mode === "week" ? groupTasksByViewDay(tasks, range) : undefined;
    const timeBlocks = mode === "month" ? buildTaskTimeBlocks(tasks, range) : undefined;
    const card = content.createDiv({ cls: `helix-card helix-task-calendar is-${mode}` });
    card.createDiv({
      cls: "helix-task-calendar-range",
      text: taskRangeLabel(range, mode, this.taskViewDate),
    });
    const weekdays = card.createDiv({ cls: "helix-task-calendar-weekdays" });
    for (const label of ["一", "二", "三", "四", "五", "六", "日"]) {
      weekdays.createDiv({ text: label });
    }
    const grid = card.createDiv({ cls: "helix-task-calendar-grid" });
    for (const day of range.days) {
      const cell = grid.createDiv({
        cls: `helix-task-calendar-day${day.inAnchorMonth ? "" : " is-outside"}` +
          `${day.key === localDateKey(new Date()) ? " is-today" : ""}`,
      });
      const header = cell.createDiv({ cls: "helix-task-calendar-day-head" });
      header.createEl("strong", {
        text: String(day.date.getDate()),
      });
      const dayEntries = timeBlocks
        ? (timeBlocks.get(day.key) ?? []).map((block) => ({
          task: block.task,
          timeLabel: block.allDay ? undefined : minuteLabel(block.startMinute),
        }))
        : (grouped?.get(day.key) ?? []).map((task) => ({ task, timeLabel: undefined }));
      header.createSpan({ text: dayEntries.length > 0 ? String(dayEntries.length) : "" });
      const list = cell.createDiv({ cls: "helix-task-calendar-items" });
      for (const entry of dayEntries) {
        this.renderTaskCalendarChip(
          list,
          entry.task,
          projects.find((project) => project.id === entry.task.projectId),
          mode === "month",
          day.key,
          entry.timeLabel,
        );
      }
    }
  }

  private renderTaskCalendarChip(
    parent: HTMLElement,
    task: DidaTask,
    project: DidaProject | undefined,
    compact: boolean,
    dayKey: string,
    timeLabel?: string,
  ): void {
    const chip = parent.createEl("button", {
      cls: `helix-task-calendar-chip${task.status === 2 ? " is-completed" : ""}` +
        `${task.isAllDay && timeLabel === undefined ? " is-all-day" : ""}${compact ? " is-compact" : ""}`,
      attr: { "aria-label": `编辑任务：${task.title}，${dayKey}` },
    });
    const dot = chip.createSpan({ cls: "helix-project-dot" });
    dot.style.backgroundColor = project?.color ?? "#8891a7";
    chip.createSpan({ cls: "helix-task-calendar-chip-title", text: task.title });
    if (timeLabel !== undefined) {
      chip.createSpan({ cls: "helix-task-calendar-chip-time", text: timeLabel });
    } else if (!compact && !task.isAllDay && (task.startDate || task.dueDate)) {
      chip.createSpan({
        cls: "helix-task-calendar-chip-time",
        text: formatHour(task.startDate ?? task.dueDate!, task.timeZone),
      });
    }
    chip.addEventListener("click", () => {
      if (task.id.startsWith("sample-")) {
        this.renderTaskPreviewEditor(task);
      } else if (this.localProjectTaskSnapshot?.byId.has(task.id)) {
        this.openLocalProjectTaskEditor(this.localProjectTaskSnapshot.byId.get(task.id)!);
      } else {
        void this.openTaskEditor(task, this.state?.projects ?? []);
      }
    });
  }

  private renderTaskPreviewEditor(task: DidaTask): void {
    this.openPreviewTaskEditor(task);
  }

  private renderTaskTimeGrid(
    content: HTMLElement,
    tasks: DidaTask[],
    projects: DidaProject[],
    mode: Extract<TaskViewMode, "day" | "three-day">,
  ): void {
    const range = buildTaskDateRange(mode, this.taskViewDate);
    const blocks = buildTaskTimeBlocks(tasks, range);
    const card = content.createDiv({ cls: `helix-card helix-task-time-block is-${mode}` });
    const heading = card.createDiv({ cls: "helix-task-time-block-heading" });
    heading.createEl("strong", {
      text: taskRangeLabel(range, mode, this.taskViewDate),
    });
    const frame = card.createDiv({ cls: "helix-task-time-frame" });
    const allDayGrid = frame.createDiv({ cls: "helix-task-time-all-day" });
    allDayGrid.style.setProperty("--helix-time-days", String(range.days.length));
    allDayGrid.createDiv({ cls: "helix-task-time-all-day-label", text: "全天" });
    for (const day of range.days) {
      const cell = allDayGrid.createDiv({ cls: "helix-task-time-all-day-cell" });
      cell.createEl("strong", { text: `${weekdayLabel(day.date)} ${day.date.getMonth() + 1}/${day.date.getDate()}` });
      for (const block of (blocks.get(day.key) ?? []).filter((candidate) => candidate.allDay)) {
        this.renderTaskCalendarChip(
          cell,
          block.task,
          projects.find((project) => project.id === block.task.projectId),
          true,
          day.key,
        );
      }
    }
    const scroll = frame.createDiv({ cls: "helix-task-time-scroll" });
    const gutter = scroll.createDiv({ cls: "helix-task-time-gutter" });
    for (let hour = 0; hour < 24; hour += 1) {
      gutter.createSpan({ text: `${String(hour).padStart(2, "0")}:00` });
    }
    const days = scroll.createDiv({ cls: "helix-task-time-days" });
    days.style.setProperty("--helix-time-days", String(range.days.length));
    for (const day of range.days) {
      const column = days.createDiv({ cls: "helix-task-time-day" });
      for (let hour = 0; hour < 24; hour += 1) column.createDiv({ cls: "helix-task-time-hour" });
      for (const block of (blocks.get(day.key) ?? []).filter((candidate) => !candidate.allDay)) {
        const item = column.createEl("button", {
          cls: `helix-task-time-item${block.task.status === 2 ? " is-completed" : ""}`,
          attr: {
            "aria-label": `编辑任务：${block.task.title}，${day.key} ${minuteLabel(block.startMinute)} 至 ${minuteLabel(block.endMinute)}`,
          },
        });
        const top = block.startMinute / 1_440 * 100;
        const height = Math.max(30, block.endMinute - block.startMinute) / 1_440 * 100;
        item.style.top = `${top}%`;
        item.style.height = `${height}%`;
        item.style.left = `${block.lane / block.laneCount * 100}%`;
        item.style.width = `${100 / block.laneCount}%`;
        const project = projects.find((candidate) => candidate.id === block.task.projectId);
        item.style.setProperty("--helix-task-color", project?.color ?? "#8891a7");
        item.createSpan({ cls: "helix-task-time-item-title", text: block.task.title });
        item.createSpan({
          cls: "helix-task-time-item-time",
          text: `${minuteLabel(block.startMinute)}–${minuteLabel(block.endMinute)}`,
        });
        item.addEventListener("click", () => {
          if (block.task.id.startsWith("sample-")) this.renderTaskPreviewEditor(block.task);
          else if (this.localProjectTaskSnapshot?.byId.has(block.task.id)) {
            this.openLocalProjectTaskEditor(this.localProjectTaskSnapshot.byId.get(block.task.id)!);
          }
          else void this.openTaskEditor(block.task, this.state?.projects ?? []);
        });
      }
    }
  }

  private renderTaskYearView(content: HTMLElement, tasks: DidaTask[]): void {
    const summary = buildTaskYearSummary(tasks, this.taskViewDate);
    const maxScheduled = Math.max(1, ...summary.map((month) => month.scheduled));
    const card = content.createDiv({ cls: "helix-card helix-task-year" });
    card.createDiv({
      cls: "helix-task-year-heading",
      text: `${this.taskViewDate.getFullYear()} 年`,
    });
    const grid = card.createDiv({ cls: "helix-task-year-grid" });
    for (const month of summary) {
      const button = grid.createEl("button", {
        cls: `helix-task-year-month${month.month === new Date().getMonth() + 1 && this.taskViewDate.getFullYear() === new Date().getFullYear() ? " is-current" : ""}`,
        attr: { "aria-label": `${month.month} 月，${month.scheduled} 项，${month.completed} 项已完成` },
      });
      const top = button.createDiv({ cls: "helix-task-year-month-head" });
      top.createEl("strong", { text: `${month.month} 月` });
      top.createSpan({ text: `${month.scheduled} 项` });
      const meter = button.createDiv({ cls: "helix-task-year-meter" });
      meter.createSpan().style.width = `${month.scheduled / maxScheduled * 100}%`;
      const stats = button.createDiv({ cls: "helix-task-year-stats" });
      stats.createSpan({ text: `${month.open} 待完成` });
      stats.createSpan({ text: `${month.completed} 已完成` });
      button.addEventListener("click", () => {
        this.taskViewDate = new Date(this.taskViewDate.getFullYear(), month.month - 1, 1);
        this.activateTaskViewMode("month");
      });
    }
  }

  private renderTaskMatrix(
    content: HTMLElement,
    tasks: DidaTask[],
    projects: DidaProject[],
  ): void {
    const rules = this.actions.getTaskMatrixRules();
    const ruleBar = content.createDiv({ cls: "helix-task-matrix-rules" });
    this.renderMatrixRuleSelect(ruleBar, "helix-task-matrix-important", "重要", String(rules.importantPriorityThreshold), [
      ["5", "高优先级"],
      ["3", "中优先级及以上"],
      ["1", "低优先级及以上"],
    ], (value) => ({
      ...this.actions.getTaskMatrixRules(),
      importantPriorityThreshold: Number(value) as 1 | 3 | 5,
    }));
    this.renderMatrixRuleSelect(ruleBar, "helix-task-matrix-urgent", "紧急", String(rules.urgentWithinDays), [
      ["0", "今天及逾期"],
      ["1", "未来 1 天内"],
      ["3", "未来 3 天内"],
      ["7", "未来 7 天内"],
    ], (value) => ({ ...this.actions.getTaskMatrixRules(), urgentWithinDays: Number(value) as 0 | 1 | 3 | 7 }));
    const matrix = content.createDiv({ cls: "helix-task-matrix" });
    for (const quadrant of buildTaskMatrix(tasks, new Date(), rules)) {
      const card = matrix.createDiv({ cls: `helix-card helix-task-quadrant is-${quadrant.id}` });
      const header = card.createDiv({ cls: "helix-task-quadrant-head" });
      header.createEl("h3", { text: quadrant.title });
      header.createSpan({ text: String(quadrant.tasks.length) });
      const list = card.createDiv();
      if (quadrant.tasks.length === 0) list.createDiv({ cls: "helix-empty", text: "暂无任务" });
      for (const task of quadrant.tasks) {
        this.renderTaskRow(
          list,
          task,
          projects.find((project) => project.id === task.projectId),
          false,
        );
      }
    }
  }

  private renderMatrixRuleSelect(
    parent: HTMLElement,
    id: string,
    label: string,
    value: string,
    options: Array<[string, string]>,
    nextRules: (value: string) => TaskMatrixRules,
  ): void {
    const field = parent.createEl("label");
    field.createSpan({ text: label });
    const select = field.createEl("select", { attr: { id, "aria-label": `四象限${label}规则` } });
    for (const [optionValue, optionLabel] of options) {
      select.createEl("option", { value: optionValue, text: optionLabel });
    }
    select.value = value;
    select.addEventListener("change", () => {
      select.disabled = true;
      void this.actions.updateTaskMatrixRules(nextRules(select.value))
        .then(() => this.renderAndRestoreFocus(id))
        .catch((error) => {
          select.disabled = false;
          select.value = value;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  private async renderProjects(
    content: HTMLElement,
    token: number,
  ): Promise<ProjectLineageWorkbench | null> {
    let workspace: ProjectWorkspaceSnapshot;
    try {
      workspace = await this.actions.readProjectWorkspace(() =>
        this.actions.projectWorkspace.loadStableWorkspace());
    } catch (error) {
      if (token !== this.renderToken) return null;
      this.renderProjectReadOnlyFallback(content, error);
      return null;
    }
    if (token !== this.renderToken) return null;
    this.lastGoodProjectWorkspace = workspace;
    if (workspace.migrationRequired) {
      const migration = content.createDiv({ cls: "helix-card helix-migration-card" });
      const migrationIcon = migration.createSpan();
      setIcon(migrationIcon, "triangle-alert");
      const migrationCopy = migration.createDiv();
      migrationCopy.createEl("strong", { text: "检测到旧项目谱系，未自动转换" });
      migrationCopy.createEl("p", {
        text: workspace.migrationRequired
          ? `${workspace.migrationItems.length} 项旧数据需要逐项确认。`
          : "旧数据已保留；关系未自动推断。",
      });
      const details = migration.createEl("details");
      details.createEl("summary", { text: "查看待迁移项" });
      const list = details.createEl("ul");
      for (const warning of workspace.migrationWarnings) {
        list.createEl("li", { text: warning });
      }
      const review = migration.createEl("button", {
        cls: "helix-primary-button",
        text: "逐项预览并确认",
      });
      review.addEventListener("click", () => this.actions.reviewLegacyMigration());
      return null;
    }

    if (workspace.canvasRepairRequired && !canSilentlyRepairProjectCanvas(workspace)) {
      const repair = content.createDiv({ cls: "helix-card helix-migration-card" });
      repair.createEl("strong", { text: "Canvas 需要修复" });
      const reasons = repair.createEl("ul");
      for (const reason of workspace.canvasRepairReasons ?? []) {
        reasons.createEl("li", { text: reason });
      }
      const apply = repair.createEl("button", {
        cls: "helix-primary-button",
        text: "修复 Canvas",
      });
      apply.addEventListener("click", () => {
        apply.disabled = true;
        void this.actions.repairProjectCanvas()
          .then(() => this.render())
          .catch((error) => {
            apply.disabled = false;
            new Notice(error instanceof Error ? error.message : String(error), 8_000);
          });
      });
    }

    if (workspace.projects.length === 0) {
      const empty = content.createDiv({ cls: "helix-card helix-project-empty" });
      const emptyIcon = empty.createDiv();
      setIcon(emptyIcon, "layout-dashboard");
      empty.createEl("h3", { text: "从第一个项目开始" });
      const emptyAction = empty.createEl("button", {
        cls: "helix-primary-button",
        text: "新建项目并加入 Canvas",
      });
      emptyAction.addEventListener("click", () => this.actions.createProject());
      return null;
    }

    if (
      this.selectedProjectId === undefined ||
      (
        this.selectedProjectId !== null &&
        !workspace.projects.some((project) => project.id === this.selectedProjectId)
      )
    ) {
      this.selectedProjectId = workspace.projects[0]!.id;
    }
    const lifecycleGeneration = this.viewGeneration;
    this.renderNativeRelationCandidates(
      content,
      workspace,
      lifecycleGeneration,
    );
    content.addClass("is-project-workbench-content");
    const workbenchHost = content.createDiv({ cls: "helix-project-workbench-host" });
    const focusEntityId = this.currentLineageFocusId();
    const arrivalCycleId = this.pendingKanbanArrivalCycleId ?? undefined;
    this.pendingKanbanArrivalCycleId = null;
    let workbench: ProjectLineageWorkbench;
    workbench = new ProjectLineageWorkbench({
      snapshot: workspace,
      selectedProjectId: this.selectedProjectId,
      mode: this.projectLineageMode,
      arrivalCycleId,
      initialCamera: this.lineageCamera,
      initialLayoutDraft: this.lineageLayoutDraft,
      onFocusApplied: (entityId) =>
        this.acknowledgeLineageFocus(entityId, lifecycleGeneration),
      onModeChange: (mode) => {
        this.projectLineageMode = mode;
        void this.render();
      },
      onSelectProject: (projectId) => {
        this.selectedProjectId = projectId;
        workbench.selectProject(projectId);
      },
      focusEntityId,
      onCreateProject: () => this.actions.createProject(
        (projectId) => this.requestLineageFocus(projectId, lifecycleGeneration),
      ),
      onCreateCycle: (projectId, sourceCycleIds) =>
        this.actions.createCycle(
          projectId,
          sourceCycleIds,
          (cycleId) => this.requestLineageFocus(cycleId, lifecycleGeneration),
        ),
      onDeleteCycle: (cycleId) => this.actions.deleteCycle(
        cycleId,
        (nextFocusEntityId) =>
          this.requestLineageFocus(nextFocusEntityId, lifecycleGeneration),
      ),
      onDeleteProject: (projectId) => this.actions.deleteProject(projectId, () => {
        this.lineageLayoutDraft = undefined;
        this.selectedProjectId = workspace.projects.find((project) => project.id !== projectId)?.id ?? null;
        void this.render();
      }),
      onRenameProject: (projectId, currentTitle, currentColor) =>
        this.actions.renameProject(projectId, currentTitle, currentColor, () => void this.render()),
      onRenameCycle: (cycleId, currentTitle) =>
        this.actions.renameCycle(cycleId, currentTitle, () => void this.render()),
      onOpenNote: (path) => {
        void this.actions.openProjectFile(path);
      },
      onSaveLayout: async (moves) => {
        if (!workspace.canvasRevisionHash) throw new Error("项目 Canvas 不存在");
        await this.actions.mutateProjectWorkspace(() =>
          this.actions.projectWorkspace.moveCanvasNodes(
            moves,
            workspace.canvasRevisionHash!,
            { recordHistory: false },
          ));
        workbench.markLayoutSaved();
        this.lineageLayoutDraft = undefined;
        new Notice("当前布局已保存");
        await this.render();
      },
      onManageRelation: (relationId) => this.actions.manageRelation(
        relationId,
        (nextFocusEntityId) =>
          this.requestLineageFocus(nextFocusEntityId, lifecycleGeneration),
      ),
      onInsertCycle: (relationId, sourceCycleId, targetCycleId, projectId) =>
        this.actions.insertCycle(
          relationId,
          sourceCycleId,
          targetCycleId,
          projectId,
          (cycleId) => this.requestLineageFocus(cycleId, lifecycleGeneration),
        ),
      onConnectCycles: (sourceCycleId, targetCycleId) =>
        void this.openConnection(
          sourceCycleId,
          targetCycleId,
          lifecycleGeneration,
        ),
      onChooseConnectionTarget: (sourceCycleId, allowedTargetIds) => {
        new ConnectionTargetModal(
          this.app,
          workspace,
          sourceCycleId,
          allowedTargetIds,
          (targetCycleId) => void this.openConnection(
            sourceCycleId,
            targetCycleId,
            lifecycleGeneration,
          ),
        ).open();
      },
      onEditProjectColor: (projectId, color) => {
        void this.actions.mutateProjectWorkspace(() =>
          this.actions.projectWorkspace.updateProjectColor(projectId, color))
          .then(() => this.render())
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      onEditProjectStatus: (projectId, status) => {
        const project = workspace.projects.find((candidate) => candidate.id === projectId);
        if (!project || status === project.status) return;
        void this.actions.readProjectWorkspace(() =>
          this.actions.projectWorkspace.prepareProjectStatusUpdate(projectId))
          .then(async (plan) => {
            await this.actions.updateProjectStatus(plan, status);
            await this.render();
          })
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      onEditCycleStatus: (cycleId, status) => {
        const cycle = workspace.projects
          .flatMap((project) => project.cycles)
          .find((candidate) => candidate.id === cycleId);
        if (!cycle || status === cycle.status) return;
        void this.requestCycleStatusChange(cycleId, cycle.status, status)
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      requestCycleStatusChange: async (cycleId, expectedStatus, status) => {
        await this.requestCycleStatusChange(cycleId, expectedStatus, status);
      },
      onToggleCompletedCollapse: (projectId, collapsed) => {
        void this.actions.mutateProjectWorkspace(() =>
          this.actions.projectWorkspace.setCompletedProjectCollapsed(projectId, collapsed))
          .then(() => this.render())
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      onExpandCompletedProjects: (projectIds) => {
        void this.actions.mutateProjectWorkspace(() =>
          this.actions.projectWorkspace.setCompletedProjectsCollapsed(projectIds, false))
          .then(() => this.render())
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      onStatusPopoverChange: (open) => {
        if (open || !this.renderPendingWhileProjectPopover) return;
        this.renderPendingWhileProjectPopover = false;
        this.requestServiceRender();
      },
      onError: (error) =>
        new Notice(error instanceof Error ? error.message : String(error), 8_000),
    });
    workbench.render(workbenchHost);
    return workbench;
  }

  private async requestCycleStatusChange(
    cycleId: string,
    expectedStatus: ProjectWorkspaceCycleStatus,
    status: ProjectWorkspaceCycleStatus,
  ): Promise<void> {
    try {
      await requestStageBoardStatusChange(
        cycleId,
        expectedStatus,
        status,
        () => this.actions.readProjectWorkspace(() =>
          this.actions.projectWorkspace.prepareCycleStatusUpdate(cycleId)),
        (plan, nextStatus) => this.actions.updateCycleStatus(plan, nextStatus),
      );
    } catch (error) {
      await this.render();
      throw error;
    }
    if (this.closed) return;
    this.pendingKanbanArrivalCycleId = cycleId;
    await this.render();
  }

  private runProjectionUiAction(
    button: HTMLButtonElement,
    _token: number,
    operation: () => Promise<void>,
    staleMessage?: string,
  ): void {
    if (button.disabled) return;
    void this.projectionUiActions.run(
      operation,
      (busy) => this.setProjectionUiBusy(busy),
      () => { if (!this.closed) void this.render(); },
    ).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(staleMessage && /变化|竞争|CAS/u.test(message) ? staleMessage : message, 8_000);
    });
  }

  private setProjectionUiBusy(busy: boolean): void {
    for (const button of this.contentEl.querySelectorAll<HTMLButtonElement>(
      ".helix-project-projection-panel button, .helix-projection-conflict-group button",
    )) button.disabled = busy;
    this.contentEl.toggleClass("is-projection-action-busy", busy);
  }

  private renderNativeRelationCandidates(
    content: HTMLElement,
    workspace: ProjectWorkspaceSnapshot,
    lifecycleGeneration: number,
  ): void {
    if (workspace.nativeRelationCandidates.length === 0) return;
    const panel = content.createEl("details", {
      cls: "helix-native-relation-panel",
    });
    panel.createEl("summary", {
      text: `${workspace.nativeRelationCandidates.length} 条 Canvas 连线等待确认`,
    });
    const list = panel.createDiv({ cls: "helix-native-relation-list" });
    for (const candidate of workspace.nativeRelationCandidates) {
      const row = list.createDiv({ cls: "helix-native-relation-row" });
      const copy = row.createDiv();
      copy.createEl("strong", {
        text: `${candidate.fromTitle} → ${candidate.toTitle}`,
      });
      if (candidate.crossProject) copy.createSpan({ text: "跨项目" });
      const adopt = row.createEl("button", {
        cls: "helix-primary-button",
        text: "交由 Helix 管理",
      });
      adopt.addEventListener("click", () => {
        adopt.disabled = true;
        void this.actions.readProjectWorkspace(() =>
          this.actions.projectWorkspace.planNativeRelationAdoption(candidate))
          .then((plan) => {
            new NativeRelationAdoptionModal(
              this.app,
              plan,
              async (confirmCrossProject) => {
                await this.actions.mutateProjectWorkspace(() =>
                  this.actions.projectWorkspace.adoptNativeRelation(
                    plan,
                    { confirmCrossProject },
                  ));
                this.requestLineageFocus(
                  plan.toCycleId,
                  lifecycleGeneration,
                );
                await this.render();
              },
            ).open();
          })
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000))
          .finally(() => {
            adopt.disabled = false;
          });
      });
    }
  }

  private renderProjectReadOnlyFallback(
    content: HTMLElement,
    error: unknown,
  ): void {
    this.renderPageTitle(content, "项目");
    const warning = content.createDiv({
      cls: "helix-card helix-error-card helix-project-readonly",
    });
    warning.createEl("strong", { text: "项目文件尚未稳定，已暂停结构编辑" });
    warning.createEl("p", {
      text: error instanceof Error ? error.message : String(error),
    });
    const retry = warning.createEl("button", {
      cls: "helix-primary-button",
      text: "重新读取",
    });
    retry.addEventListener("click", () => void this.render());
    const cached = this.lastGoodProjectWorkspace;
    if (!cached) return;
    warning.createEl("p", {
      text: "以下为最后一次有效快照，只提供 Markdown 打开入口。",
    });
    const list = content.createDiv({
      cls: "helix-project-readonly-list",
      attr: { "aria-label": "最后一次有效项目快照" },
    });
    for (const project of cached.projects) {
      const card = list.createDiv({ cls: "helix-card" });
      const openProject = card.createEl("button", {
        cls: "helix-link-button",
        text: project.title,
      });
      openProject.addEventListener("click", () => {
        void this.actions.openProjectFile(project.notePath)
          .catch((error) =>
            new Notice(
              `缓存路径已失效，请重新读取：${
                error instanceof Error ? error.message : String(error)
              }`,
              8_000,
            ));
      });
      const stages = card.createEl("ul");
      for (const stage of project.cycles) {
        const item = stages.createEl("li");
        const openStage = item.createEl("button", {
          cls: "helix-link-button",
          text: `阶段 ${stage.stageCode} · ${stage.title}`,
        });
        openStage.addEventListener("click", () => {
          void this.actions.openProjectFile(stage.notePath)
            .catch((error) =>
              new Notice(
                `缓存路径已失效，请重新读取：${
                  error instanceof Error ? error.message : String(error)
                }`,
                8_000,
              ));
        });
      }
    }
  }

  private async openConnection(
    sourceCycleId: string,
    targetCycleId: string,
    lifecycleGeneration = this.viewGeneration,
  ): Promise<void> {
    try {
      const plan = await this.actions.readProjectWorkspace(() =>
        this.actions.projectWorkspace.planConnection(
          sourceCycleId,
          targetCycleId,
        ));
      new ConnectionConfirmModal(
        this.app,
        plan,
        async (confirmCrossProject) => {
          await this.actions.mutateProjectWorkspace(() =>
            this.actions.projectWorkspace.connectCycles(plan, {
              confirmCrossProject,
            }));
          this.requestLineageFocus(sourceCycleId, lifecycleGeneration);
          new Notice("阶段连接已建立，受影响分支已自动整理");
        },
      ).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8_000);
    }
  }

  private requestLineageFocus(
    entityId: string,
    lifecycleGeneration = this.viewGeneration,
  ): void {
    if (this.closed || lifecycleGeneration !== this.viewGeneration) return;
    this.lineageFocusRequest = {
      entityId,
      generation: lifecycleGeneration,
    };
    if (this.section === "projects") void this.render();
  }

  private currentLineageFocusId(): string | undefined {
    const request = this.lineageFocusRequest;
    if (
      !request ||
      this.closed ||
      request.generation !== this.viewGeneration
    ) return undefined;
    return request.entityId;
  }

  private acknowledgeLineageFocus(
    entityId: string,
    lifecycleGeneration: number,
  ): void {
    const request = this.lineageFocusRequest;
    if (
      !request ||
      request.entityId !== entityId ||
      request.generation !== lifecycleGeneration
    ) return;
    this.lineageFocusRequest = null;
  }

  private renderReviews(content: HTMLElement): void {
    this.renderPageTitle(content, "周期复盘");
    const grid = content.createDiv({ cls: "helix-review-grid" });
    const cards = [
      ["daily", "日记", "今天完成了什么？哪些证据改变了项目判断？", "今日"],
      ["weekly", "周记", "计划与实际的最大偏差是什么？", "本周"],
      ["monthly", "月记", "哪些系统性问题正在反复出现？", "本月"],
      ["yearly", "年记", "什么真正改变了长期轨迹？", "今年"],
    ];
    for (const [iconName, title, question, period] of cards) {
      const card = grid.createDiv({ cls: "helix-card helix-review-card" });
      const icon = card.createDiv({ cls: "helix-review-icon" });
      setIcon(icon, iconName === "daily" ? "calendar-days" : iconName === "weekly" ? "calendar-range" : iconName === "monthly" ? "calendar" : "sparkles");
      card.createSpan({ cls: "helix-chip is-soft", text: period });
      card.createEl("h3", { text: title });
      card.createEl("p", { text: question });
      const button = card.createEl("button", { cls: "helix-secondary-button", text: "打开或创建" });
      button.addEventListener("click", () => {
        void this.actions
          .openReview(iconName as "daily" | "weekly" | "monthly" | "yearly")
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
      });
    }
    const recall = content.createDiv({ cls: "helix-review-recall" });
    recall.createEl("h2", { text: "数据回顾" });
    recall.createEl("p", { text: "从任务、专注与习惯记录中回看本周期的投入和节律。" });
    this.renderAnalytics(recall, false);
  }

  private renderAnalytics(content: HTMLElement, includeTitle = true): void {
    if (includeTitle) this.renderPageTitle(content, "数据分析");
    const to = localDateKey(new Date());
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 13);
    const summary = aggregateAnalytics(this.state?.events ?? [], {
      from: localDateKey(fromDate),
      to,
    });
    const progress = deriveProgress(this.state?.events ?? []);
    const chartSeries = analyticsChartSeries(summary.daily, new Date());
    const stats = content.createDiv({ cls: "helix-stat-grid" });
    for (const [value, label, delta] of [
      [String(summary.totalTasks), "完成任务", "近 14 日"],
      [String(summary.totalFocusMinutes), "专注分钟", "近 14 日"],
      [String(summary.totalHabitCheckins), "习惯打卡", "近 14 日"],
      [String(summary.totalReviews), "完成复盘", "近 14 日"],
      [String(progress.level), "当前等级", `${progress.xp} XP`],
    ]) {
      const card = stats.createDiv({ cls: "helix-card helix-stat" });
      card.createEl("strong", { text: value });
      card.createSpan({ text: label });
      card.createEl("small", { text: delta });
    }
    const chartGrid = content.createDiv({ cls: "helix-chart-grid" });
    const trendCard = chartGrid.createDiv({ cls: "helix-card helix-chart-card" });
    trendCard.createEl("h3", { text: "近 14 日完成趋势" });
    const trend = trendCard.createDiv({ cls: "helix-chart" });
    this.mountTrendChart(trend, chartSeries.trend);
    this.renderMonthHeatmap(chartGrid);
  }

  private renderChallenges(content: HTMLElement): void {
    this.renderPageTitle(content, "挑战");
    const showcase = content.createDiv({ cls: "helix-challenge-showcase" });
    this.renderWeeklyChallengeCard(showcase);
    this.renderMonthlyChallengeCard(showcase);
    const side = showcase.createDiv({ cls: "helix-card helix-achievement-panel" });
    side.createEl("h3", { text: "成就陈列" });
    const unlocked = new Set(deriveProgress(this.state?.events ?? []).badges);
    for (const [iconName, badge, title, desc] of [
      ["git-branch", "完成首轮迭代", "迭代者", "关闭首个项目阶段"],
      ["notebook-pen", "复盘节律", "复盘节律", "累计关闭 7 次复盘"],
      ["brain", "千分钟专注", "千分钟专注", "累计专注达到 1,000 分钟"],
    ] as const) {
      const isUnlocked = unlocked.has(badge);
      const row = side.createDiv({
        cls: `helix-achievement-row${isUnlocked ? "" : " is-locked"}`,
      });
      const icon = row.createSpan();
      setIcon(icon, iconName as IconName);
      const copy = row.createDiv();
      copy.createEl("strong", { text: title });
      copy.createEl("p", { text: isUnlocked ? `${desc} · 已解锁` : `${desc} · 未解锁` });
    }
  }

  private renderMonthHeatmap(parent: HTMLElement): void {
    const year = this.heatmapMonth.getFullYear();
    const first = new Date(year, 0, 1);
    const last = new Date(year, 11, 31);
    const summary = aggregateAnalytics(this.state?.events ?? [], {
      from: localDateKey(first),
      to: localDateKey(last),
    });
    const heatmap = buildYearHeatmap(summary.daily, year, this.heatmapMetric);
    const card = parent.createDiv({ cls: "helix-card helix-heatmap-card" });
    const header = card.createDiv({ cls: "helix-heatmap-header" });
    const heading = header.createDiv();
    heading.createEl("h3", { text: "年度记录" });
    heading.createSpan({
      text: `${year} 年 · ${heatmap.total} ${
        this.heatmapMetric === "tasks" ? "个任务" : "次打卡"
      }`,
    });
    const controls = header.createDiv({ cls: "helix-heatmap-controls" });
    const previous = controls.createEl("button", {
      attr: { "aria-label": "上一年", title: "上一年" },
    });
    setIcon(previous, "chevron-left");
    previous.addEventListener("click", () => {
      this.heatmapMonth = new Date(year - 1, 0, 1);
      void this.render();
    });
    const current = controls.createEl("button", { text: "今年" });
    current.addEventListener("click", () => {
      const now = new Date();
      this.heatmapMonth = new Date(now.getFullYear(), 0, 1);
      void this.render();
    });
    const next = controls.createEl("button", {
      attr: { "aria-label": "下一年", title: "下一年" },
    });
    setIcon(next, "chevron-right");
    next.addEventListener("click", () => {
      this.heatmapMonth = new Date(year + 1, 0, 1);
      void this.render();
    });
    const metric = controls.createEl("select", {
      attr: { "aria-label": "热力图指标" },
    });
    metric.createEl("option", { text: "任务完成", value: "tasks" });
    metric.createEl("option", { text: "习惯打卡", value: "habits" });
    metric.value = this.heatmapMetric;
    metric.addEventListener("change", () => {
      this.heatmapMetric = metric.value as HeatmapMetric;
      void this.render();
    });

    const scroll = card.createDiv({ cls: "helix-heatmap-scroll" });
    const yearGrid = scroll.createDiv({ cls: "helix-heatmap-year" });
    heatmap.months.forEach((monthHeatmap, monthIndex) => {
      const month = yearGrid.createDiv({
        cls: "helix-heatmap-month",
        attr: {
          role: "group",
          "aria-label": `${monthIndex + 1} 月，共 ${monthHeatmap.total} ${
            this.heatmapMetric === "tasks" ? "个完成任务" : "次习惯打卡"
          }`,
        },
      });
      month.createEl("h4", {
        text: `${monthIndex + 1}月`,
      });
      const weeks = month.createDiv({ cls: "helix-heatmap-month-weeks" });
      for (let weekIndex = 0; weekIndex < 6; weekIndex += 1) {
        const column = weeks.createDiv({ cls: "helix-heatmap-week" });
        const week = monthHeatmap.weeks[weekIndex]!;
        for (let weekday = 0; weekday < 7; weekday += 1) {
          const day = week[weekday];
          if (!day) {
            column.createSpan({
              cls: "helix-heatmap-day is-placeholder",
              attr: { "aria-hidden": "true" },
            });
            continue;
          }
          const label = `${day.date}：${day.value} ${
            this.heatmapMetric === "tasks" ? "个完成任务" : "次习惯打卡"
          }`;
          column.createSpan({
            cls: `helix-heatmap-day is-level-${day.intensity}`,
            attr: {
              "aria-label": label,
              title: label,
              role: "img",
            },
          });
        }
      }
    });
    const legend = card.createDiv({ cls: "helix-heatmap-legend" });
    legend.createSpan({ text: "少" });
    for (let level = 0; level <= 4; level += 1) {
      legend.createSpan({ cls: `helix-heatmap-day is-level-${level}` });
    }
    legend.createSpan({ text: "多" });
  }

  private renderMonthlyChallengeCard(parent: HTMLElement): void {
    const challenge = rotatingChallenges(new Date())[1]!;
    const current = challengeProgress(challenge, this.state?.events ?? []);
    const ratio = Math.min(100, Math.round((current / challenge.target) * 100));
    const card = parent.createDiv({ cls: "helix-card helix-monthly-challenge" });
    const icon = card.createDiv({ cls: "helix-review-icon" });
    setIcon(icon, "calendar-range");
    card.createSpan({ cls: "helix-chip is-soft", text: `${challenge.rewardXp} XP` });
    card.createEl("h3", { text: challenge.title });
    card.createEl("p", { text: challenge.description });
    const progress = card.createDiv({ cls: "helix-pulse-meter" });
    const fill = progress.createDiv();
    fill.style.width = `${ratio}%`;
    card.createDiv({
      cls: "helix-monthly-progress-copy",
      text: `${current} / ${challenge.target} · ${daysRemaining(challenge.endsAt)}`,
    });
    const detail = card.createEl("button", {
      cls: "helix-secondary-button helix-monthly-detail",
      text: "查看详情",
    });
    detail.addEventListener("click", () => {
      new ChallengeDetailModal(
        this.app,
        challenge,
        this.state?.events ?? [],
      ).open();
    });
  }

  private async renderConflicts(content: HTMLElement, token: number): Promise<void> {
    const [conflicts, persisted, queue, focusConflicts] = await Promise.all([
      this.store.list(),
      this.store.snapshot(),
      this.service.listQueue(),
      this.actions.readProjectWorkspace(() =>
        this.actions.projectWorkspace.listFocusBridgeConflicts()).catch(() => []),
    ]);
    if (token !== this.renderToken) return;
    const projectionLoad = await loadProjectionConflictModels(
      async () => (await this.actions.readProjectWorkspace(() =>
        this.actions.projectWorkspace.loadStableWorkspace())).projects.map((project) => project.id),
      (projectId) => this.actions.readProjectProjection(projectId),
    );
    if (token !== this.renderToken) return;
    const masterDetail = content.createDiv({ cls: "helix-conflict-master-detail-region" });
    const diagnostics = content.createDiv({ cls: "helix-conflict-diagnostics" });
    const projectionIssueCount = this.renderProjectionConflicts(
      diagnostics,
      projectionLoad.models,
      persisted.didaProjectionState?.columnCreation,
      token,
    );
    const cleanupPending = persisted.pendingDidaContractCleanup;
    const cleanupRuntime = this.service.didaContractCleanupRuntimeStatus();
    const requestControl = persisted.didaRequestControl;
    const cooldownUntil = requestControl?.cooldownUntil
      ? Date.parse(requestControl.cooldownUntil)
      : Number.NaN;
    const requestControlAttention = Boolean(
      requestControl?.recoveryReadPending ||
      (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()),
    );
    if (requestControlAttention) {
      const card = diagnostics.createDiv({ cls: "helix-card helix-reconciliation-card" });
      card.createEl("span", { cls: "helix-chip is-warning", text: "滴答请求冷却" });
      card.createEl("h3", { text: "远端写入保持暂停" });
      card.createEl("p", {
        text: Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()
          ? `冷却至 ${new Date(cooldownUntil).toLocaleString()}；到期后的下一次同步只进行一次受控读取。`
          : "冷却已到期；下一次手动或计划同步将先进行一次受控读取，成功后才恢复队列写入。",
      });
    }
    const cleanupNeedsAdoption = Boolean(cleanupPending &&
      cleanupPending.plan.tasks.length === 0 && cleanupPending.plan.projects.length === 0);
    if (cleanupPending || cleanupRuntime.adoptionSuggested) {
      const card = diagnostics.createDiv({ cls: "helix-card helix-reconciliation-card" });
      card.createEl("span", { cls: "helix-chip is-danger", text: "合同残留已冻结" });
      card.createEl("h3", { text: cleanupPending && !cleanupNeedsAdoption
        ? "专用测试对象等待安全清理"
        : "旧合同残留等待严格领养" });
      card.createEl("p", {
        text: cleanupPending && !cleanupNeedsAdoption
          ? `仅限本轮专用对象：${cleanupPending.plan.tasks.length} 个任务、${cleanupPending.plan.projects.length} 个清单。不会触碰其他数据。`
          : "只会领养唯一且身份完整的 A/B 测试组；存在多个运行组、普通任务或任何歧义都会拒绝。",
      });
      const action = card.createEl("button", {
        cls: "helix-secondary-button",
        text: cleanupPending && !cleanupNeedsAdoption ? "冷却后精确清理" : "严格领养本轮残留",
      });
      let armed = false;
      action.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          action.textContent = cleanupPending && !cleanupNeedsAdoption
            ? "再次确认：只清理专用对象"
            : "再次确认：执行只读领养";
          return;
        }
        action.disabled = true;
        const run = cleanupPending && !cleanupNeedsAdoption
          ? this.service.recoverPendingDidaContractCleanup()
          : this.service.adoptPendingContractRunFromRemote();
        void run.then(() => this.render()).catch(() => {
          action.disabled = false;
          armed = false;
          action.textContent = cleanupPending && !cleanupNeedsAdoption
            ? "冷却后精确清理"
            : "严格领养本轮残留";
          new Notice("安全操作未完成；对象保持冻结，请查看脱敏诊断", 8_000);
        });
      });
    }
    if (projectionLoad.diagnostic) {
      const card = diagnostics.createDiv({ cls: "helix-card helix-reconciliation-card" });
      card.createEl("span", { cls: "helix-chip is-danger", text: "项目工作区只读" });
      card.createEl("h3", { text: "滴答项目同步诊断暂不可读" });
      card.createEl("p", { text: `脱敏错误：${projectionLoad.diagnostic}` });
    }
    if (persisted.lineageConflict) {
      const card = diagnostics.createDiv({ cls: "helix-card helix-reconciliation-card" });
      card.createEl("span", {
        cls: "helix-chip is-danger",
        text: "旧版谱系同步已冻结",
      });
      card.createEl("h3", {
        text: "请先核对旧项目谱系",
      });
      card.createEl("p", {
        text: persisted.lineageConflict.message ??
          "新版项目工作区不会在 Canvas 与 Markdown 间自动选边或写回。旧数据会保留，迁移必须在项目页逐项确认。",
      });
      card.createEl("code", { text: persisted.lineageConflict.canvasPath });
    }
    for (const issue of this.state?.recoveryIssues ?? []) {
      const card = diagnostics.createDiv({ cls: "helix-card helix-reconciliation-card" });
      card.createEl("span", { cls: "helix-chip is-danger", text: "只读恢复模式" });
      card.createEl("h3", { text: "Helix 数据或事务状态需要人工修复" });
      card.createEl("p", { text: issue });
      const copy = card.createEl("button", { text: "复制脱敏诊断摘要" });
      copy.addEventListener("click", () => {
        void this.service.diagnosticSummary()
          .then((summary) => navigator.clipboard.writeText(JSON.stringify(summary, null, 2)))
          .then(() => new Notice("脱敏诊断摘要已复制"))
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
      });
    }
    const reconciliation = queue.filter(
      (operation) => operation.status === "reconciliation",
    );
    for (const operation of reconciliation) {
      const card = diagnostics.createDiv({ cls: "helix-card helix-reconciliation-card" });
      card.createEl("span", { cls: "helix-chip is-danger", text: "远端结果未知" });
      card.createEl("h3", { text: String((operation.local.value as Partial<DidaTask>).title ?? operation.entityId) });
      card.createEl("p", {
        text: operation.lastError ?? "应用在请求期间中断。Helix 不会自动重放非幂等写入。",
      });
      if (!PROJECT_DIDA_PROJECTION_AVAILABLE && isProjectionQueueOperation(operation)) {
        card.createEl("p", { text: "0.1.0 仅保留该项目联动记录供诊断，不提供复读、绑定或重试操作。" });
        continue;
      }
      if (operation.operation !== "create") {
        const actions = card.createDiv({ cls: "helix-reconciliation-actions" });
        actions.createEl("p", { text: "请在滴答 App 核对；Helix 不会重发结果未知的写入。" });
        const adopt = actions.createEl("button", {
          cls: "helix-secondary-button",
          text: "采用当前远端，放弃本次写入",
        });
        adopt.addEventListener("click", () => {
          void this.service
            .resolveUnknownWrite(operation.id, "adopt-remote")
            .then(() => this.render())
            .catch((error) => new Notice(error instanceof Error ? error.message : String(error), 8_000));
        });
        continue;
      }
      const remoteId = card.createEl("input", {
        type: "text",
        placeholder: "如果远端已创建，请粘贴滴答记录 ID",
        attr: { "aria-label": "滴答远端记录 ID" },
      });
      const actions = card.createDiv({ cls: "helix-reconciliation-actions" });
      actions.createEl("p", { text: "结果未知时不提供重试；请在滴答 App 核对后绑定已创建记录。" });
      const bind = actions.createEl("button", {
        cls: "helix-primary-button",
        text: "核对并绑定远端记录",
      });
      bind.addEventListener("click", () => {
        void this.service
          .resolveUnknownCreate(operation.id, "confirmed", remoteId.value)
          .then(() => this.render())
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error), 8_000));
      });
    }
    const failed = queue.filter((operation) => operation.status === "failed");
    for (const operation of failed) {
      const card = diagnostics.createDiv({ cls: "helix-card helix-reconciliation-card" });
      card.createEl("span", { cls: "helix-chip is-danger", text: "写入失败" });
      card.createEl("h3", {
        text: String((operation.local.value as Partial<DidaTask>).title ?? operation.entityId),
      });
      card.createEl("p", {
        text: `${operation.lastError ?? "未知错误"} · 已尝试 ${operation.attempts} 次`,
      });
      if (!PROJECT_DIDA_PROJECTION_AVAILABLE && isProjectionQueueOperation(operation)) {
        card.createEl("p", { text: "0.1.0 仅保留该项目联动记录供诊断，不提供重试操作。" });
        continue;
      }
      const retry = card.createEl("button", {
        cls: "helix-secondary-button",
        text: "修复原因后手动重试",
      });
      retry.addEventListener("click", () => {
        void this.service
          .retryFailedOperation(operation.id)
          .then(() => this.render())
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error), 8_000));
      });
    }
    const orphanedBlocked = queue.filter(
      (operation) =>
        operation.status === "blocked" &&
        !conflicts.some((conflict) => conflict.id === operation.conflictId),
    );
    for (const operation of orphanedBlocked) {
      const card = diagnostics.createDiv({ cls: "helix-card helix-reconciliation-card" });
      card.createEl("span", { cls: "helix-chip is-danger", text: "队列已阻塞" });
      card.createEl("h3", { text: operation.entityId });
      card.createEl("p", { text: "关联冲突记录缺失。已停止写入；复制脱敏诊断摘要后再人工检查。" });
      const copy = card.createEl("button", { text: "复制诊断摘要" });
      copy.addEventListener("click", () => {
        void this.service.diagnosticSummary()
          .then((summary) => navigator.clipboard.writeText(JSON.stringify(summary, null, 2)))
          .then(() => new Notice("脱敏诊断摘要已复制"))
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
      });
    }
    if (conflictCenterIsEmpty({
      conflicts: conflicts.length,
      focusConflicts: focusConflicts.length,
      recoveryIssues: this.state?.recoveryIssues.length ?? 0,
      reconciliation: reconciliation.length,
      failed: failed.length,
      orphanedBlocked: orphanedBlocked.length,
      projectionIssues: projectionIssueCount,
      workspaceDiagnostic: Boolean(projectionLoad.diagnostic),
      lineageConflict: Boolean(persisted.lineageConflict),
      contractCleanup: Boolean(cleanupPending || cleanupRuntime.adoptionSuggested),
      requestControlAttention,
    })) {
      const empty = diagnostics.createDiv({ cls: "helix-empty-state" });
      const icon = empty.createDiv();
      setIcon(icon, "shield-check");
      empty.createEl("h3", { text: "没有待处理冲突" });
      empty.createEl("p", { text: "Helix 会在发生竞争修改时暂停单条记录，不阻塞其他对象同步。" });
      return;
    }
    this.renderConflictMasterDetail(
      masterDetail,
      conflicts,
      focusConflicts,
      persisted.resolutionAudit,
    );
  }

  /** 冲突选择仍是逐字段操作；表格只负责分流，展开区复用唯一合并入口。 */
  private renderConflictMasterDetail(
    content: HTMLElement,
    conflicts: SyncConflict[],
    focusConflicts: ProjectWorkspaceFocusConflict[],
    audits: ResolutionAuditEntry[],
  ): void {
    type CenterItem = {
      id: string;
      type: "task" | "project" | "focus";
      category: "decision" | "blocked" | "inspect";
      title: string;
      diagnosis: string;
      scope: string;
      updatedAt: string;
      severity: "high" | "medium" | "low";
      conflict: SyncConflict | ProjectWorkspaceFocusConflict;
    };
    const items: CenterItem[] = [
      ...conflicts.map<CenterItem>((conflict) => ({
        id: `sync:${conflict.id}`,
        type: conflict.kind === "task" ? "task" : "project",
        category: conflict.status === "applying" ? "blocked" : "decision",
        title: conflict.title,
        diagnosis: conflict.status === "applying"
          ? "远端结果未知，已冻结写入"
          : `${conflict.fields.length} 个竞争字段，需要逐项选择`,
        scope: conflict.kind === "task" ? "滴答任务" : "滴答清单",
        updatedAt: conflict.updatedAt,
        severity: conflict.status === "applying" || conflict.status === "open" ? "high" : "medium",
        conflict,
      })),
      ...focusConflicts.map<CenterItem>((conflict) => ({
        id: `focus:${conflict.id}`,
        type: "focus" as const,
        category: conflict.reason === "simultaneous-edit" ? "decision" : "inspect",
        title: `${conflict.sourceId} → ${conflict.targetId}`,
        diagnosis: conflict.reason === "simultaneous-edit"
          ? "来源与派生同时修改"
          : conflict.reason === "derived-structure-changed"
            ? "自动引用结构发生变化"
            : "缺少可验证的共同基线",
        scope: `${conflict.sourcePath} → ${conflict.targetPath}`,
        updatedAt: conflict.createdAt,
        severity: conflict.reason === "simultaneous-edit" ? "high" : "low",
        conflict,
      })),
    ];
    if (items.length === 0) return;

    const shell = content.createDiv({ cls: "helix-conflict-workspace" });
    const main = shell.createDiv({ cls: "helix-conflict-workspace-main" });
    const history = shell.createDiv({ cls: "helix-conflict-history" });
    const top = main.createDiv({ cls: "helix-conflict-topline" });
    const introduction = top.createDiv({ cls: "helix-conflict-introduction" });
    introduction.createEl("h1", { text: "冲突中心" });
    introduction.createEl("p", { text: "按处理优先级整理，快速完成三方合并与安全核对" });
    const toolbar = top.createDiv({ cls: "helix-conflict-toolbar" });
    const summary = toolbar.createDiv({ cls: "helix-conflict-summary" });
    const summaryMetric = (value: string, label: string, iconName?: IconName) => {
      const metric = summary.createDiv({ cls: "helix-conflict-summary-metric" });
      if (iconName) {
        const icon = metric.createSpan({ cls: "helix-conflict-summary-icon" });
        setIcon(icon, iconName);
      } else {
        metric.createEl("strong", { text: value });
      }
      metric.createSpan({ text: label });
    };
    summaryMetric(String(items.filter((item) => item.category === "decision").length), "待你选择");
    summaryMetric(String(items.filter((item) => item.category === "blocked").length), "已阻止写入");
    summaryMetric("", "不影响其他同步", "circle-check");
    const controls = toolbar.createDiv({ cls: "helix-conflict-toolbar-controls" });
    const searchWrap = controls.createDiv({ cls: "helix-conflict-search-wrap" });
    const searchIcon = searchWrap.createSpan();
    setIcon(searchIcon, "search");
    const search = searchWrap.createEl("input", {
      cls: "helix-conflict-search",
      type: "search",
      placeholder: "搜索冲突内容或路径",
      attr: { "aria-label": "搜索冲突" },
    });
    search.value = this.conflictSearch;
    const filterWrap = controls.createDiv({ cls: "helix-conflict-filter-wrap" });
    const filterIcon = filterWrap.createSpan();
    setIcon(filterIcon, "list-filter");
    const filter = filterWrap.createEl("select", { attr: { "aria-label": "冲突类型筛选" } });
    for (const [value, label] of [["all", "全部类型"], ["task", "任务"], ["project", "项目"], ["focus", "聚焦"]] as const) {
      filter.createEl("option", { value, text: label });
    }
    filter.value = this.conflictTypeFilter;

    const board = main.createDiv({ cls: "helix-conflict-board", attr: { tabindex: "0" } });
    const filtered = () => items.filter((item) =>
      (this.conflictTypeFilter === "all" || item.type === this.conflictTypeFilter) &&
      `${item.title} ${item.diagnosis} ${item.scope} ${item.type}`.toLocaleLowerCase("zh-CN")
        .includes(this.conflictSearch.trim().toLocaleLowerCase("zh-CN")));
    const itemById = (id: string) => items.find((item) => item.id === id);
    const renderExpanded = (parent: HTMLElement, item: CenterItem) => {
      const expanded = parent.createDiv({
        cls: `helix-conflict-expanded is-${this.conflictDiffMode}`,
        attr: { tabindex: "-1" },
      });
      const steps = expanded.createDiv({ cls: "helix-conflict-steps" });
      for (const [index, title, copy] of [
        ["1", "预览差异", "查看共同基线与两侧变化。"],
        ["2", "选择方案", "保留本地、采用远端或手动编辑。"],
        ["3", "完成处理", "复检远端并标记处理结果。"],
      ] as const) {
        const step = steps.createDiv({ cls: "helix-conflict-step" });
        step.createSpan({ text: index });
        const copyEl = step.createDiv();
        copyEl.createEl("strong", { text: title });
        copyEl.createEl("small", { text: copy });
      }
      const resolution = expanded.createDiv({ cls: "helix-conflict-resolution" });
      const resolutionToolbar = resolution.createDiv({ cls: "helix-conflict-resolution-toolbar" });
      resolutionToolbar.createEl("strong", { text: item.type === "focus" ? "三方内容预览" : "字段差异预览" });
      const viewModes = resolutionToolbar.createDiv({ cls: "helix-conflict-view-modes" });
      for (const [mode, label] of [["split", "并排视图"], ["unified", "统一视图"]] as const) {
        const button = viewModes.createEl("button", {
          cls: this.conflictDiffMode === mode ? "is-selected" : "",
          text: label,
        });
        button.addEventListener("click", () => {
          this.conflictDiffMode = mode;
          renderBoard();
        });
      }
      const detail = resolution.createDiv({ cls: "helix-conflict-detail" });
      if (item.type === "focus") {
        this.renderFocusBridgeConflict(detail, item.conflict as ProjectWorkspaceFocusConflict, true);
      } else {
        this.renderConflict(detail, item.conflict as SyncConflict, true);
        const conflict = item.conflict as SyncConflict;
        if (conflict.status !== "applying") {
          const actions = resolution.createDiv({ cls: "helix-conflict-resolution-shortcuts" });
          const chooseAll = (choice: "local" | "remote") => {
            void this.chooseAllConflictFields(conflict, choice)
              .catch((error) => new Notice(messageOf(error), 8_000));
          };
          actions.createEl("button", { cls: "is-local", text: "保留本地" })
            .addEventListener("click", () => chooseAll("local"));
          actions.createEl("button", { cls: "is-remote", text: "采用远端" })
            .addEventListener("click", () => chooseAll("remote"));
          const manual = actions.createEl("button", { text: "手动编辑" });
          manual.addEventListener("click", () => {
            const toggle = detail.querySelector<HTMLButtonElement>(".helix-conflict-custom-toggle");
            toggle?.click();
            toggle?.scrollIntoView({ block: "center", behavior: "smooth" });
          });
        }
      }
    };
    const renderBoard = () => {
      const visible = filtered();
      if (!visible.some((item) => item.id === this.selectedConflictCenterItemId)) {
        this.selectedConflictCenterItemId = visible[0]?.id ?? null;
      }
      for (const selected of [...this.selectedConflictCenterItemIds]) {
        if (!items.some((item) => item.id === selected)) this.selectedConflictCenterItemIds.delete(selected);
      }
      board.empty();
      if (visible.length === 0) {
        board.createDiv({ cls: "helix-empty-state", text: "没有匹配的冲突，调整搜索或类型筛选后继续。" });
        return;
      }
      const groupDefinitions = [
        { category: "decision", title: "需要你选择", description: "存在内容分歧，需要决定采用本地、远端或自定义版本。", icon: "circle-alert", tone: "danger" },
        { category: "blocked", title: "等待远端核对", description: "结果未知或正在收口，保持冻结且禁止重发。", icon: "clock-3", tone: "warning" },
        { category: "inspect", title: "仅需检查", description: "自动处理未继续执行，需要确认结构或共同基线。", icon: "info", tone: "info" },
      ] as const;
      for (const definition of groupDefinitions) {
        const groupItems = visible.filter((item) => item.category === definition.category);
        if (groupItems.length === 0) continue;
        const group = board.createDiv({ cls: `helix-conflict-group is-${definition.tone}` });
        const groupHead = group.createDiv({ cls: "helix-conflict-group-head" });
        const groupIcon = groupHead.createSpan();
        setIcon(groupIcon, definition.icon);
        groupHead.createEl("strong", { text: `${definition.title} ${groupItems.length}` });
        groupHead.createSpan({ text: definition.description });
        const tableHead = group.createDiv({ cls: "helix-conflict-table-head" });
        tableHead.createSpan({ text: "" });
        tableHead.createSpan({ text: "来源" });
        tableHead.createSpan({ text: "对象" });
        tableHead.createSpan({ text: "诊断" });
        tableHead.createSpan({ text: "影响范围／路径" });
        tableHead.createSpan({ text: "时间" });
        tableHead.createSpan({ text: "严重性" });
        tableHead.createSpan({ text: "操作" });
        for (const item of groupItems) {
          const entry = group.createDiv({ cls: `helix-conflict-entry${item.id === this.selectedConflictCenterItemId ? " is-selected" : ""}` });
          const row = entry.createDiv({ cls: "helix-conflict-table-row" });
          const checkbox = row.createEl("input", { type: "checkbox", attr: { "aria-label": `选择 ${item.title}` } });
          checkbox.checked = this.selectedConflictCenterItemIds.has(item.id);
          checkbox.disabled = item.type === "focus" || item.category === "blocked";
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) this.selectedConflictCenterItemIds.add(item.id);
            else this.selectedConflictCenterItemIds.delete(item.id);
            renderBulkBar();
          });
          const source = row.createDiv({ cls: `helix-conflict-source is-${item.type}` });
          const sourceIcon = source.createSpan();
          setIcon(sourceIcon, item.type === "task" ? "square-check-big" : item.type === "project" ? "folder" : "git-merge");
          source.createSpan({ text: item.type === "task" ? "任务" : item.type === "project" ? "项目" : "聚焦" });
          row.createEl("strong", { cls: "helix-conflict-object", text: item.title });
          row.createSpan({ cls: "helix-conflict-diagnosis", text: item.diagnosis });
          row.createSpan({ cls: "helix-conflict-scope", text: item.scope });
          row.createSpan({ cls: "helix-conflict-time", text: relativeConflictTime(item.updatedAt) });
          row.createSpan({ cls: `helix-conflict-severity is-${item.severity}`, text: item.severity === "high" ? "高" : item.severity === "medium" ? "中" : "低" });
          const open = row.createEl("button", {
            cls: "helix-conflict-open",
            text: item.id === this.selectedConflictCenterItemId
              ? "收起"
              : item.type === "focus" ? "查看详情" : "对比字段",
          });
          open.addEventListener("click", () => {
            this.selectedConflictCenterItemId = item.id === this.selectedConflictCenterItemId ? null : item.id;
            renderBoard();
          });
          row.addEventListener("dblclick", () => {
            this.selectedConflictCenterItemId = item.id;
            renderBoard();
          });
          if (item.id === this.selectedConflictCenterItemId) renderExpanded(entry, item);
        }
      }
      renderBulkBar();
    };
    const bulk = main.createDiv({ cls: "helix-conflict-bulk" });
    const renderBulkBar = () => {
      bulk.empty();
      bulk.createSpan({ text: `已选择 ${this.selectedConflictCenterItemIds.size} 项` });
      const actions = bulk.createDiv();
      const suggested = actions.createEl("button", { cls: "helix-primary-button", text: "批量采用建议" });
      suggested.disabled = this.selectedConflictCenterItemIds.size === 0;
      suggested.addEventListener("click", () => {
        const selected = [...this.selectedConflictCenterItemIds]
          .map(itemById)
          .filter((item): item is CenterItem => Boolean(item && item.type !== "focus" && item.category !== "blocked"));
        void this.applySuggestedConflictChoices(selected.map((item) => item.conflict as SyncConflict))
          .catch((error) => new Notice(messageOf(error), 8_000));
      });
      const clear = actions.createEl("button", { text: "清除选择" });
      clear.addEventListener("click", () => {
        this.selectedConflictCenterItemIds.clear();
        renderBoard();
      });
    };
    search.addEventListener("input", () => {
      this.conflictSearch = search.value;
      renderBoard();
    });
    filter.addEventListener("change", () => {
      this.conflictTypeFilter = filter.value as typeof this.conflictTypeFilter;
      renderBoard();
    });
    board.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
      const visible = filtered();
      const index = Math.max(0, visible.findIndex((item) => item.id === this.selectedConflictCenterItemId));
      if (event.key === "Enter") {
        event.preventDefault();
        board.querySelector<HTMLElement>(".helix-conflict-expanded")?.focus();
        return;
      }
      const next = visible[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      this.selectedConflictCenterItemId = next.id;
      renderBoard();
      board.querySelector<HTMLElement>(".helix-conflict-entry.is-selected")?.scrollIntoView({ block: "nearest" });
    });

    const historyHead = history.createDiv({ cls: "helix-conflict-history-head" });
    historyHead.createEl("strong", { text: "最近处理" });
    const historyIcon = historyHead.createSpan();
    setIcon(historyIcon, "chevron-up");
    const timeline = history.createDiv({ cls: "helix-conflict-history-list" });
    const recent = [...audits].sort((left, right) => right.resolvedAt.localeCompare(left.resolvedAt)).slice(0, 6);
    if (recent.length === 0) {
      timeline.createDiv({ cls: "helix-conflict-history-empty", text: "还没有已完成的冲突处理。" });
    } else {
      for (const audit of recent) {
        const event = timeline.createDiv({ cls: "helix-conflict-history-event" });
        const icon = event.createSpan();
        setIcon(icon, "circle-check");
        const copy = event.createDiv();
        copy.createSpan({ text: formatConflictClock(audit.resolvedAt) });
        copy.createEl("strong", { text: "已完成逐字段合并" });
        copy.createEl("small", { text: `${audit.kind === "task" ? "任务" : "项目"} · ${audit.entityId}` });
      }
    }
    renderBoard();
  }

  private async chooseAllConflictFields(
    conflict: SyncConflict,
    choice: "local" | "remote",
  ): Promise<void> {
    if (conflict.status === "applying") throw new Error("该冲突正在等待远端核对，当前不能修改选择");
    for (const field of conflict.fields) {
      if (field.sameResult || field.choice === choice) continue;
      await this.service.chooseConflict(conflict.id, field.path, choice);
    }
    await this.render();
  }

  private async applySuggestedConflictChoices(conflicts: SyncConflict[]): Promise<void> {
    let applied = 0;
    for (const conflict of conflicts) {
      if (conflict.status === "applying") continue;
      for (const field of conflict.fields) {
        if (field.sameResult || field.choice || !field.suggestedChoice) continue;
        await this.service.chooseConflict(conflict.id, field.path, field.suggestedChoice);
        applied += 1;
      }
    }
    if (applied === 0) new Notice("所选冲突没有可安全自动采用的单边建议");
    else new Notice(`已采用 ${applied} 个无竞争字段建议；双边竞争仍需你选择`);
    await this.render();
  }

  private renderProjectionConflicts(
    content: HTMLElement,
    models: ProjectionProjectReadModel[],
    persistedColumnCreation: ProjectionProjectReadModel["columnCreation"],
    token: number,
  ): number {
    const pending = models.flatMap((model) => model.receiptCleanupPending);
    const columnCreation = persistedColumnCreation?.status === "unknown" ? persistedColumnCreation : undefined;
    const frozenActions = models.flatMap((model) => model.stages.flatMap((stage) =>
      stage.managed.filter((action) => action.frozen).map((action) => ({ model, stageId: stage.id, action }))));
    const orphaned = models.flatMap((model) => model.orphanDiagnostics.map((action) => ({ model, action })));
    const frozenParents = models.flatMap((model) => model.stages
      .filter((stage) => stage.parentDiagnostic?.frozen)
      .map((stage) => ({ model, stage })));
    const referenced = new Set([
      ...pending.map((item) => item.operationId),
      ...frozenActions.flatMap((item) => item.action.operationId ? [item.action.operationId] : []),
      ...orphaned.flatMap((item) => item.action.operationId ? [item.action.operationId] : []),
      ...frozenParents.flatMap(({ stage }) =>
        stage.parentDiagnostic?.operationId ? [stage.parentDiagnostic.operationId] : []),
    ]);
    const receipts = [...new Map(models.flatMap((model) => model.receipts)
      .map((receipt) => [receipt.operationId, receipt])).values()]
      .filter((receipt) => !referenced.has(receipt.operationId));
    const count = pending.length + frozenActions.length + orphaned.length + frozenParents.length + receipts.length +
      (columnCreation ? 1 : 0);
    if (count === 0) return 0;
    const group = content.createDiv({ cls: "helix-projection-conflict-group" });
    group.createEl("h2", { text: "滴答项目同步" });
    if (!PROJECT_DIDA_PROJECTION_AVAILABLE) {
      group.createEl("p", { text: "0.1.0 个人预览版仅显示历史诊断；所有复读、重试、清理和写回入口均已关闭。" });
    }
    if (columnCreation) {
      const card = group.createDiv({ cls: "helix-card helix-projection-conflict-card" });
      card.createEl("strong", { text: `分栏创建结果未知 · ${columnCreation.desiredName}` });
      card.createEl("code", { text: `${columnCreation.targetProjectId} / ${columnCreation.operationId}` });
      card.createEl("p", { text: "只会双源复读并精确领养；不会重发创建、删除或改名任何分栏。" });
      if (PROJECT_DIDA_PROJECTION_AVAILABLE) {
        const reconcile = card.createEl("button", { text: "精确复读并收口" });
        reconcile.addEventListener("click", () => this.runProjectionUiAction(reconcile, token,
          () => this.actions.reconcileProjectProjectionColumn()));
      }
    }
    if (pending.length > 0) {
      const card = group.createDiv({ cls: "helix-card helix-projection-conflict-card" });
      card.createEl("strong", { text: `${pending.length} 条收据清理等待重试` });
      card.createEl("p", { text: "冻结状态已经安全收口；这里只幂等清理持久收据，不触发远端写入。" });
      if (PROJECT_DIDA_PROJECTION_AVAILABLE) {
        const retry = card.createEl("button", { text: "重试安全清理" });
        retry.addEventListener("click", () => this.runProjectionUiAction(retry, token,
          () => this.actions.recoverPendingProjectProjectionReceiptCleanup()));
      }
    }
    for (const { model, stageId, action } of frozenActions) {
      this.renderProjectionReconcileCard(group, token, model, stageId, action.uuid,
        `${action.title} · ${action.frozen}`, true);
    }
    for (const { model, action } of orphaned) {
      this.renderProjectionReconcileCard(group, token, model, action.stageId, action.uuid,
        `失联关联 ${action.uuid} · ${action.frozen ?? action.state}`, Boolean(action.frozen));
    }
    for (const { model, stage } of frozenParents) {
      const card = group.createDiv({ cls: "helix-card helix-projection-conflict-card" });
      card.createEl("strong", { text: `${model.project.title}／${stage.title ?? stage.id} · 阶段任务冻结` });
      card.createEl("code", { text: stage.parentDiagnostic?.operationId ?? "无操作 ID" });
      if (PROJECT_DIDA_PROJECTION_AVAILABLE) {
        const reconcile = card.createEl("button", { text: "精确复读并收口" });
        reconcile.addEventListener("click", () => this.runProjectionUiAction(reconcile, token,
          () => this.actions.reconcileProjectProjectionFrozen({
            kind: "parent", projectId: model.project.id, stageId: stage.id,
          })));
      }
    }
    for (const receipt of receipts) {
      const card = group.createDiv({ cls: "helix-card helix-projection-conflict-card" });
      card.createEl("strong", { text: `滴答项目同步收据 · ${receipt.outcome}` });
      card.createEl("code", { text: receipt.operationId });
      if (receipt.outcome !== "verified" && receipt.outcome !== "verified-absent") {
        card.createEl("p", { text: "该收据尚未完成既有队列、冲突或结果未知收口；此处不提供清理。" });
        continue;
      }
      card.createEl("p", { text: "只有既有队列与逐字段冲突均已收口时，安全检查才允许移除此收据。" });
      if (PROJECT_DIDA_PROJECTION_AVAILABLE) {
        const cleanup = card.createEl("button", { text: "安全检查并清理" });
        cleanup.addEventListener("click", () => this.runProjectionUiAction(cleanup, token,
          () => this.actions.removeResolvedProjectProjectionReceipt(receipt.operationId)));
      }
    }
    return count;
  }

  private renderProjectionReconcileCard(
    group: HTMLElement,
    token: number,
    model: ProjectionProjectReadModel,
    stageId: string,
    uuid: string,
    label: string,
    actionable: boolean,
  ): void {
    const card = group.createDiv({ cls: "helix-card helix-projection-conflict-card" });
    card.createEl("strong", { text: `${model.project.title} · ${label}` });
    card.createEl("code", { text: `${stageId} / ${uuid}` });
    if (!PROJECT_DIDA_PROJECTION_AVAILABLE) {
      card.createEl("p", { text: "0.1.0 仅保留该项目联动记录供诊断，不提供复读或写回操作。" });
      return;
    }
    if (!actionable) {
      card.createEl("p", { text: "该行动尚未冻结；返回项目页保存变更后，后台同步会生成并处理删除记录。" });
      return;
    }
    const reconcile = card.createEl("button", { text: "精确复读并收口" });
    reconcile.addEventListener("click", () => this.runProjectionUiAction(reconcile, token,
      () => this.actions.reconcileProjectProjectionFrozen({
        kind: "action", projectId: model.project.id, stageId, uuid,
      })));
  }

  private renderFocusBridgeConflict(
    content: HTMLElement,
    conflict: ProjectWorkspaceFocusConflict,
    embedded = false,
  ): void {
    const card = content.createDiv({ cls: `helix-card helix-conflict-card${embedded ? " is-embedded" : ""}` });
    if (!embedded) {
      card.createEl("span", { cls: "helix-chip is-danger", text: "阶段聚焦冲突" });
      card.createEl("h3", { text: `${conflict.sourceId} → ${conflict.targetId}` });
      card.createEl("p", {
        text: conflict.reason === "derived-structure-changed"
          ? "派生引用的链接或结构发生变化，已冻结该引用。"
          : conflict.reason === "checkpoint-missing"
            ? "缺少可验证的同步基线，已停止自动写入。"
            : "来源和派生正文均已变化，请选择保留内容。",
      });
    }
    const columns = card.createDiv({ cls: "helix-conflict-options" });
    const base = columns.createDiv({ cls: "helix-conflict-option is-base" });
    base.createEl("strong", { text: "Base" });
    base.createEl("pre", { text: conflict.baseContent ?? "（检查点不可恢复）" });
    if (conflict.reason !== "simultaneous-edit") {
      const actions = card.createDiv({ cls: "helix-reconciliation-actions" });
      if (conflict.reason === "derived-structure-changed" &&
        conflict.derivedContent !== "<派生受管块结构损坏>") {
        const rebuild = actions.createEl("button", {
          cls: "helix-primary-button",
          text: "按来源重建自动引用",
        });
        rebuild.addEventListener("click", () => {
          rebuild.disabled = true;
          void this.actions.mutateProjectWorkspace(() =>
            this.actions.projectWorkspace.rebuildFocusBridgeConflict(conflict.id))
            .then(() => this.render())
            .catch((error) => {
              rebuild.disabled = false;
              new Notice(error instanceof Error ? error.message : String(error), 8_000);
            });
        });
      }
      const open = actions.createEl("button", {
        cls: "helix-secondary-button",
        text: "打开 Markdown 手工修复",
      });
      open.addEventListener("click", () => {
        void this.actions.openProjectFile(conflict.targetPath);
      });
      return;
    }
    const addChoice = (
      title: string,
      value: string | null,
      choice: "source" | "derived",
    ) => {
      const option = columns.createDiv({ cls: "helix-conflict-option" });
      option.createEl("strong", { text: title });
      option.createEl("pre", { text: value ?? "（检查点不可恢复）" });
      const button = option.createEl("button", {
        cls: "helix-secondary-button",
        text: `采用${title}`,
      });
      button.addEventListener("click", () => {
        button.disabled = true;
        void this.actions.mutateProjectWorkspace(() =>
          this.actions.projectWorkspace.resolveFocusBridgeConflict(conflict.id, choice))
          .then(() => this.render())
          .catch((error) => {
            button.disabled = false;
            new Notice(error instanceof Error ? error.message : String(error), 8_000);
          });
      });
    };
    addChoice("来源", conflict.sourceContent, "source");
    addChoice("派生", conflict.derivedContent, "derived");
    const custom = columns.createDiv({
      cls: `helix-conflict-option helix-focus-custom${embedded ? " is-collapsed" : ""}`,
    });
    custom.createEl("strong", { text: "自定义" });
    if (embedded) {
      const reveal = custom.createEl("button", {
        cls: "helix-secondary-button helix-focus-custom-toggle",
        text: "手动编辑",
        attr: { "aria-expanded": "false" },
      });
      reveal.addEventListener("click", () => {
        custom.removeClass("is-collapsed");
        reveal.setAttribute("aria-expanded", "true");
      });
    }
    const editor = custom.createEl("textarea", {
      attr: { "aria-label": "自定义阶段聚焦内容" },
    });
    const apply = custom.createEl("button", {
      cls: "helix-primary-button",
      text: "采用自定义内容",
    });
    apply.addEventListener("click", () => {
      apply.disabled = true;
      void this.actions.mutateProjectWorkspace(() =>
        this.actions.projectWorkspace.resolveFocusBridgeConflict(
          conflict.id,
          "custom",
          editor.value,
        ))
        .then(() => this.render())
        .catch((error) => {
          apply.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  private renderConflictTextDiff(
    parent: HTMLElement,
    conflict: SyncConflict,
    field: ConflictField,
    applying: boolean,
  ): void {
    const localValue = String(field.localValue ?? "");
    const remoteValue = String(field.remoteValue ?? "");
    const previewLimit = 400;
    const localLines = localValue.replace(/\r\n?/g, "\n").split("\n");
    const remoteLines = remoteValue.replace(/\r\n?/g, "\n").split("\n");
    const previewTruncated = localLines.length > previewLimit || remoteLines.length > previewLimit;
    const rows = sideBySideTextDiff(
      localLines.slice(0, previewLimit).join("\n"),
      remoteLines.slice(0, previewLimit).join("\n"),
    );
    const lastLine = Math.max(
      ...rows.flatMap((row) => [row.leftNumber ?? 0, row.rightNumber ?? 0]),
      1,
    );
    const section = parent.createDiv({ cls: "helix-conflict-ide-field" });
    const head = section.createDiv({ cls: "helix-conflict-ide-field-head" });
    const identity = head.createDiv();
    identity.createEl("strong", { text: `差异预览（第 1–${lastLine} 行）` });
    identity.createSpan({ text: `${field.label} · ${field.path}` });
    const base = head.createDiv({ cls: "helix-conflict-ide-base" });
    base.createSpan({ text: previewTruncated ? "前 400 行预览" : "Base（共同基线）" });
    const baseValue = String(field.baseValue ?? "（空）");
    base.createEl("code", { text: baseValue.length > 160 ? `${baseValue.slice(0, 160)}…` : baseValue });

    const ide = section.createDiv({
      cls: `helix-conflict-ide is-${this.conflictDiffMode}${field.choice ? ` is-${field.choice}` : ""}`,
    });
    const choose = (choice: "local" | "remote") => {
      void this.service.chooseConflict(conflict.id, field.path, choice)
        .then(() => this.render())
        .catch((error) => new Notice(messageOf(error), 8_000));
    };
    if (this.conflictDiffMode === "split") {
      const paneHead = ide.createDiv({ cls: "helix-conflict-ide-pane-head is-local" });
      paneHead.createSpan({ text: "本地（你的版本）" });
      const useLocal = paneHead.createEl("button", {
        cls: field.choice === "local" ? "is-selected" : "",
        text: field.choice === "local" ? "已选本地" : "采用本地",
      });
      useLocal.disabled = applying;
      useLocal.addEventListener("click", () => choose("local"));
      const remoteHead = ide.createDiv({ cls: "helix-conflict-ide-pane-head is-remote" });
      remoteHead.createSpan({ text: "远端（同步版本）" });
      const useRemote = remoteHead.createEl("button", {
        cls: field.choice === "remote" ? "is-selected" : "",
        text: field.choice === "remote" ? "已选远端" : "采用远端",
      });
      useRemote.disabled = applying;
      useRemote.addEventListener("click", () => choose("remote"));
      for (const row of rows) {
        const left = ide.createDiv({ cls: `helix-conflict-ide-line is-${row.leftTone}` });
        left.createSpan({ text: row.leftNumber === undefined ? "" : String(row.leftNumber) });
        left.createEl("code", { text: row.leftText || " " });
        const right = ide.createDiv({ cls: `helix-conflict-ide-line is-${row.rightTone}` });
        right.createSpan({ text: row.rightNumber === undefined ? "" : String(row.rightNumber) });
        right.createEl("code", { text: row.rightText || " " });
      }
    } else {
      const unifiedHead = ide.createDiv({ cls: "helix-conflict-ide-unified-head" });
      unifiedHead.createSpan({ text: "统一差异 · − 本地删除／＋远端新增" });
      const actions = unifiedHead.createDiv();
      actions.createEl("button", { text: "采用本地" }).addEventListener("click", () => choose("local"));
      actions.createEl("button", { text: "采用远端" }).addEventListener("click", () => choose("remote"));
      for (const row of rows) {
        if (row.leftTone === "unchanged") {
          const line = ide.createDiv({ cls: "helix-conflict-ide-unified-line is-unchanged" });
          line.createSpan({ text: String(row.leftNumber ?? "") });
          line.createSpan({ text: String(row.rightNumber ?? "") });
          line.createEl("code", { text: `  ${row.leftText || " "}` });
          continue;
        }
        if (row.leftTone !== "empty") {
          const line = ide.createDiv({ cls: "helix-conflict-ide-unified-line is-removed" });
          line.createSpan({ text: String(row.leftNumber ?? "") });
          line.createSpan({ text: "" });
          line.createEl("code", { text: `− ${row.leftText || " "}` });
        }
        if (row.rightTone !== "empty") {
          const line = ide.createDiv({ cls: "helix-conflict-ide-unified-line is-added" });
          line.createSpan({ text: "" });
          line.createSpan({ text: String(row.rightNumber ?? "") });
          line.createEl("code", { text: `＋ ${row.rightText || " "}` });
        }
      }
    }

    const custom = section.createDiv({
      cls: `helix-conflict-custom helix-conflict-ide-custom${field.choice === "custom" ? " is-selected" : " is-collapsed"}`,
    });
    const reveal = custom.createEl("button", {
      cls: "helix-secondary-button helix-conflict-custom-toggle",
      text: field.choice === "custom" ? "自定义合并内容" : "手动编辑合并内容",
      attr: { "aria-expanded": String(field.choice === "custom") },
    });
    reveal.disabled = applying;
    const editor = custom.createEl("textarea", {
      placeholder: "输入最终合并后的完整正文",
      attr: { "aria-label": `${field.label} 自定义合并内容` },
    });
    editor.value = field.choice === "custom" ? String(field.customValue ?? "") : localValue;
    editor.disabled = applying;
    const apply = custom.createEl("button", {
      cls: "helix-secondary-button",
      text: "采用手动合并内容",
    });
    apply.disabled = applying;
    reveal.addEventListener("click", () => {
      custom.removeClass("is-collapsed");
      reveal.setAttr("aria-expanded", "true");
      editor.focus();
    });
    apply.addEventListener("click", () => {
      void this.service.chooseConflict(conflict.id, field.path, "custom", editor.value)
        .then(() => this.render())
        .catch((error) => new Notice(messageOf(error), 8_000));
    });
  }

  private renderConflict(content: HTMLElement, conflict: SyncConflict, embedded = false): void {
    const applying = conflict.status === "applying";
    const projectionReadOnly =
      !PROJECT_DIDA_PROJECTION_AVAILABLE && conflict.scope === "helix-projection-owned-items";
    const card = content.createDiv({ cls: `helix-card helix-conflict-card${embedded ? " is-embedded" : ""}` });
    if (!embedded) {
      const head = card.createDiv({ cls: "helix-conflict-head" });
      const title = head.createDiv();
      title.createEl("span", { cls: "helix-chip is-danger", text: conflict.kind === "task" ? "任务冲突" : "项目冲突" });
      title.createEl("h3", { text: conflict.title });
      title.createEl("p", { text: `远端复检 ${conflict.remoteRecheckCount} 次 · ${conflict.fields.length} 个变化字段` });
    }
    if (projectionReadOnly) {
      card.createEl("p", { text: "0.1.0 仅保留该项目联动冲突供诊断，不提供字段选择、写回或远端采纳。" });
      for (const field of conflict.fields) {
        const row = card.createDiv({ cls: "helix-conflict-field" });
        row.createEl("strong", { text: `${field.label} · ${field.path}` });
        row.createEl("code", { text: `Base ${displayValue(field.baseValue)}` });
        row.createEl("code", { text: `本地 ${displayValue(field.localValue)}` });
        row.createEl("code", { text: `远端 ${displayValue(field.remoteValue)}` });
      }
      return;
    }
    const hasEmbeddedTextDiff = embedded && conflict.fields.some((field) =>
      field.group === "text" && typeof field.localValue === "string" && typeof field.remoteValue === "string");
    let otherFields: HTMLElement | null = null;
    for (const field of conflict.fields) {
      if (embedded && field.group === "text" &&
        typeof field.localValue === "string" && typeof field.remoteValue === "string") {
        this.renderConflictTextDiff(card, conflict, field, applying);
        continue;
      }
      if (hasEmbeddedTextDiff && !otherFields) {
        const details = card.createEl("details", { cls: "helix-conflict-other-fields" });
        details.createEl("summary", {
          text: `其他 ${conflict.fields.filter((candidate) => candidate.group !== "text").length} 个属性冲突`,
        });
        otherFields = details.createDiv({ cls: "helix-conflict-other-fields-content" });
      }
      const row = (otherFields ?? card).createDiv({ cls: "helix-conflict-field" });
      const label = row.createDiv({ cls: "helix-conflict-label" });
      label.createEl("strong", { text: field.label });
      label.createSpan({ text: field.path });
      const options = row.createDiv({ cls: "helix-conflict-options" });
      const base = options.createDiv({ cls: "helix-conflict-option is-base" });
      base.createSpan({ text: "Base（共同基线）" });
      base.createEl("code", { text: displayValue(field.baseValue) });
      this.renderConflictOption(options, conflict, field.path, "local", "本地", field.localValue, field.choice, applying);
      this.renderConflictOption(options, conflict, field.path, "remote", "远端", field.remoteValue, field.choice, applying);
      const custom = options.createDiv({
        cls: `helix-conflict-custom${field.choice === "custom" ? " is-selected" : " is-collapsed"}`,
      });
      const revealCustom = custom.createEl("button", {
        cls: "helix-secondary-button helix-conflict-custom-toggle",
        text: field.choice === "custom" ? "自定义值" : "使用自定义值",
        attr: { "aria-expanded": String(field.choice === "custom") },
      });
      const input = custom.createEl("textarea", {
        placeholder: "输入自定义合并值；数组或对象可使用 JSON",
        attr: { "aria-label": `${field.label} 自定义值` },
      });
      input.value = field.choice === "custom" ? displayEditableValue(field.customValue) : "";
      input.disabled = applying;
      const useCustom = custom.createEl("button", {
        cls: "helix-secondary-button",
        text: "确认自定义值",
      });
      revealCustom.disabled = applying;
      revealCustom.addEventListener("click", () => {
        custom.removeClass("is-collapsed");
        revealCustom.setAttr("aria-expanded", "true");
        input.focus();
      });
      useCustom.disabled = applying;
      useCustom.addEventListener("click", () => {
        void Promise.resolve()
          .then(() => parseCustomValue(input.value))
          .then((value) =>
            this.service.chooseConflict(conflict.id, field.path, "custom", value),
          )
          .then(() => this.render())
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
      });
      if (field.group === "schedule") {
        row.createDiv({
          cls: "helix-conflict-group-note",
          text: "时间组：选择本地或远端时会同步选择开始、截止、时区、全天、提醒与重复规则。",
        });
      }
    }
    const footer = card.createDiv({ cls: "helix-conflict-footer" });
    const unresolved = conflict.fields.filter((field) => !field.sameResult && !field.choice).length;
    footer.createSpan({ text: unresolved > 0 ? `还有 ${unresolved} 个字段未选择` : "所有字段已明确选择" });
    const apply = footer.createEl("button", {
      cls: "helix-primary-button",
      text: conflict.status === "applying" ? "正在应用或待核对" : "复检远端并应用",
    });
    apply.disabled = unresolved > 0 || applying;
    apply.addEventListener("click", () => {
      apply.disabled = true;
      void this.service.applyConflict(conflict.id)
        .then(() => new Notice("冲突已合并并完成远端复检"))
        .catch((error) => new Notice(error instanceof Error ? error.message : String(error), 8_000))
        .finally(() => void this.render());
    });
    if (applying) {
      const recovery = card.createDiv({ cls: "helix-conflict-recovery" });
      recovery.createEl("p", {
        text: "上次写回的远端结果未知。请前往滴答 App 核对；仅在确认已生效后复读采纳。未确认前将保持只读冻结，不能解锁或重发。若本次是重建且产生了新记录，请填写新记录 ID。",
      });
      const remoteId = recovery.createEl("input", {
        type: "text",
        placeholder: "可选：重建后产生的新滴答记录 ID",
        attr: { "aria-label": "冲突恢复远端记录 ID" },
      });
      const adopt = recovery.createEl("button", {
        cls: "helix-primary-button",
        text: "远端已生效，复读并采纳",
      });
      adopt.addEventListener("click", () => {
        adopt.disabled = true;
        void this.service.adoptAppliedConflict(conflict.id, remoteId.value)
          .then(() => this.render())
          .catch((error) => {
            adopt.disabled = false;
            new Notice(error instanceof Error ? error.message : String(error), 8_000);
          });
      });
    }
  }

  private renderConflictOption(
    parent: HTMLElement,
    conflict: SyncConflict,
    path: string,
    choice: ResolutionChoice,
    label: string,
    value: unknown,
    selected?: ResolutionChoice,
    disabled = false,
  ): void {
    const button = parent.createEl("button", {
      cls: `helix-conflict-option${selected === choice ? " is-selected" : ""}`,
    });
    button.createSpan({ text: label });
    button.createEl("code", { text: displayValue(value) });
    button.disabled = disabled;
    button.addEventListener("click", () => {
      button.disabled = true;
      void this.service
        .chooseConflict(conflict.id, path, choice)
        .then(() => this.render())
        .catch((error) => {
          button.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  private renderPageTitle(content: HTMLElement, title: string): void {
    const intro = content.createDiv({ cls: "helix-page-intro" });
    intro.createEl("h2", { text: title });
  }

  private displayState(): { projects: DidaProject[]; tasks: DidaTask[] } {
    if (!DIDA_READ_AVAILABLE) return { projects: [], tasks: [] };
    const projects = this.state?.demoMode ? this.previewProjects : this.state?.projects ?? [];
    const tasks = this.state?.demoMode ? this.previewTasks : this.state?.tasks ?? [];
    return { projects, tasks };
  }

  private filterTasks(tasks: DidaTask[]): DidaTask[] {
    if (this.taskFilter === "all") return completionLast(tasks);
    const inProgressIds = new Set(this.state?.inProgress.map((entry) => entry.taskId) ?? []);
    for (const parent of this.localProjectTaskSnapshot?.stageParents ?? []) {
      if (parent.stageStatus === "active") inProgressIds.add(parent.remoteTaskId);
    }
    if (this.taskFilter === "active") {
      for (const task of tasks) {
        if (this.localProjectTaskSnapshot?.byId.get(task.id)?.state === "active") {
          inProgressIds.add(task.id);
        }
      }
      const visibleIds = withTaskDescendants(tasks, inProgressIds);
      return completionLast(tasks.filter((task) => visibleIds.has(task.id) && task.status !== 2));
    }
    return tasks.filter((task) => {
      const localState = this.localProjectTaskSnapshot?.byId.get(task.id)?.state;
      if (localState) return localState === this.taskFilter;
      const stageState = this.localProjectTaskSnapshot?.byRemoteParentTaskId.get(task.id)?.stageStatus;
      if (stageState) return stageState === this.taskFilter;
      if (this.taskFilter === "completed") return task.status === 2;
      if (task.status === 2) return false;
      if (this.taskFilter === "idea") return !inProgressIds.has(task.id);
      return false;
    }).sort((left, right) =>
      Number(isTaskCompleted(left)) - Number(isTaskCompleted(right)));
  }

  private hasHabitCheckin(label: string, date: string): boolean {
    const habit = this.state?.habits.find((candidate) => candidate.name === label);
    if (!habit) return false;
    return (this.state?.habitCheckins ?? []).some(
      (checkin) =>
        checkin.habitId === habit.id &&
        localDateKeyFromInstant(checkin.checkinTime) === date,
    );
  }

  private mountTrendChart(
    element: HTMLElement,
    points: Array<{ label: string; value: number }>,
  ): void {
    const chart = echarts.init(element, undefined, { renderer: "canvas" });
    chart.setOption({
      animationDuration: 350,
      grid: { left: 28, right: 16, top: 18, bottom: 26 },
      xAxis: { type: "category", boundaryGap: false, data: points.map((point) => point.label), axisLine: { lineStyle: { color: "#dfe3ea" } }, axisTick: { show: false } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f4" } } },
      tooltip: { trigger: "axis" },
      series: [{ type: "line", smooth: 0.35, symbol: "circle", symbolSize: 6, data: points.map((point) => point.value), lineStyle: { color: "#4967de", width: 3 }, itemStyle: { color: "#4967de" }, areaStyle: { color: "rgba(73,103,222,.12)" } }],
    });
    this.charts.push(chart);
    this.observeChart(element, chart);
  }

  private disposeCharts(): void {
    for (const observer of this.chartObservers) observer.disconnect();
    this.chartObservers = [];
    for (const chart of this.charts) chart.dispose();
    this.charts = [];
  }

  private observeChart(element: HTMLElement, chart: echarts.ECharts): void {
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);
    this.chartObservers.push(observer);
  }
}

export class WorkspaceStatusModal<T extends string> extends Modal {
  private selected: T;

  constructor(
    app: HelixView["app"],
    private readonly heading: string,
    private readonly entityLabel: string,
    private readonly current: T,
    private readonly options: Array<{ value: T; label: string }>,
    private readonly submit: (status: T) => Promise<void>,
  ) {
    super(app);
    this.selected = current;
  }

  onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl("p", {
      cls: "helix-modal-entity",
      text: this.entityLabel,
    });
    let save!: HTMLButtonElement;
    new Setting(this.contentEl)
      .setName("状态")
      .addDropdown((dropdown) => {
        for (const option of this.options) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown.setValue(this.current);
        dropdown.onChange((value) => {
          this.selected = value as T;
          save.disabled = this.selected === this.current;
        });
        dropdown.selectEl.setAttribute("aria-label", `${this.entityLabel} 的状态`);
      });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" })
      .addEventListener("click", () => this.close());
    save = actions.createEl("button", {
      cls: "mod-cta",
      text: "保存状态",
    });
    save.disabled = true;
    save.addEventListener("click", () => {
      save.disabled = true;
      void this.submit(this.selected)
        .then(() => this.close())
        .catch((error) => {
          save.disabled = this.selected === this.current;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ConnectionTargetModal extends Modal {
  private targetId = "";

  constructor(
    app: HelixView["app"],
    private readonly snapshot: ProjectWorkspaceSnapshot,
    private readonly sourceId: string,
    private readonly allowedTargetIds: string[],
    private readonly submit: (targetId: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("连接到已有阶段");
    const source = this.stageLabel(this.sourceId);
    this.contentEl.createEl("p", { text: `来源：${source}` });
    new Setting(this.contentEl)
      .setName("目标阶段")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "选择目标阶段");
        const allowed = new Set(this.allowedTargetIds);
        for (const project of this.snapshot.projects) {
          for (const cycle of project.cycles) {
            if (cycle.id === this.sourceId || !allowed.has(cycle.id)) continue;
            dropdown.addOption(
              cycle.id,
              `${project.title} / 阶段 ${cycle.stageCode} · ${cycle.title}`,
            );
          }
        }
        dropdown.onChange((value) => {
          this.targetId = value;
        });
      });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" })
      .addEventListener("click", () => this.close());
    const connect = actions.createEl("button", { cls: "mod-cta", text: "预览连接" });
    connect.addEventListener("click", () => {
      if (!this.targetId) {
        new Notice("请选择目标阶段");
        return;
      }
      this.close();
      this.submit(this.targetId);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private stageLabel(id: string): string {
    for (const project of this.snapshot.projects) {
      const cycle = project.cycles.find((candidate) => candidate.id === id);
      if (cycle) return `${project.title} / 阶段 ${cycle.stageCode} · ${cycle.title}`;
    }
    return id;
  }
}

class ConnectionConfirmModal extends Modal {
  private crossProjectConfirmed = false;

  constructor(
    app: HelixView["app"],
    private readonly plan: ProjectConnectionPlan,
    private readonly submit: (confirmCrossProject: boolean) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("确认阶段连接");
    this.contentEl.createEl("p", {
      text: `来源：${this.stageLabel(this.plan.source)}`,
    });
    this.contentEl.createEl("p", {
      text: `目标：${this.stageLabel(this.plan.target)}`,
    });
    this.contentEl.createEl("p", {
      text: `将新增 1 条有向边，并整理受影响的 ${this.plan.affectedNodeCount} 个节点。`,
    });
    this.contentEl.createEl("p", {
      cls: "helix-modal-note",
      text: `目标当前已有 ${this.plan.targetInboundCount} 条入边；连接后共有 ${
        this.plan.targetInboundCount + 1
      } 条入边，新增关系将按${
        CYCLE_RELATION_LABELS[this.plan.resultKind]
      }显示。`,
    });
    this.contentEl.createEl("p", {
      cls: "helix-modal-note",
      text: this.plan.relabeledEdgeCount > 0
        ? `完整拓扑重算后，会有 ${this.plan.relabeledEdgeCount} 条已有边改为继承、分支或合并。`
        : "已有边的关系类型不会变化。",
    });
    if (this.plan.crossProject) {
      const confirmation = this.contentEl.createEl("label", {
        cls: "helix-branch-confirm",
      });
      const checkbox = confirmation.createEl("input", { type: "checkbox" });
      confirmation.createSpan({ text: "我确认建立跨项目阶段关系" });
      checkbox.addEventListener("change", () => {
        this.crossProjectConfirmed = checkbox.checked;
        confirm.disabled = !this.crossProjectConfirmed;
      });
    }
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" })
      .addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      cls: "mod-cta",
      text: "建立连接",
    });
    confirm.disabled = this.plan.crossProject;
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      void this.submit(this.crossProjectConfirmed)
        .then(() => this.close())
        .catch((error) => {
          confirm.disabled = this.plan.crossProject && !this.crossProjectConfirmed;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private stageLabel(stage: ProjectConnectionPlan["source"]): string {
    return `${stage.projectTitle} / 阶段 ${stage.sequence} · ${stage.cycleTitle}`;
  }
}

class NativeRelationAdoptionModal extends Modal {
  private crossProjectConfirmed = false;

  constructor(
    app: HelixView["app"],
    private readonly candidate: ProjectWorkspaceNativeRelationAdoptionPlan,
    private readonly submit: (confirmCrossProject: boolean) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("将 Canvas 连线交由 Helix 管理");
    this.contentEl.createEl("p", {
      text: `${this.candidate.fromTitle} → ${this.candidate.toTitle}`,
    });
    this.contentEl.createEl("p", {
      cls: "helix-modal-note",
      text: `完整拓扑计算为${
        CYCLE_RELATION_LABELS[this.candidate.resultKind]
      }；将整理受影响的 ${this.candidate.affectedNodeCount} 个节点。`,
    });
    this.contentEl.createEl("p", {
      cls: "helix-modal-note",
      text: this.candidate.relabeledEdgeCount > 0
        ? `另有 ${this.candidate.relabeledEdgeCount} 条已有边会同步改为继承、分支或合并。`
        : "Helix 已管理的其他连线关系类型不会变化。",
    });
    if (this.candidate.crossProject) {
      const confirmation = this.contentEl.createEl("label", {
        cls: "helix-branch-confirm",
      });
      const checkbox = confirmation.createEl("input", { type: "checkbox" });
      confirmation.createSpan({ text: "我确认将这条跨项目连线交由 Helix 管理" });
      checkbox.addEventListener("change", () => {
        this.crossProjectConfirmed = checkbox.checked;
        confirm.disabled = !this.crossProjectConfirmed;
      });
    }
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" })
      .addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      cls: "mod-cta",
      text: "确认管理",
    });
    confirm.disabled = this.candidate.crossProject;
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      void this.submit(this.crossProjectConfirmed)
        .then(() => this.close())
        .catch((error) => {
          confirm.disabled =
            this.candidate.crossProject && !this.crossProjectConfirmed;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function formatFullDate(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

function longDateLabel(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

function weekdayLabel(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
}

function taskRangeLabel(
  range: TaskDateRange,
  mode: Extract<TaskViewMode, "day" | "three-day" | "week" | "month">,
  anchor: Date,
): string {
  if (mode === "day") return longDateLabel(anchor);
  if (mode === "month") {
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(anchor);
  }
  const short = (date: Date): string => new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(date);
  return `${short(range.start)} – ${short(range.end)}`;
}

function formatShortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function relativeConflictTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "时间未知";
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function formatConflictClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatHour(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return instantToWallDateTime(date.toISOString(), safeTaskTimeZone(timeZone)).slice(11, 16);
}

function minuteLabel(value: number): string {
  const minute = Math.max(0, Math.min(1_440, value));
  if (minute === 1_440) return "24:00";
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function displayValue(value: unknown): string {
  if (value === undefined) return "未设置";
  if (value === null) return "空";
  if (typeof value === "string") return value || "空字符串";
  return JSON.stringify(value);
}

function displayEditableValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function parseCustomValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    trimmed.startsWith("[") ||
    trimmed.startsWith("{") ||
    trimmed === "null" ||
    trimmed === "true" ||
    trimmed === "false" ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error("自定义 JSON 格式不正确");
    }
  }
  return value;
}

function daysRemaining(endsAt: string): string {
  const days = Math.max(
    0,
    Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000),
  );
  return `还剩 ${days} 天`;
}

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateKey(date);
}

function taskDateKey(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  try {
    return localDateKeyFromInstant(value);
  } catch {
    return value.slice(0, 10);
  }
}

function safeTaskTimeZone(value: string | undefined): string {
  for (const candidate of [
    value,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "UTC",
  ]) {
    if (!candidate) continue;
    try {
      assertTimeZone(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return "UTC";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class DidaProjectCreateModal extends Modal {
  private name = "";
  private color = "#5268d4";

  constructor(
    app: HelixView["app"],
    private readonly submit: (name: string, color: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("创建滴答清单");
    new Setting(this.contentEl)
      .setName("清单名称")
      .addText((text) => text.setPlaceholder("例如：论文实验").onChange((value) => {
        this.name = value;
      }));
    new Setting(this.contentEl)
      .setName("清单颜色")
      .addText((text) => {
        text.inputEl.type = "color";
        text.setValue(this.color).onChange((value) => {
          this.color = value;
        });
      });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const create = actions.createEl("button", { cls: "mod-cta", text: "创建清单" });
    create.addEventListener("click", () => {
      const name = this.name.trim();
      if (!name) {
        new Notice("清单名称不能为空");
        return;
      }
      create.disabled = true;
      void this.submit(name, this.color)
        .then(() => {
          new Notice("清单已创建");
          this.close();
        })
        .catch((error) => {
          create.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function taskDetailWallParts(
  startDate: string | null | undefined,
  dueDate: string | null | undefined,
  timeZone: string | null | undefined,
  isAllDay: boolean | undefined,
): Pick<TaskDetailDraft, "date" | "startTime" | "endTime" | "timeMode" | "timeZone"> {
  const zone = safeTaskTimeZone(timeZone ?? undefined);
  const start = instantToWallDateTime(startDate, zone);
  const due = instantToWallDateTime(dueDate, zone);
  const startTime = start.slice(11, 16);
  const endTime = due.slice(11, 16);
  return {
    date: (start || due).slice(0, 10),
    startTime,
    endTime,
    timeMode: isAllDay || (!startTime && !endTime)
      ? "none"
      : startTime && endTime && startTime !== endTime ? "range" : "point",
    timeZone: zone,
  };
}

function didaSubtaskDetail(task: DidaTask): TaskDetailSubtaskDraft {
  const wall = taskDetailWallParts(task.startDate, task.dueDate, task.timeZone, task.isAllDay);
  return {
    id: task.id,
    title: task.title,
    status: task.status === 2 ? "completed" : "active",
    priority: (task.priority ?? 0) as TaskDetailPriority,
    date: wall.date,
    startTime: wall.startTime,
    endTime: wall.endTime,
  };
}

function didaTaskDetailDraft(
  task: DidaTask,
  projects: DidaProject[],
  children: DidaTask[],
  source: "dida" | "preview",
): TaskDetailDraft {
  const wall = taskDetailWallParts(task.startDate, task.dueDate, task.timeZone, task.isAllDay);
  const projectName = projects.find((project) => project.id === task.projectId)?.name ?? "当前清单";
  return {
    id: task.id,
    source,
    breadcrumb: [source === "preview" ? "Helix 演示" : "滴答清单", projectName],
    syncLabel: source === "preview" ? "演示数据" : `已同步至滴答 · ${projectName}`,
    title: task.title,
    status: task.status === 2 ? "completed" : "active",
    priority: (task.priority ?? 0) as TaskDetailPriority,
    ...wall,
    tags: [...(task.tags ?? [])],
    listId: task.projectId,
    reminders: [...(task.reminders ?? [])],
    repeatFlag: task.repeatFlag ?? null,
    subtasks: children.map(didaSubtaskDetail),
  };
}

function didaTaskDetailCapabilities(
  projects: DidaProject[],
  reminder: boolean,
  repeat: boolean,
  hasChildren: boolean,
): TaskDetailCapabilities {
  return {
    delete: true,
    editTitle: true,
    editStatus: true,
    statusOptions: ["active", "completed"],
    editPriority: true,
    editSchedule: true,
    editTags: true,
    editSubtasks: hasChildren,
    addSubtasks: false,
    deleteSubtasks: false,
    editSubtaskSchedule: false,
    reorderSubtasks: false,
    list: true,
    listChoices: projects
      .filter((project) => !project.id.startsWith("local-project-"))
      .map((project) => ({ id: project.id, name: project.name })),
    reminder,
    repeat,
  };
}

function localSubtaskDetail(task: LocalProjectTask): TaskDetailSubtaskDraft {
  const wall = taskDetailWallParts(task.startDate, task.dueDate, task.timeZone, task.isAllDay);
  return {
    id: task.uuid,
    title: task.title,
    status: task.state,
    priority: task.priority,
    date: wall.date,
    startTime: wall.startTime,
    endTime: wall.endTime,
  };
}

function localTaskDetailDraft(task: LocalProjectTask, children: LocalProjectTask[]): TaskDetailDraft {
  const wall = taskDetailWallParts(task.startDate, task.dueDate, task.timeZone, task.isAllDay);
  return {
    id: task.id,
    source: "stage-action",
    breadcrumb: ["Helix 本地", task.projectTitle, `阶段 ${task.stageCode} ${task.stageTitle}`],
    syncLabel: "保存到阶段 Markdown",
    title: task.title,
    status: task.state,
    priority: task.priority,
    ...wall,
    tags: [...task.tags],
    reminders: [],
    repeatFlag: null,
    subtasks: children.map(localSubtaskDetail),
  };
}

function localTaskDetailCapabilities(completionDerivedFromSubtasks = false): TaskDetailCapabilities {
  return {
    delete: true,
    editTitle: true,
    editStatus: true,
    statusOptions: ["idea", "active", "completed", "paused", "terminated"],
    completionDerivedFromSubtasks,
    editPriority: true,
    editSchedule: true,
    editTags: true,
    editSubtasks: true,
    addSubtasks: true,
    deleteSubtasks: true,
    editSubtaskSchedule: true,
    reorderSubtasks: true,
    list: false,
    listChoices: [],
    reminder: false,
    repeat: false,
  };
}

function stageTaskDetailCapabilities(): TaskDetailCapabilities {
  return {
    ...localTaskDetailCapabilities(true),
    delete: false,
    editPriority: false,
    editSchedule: false,
    editTags: false,
    reorderSubtasks: false,
  };
}

function stageTaskDetailDraft(
  stage: LocalProjectStageTaskParent,
  roots: LocalProjectTask[],
): TaskDetailDraft {
  return {
    id: stage.remoteTaskId,
    source: "stage-projection",
    breadcrumb: ["Helix", stage.projectTitle, `阶段 ${stage.stageCode}`],
    syncLabel: "Markdown 权威 · 后台同步滴答",
    title: stage.stageTitle,
    status: stage.stageStatus as TaskDetailStatus,
    priority: 0,
    date: "",
    startTime: "",
    endTime: "",
    timeMode: "none",
    timeZone: safeTaskTimeZone(undefined),
    tags: [],
    reminders: [],
    repeatFlag: null,
    subtasks: roots.map(localSubtaskDetail),
  };
}

function localTaskDraftFromDetail(draft: TaskDetailDraft, content = ""): LocalProjectTaskDraft {
  const timeZone = draft.timeZone;
  const instant = (date: string, time: string): string | undefined =>
    date && time ? wallDateTimeToInstant(`${date}T${time}`, timeZone) ?? undefined : undefined;
  return {
    title: draft.title.trim(),
    state: draft.status,
    content,
    startDate: draft.date && draft.timeMode !== "none"
      ? instant(draft.date, draft.startTime || draft.endTime)
      : draft.date ? instant(draft.date, "00:00") : undefined,
    dueDate: draft.date && draft.timeMode === "range"
      ? instant(draft.date, draft.endTime || draft.startTime)
      : draft.date && draft.timeMode === "point"
        ? instant(draft.date, draft.startTime || draft.endTime)
        : draft.date ? instant(draft.date, "00:00") : undefined,
    timeZone,
    isAllDay: Boolean(draft.date) && draft.timeMode === "none",
    priority: draft.priority,
    tags: [...draft.tags],
    children: draft.subtasks.map((child) => ({
      uuid: child.id.startsWith("new:") ? undefined : child.id,
      title: child.title.trim(),
      state: child.status,
      startDate: instant(child.date, child.startTime || child.endTime),
      dueDate: instant(child.date, child.endTime || child.startTime),
      timeZone: child.date && (child.startTime || child.endTime) ? timeZone : undefined,
      priority: child.priority,
    })),
  };
}

function didaTaskEditableSnapshot(task: DidaTask): Record<string, unknown> {
  const zone = safeTaskTimeZone(task.timeZone);
  return {
    title: task.title,
    content: task.content ?? task.desc ?? "",
    startDate: instantToWallDateTime(task.startDate, zone),
    dueDate: instantToWallDateTime(task.dueDate, zone),
    isAllDay: task.isAllDay ?? false,
    timeZone: zone,
    priority: task.priority ?? 0,
    tags: [...(task.tags ?? [])],
  };
}

function didaTaskFromDetail(
  task: DidaTask,
  draft: TaskDetailDraft,
  scheduleMode: TaskScheduleMode,
): DidaTask {
  const startWall = draft.date && draft.timeMode !== "none"
    ? `${draft.date}T${draft.startTime || draft.endTime || "09:00"}`
    : draft.date ? `${draft.date}T00:00` : "";
  const dueWall = draft.date && draft.timeMode === "range"
    ? `${draft.date}T${draft.endTime || draft.startTime || "09:00"}`
    : startWall;
  const requested = {
    startDate: wallDateTimeToInstant(startWall, draft.timeZone),
    dueDate: wallDateTimeToInstant(dueWall, draft.timeZone),
    timeZone: draft.timeZone,
    isAllDay: Boolean(draft.date) && draft.timeMode === "none",
  };
  const schedule = taskScheduleForSubmission(
    task,
    requested,
    taskScheduleEditorMode(task, scheduleMode),
  );
  return {
    ...task,
    title: draft.title.trim(),
    projectId: draft.listId ?? task.projectId,
    ...schedule,
    status: draft.status === "completed" ? 2 : 0,
    priority: draft.priority,
    tags: [...draft.tags],
    reminders: [...draft.reminders],
    repeatFlag: draft.repeatFlag,
  };
}

class ChallengeDetailModal extends Modal {
  constructor(
    app: HelixView["app"],
    private readonly challenge: ChallengeDefinition,
    private readonly events: HelixEvent[],
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.challenge.title);
    const current = challengeProgress(this.challenge, this.events);
    const remaining = Math.max(0, this.challenge.target - current);
    const claimed = challengeClaimed(this.challenge, this.events);
    const summary = this.contentEl.createDiv({ cls: "helix-challenge-detail-summary" });
    summary.createDiv({ text: this.challenge.description });
    const metrics = summary.createDiv({ cls: "helix-challenge-detail-metrics" });
    for (const [label, value] of [
      ["当前进度", `${current} / ${this.challenge.target}`],
      ["还差", String(remaining)],
      ["奖励", `${this.challenge.rewardXp} XP`],
      ["状态", claimed ? "已领取" : current >= this.challenge.target ? "待领取" : "进行中"],
    ]) {
      const item = metrics.createDiv();
      item.createSpan({ text: label });
      item.createEl("strong", { text: value });
    }
    const rules = this.contentEl.createDiv({ cls: "helix-challenge-detail-section" });
    rules.createEl("h3", { text: "规则" });
    rules.createEl("dl").append(
      detailPair("指标", challengeMetricLabel(this.challenge.metric)),
      detailPair("开始", formatDateTime(this.challenge.startsAt)),
      detailPair("结束", formatDateTime(this.challenge.endsAt)),
      detailPair("撤销", "任务重开、习惯撤销或专注删除会同步扣回进度"),
    );
    const contributions = challengeContributions(this.challenge, this.events);
    const contributionSection = this.contentEl.createDiv({
      cls: "helix-challenge-detail-section",
    });
    contributionSection.createEl("h3", { text: "贡献明细" });
    if (contributions.length === 0) {
      contributionSection.createDiv({
        cls: "helix-empty",
        text: "当前周期还没有计入这项挑战的记录。",
      });
    } else {
      const list = contributionSection.createDiv({
        cls: "helix-challenge-contribution-list",
      });
      for (const contribution of contributions.slice(0, 30)) {
        const row = list.createDiv({ cls: "helix-challenge-contribution" });
        const copy = row.createDiv();
        copy.createEl("strong", { text: contribution.label });
        copy.createSpan({ text: `${formatDateTime(contribution.occurredAt)} · ${contribution.entityId}` });
        row.createSpan({
          text: `+${contribution.value}`,
        });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function detailPair(label: string, value: string): HTMLElement {
  const item = document.createElement("div");
  item.createEl("dt", { text: label });
  item.createEl("dd", { text: value });
  return item;
}

function challengeMetricLabel(metric: ChallengeDefinition["metric"]): string {
  return {
    "focus-sessions": "不少于 25 分钟的专注次数",
    "focus-minutes": "有效专注分钟",
    tasks: "完成任务数",
    reviews: "关闭复盘数",
    "active-days": "活跃天数",
  }[metric];
}

function taskPriorityLabel(priority: 0 | 1 | 3 | 5): string {
  return { 0: "无", 1: "低", 3: "中", 5: "高" }[priority];
}

function localTaskStateLabel(state: ProjectionActionState): string {
  return {
    idea: "想法",
    active: "进行中",
    completed: "已完成",
    paused: "已暂停",
    terminated: "已终止",
  }[state];
}

function taskSummary(task: DidaTask, local = false): string | undefined {
  const source = (local ? task.content ?? "" : task.desc || task.content || "")
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/^[#>*+\-\d.\s]+/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return source || undefined;
}

function mergeProjectTaskCollections(remoteTasks: DidaTask[], localTasks: DidaTask[]): DidaTask[] {
  const tasks = new Map(remoteTasks.map((task) => [task.id, task]));
  for (const local of localTasks) {
    const remote = tasks.get(local.id);
    tasks.set(local.id, remote ? {
      ...remote,
      ...local,
      projectId: remote.projectId,
      ...(remote.parentId !== undefined ? { parentId: remote.parentId } : {}),
      ...(remote.columnId !== undefined ? { columnId: remote.columnId } : {}),
      ...(remote.columnName !== undefined ? { columnName: remote.columnName } : {}),
      ...(remote.sortOrder !== undefined ? { sortOrder: remote.sortOrder } : {}),
      ...(remote.childIds !== undefined ? { childIds: remote.childIds } : {}),
    } : local);
  }
  return [...tasks.values()];
}

function localTaskDestinationValue(projectId: string, stageId: string): string {
  return `helix:${encodeURIComponent(projectId)}:${encodeURIComponent(stageId)}`;
}

function parseLocalTaskDestination(value: string): { projectId: string; stageId: string } | null {
  const match = /^helix:([^:]+):([^:]+)$/.exec(value);
  if (!match) return null;
  try {
    return {
      projectId: decodeURIComponent(match[1]!),
      stageId: decodeURIComponent(match[2]!),
    };
  } catch {
    return null;
  }
}

function bindTaskQuickSuggestions(
  input: HTMLInputElement,
  parent: HTMLElement,
  projects: DidaProject[],
  tags: string[],
  onApplied: () => void,
): void {
  const menuId = `helix-task-quick-menu-${crypto.randomUUID()}`;
  const menu = parent.createDiv({
    cls: "helix-task-quick-suggestions",
    attr: { id: menuId, role: "listbox", "aria-label": "快捷属性候选" },
  });
  let suggestions: TaskQuickSuggestion[] = [];
  let activeIndex = -1;
  let composing = false;
  const positionMenu = (): void => {
    const inputRect = input.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    menu.style.top = `${inputRect.bottom - parentRect.top + parent.scrollTop + 6}px`;
    menu.style.left = `${inputRect.left - parentRect.left + parent.scrollLeft}px`;
    menu.style.width = `${Math.max(220, inputRect.width)}px`;
  };
  const hide = (): void => {
    suggestions = [];
    activeIndex = -1;
    menu.empty();
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const apply = (suggestion: TaskQuickSuggestion): void => {
    const current = taskQuickSuggestions(
      input.value,
      input.selectionStart ?? input.value.length,
      projects,
      tags,
    );
    if (!current.some((candidate) =>
      candidate.kind === suggestion.kind && candidate.token === suggestion.token
    )) {
      hide();
      return;
    }
    const applied = applyTaskQuickSuggestion(
      input.value,
      input.selectionStart ?? input.value.length,
      suggestion,
    );
    input.value = applied.value;
    input.setSelectionRange(applied.cursor, applied.cursor);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    onApplied();
    hide();
    input.focus();
  };
  const paint = (): void => {
    menu.empty();
    if (suggestions.length === 0) {
      hide();
      return;
    }
    positionMenu();
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    suggestions.forEach((suggestion, index) => {
      const option = menu.createEl("button", {
        cls: `helix-task-quick-suggestion${index === activeIndex ? " is-active" : ""}`,
        attr: {
          id: `helix-task-quick-${crypto.randomUUID()}`,
          role: "option",
          "aria-selected": String(index === activeIndex),
          type: "button",
        },
      });
      option.createSpan({ cls: "helix-task-quick-token", text: suggestion.token });
      option.createSpan({ cls: "helix-task-quick-detail", text: suggestion.detail ?? suggestion.label });
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => apply(suggestion));
      if (index === activeIndex) input.setAttribute("aria-activedescendant", option.id);
    });
  };
  const refresh = (): void => {
    if (composing) {
      hide();
      return;
    }
    suggestions = taskQuickSuggestions(
      input.value,
      input.selectionStart ?? input.value.length,
      projects,
      tags,
    ).slice(0, 8);
    activeIndex = suggestions.length > 0 ? 0 : -1;
    paint();
  };
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", menuId);
  input.setAttribute("aria-expanded", "false");
  input.addEventListener("input", refresh);
  input.addEventListener("click", refresh);
  input.addEventListener("select", refresh);
  input.addEventListener("compositionstart", () => {
    composing = true;
    hide();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    refresh();
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || composing) {
      if (event.key === "Enter") event.stopImmediatePropagation();
      return;
    }
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + delta + suggestions.length) % suggestions.length;
      paint();
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && activeIndex >= 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      apply(suggestions[activeIndex]!);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      hide();
    }
  });
  input.addEventListener("keyup", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) refresh();
  });
  parent.addEventListener("scroll", positionMenu, { passive: true });
  input.addEventListener("blur", () => globalThis.setTimeout(hide, 0));
  hide();
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatBoardCapturedAt(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "同步时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
