import {
  ItemView,
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
import type { HelixEvent } from "../domain/events";
import { aggregateAnalytics } from "../domain/analytics";
import { localDateKey, localDateKeyFromInstant } from "../domain/local-date";
import {
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
import {
  taskScheduleEditorMode,
  taskScheduleForSubmission,
  type TaskScheduleMode,
} from "../domain/task-schedule";
import { presentDidaReminders, presentDidaRepeat } from "../domain/task-reminders";
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
  type TaskCollectionFilters,
  type TaskDateRange,
  type TaskMatrixRules,
  type TaskViewMode,
} from "../domain/task-views";
import type {
  DidaProjectViewModeSyncStatus,
  HelixRuntimeState,
} from "../services/helix-service";
import { HelixService } from "../services/helix-service";
import type {
  ProjectConnectionPlan,
  ProjectWorkspaceCycleStatus,
  ProjectWorkspaceNativeRelationAdoptionPlan,
  ProjectWorkspaceNativeRelationCandidate,
  ProjectWorkspaceProject,
  ProjectWorkspaceProjectStatus,
  ProjectWorkspaceService,
  ProjectWorkspaceSnapshot,
} from "../services/project-workspace";
import {
  TaskReferenceConflictError,
  taskReferenceRuntimeIssues,
  type TaskReferenceExpectedRevision,
  type TaskReferenceResolved,
  type TaskReferenceSelection,
  type TaskReferenceSnapshot,
  type TaskReferenceService,
} from "../services/task-references";
import { HelixDataStore } from "../storage/data-store";
import type { ResolutionChoice, SyncConflict } from "../sync/types";
import { analyticsChartSeries } from "./chart-series";
import { inProgressPresentation } from "./in-progress-presentation";
import {
  LINEAGE_ALL_PROJECTS_FOCUS_ID,
  ProjectLineageWorkbench,
  type LineageCamera,
  type ProjectLineageViewMode,
} from "./project-lineage-workbench";

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export const HELIX_VIEW_TYPE = "helix-productivity-workbench";
type Section = "today" | "tasks" | "projects" | "reviews" | "analytics" | "challenges" | "conflicts";

const NAV: Array<{ id: Section; label: string; icon: IconName }> = [
  { id: "today", label: "今日", icon: "sun" },
  { id: "tasks", label: "任务", icon: "circle-check-big" },
  { id: "projects", label: "项目", icon: "folder-kanban" },
  { id: "reviews", label: "复盘", icon: "notebook-pen" },
  { id: "analytics", label: "分析", icon: "chart-no-axes-combined" },
  { id: "challenges", label: "挑战", icon: "trophy" },
  { id: "conflicts", label: "冲突", icon: "git-compare-arrows" },
];

const PROJECT_STATUS_OPTIONS: Array<{
  value: ProjectWorkspaceProjectStatus;
  label: string;
}> = [
  { value: "planned", label: "计划中" },
  { value: "active", label: "进行中" },
  { value: "paused", label: "已暂停" },
  { value: "completed", label: "已完成" },
  { value: "archived", label: "已归档" },
];

const CYCLE_STATUS_OPTIONS: Array<{
  value: ProjectWorkspaceCycleStatus;
  label: string;
}> = [
  { value: "planned", label: "计划中" },
  { value: "active", label: "进行中" },
  { value: "closed", label: "已完成" },
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
  private taskFilter: "all" | "open" | "in-progress" | "completed" = "open";
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
  private taskReferenceSnapshot: TaskReferenceSnapshot | null = null;
  private lineageCamera: LineageCamera | undefined;
  private lineageFocusRequest: { entityId: string; generation: number } | null = null;
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
  private charts: echarts.ECharts[] = [];
  private chartObservers: ResizeObserver[] = [];
  private taskBoardDrag: { taskId: string; sourceColumnId?: string | null } | null = null;

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
      deleteCycle: (cycleId: string, onDeleted?: (focusEntityId: string) => void) => void;
      manageRelation: (
        relationId: string,
        onChanged?: (focusEntityId: string) => void,
      ) => void;
      openProjectFile: (path: string) => Promise<void>;
      projectWorkspace: ProjectWorkspaceService;
      taskReferences: TaskReferenceService;
      mutateProjectWorkspace: <T>(operation: () => Promise<T>) => Promise<T>;
      reviewLegacyMigration: () => void;
      getTaskMatrixRules: () => TaskMatrixRules;
      updateTaskMatrixRules: (rules: TaskMatrixRules) => Promise<void>;
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
      this.state = state;
      void this.render();
    });
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.viewGeneration += 1;
    this.renderToken += 1;
    this.unsubscribe?.();
    if (this.taskSearchTimer !== null) {
      window.clearTimeout(this.taskSearchTimer);
      this.taskSearchTimer = null;
    }
    this.lineageFocusRequest = null;
    this.lineageCamera = undefined;
    this.projectWorkbench?.destroy();
    this.projectWorkbench = null;
    this.disposeCharts();
  }

  private async render(): Promise<void> {
    if (!this.state || this.closed) return;
    const token = ++this.renderToken;
    if (this.section === "projects") {
      this.lineageCamera = this.projectWorkbench?.camera() ?? this.lineageCamera;
    }
    this.projectWorkbench?.destroy();
    this.projectWorkbench = null;
    this.disposeCharts();
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "helix-shell" });
    this.renderSidebar(shell);
    const main = shell.createDiv({ cls: "helix-main" });
    this.renderHeader(main);
    const content = main.createDiv({ cls: "helix-content" });
    if (this.section === "today") await this.renderToday(content, token);
    else if (this.section === "tasks") await this.renderTasks(content, token);
    else if (this.section === "projects") await this.renderProjects(content, token);
    else if (this.section === "reviews") this.renderReviews(content);
    else if (this.section === "analytics") this.renderAnalytics(content);
    else if (this.section === "challenges") this.renderChallenges(content);
    else await this.renderConflicts(content, token);
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
        const count = this.state?.attentionCount ?? 0;
        if (count > 0) button.createSpan({ cls: "helix-nav-badge", text: String(count) });
      }
      button.addEventListener("click", () => {
        this.section = item.id;
        void this.render();
      });
    }
    const sidebarProjects = this.state?.demoMode
      ? this.previewProjects
      : (this.state?.projects ?? []);
    const sidebarTasks = this.state?.demoMode ? this.previewTasks : (this.state?.tasks ?? []);
    const projectSection = sidebar.createDiv({ cls: "helix-sidebar-lists" });
    const projectHeading = projectSection.createDiv({ cls: "helix-sidebar-lists-head" });
    projectHeading.createSpan({ text: "清单" });
    const listHeadActions = projectHeading.createDiv({ cls: "helix-sidebar-lists-actions" });
    listHeadActions.createSpan({ text: String(sidebarProjects.length) });
    if (this.state?.connected || this.state?.demoMode) {
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
      cls: `helix-sync-status ${this.state?.connected ? "is-online" : "is-offline"}`,
      attr: {
        title: this.state?.syncWarnings.join("；") || this.state?.error || "",
      },
    });
    status.createSpan();
    status.createSpan({
      text: this.state?.loading
        ? "正在同步"
        : this.state?.connected
        ? this.state.syncWarnings.length > 0
          ? "滴答已连接 · 部分数据待恢复"
          : "滴答已连接"
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
    await this.refreshTaskReferenceSnapshot(token);
    if (token !== this.renderToken) return;
    const state = this.displayState();
    const hero = content.createDiv({ cls: "helix-today-heading" });
    const copy = hero.createDiv();
    copy.createEl("p", { cls: "helix-eyebrow", text: formatFullDate(new Date()) });
    copy.createEl("h2", { text: "早上好，今天推进什么？" });
    const score = hero.createDiv({ cls: "helix-score" });
    const today = localDateKey(new Date());
    const activity = aggregateAnalytics(this.state?.events ?? [], {
      from: today,
      to: today,
    }).daily[0]?.activity ?? 0;
    score.createSpan({ cls: "helix-score-value", text: String(activity) });
    score.createSpan({ text: "今日活跃度" });

    const grid = content.createDiv({ cls: "helix-dashboard-grid" });
    const primary = grid.createDiv({ cls: "helix-dashboard-primary" });
    this.renderInProgress(primary, state.tasks, state.projects);
    this.renderTodayTasks(primary, state.tasks, state.projects);
    const rail = grid.createDiv({ cls: "helix-dashboard-rail" });
    this.renderTimeline(rail, state.tasks, state.projects);
    const lower = content.createDiv({ cls: "helix-dashboard-lower" });
    this.renderProjectPulse(lower, state.projects, state.tasks);
    this.renderWeeklyOverview(lower);
    this.renderWeeklyChallengeCard(lower);
    const conflicts = await this.store.list();
    if (token !== this.renderToken) return;
    if (conflicts.length > 0) {
      const warning = content.createDiv({ cls: "helix-card helix-conflict-warning" });
      const icon = warning.createSpan();
      setIcon(icon, "git-compare-arrows");
      const body = warning.createDiv();
      body.createEl("strong", { text: `${conflicts.length} 项等待手动合并` });
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
    const allRealItems = this.service.visibleInProgress(true);
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

  private renderTodayTasks(parent: HTMLElement, tasks: DidaTask[], projects: DidaProject[]): void {
    const card = parent.createDiv({ cls: "helix-card" });
    const header = card.createDiv({ cls: "helix-section-header" });
    const title = header.createDiv();
    title.createEl("h3", { text: "今日任务" });
    title.createEl("p", { text: `${tasks.filter((task) => task.status !== 2).length} 项待推进` });
    const list = card.createDiv({ cls: "helix-task-list" });
    for (const task of tasks.filter((candidate) => candidate.status !== 2).slice(0, 6)) {
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
  ): void {
    const row = parent.createDiv({ cls: `helix-task-row${prominent ? " is-prominent" : ""}` });
    const check = row.createEl("button", {
      cls: "helix-task-check",
      attr: { "aria-label": `完成 ${task.title}` },
    });
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
    const meta = body.createDiv({ cls: "helix-task-meta" });
    const reference = this.taskReferenceSnapshot?.byTaskId.get(task.id);
    const dot = meta.createSpan({ cls: "helix-project-dot" });
    dot.style.backgroundColor =
      reference?.project?.color ?? project?.color ?? "#8891a7";
    if (reference?.issues.length) {
      meta.createSpan({
        text: reference.project
          ? `Helix 关联需修复 · ${reference.project.title}`
          : "Helix 关联需修复",
      });
    } else if (reference?.project) {
      meta.createSpan({ text: reference.project.title });
      if (reference.stages.length > 0) {
        const stageLabels = reference.stages.slice(0, 2).map((stage) => stage.title);
        if (reference.stages.length > 2) {
          stageLabels.push(`+${reference.stages.length - 2}`);
        }
        meta.createSpan({
          text: stageLabels.join(" · "),
        });
      }
    } else {
      meta.createSpan({ text: `滴答 · ${project?.name ?? "未归档清单"}` });
    }
    if (task.dueDate) meta.createSpan({ text: formatShortTime(task.dueDate) });
    const edit = row.createEl("button", {
      cls: "helix-mini-action",
      attr: { "aria-label": "编辑任务", title: "编辑任务或移动项目" },
    });
    setIcon(edit, "pencil");
    const action = row.createEl("button", {
      cls: "helix-mini-action",
      attr: { "aria-label": "切换正在进行", title: "切换正在进行" },
    });
    setIcon(action, prominent ? "pin-off" : "play");
    if (!task.id.startsWith("sample-")) {
      check.addEventListener("click", () => {
        check.disabled = true;
        void this.service
          .completeTask(task.id)
          .then(() => this.render())
          .catch((error) => {
            new Notice(error instanceof Error ? error.message : String(error), 8_000);
            void this.render();
          });
      });
      action.addEventListener("click", () => {
        void this.service.toggleInProgress(task.id).catch((error) => {
          new Notice(error instanceof Error ? error.message : String(error));
        });
      });
      edit.addEventListener("click", () => {
        void this.openTaskEditor(task, this.state?.projects ?? []);
      });
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
      action.addEventListener("click", () => {
        if (this.previewInProgress.has(task.id)) this.previewInProgress.delete(task.id);
        else this.previewInProgress.add(task.id);
        void this.render();
      });
      edit.addEventListener("click", () => {
        new TaskEditModal(
          this.app,
          task,
          SAMPLE_PROJECTS,
          this.previewTasks.flatMap((candidate) => candidate.tags ?? []),
          [],
          undefined,
          [],
          undefined,
          "duration",
          async (updated) => {
            this.previewTasks = this.previewTasks.map((candidate) =>
              candidate.id === updated.id ? updated : candidate,
            );
            await this.render();
          },
          undefined,
          true,
        ).open();
      });
    }
    if (task.status === 2) check.disabled = true;
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
          if (task.id.startsWith("sample-")) {
            this.previewTasks = this.previewTasks.map((candidate) =>
              candidate.id === task.id ? { ...candidate, title } : candidate);
          } else {
            await this.service.queueTaskUpdate({ ...task, title });
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

  private async refreshTaskReferenceSnapshot(token: number): Promise<void> {
    if (this.state?.demoMode) {
      this.taskReferenceSnapshot = null;
      return;
    }
    try {
      const snapshot = await this.actions.taskReferences.snapshot();
      if (token === this.renderToken) this.taskReferenceSnapshot = snapshot;
    } catch (error) {
      if (token !== this.renderToken) return;
      this.taskReferenceSnapshot = {
        references: [],
        issues: [error instanceof Error ? error.message : String(error)],
        blockingIssues: [error instanceof Error ? error.message : String(error)],
        byTaskId: new Map(),
        byProjectId: new Map(),
        byStageId: new Map(),
      };
    }
  }

  private async openTaskEditor(
    task: DidaTask,
    didaProjects: DidaProject[],
  ): Promise<void> {
    const [workspaceResult, referencesResult] = await Promise.allSettled([
      this.actions.projectWorkspace.snapshot(),
      this.actions.taskReferences.snapshot(),
    ]);
    const workspaceProjects = workspaceResult.status === "fulfilled"
      ? workspaceResult.value.projects
      : [];
    const references = referencesResult.status === "fulfilled"
      ? referencesResult.value
      : undefined;
    const unavailableReasons = [
      workspaceResult.status === "rejected"
        ? `项目目录不可用：${messageOf(workspaceResult.reason)}`
        : undefined,
      referencesResult.status === "rejected"
        ? `关联目录不可用：${messageOf(referencesResult.reason)}`
        : undefined,
    ].filter((reason): reason is string => Boolean(reason));
    if (references) {
      this.taskReferenceSnapshot = references;
    }
    new TaskEditModal(
      this.app,
      task,
      didaProjects,
      (this.state?.tasks ?? []).flatMap((candidate) => candidate.tags ?? []),
      workspaceProjects,
      references?.byTaskId.get(task.id),
      references?.blockingIssues ?? [],
      unavailableReasons.join("；") || undefined,
      this.state?.taskScheduleMode ?? "unknown",
      async (updated) => {
        await this.service.queueTaskUpdate(updated);
        void this.render();
      },
      async (selection, expected) => {
        const verified = selection.projectId
          ? await this.service.verifyRemoteTask(task.projectId, task.id)
          : undefined;
        const result = await this.actions.taskReferences.saveTaskReference(
          task.id,
          selection,
          expected,
          selection.projectId && verified ? { didaProjectId: verified.projectId } : undefined,
        );
        await this.refreshTaskReferencesAfterCommit("Helix 关联");
        return result.reference;
      },
    ).open();
  }

  private async refreshTaskReferencesAfterCommit(label: string): Promise<void> {
    try {
      this.taskReferenceSnapshot = await this.actions.taskReferences.snapshot();
    } catch (error) {
      new Notice(
        `${label}已经提交，但界面刷新失败：${messageOf(error)}`,
        8_000,
      );
    } finally {
      void this.render();
    }
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
    await this.refreshTaskReferenceSnapshot(token);
    if (token !== this.renderToken) return;
    const { tasks, projects } = this.displayState();
    const writableProjects = projects.filter((project) => !project.id.startsWith("local-project-"));
    this.renderPageTitle(content, "任务总览");
    this.renderTaskReferenceDiagnostics(content, tasks);
    const canCompose = writableProjects.length > 0 &&
      (this.state?.connected || this.state?.demoMode);
    if (canCompose) {
      const composer = content.createDiv({ cls: "helix-card helix-task-composer" });
      const input = composer.createEl("input", {
        type: "text",
        placeholder: this.state?.demoMode ? "新建演示任务…" : "新建任务…",
        attr: { "aria-label": "任务标题" },
      });
      const select = composer.createEl("select", { attr: { "aria-label": "滴答清单" } });
      for (const project of writableProjects) {
        select.createEl("option", { text: project.name, value: project.id });
      }
      if (this.taskCollectionFilters.didaProjectId &&
        writableProjects.some((project) => project.id === this.taskCollectionFilters.didaProjectId)) {
        select.value = this.taskCollectionFilters.didaProjectId;
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
        const targetProjectId = parsed.projectId ?? select.value;
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
    const helixProjectByTaskId = new Map(
      (this.taskReferenceSnapshot?.references ?? []).map((reference) => [
        reference.taskId,
        reference.projectId,
      ]),
    );
    const visibleTasks = filterTaskCollection(this.filterTasks(tasks), this.taskCollectionFilters, {
      anchor: new Date(),
      helixProjectByTaskId,
    });
    const panel = content.createDiv({
      cls: "helix-task-view-panel",
      attr: {
        id: "helix-task-view-panel",
        role: "tabpanel",
        "aria-labelledby": `helix-task-view-tab-${this.taskViewMode}`,
      },
    });
    if (this.taskViewMode === "matrix") {
      this.renderTaskMatrix(panel, visibleTasks, projects);
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
      for (const task of visibleTasks) {
        this.renderTaskRow(card, task, projects.find((project) => project.id === task.projectId), false);
      }
    } else {
      this.renderTaskCalendar(panel, visibleTasks, projects, this.taskViewMode);
    }
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
      (this.taskReferenceSnapshot?.references ?? [])
        .filter((reference) => reference.project)
        .map((reference) => [reference.projectId, reference.project!]),
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
      ["open", "待完成"],
      ["in-progress", "进行中"],
      ["completed", "已完成"],
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
        this.renderAndRestoreFocus(`helix-task-status-filter-${id}`);
      });
    }
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
      } else {
        void this.openTaskEditor(task, this.state?.projects ?? []);
      }
    });
  }

  private renderTaskPreviewEditor(task: DidaTask): void {
    new TaskEditModal(
      this.app,
      task,
      this.previewProjects,
      this.previewTasks.flatMap((candidate) => candidate.tags ?? []),
      [],
      undefined,
      [],
      undefined,
      "duration",
      async (updated) => {
        this.previewTasks = this.previewTasks.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        );
        await this.render();
      },
      undefined,
      true,
    ).open();
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

  private renderTaskReferenceDiagnostics(
    content: HTMLElement,
    tasks: DidaTask[],
  ): void {
    const snapshot = this.taskReferenceSnapshot;
    if (!snapshot) return;
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const affected = snapshot.references.filter((reference) =>
      taskReferenceRuntimeIssues(reference, taskById.get(reference.taskId)).length > 0);
    if (snapshot.blockingIssues.length === 0 && affected.length === 0) return;
    const card = content.createDiv({
      cls: "helix-card helix-task-reference-diagnostics",
    });
    const header = card.createDiv({ cls: "helix-section-header" });
    header.createEl("h3", { text: "关联诊断" });
    header.createSpan({
      cls: "helix-chip is-soft",
      text: `${snapshot.blockingIssues.length + affected.length} 项`,
    });
    for (const issue of snapshot.blockingIssues) {
      card.createDiv({
        cls: "helix-task-reference-diagnostic is-blocking",
        text: issue,
      });
    }
    for (const reference of affected) {
      const currentTask = taskById.get(reference.taskId);
      const row = card.createDiv({ cls: "helix-task-reference-diagnostic" });
      const copy = row.createDiv();
      copy.createEl("strong", {
        text: reference.project?.title ?? reference.projectId,
      });
      const issues = taskReferenceRuntimeIssues(reference, currentTask);
      copy.createDiv({ text: issues.join("；") });
      const actions = row.createDiv({ cls: "helix-task-reference-diagnostic-actions" });
      if (currentTask) {
        const repair = actions.createEl("button", { text: "打开并修复" });
        repair.addEventListener("click", () => {
          void this.openTaskEditor(currentTask, this.state?.projects ?? []);
        });
      } else {
        const mappedDidaProjectId = reference.project?.didaProjectId;
        const candidates = tasks.filter((task) =>
          !task.id.startsWith("local-") &&
          !snapshot.byTaskId.has(task.id) &&
          !!mappedDidaProjectId &&
          task.projectId === mappedDidaProjectId);
        const rebind = actions.createEl("button", { text: "重新绑定" });
        rebind.disabled = candidates.length === 0;
        rebind.addEventListener("click", () => {
          new TaskReferenceRebindModal(
            this.app,
            reference,
            candidates,
            async (nextTaskId) => {
              const target = candidates.find((task) => task.id === nextTaskId);
              if (!target) throw new Error("待绑定任务已不在候选列表");
              if (
                reference.project?.didaProjectId &&
                target.projectId !== reference.project.didaProjectId
              ) {
                throw new Error("新任务所属清单与 Helix 项目映射不一致，拒绝重绑");
              }
              const verified = await this.service.verifyRemoteTask(target.projectId, target.id);
              await this.actions.taskReferences.rebindTaskId(
                reference.taskId,
                nextTaskId,
                {
                  refId: reference.refId,
                  revisionHash: reference.revisionHash,
                },
                { didaProjectId: verified.projectId },
              );
              await this.refreshTaskReferencesAfterCommit("任务关联重绑");
              new Notice("任务关联已重新绑定");
            },
          ).open();
        });
      }
      const unlink = actions.createEl("button", { text: "解除关联" });
      unlink.addClass("mod-warning");
      unlink.addEventListener("click", () => {
        new TaskReferenceRemovalModal(
          this.app,
          reference,
          async () => {
            await this.actions.taskReferences.saveTaskReference(
              reference.taskId,
              { projectId: undefined, stageIds: [] },
              {
                refId: reference.refId,
                revisionHash: reference.revisionHash,
              },
            );
            await this.refreshTaskReferencesAfterCommit("解除关联");
            new Notice("Helix 关联已移入仓库废纸篓");
          },
        ).open();
      });
    }
  }

  private async renderProjects(content: HTMLElement, token: number): Promise<void> {
    let workspace: ProjectWorkspaceSnapshot;
    try {
      workspace = await this.actions.mutateProjectWorkspace(() =>
        this.actions.projectWorkspace.loadStableWorkspace());
    } catch (error) {
      if (token !== this.renderToken) return;
      this.renderProjectReadOnlyFallback(content, error);
      return;
    }
    if (token !== this.renderToken) return;
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
      return;
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
      return;
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
    this.renderProjectDidaMappingBar(content, workspace);
    const lifecycleGeneration = this.viewGeneration;
    this.renderNativeRelationCandidates(
      content,
      workspace,
      lifecycleGeneration,
    );
    const focusEntityId = this.currentLineageFocusId();
    this.projectWorkbench = new ProjectLineageWorkbench({
      snapshot: workspace,
      selectedProjectId: this.selectedProjectId,
      mode: this.projectLineageMode,
      initialCamera: this.lineageCamera,
      onFocusApplied: (entityId) =>
        this.acknowledgeLineageFocus(entityId, lifecycleGeneration),
      onModeChange: (mode) => {
        this.projectLineageMode = mode;
        void this.render();
      },
      onSelectProject: (projectId) => {
        this.selectedProjectId = projectId;
        this.requestLineageFocus(
          projectId ?? LINEAGE_ALL_PROJECTS_FOCUS_ID,
          lifecycleGeneration,
        );
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
      onOpenNote: (path) => {
        void this.actions.openProjectFile(path);
      },
      onMoveNodes: async (moves) => {
        if (!workspace.canvasRevisionHash) throw new Error("项目 Canvas 不存在");
        await this.actions.mutateProjectWorkspace(() =>
          this.actions.projectWorkspace.moveCanvasNodes(
            moves,
            workspace.canvasRevisionHash!,
          ));
      },
      onManageRelation: (relationId) => this.actions.manageRelation(
        relationId,
        (nextFocusEntityId) =>
          this.requestLineageFocus(nextFocusEntityId, lifecycleGeneration),
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
      onEditProjectStatus: (projectId) => {
        const project = workspace.projects.find((candidate) => candidate.id === projectId);
        if (!project) return;
        void this.actions.projectWorkspace.prepareProjectStatusUpdate(projectId)
          .then((plan) => {
            new WorkspaceStatusModal(
              this.app,
              "修改项目状态",
              project.title,
              plan.currentStatus,
              PROJECT_STATUS_OPTIONS,
              async (status) => {
                await this.actions.mutateProjectWorkspace(() =>
                  this.actions.projectWorkspace.updateProjectStatus(plan, status));
                await this.render();
              },
            ).open();
          })
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      onEditCycleStatus: (cycleId) => {
        const cycle = workspace.projects
          .flatMap((project) => project.cycles)
          .find((candidate) => candidate.id === cycleId);
        if (!cycle) return;
        void this.actions.projectWorkspace.prepareCycleStatusUpdate(cycleId)
          .then((plan) => {
            new WorkspaceStatusModal(
              this.app,
              "修改阶段状态",
              `阶段 ${cycle.sequence} · ${cycle.title}`,
              plan.currentStatus,
              CYCLE_STATUS_OPTIONS,
              async (status) => {
                await this.actions.mutateProjectWorkspace(() =>
                  this.actions.projectWorkspace.updateCycleStatus(plan, status));
                await this.render();
              },
            ).open();
          })
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
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
      onAutoLayout: () => {
        void this.actions.mutateProjectWorkspace(() =>
          this.actions.projectWorkspace.autoLayoutCanvas())
          .then(() => this.render())
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      history: this.actions.projectWorkspace.historyState(),
      onUndo: () => {
        void this.actions.mutateProjectWorkspace(() =>
          this.actions.projectWorkspace.undoLastWorkspaceChange())
          .then(() => this.render())
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      onRedo: () => {
        void this.actions.mutateProjectWorkspace(() =>
          this.actions.projectWorkspace.redoLastWorkspaceChange())
          .then(() => this.render())
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      onError: (error) =>
        new Notice(error instanceof Error ? error.message : String(error), 8_000),
    });
    this.projectWorkbench.render(content);
  }

  private renderProjectDidaMappingBar(
    content: HTMLElement,
    workspace: ProjectWorkspaceSnapshot,
  ): void {
    if (!this.selectedProjectId) return;
    const project = workspace.projects.find((candidate) =>
      candidate.id === this.selectedProjectId);
    if (!project) return;
    const remoteProjects = (this.state?.projects ?? []).filter((candidate) =>
      !candidate.id.startsWith("local-project-"));
    const mappedByOther = new Set(workspace.projects
      .filter((candidate) => candidate.id !== project.id && candidate.didaProjectId)
      .map((candidate) => candidate.didaProjectId!));
    const bar = content.createDiv({ cls: "helix-project-dida-mapping" });
    const copy = bar.createDiv();
    copy.createEl("strong", { text: "滴答清单" });
    copy.createSpan({
      text: project.didaProjectId
        ? remoteProjects.find((candidate) => candidate.id === project.didaProjectId)?.name ??
          `已断开 · ${project.didaProjectId}`
        : "未映射",
    });
    const controls = bar.createDiv({ cls: "helix-project-dida-mapping-controls" });
    const select = controls.createEl("select", { attr: { "aria-label": "项目滴答清单映射" } });
    select.createEl("option", { value: "", text: "不映射" });
    for (const remote of remoteProjects) {
      const option = select.createEl("option", { value: remote.id, text: remote.name });
      if (mappedByOther.has(remote.id)) option.disabled = true;
    }
    if (
      project.didaProjectId &&
      !remoteProjects.some((candidate) => candidate.id === project.didaProjectId)
    ) {
      select.createEl("option", {
        value: project.didaProjectId,
        text: `已断开 · ${project.didaProjectId}`,
      });
    }
    select.value = project.didaProjectId ?? "";
    const save = controls.createEl("button", { text: "保存映射" });
    save.disabled = true;
    select.addEventListener("change", () => {
      save.disabled = select.value === (project.didaProjectId ?? "");
    });
    save.addEventListener("click", () => {
      save.disabled = true;
      const nextId = select.value || undefined;
      void this.actions.mutateProjectWorkspace(() =>
        this.actions.projectWorkspace.prepareProjectDidaMappingUpdate(project.id))
        .then((plan) => {
          new ProjectDidaMappingConfirmModal(
            this.app,
            project,
            remoteProjects.find((candidate) => candidate.id === nextId),
            nextId,
            async () => {
              if (nextId) await this.service.verifyRemoteProject(nextId);
              await this.actions.mutateProjectWorkspace(() =>
                this.actions.projectWorkspace.updateProjectDidaMapping(plan, nextId));
              new Notice(nextId ? "项目滴答清单映射已保存" : "项目滴答清单映射已解除");
              await this.render();
            },
            () => {
              save.disabled = select.value === (project.didaProjectId ?? "");
            },
          ).open();
        })
        .catch((error) => {
          save.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
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
        text: "纳入 Helix",
      });
      adopt.addEventListener("click", () => {
        adopt.disabled = true;
        void this.actions.mutateProjectWorkspace(() =>
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
          text: `阶段 ${stage.sequence} · ${stage.title}`,
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
      const plan = await this.actions.mutateProjectWorkspace(() =>
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
  }

  private renderAnalytics(content: HTMLElement): void {
    this.renderPageTitle(content, "数据分析");
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
    this.renderPageTitle(content, "冲突中心");
    content.createDiv({
      cls: "helix-safety-note",
      text: "竞争字段必须逐项选择；应用前会再次读取远端。",
    });
    const [conflicts, persisted, queue] = await Promise.all([
      this.store.list(),
      this.store.snapshot(),
      this.service.listQueue(),
    ]);
    if (token !== this.renderToken) return;
    if (persisted.lineageConflict) {
      const card = content.createDiv({ cls: "helix-card helix-reconciliation-card" });
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
      const card = content.createDiv({ cls: "helix-card helix-reconciliation-card" });
      card.createEl("span", { cls: "helix-chip is-danger", text: "只读恢复模式" });
      card.createEl("h3", { text: "data.json 结构需要人工修复" });
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
      const card = content.createDiv({ cls: "helix-card helix-reconciliation-card" });
      card.createEl("span", { cls: "helix-chip is-danger", text: "远端结果未知" });
      card.createEl("h3", { text: String((operation.local.value as Partial<DidaTask>).title ?? operation.entityId) });
      card.createEl("p", {
        text: operation.lastError ?? "应用在请求期间中断。Helix 不会自动重放非幂等写入。",
      });
      if (operation.operation !== "create") {
        const actions = card.createDiv({ cls: "helix-reconciliation-actions" });
        const continueWrite = actions.createEl("button", {
          cls: "helix-primary-button",
          text: "核对远端并继续",
        });
        continueWrite.addEventListener("click", () => {
          void this.service
            .resolveUnknownWrite(operation.id, "continue")
            .then(() => this.render())
            .catch((error) => new Notice(error instanceof Error ? error.message : String(error), 8_000));
        });
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
      const retry = actions.createEl("button", {
        cls: "helix-secondary-button",
        text: "我已确认未创建，安全重试",
      });
      retry.addEventListener("click", () => {
        void this.service
          .resolveUnknownCreate(operation.id, "not-created")
          .then(() => this.render())
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
      });
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
      const card = content.createDiv({ cls: "helix-card helix-reconciliation-card" });
      card.createEl("span", { cls: "helix-chip is-danger", text: "写入失败" });
      card.createEl("h3", {
        text: String((operation.local.value as Partial<DidaTask>).title ?? operation.entityId),
      });
      card.createEl("p", {
        text: `${operation.lastError ?? "未知错误"} · 已尝试 ${operation.attempts} 次`,
      });
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
      const card = content.createDiv({ cls: "helix-card helix-reconciliation-card" });
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
    if (
      conflicts.length === 0 &&
      (this.state?.recoveryIssues.length ?? 0) === 0 &&
      reconciliation.length === 0 &&
      failed.length === 0 &&
      orphanedBlocked.length === 0 &&
      !persisted.lineageConflict
    ) {
      const empty = content.createDiv({ cls: "helix-empty-state" });
      const icon = empty.createDiv();
      setIcon(icon, "shield-check");
      empty.createEl("h3", { text: "没有待处理冲突" });
      empty.createEl("p", { text: "Helix 会在发生竞争修改时暂停单条记录，不阻塞其他对象同步。" });
      return;
    }
    for (const conflict of conflicts) this.renderConflict(content, conflict);
  }

  private renderConflict(content: HTMLElement, conflict: SyncConflict): void {
    const applying = conflict.status === "applying";
    const card = content.createDiv({ cls: "helix-card helix-conflict-card" });
    const head = card.createDiv({ cls: "helix-conflict-head" });
    const title = head.createDiv();
    title.createEl("span", { cls: "helix-chip is-danger", text: conflict.kind === "task" ? "任务冲突" : "项目冲突" });
    title.createEl("h3", { text: conflict.title });
    title.createEl("p", { text: `远端复检 ${conflict.remoteRecheckCount} 次 · ${conflict.fields.length} 个变化字段` });
    for (const field of conflict.fields) {
      const row = card.createDiv({ cls: "helix-conflict-field" });
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
        cls: `helix-conflict-custom${field.choice === "custom" ? " is-selected" : ""}`,
      });
      const input = custom.createEl("textarea", {
        placeholder: "输入自定义合并值；数组或对象可使用 JSON",
        attr: { "aria-label": `${field.label} 自定义值` },
      });
      input.value = field.choice === "custom" ? displayEditableValue(field.customValue) : "";
      input.disabled = applying;
      const useCustom = custom.createEl("button", {
        cls: "helix-secondary-button",
        text: "使用自定义值",
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
        text: "上次写回的远端结果未知。请先在滴答中核对：已经生效则复读采纳；确认未写入才可解锁重试。若本次是重建且产生了新记录，请填写新记录 ID。",
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
        unlock.disabled = true;
        void this.service.adoptAppliedConflict(conflict.id, remoteId.value)
          .then(() => this.render())
          .catch((error) => {
            adopt.disabled = false;
            unlock.disabled = false;
            new Notice(error instanceof Error ? error.message : String(error), 8_000);
          });
      });
      const unlock = recovery.createEl("button", {
        cls: "helix-secondary-button",
        text: "我已确认远端未写入，解锁重新合并",
      });
      unlock.addEventListener("click", () => {
        unlock.disabled = true;
        void this.service.releaseApplyingConflict(conflict.id)
          .then(() => this.render())
          .catch((error) => {
            unlock.disabled = false;
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
    const projects = this.state?.demoMode ? this.previewProjects : this.state?.projects ?? [];
    const tasks = this.state?.demoMode ? this.previewTasks : this.state?.tasks ?? [];
    return { projects, tasks };
  }

  private filterTasks(tasks: DidaTask[]): DidaTask[] {
    if (this.taskFilter === "completed") return tasks.filter((task) => task.status === 2);
    if (this.taskFilter === "in-progress") {
      const ids = new Set(this.state?.inProgress.map((entry) => entry.taskId) ?? []);
      return tasks.filter((task) => ids.has(task.id) && task.status !== 2);
    }
    if (this.taskFilter === "open") return tasks.filter((task) => task.status !== 2);
    return tasks;
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

class WorkspaceStatusModal<T extends string> extends Modal {
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
              `${project.title} / 阶段 ${cycle.sequence} · ${cycle.title}`,
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
      if (cycle) return `${project.title} / 阶段 ${cycle.sequence} · ${cycle.title}`;
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
    this.setTitle("纳管 Canvas 连线");
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
        : "已有托管边的关系类型不会变化。",
    });
    if (this.candidate.crossProject) {
      const confirmation = this.contentEl.createEl("label", {
        cls: "helix-branch-confirm",
      });
      const checkbox = confirmation.createEl("input", { type: "checkbox" });
      confirmation.createSpan({ text: "我确认纳管这条跨项目连线" });
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
      text: "确认纳管",
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

class TaskReferenceRebindModal extends Modal {
  private nextTaskId = "";
  private confirmed = false;

  constructor(
    app: HelixView["app"],
    private readonly reference: TaskReferenceResolved,
    private readonly candidates: DidaTask[],
    private readonly submit: (nextTaskId: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("重新绑定任务关联");
    this.contentEl.createEl("p", {
      text: `当前任务 ID：${this.reference.taskId}`,
    });
    new Setting(this.contentEl)
      .setName("新的滴答任务")
      .setDesc("列出当前缓存中未被占用的任务；提交前会按任务 ID 与清单从滴答重新读取验证。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "请选择");
        for (const task of this.candidates) {
          dropdown.addOption(task.id, `${task.title} · ${task.id}`);
        }
        dropdown.onChange((value) => {
          this.nextTaskId = value;
        });
      });
    new Setting(this.contentEl)
      .setName("确认任务身份")
      .setDesc("我已核对旧任务与新任务是同一项工作，不是仅标题相似。")
      .addToggle((toggle) =>
        toggle.onChange((value) => {
          this.confirmed = value;
        }));
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" })
      .addEventListener("click", () => this.close());
    const apply = actions.createEl("button", {
      cls: "mod-cta",
      text: "确认重新绑定",
    });
    apply.addEventListener("click", () => {
      if (!this.nextTaskId || !this.confirmed) {
        new Notice("请选择新任务并确认身份");
        return;
      }
      apply.disabled = true;
      void this.submit(this.nextTaskId)
        .then(() => this.close())
        .catch((error) => {
          apply.disabled = false;
          new Notice(messageOf(error), 8_000);
        });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class TaskReferenceRemovalModal extends Modal {
  constructor(
    app: HelixView["app"],
    private readonly reference: TaskReferenceResolved,
    private readonly submit: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("解除 Helix 关联");
    this.contentEl.createEl("p", {
      text:
        `将任务 ${this.reference.taskId} 的关联笔记移入仓库废纸篓；不会删除或修改滴答任务。`,
    });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" })
      .addEventListener("click", () => this.close());
    const remove = actions.createEl("button", {
      cls: "mod-warning",
      text: "解除关联",
    });
    remove.addEventListener("click", () => {
      remove.disabled = true;
      void this.submit()
        .then(() => this.close())
        .catch((error) => {
          remove.disabled = false;
          new Notice(messageOf(error), 8_000);
        });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
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

class TaskEditModal extends Modal {
  private title: string;
  private didaProjectId: string;
  private content: string;
  private startDate: string;
  private dueDate: string;
  private isAllDay: boolean;
  private timeZone: string;
  private priority: number;
  private tags: string[];
  private helixProjectId: string;
  private readonly helixStageIds: Set<string>;
  private stageChoicesEl: HTMLElement | null = null;
  private currentReference: TaskReferenceResolved | undefined;

  constructor(
    app: HelixView["app"],
    private readonly task: DidaTask,
    private readonly didaProjects: DidaProject[],
    private readonly tagChoices: string[],
    private readonly helixProjects: ProjectWorkspaceProject[],
    reference: TaskReferenceResolved | undefined,
    private readonly referenceBlockingIssues: string[],
    private readonly associationUnavailableReason: string | undefined,
    private readonly scheduleMode: TaskScheduleMode,
    private readonly submitTask: (task: DidaTask) => Promise<void>,
    private readonly submitReference?: (
      selection: TaskReferenceSelection,
      expected: TaskReferenceExpectedRevision,
    ) => Promise<TaskReferenceResolved | undefined>,
    private readonly preview = false,
  ) {
    super(app);
    this.title = task.title;
    this.didaProjectId = task.projectId;
    this.content = task.content ?? task.desc ?? "";
    this.timeZone = safeTaskTimeZone(task.timeZone);
    this.startDate = instantToWallDateTime(task.startDate, this.timeZone);
    this.dueDate = instantToWallDateTime(task.dueDate, this.timeZone);
    this.isAllDay = task.isAllDay ?? false;
    this.priority = task.priority ?? 0;
    this.tags = [...(task.tags ?? [])];
    this.currentReference = reference;
    this.helixProjectId = reference?.projectId ?? "";
    this.helixStageIds = new Set(reference?.stageIds ?? []);
  }

  onOpen(): void {
    this.setTitle(this.preview ? "编辑演示任务" : "编辑任务");
    this.contentEl.addClass("helix-task-edit-modal");
    this.contentEl.createEl("h3", { text: "滴答任务" });
    let titleInputEl: HTMLInputElement | undefined;
    let projectSelectEl: HTMLSelectElement | undefined;
    let prioritySelectEl: HTMLSelectElement | undefined;
    let tagsInputEl: HTMLInputElement | undefined;
    new Setting(this.contentEl)
      .setName("任务标题")
      .addText((text) => {
        titleInputEl = text.inputEl;
        text.setValue(this.title).onChange((value) => {
          this.title = value;
        });
      });
    let quickEntry = "";
    let quickEntryEl: HTMLInputElement | undefined;
    const writableDidaProjects = this.didaProjects.filter((project) =>
      !project.id.startsWith("local-project-"));
    new Setting(this.contentEl)
      .setName("快捷属性")
      .setDesc("输入 ~清单、#标签、!高／!中／!低／!无；只解析明确匹配的属性。")
      .addText((text) => {
        quickEntryEl = text.inputEl;
        text.setPlaceholder("例如：~科研 #实验 !高").onChange((value) => {
          quickEntry = value;
        });
      })
      .addButton((button) => button.setButtonText("应用").onClick(() => {
        const parsed = parseTaskQuickEntry(quickEntry, writableDidaProjects);
        if (parsed.issues.length > 0) {
          new Notice(parsed.issues.join("；"));
          return;
        }
        if (parsed.title) {
          new Notice("快捷属性栏只接受 ~、#、! 属性，请把普通文字写入任务标题");
          return;
        }
        if (parsed.projectId) this.didaProjectId = parsed.projectId;
        if (parsed.priority !== undefined) this.priority = parsed.priority;
        this.tags = [...new Set([...this.tags, ...parsed.tags])];
        if (projectSelectEl) projectSelectEl.value = this.didaProjectId;
        if (prioritySelectEl) prioritySelectEl.value = String(this.priority);
        if (tagsInputEl) tagsInputEl.value = this.tags.join(" ");
        if (titleInputEl) titleInputEl.value = this.title;
        if (quickEntryEl) quickEntryEl.value = "";
        quickEntry = "";
      }));
    if (quickEntryEl) {
      bindTaskQuickSuggestions(
        quickEntryEl,
        this.contentEl,
        writableDidaProjects,
        this.tagChoices,
        () => {
          quickEntry = quickEntryEl?.value ?? "";
        },
      );
    }
    new Setting(this.contentEl)
      .setName("内容")
      .addTextArea((text) =>
        text.setValue(this.content).onChange((value) => {
          this.content = value;
        }),
      );
    new Setting(this.contentEl)
      .setName("滴答清单")
      .addDropdown((dropdown) => {
        projectSelectEl = dropdown.selectEl;
        for (const project of writableDidaProjects) {
          dropdown.addOption(project.id, project.name);
        }
        if (!writableDidaProjects.some((project) => project.id === this.didaProjectId)) {
          const pending = this.didaProjectId.startsWith("local-project-");
          dropdown.addOption(
            this.didaProjectId,
            pending ? "当前待核对清单（不可移动）" : "当前清单",
          );
          if (pending) {
            dropdown.selectEl.querySelector<HTMLOptionElement>(
              `option[value="${CSS.escape(this.didaProjectId)}"]`,
            )?.setAttribute("disabled", "true");
          }
        }
        dropdown.setValue(this.didaProjectId).onChange((value) => {
          this.didaProjectId = value;
        });
      });
    const scheduleEditorMode = taskScheduleEditorMode(this.task, this.scheduleMode);
    const scheduleMetadataLocked = scheduleEditorMode === "locked-duration";
    if (scheduleEditorMode === "point") {
      new Setting(this.contentEl)
        .setName("任务时间")
        .addText((text) => {
          text.inputEl.type = "datetime-local";
          text.setValue(this.dueDate || this.startDate).onChange((value) => {
            this.startDate = value;
            this.dueDate = value;
          });
        });
    } else if (scheduleEditorMode === "locked-duration") {
      new Setting(this.contentEl)
        .setName("已有开始时间")
        .setDesc("该任务已有独立时间段；当前账号仅支持单点任务时间，因此保持原值且不可在此转换。")
        .addText((text) => {
          text.inputEl.type = "datetime-local";
          text.setValue(this.startDate).setDisabled(true);
        });
      new Setting(this.contentEl)
        .setName("已有截止时间")
        .setDesc("仍可修改标题、内容、清单等其他字段，不会折叠这段时间。")
        .addText((text) => {
          text.inputEl.type = "datetime-local";
          text.setValue(this.dueDate).setDisabled(true);
        });
    } else {
      new Setting(this.contentEl)
        .setName("开始时间")
        .addText((text) => {
          text.inputEl.type = "datetime-local";
          text.setValue(this.startDate).onChange((value) => {
            this.startDate = value;
          });
        });
      new Setting(this.contentEl)
        .setName("截止时间")
        .addText((text) => {
          text.inputEl.type = "datetime-local";
          text.setValue(this.dueDate).onChange((value) => {
            this.dueDate = value;
          });
        });
    }
    new Setting(this.contentEl)
      .setName("全天")
      .setDesc(scheduleMetadataLocked ? "已有时间段的全天状态保持原值。" : "")
      .addToggle((toggle) => {
        toggle.setValue(this.isAllDay).setDisabled(scheduleMetadataLocked).onChange((value) => {
          this.isAllDay = value;
        });
      });
    new Setting(this.contentEl)
      .setName("时区")
      .setDesc(scheduleMetadataLocked ? "已有时间段的时区保持原值。" : "")
      .addText((text) => {
        text.setValue(this.timeZone).setDisabled(scheduleMetadataLocked).onChange((value) => {
          this.timeZone = value;
        });
      });
    const reminderPresentations = presentDidaReminders(this.task.reminders);
    const reminderSetting = new Setting(this.contentEl)
      .setName("提醒")
      .setDesc("当前只读；完成专用合同验证后开放修改与清空。");
    reminderSetting.controlEl.createSpan({
      cls: "helix-task-readonly-property",
      text: reminderPresentations.length > 0
        ? reminderPresentations.map((item) => item.label).join("、")
        : "无",
    });
    const repeatPresentation = presentDidaRepeat(this.task.repeatFlag);
    const repeatSetting = new Setting(this.contentEl)
      .setName("重复")
      .setDesc("当前只读；不会把未知规则静默改写为预设。");
    repeatSetting.controlEl.createSpan({
      cls: "helix-task-readonly-property",
      text: repeatPresentation.label,
    });
    new Setting(this.contentEl)
      .setName("标签")
      .setDesc("多个标签使用空格或逗号分隔。")
      .addText((text) => {
        tagsInputEl = text.inputEl;
        text.setValue(this.tags.join(" ")).onChange((value) => {
          this.tags = [...new Set(value.split(/[\s,，]+/u).map((tag) => tag.trim()).filter(Boolean))];
        });
      });
    new Setting(this.contentEl)
      .setName("优先级")
      .addDropdown((dropdown) => {
        prioritySelectEl = dropdown.selectEl;
        dropdown
          .addOption("0", "无")
          .addOption("1", "低")
          .addOption("3", "中")
          .addOption("5", "高")
          .setValue(String(this.priority))
          .onChange((value) => {
            this.priority = Number(value);
          });
      });
    const taskActions = this.contentEl.createDiv({
      cls: "modal-button-container helix-task-modal-actions",
    });
    const saveTask = taskActions.createEl("button", {
      cls: "mod-cta",
      text: this.preview ? "保存演示任务" : "保存滴答任务",
    });
    saveTask.addEventListener("click", () => {
      const title = this.title.trim();
      if (!title) {
        new Notice("任务标题不能为空");
        return;
      }
      const timeZone = this.timeZone.trim();
      if (!timeZone) {
        new Notice("时区不能为空");
        return;
      }
      let startDate: string | null;
      let dueDate: string | null;
      try {
        assertTimeZone(timeZone);
        startDate = wallDateTimeToInstant(this.startDate, timeZone);
        dueDate = wallDateTimeToInstant(this.dueDate, timeZone);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
        return;
      }
      if (startDate && dueDate && Date.parse(startDate) > Date.parse(dueDate)) {
        new Notice("截止时间不能早于开始时间");
        return;
      }
      const schedule = taskScheduleForSubmission(
        this.task,
        { startDate, dueDate, timeZone, isAllDay: this.isAllDay },
        scheduleEditorMode,
      );
      saveTask.disabled = true;
      void this.submitTask({
        ...this.task,
        title,
        projectId: this.didaProjectId,
        content: this.content,
        ...schedule,
        priority: this.priority,
        tags: this.tags,
      })
        .then(() => {
          new Notice(this.preview ? "演示任务已保存" : "滴答任务已加入同步队列");
          this.close();
        })
        .catch((error) => {
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        })
        .finally(() => {
          saveTask.disabled = false;
        });
    });

    if (!this.preview) this.renderReferenceEditor();

    const closeActions = this.contentEl.createDiv({ cls: "modal-button-container" });
    closeActions.createEl("button", { text: "关闭" })
      .addEventListener("click", () => this.close());
  }

  private renderReferenceEditor(): void {
    this.contentEl.createEl("h3", { text: "Helix 关联" });
    if (this.task.id.startsWith("local-")) {
      this.contentEl.createDiv({
        cls: "helix-task-reference-warning",
        text: "任务取得滴答远端 ID 后才可建立关联。",
      });
      return;
    }
    if (this.associationUnavailableReason) {
      this.contentEl.createDiv({
        cls: "helix-task-reference-warning",
        text: this.associationUnavailableReason,
      });
      return;
    }
    if (this.referenceBlockingIssues.length > 0) {
      this.contentEl.createDiv({
        cls: "helix-task-reference-warning",
        text: `关联文件存在重复或结构错误：${this.referenceBlockingIssues.join("；")}`,
      });
      return;
    }
    if (this.currentReference?.issues.length) {
      this.contentEl.createDiv({
        cls: "helix-task-reference-warning",
        text: this.currentReference.issues.join("；"),
      });
    }
    new Setting(this.contentEl)
      .setName("Helix 项目")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "不关联");
        for (const project of this.helixProjects) {
          dropdown.addOption(project.id, project.title);
        }
        if (
          this.helixProjectId &&
          !this.helixProjects.some((project) => project.id === this.helixProjectId)
        ) {
          dropdown.addOption(this.helixProjectId, `已断开 · ${this.helixProjectId}`);
        }
        dropdown.setValue(this.helixProjectId).onChange((value) => {
          if (value !== this.helixProjectId && this.helixStageIds.size > 0) {
            new Notice("请先取消现有阶段，再切换 Helix 项目");
            dropdown.setValue(this.helixProjectId);
            return;
          }
          this.helixProjectId = value;
          this.renderStageChoices();
        });
      });
    this.stageChoicesEl = this.contentEl.createDiv({
      cls: "helix-task-stage-choices",
    });
    this.renderStageChoices();

    const actions = this.contentEl.createDiv({
      cls: "modal-button-container helix-task-modal-actions",
    });
    const saveReference = actions.createEl("button", {
      cls: "mod-cta",
      text: this.currentReference ? "更新 Helix 关联" : "保存 Helix 关联",
    });
    saveReference.addEventListener("click", () => {
      if (!this.submitReference) return;
      saveReference.disabled = true;
      const expected: TaskReferenceExpectedRevision = this.currentReference
        ? {
          refId: this.currentReference.refId,
          revisionHash: this.currentReference.revisionHash,
        }
        : null;
      void this.submitReference(
        {
          projectId: this.helixProjectId || undefined,
          stageIds: [...this.helixStageIds],
        },
        expected,
      )
        .then((reference) => {
          this.currentReference = reference;
          new Notice(reference ? "Helix 关联已保存" : "Helix 关联已解除");
        })
        .catch((error) => {
          const message = error instanceof TaskReferenceConflictError
            ? `${error.message}；本次未覆盖任何字段`
            : error instanceof Error
              ? error.message
              : String(error);
          new Notice(message, 8_000);
        })
        .finally(() => {
          saveReference.disabled = false;
        });
    });
  }

  private renderStageChoices(): void {
    if (!this.stageChoicesEl) return;
    this.stageChoicesEl.empty();
    if (!this.helixProjectId) return;
    const project = this.helixProjects.find((candidate) =>
      candidate.id === this.helixProjectId);
    const knownStageIds = new Set(project?.cycles.map((stage) => stage.id) ?? []);
    if (project) {
      for (const stage of project.cycles) {
        new Setting(this.stageChoicesEl)
          .setName(stage.title)
          .addToggle((toggle) =>
            toggle.setValue(this.helixStageIds.has(stage.id)).onChange((value) => {
              if (value) this.helixStageIds.add(stage.id);
              else this.helixStageIds.delete(stage.id);
            }));
      }
    }
    for (const stageId of [...this.helixStageIds]) {
      if (knownStageIds.has(stageId)) continue;
      new Setting(this.stageChoicesEl)
        .setName(`已断开 · ${stageId}`)
        .addToggle((toggle) =>
          toggle.setValue(true).onChange((value) => {
            if (!value) {
              this.helixStageIds.delete(stageId);
              this.renderStageChoices();
            }
          }));
    }
    if (!project && this.helixStageIds.size === 0) {
      this.stageChoicesEl.createDiv({
        cls: "helix-empty",
        text: "请选择可用项目。",
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
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
    const claimed = this.events.some(
      (event) =>
        event.type === "challenge-completed" &&
        event.entityId === this.challenge.id,
    );
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

class ProjectDidaMappingConfirmModal extends Modal {
  constructor(
    app: HelixView["app"],
    private readonly project: ProjectWorkspaceProject,
    private readonly didaProject: DidaProject | undefined,
    private readonly nextDidaProjectId: string | undefined,
    private readonly submit: () => Promise<void>,
    private readonly closed: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.nextDidaProjectId ? "确认项目映射" : "确认解除映射");
    const summary = this.contentEl.createDiv({ cls: "helix-project-mapping-confirm" });
    summary.createEl("strong", { text: this.project.title });
    summary.createSpan({ text: "→" });
    summary.createEl("strong", {
      text: this.nextDidaProjectId
        ? this.didaProject?.name ?? this.nextDidaProjectId
        : "不映射滴答清单",
    });
    this.contentEl.createEl("p", {
      text: this.nextDidaProjectId
        ? "后续项目行动只能稳定关联到该清单中的滴答任务；不会按标题自动猜测或移动现有任务。"
        : "已有任务引用会保留稳定 ID 并显示映射断开，不会被静默删除。",
    });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "确认保存" });
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      void this.submit()
        .then(() => this.close())
        .catch((error) => {
          confirm.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  onClose(): void {
    this.closed();
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
