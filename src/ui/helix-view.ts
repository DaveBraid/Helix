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
import type { HelixRuntimeState } from "../services/helix-service";
import { HelixService } from "../services/helix-service";
import type {
  ProjectConnectionPlan,
  ProjectWorkspaceService,
  ProjectWorkspaceSnapshot,
} from "../services/project-workspace";
import { HelixDataStore } from "../storage/data-store";
import type { ResolutionChoice, SyncConflict } from "../sync/types";
import { analyticsChartSeries } from "./chart-series";
import { inProgressPresentation } from "./in-progress-presentation";
import {
  ProjectLineageWorkbench,
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

const SAMPLE_PROJECTS: DidaProject[] = [
  { id: "sample-a", name: "强化学习论文实验", color: "#3659d9" },
  { id: "sample-b", name: "Helix 产品设计", color: "#26a17b" },
  { id: "sample-c", name: "研究方法课程", color: "#e29b3c" },
];

const SAMPLE_TASKS: DidaTask[] = [
  { id: "sample-1", projectId: "sample-a", title: "复现实验基线并核对指标", status: 0, priority: 5, dueDate: new Date().toISOString() },
  { id: "sample-2", projectId: "sample-b", title: "整理冲突合并真值表", status: 0, priority: 3 },
  { id: "sample-3", projectId: "sample-c", title: "完成本周阅读笔记", status: 0, priority: 1 },
  { id: "sample-4", projectId: "sample-a", title: "补充消融实验计划", status: 0, priority: 3 },
];

export class HelixView extends ItemView {
  private section: Section = "today";
  private expandedInProgress = false;
  private taskFilter: "all" | "today" | "in-progress" | "completed" = "all";
  private selectedProjectId: string | null | undefined;
  private projectLineageMode: ProjectLineageViewMode = "graph";
  private projectWorkbench: ProjectLineageWorkbench | null = null;
  private renderToken = 0;
  private heatmapMetric: HeatmapMetric = "tasks";
  private heatmapMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  private previewTasks = SAMPLE_TASKS.map((task) => ({ ...task }));
  private previewInProgress = new Set(SAMPLE_TASKS.map((task) => task.id));
  private state: HelixRuntimeState | null = null;
  private unsubscribe: (() => void) | null = null;
  private charts: echarts.ECharts[] = [];
  private chartObservers: ResizeObserver[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly service: HelixService,
    private readonly store: HelixDataStore,
    private readonly actions: {
      openReview: (period: "daily" | "weekly" | "monthly" | "yearly") => Promise<void>;
      createProject: () => void;
      createCycle: (projectId: string, sourceCycleIds: string[]) => void;
      deleteCycle: (cycleId: string) => void;
      manageRelation: (relationId: string) => void;
      openProjectFile: (path: string) => Promise<void>;
      projectWorkspace: ProjectWorkspaceService;
      reviewLegacyMigration: () => void;
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
    this.contentEl.addClass("helix-root");
    this.unsubscribe = this.service.subscribe((state) => {
      this.state = state;
      void this.render();
    });
  }

  async onClose(): Promise<void> {
    this.renderToken += 1;
    this.unsubscribe?.();
    this.projectWorkbench?.destroy();
    this.projectWorkbench = null;
    this.disposeCharts();
  }

  private async render(): Promise<void> {
    if (!this.state) return;
    const token = ++this.renderToken;
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
    else if (this.section === "tasks") this.renderTasks(content);
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
      ? SAMPLE_PROJECTS
      : (this.state?.projects ?? []);
    const projectSection = sidebar.createDiv({ cls: "helix-sidebar-projects" });
    const projectHeading = projectSection.createDiv({ cls: "helix-sidebar-projects-head" });
    projectHeading.createSpan({ text: "我的项目" });
    projectHeading.createSpan({ text: String(sidebarProjects.length) });
    for (const project of sidebarProjects.slice(0, 5)) {
      const button = projectSection.createEl("button", {
        cls: "helix-sidebar-project",
        attr: { "aria-label": `打开项目 ${project.name}` },
      });
      const dot = button.createSpan({ cls: "helix-project-dot" });
      dot.style.backgroundColor = project.color ?? "#5268d4";
      button.createSpan({ text: project.name });
      button.addEventListener("click", () => {
        this.section = "projects";
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
    });
    status.createSpan();
    status.createSpan({
      text: this.state?.connected
        ? "滴答已连接"
        : this.state?.demoMode
          ? "演示数据"
          : "离线缓存",
    });
    const sync = actions.createEl("button", {
      cls: "helix-icon-button",
      attr: { "aria-label": "立即同步", title: "立即同步" },
    });
    setIcon(sync, "refresh-cw");
    if (this.state?.loading) sync.addClass("is-spinning");
    sync.addEventListener("click", () => {
      void this.service.sync().catch((error) => this.service.notifySyncError(error));
    });
  }

  private async renderToday(content: HTMLElement, token: number): Promise<void> {
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
    body.createDiv({ cls: "helix-task-title", text: task.title });
    const meta = body.createDiv({ cls: "helix-task-meta" });
    const dot = meta.createSpan({ cls: "helix-project-dot" });
    dot.style.backgroundColor = project?.color ?? "#8891a7";
    meta.createSpan({ text: project?.name ?? "未归档项目" });
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
        new TaskEditModal(
          this.app,
          task,
          this.state?.projects ?? [],
          async (updated) => {
            await this.service.queueTaskUpdate(updated);
            this.render();
          },
        ).open();
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
          async (updated) => {
            this.previewTasks = this.previewTasks.map((candidate) =>
              candidate.id === updated.id ? updated : candidate,
            );
            await this.render();
          },
          true,
        ).open();
      });
    }
    if (task.status === 2) check.disabled = true;
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

  private renderTasks(content: HTMLElement): void {
    const { tasks, projects } = this.displayState();
    this.renderPageTitle(content, "任务总览");
    const canCompose = projects.length > 0 &&
      (this.state?.connected || this.state?.demoMode);
    if (canCompose) {
      const composer = content.createDiv({ cls: "helix-card helix-task-composer" });
      const input = composer.createEl("input", {
        type: "text",
        placeholder: this.state?.demoMode ? "新建预览任务…" : "新建滴答任务…",
        attr: { "aria-label": "任务标题" },
      });
      const select = composer.createEl("select", { attr: { "aria-label": "滴答清单" } });
      for (const project of projects) {
        select.createEl("option", { text: project.name, value: project.id });
      }
      const submit = composer.createEl("button", {
        cls: "helix-primary-button",
        text: this.state?.demoMode ? "添加" : "加入同步队列",
      });
      const create = (): void => {
        const title = input.value.trim();
        if (!title) {
          new Notice("任务标题不能为空");
          return;
        }
        if (this.state?.demoMode) {
          this.previewTasks = [
            ...this.previewTasks,
            {
              id: `sample-${crypto.randomUUID()}`,
              projectId: select.value,
              title,
              status: 0,
              priority: 0,
            },
          ];
          input.value = "";
          void this.render();
          return;
        }
        submit.disabled = true;
        void this.service.createTask(title, select.value)
          .then(() => {
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
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") create();
      });
    }
    const filters = content.createDiv({ cls: "helix-filter-row" });
    const filterItems = [
      ["all", "全部"],
      ["today", "今天"],
      ["in-progress", "进行中"],
      ["completed", "已完成"],
    ] as const;
    for (const [id, label] of filterItems) {
      const button = filters.createEl("button", {
        text: label,
        cls: this.taskFilter === id ? "is-active" : "",
      });
      button.addEventListener("click", () => {
        this.taskFilter = id;
        void this.render();
      });
    }
    const card = content.createDiv({ cls: "helix-card helix-table-card" });
    for (const task of this.filterTasks(tasks)) {
      this.renderTaskRow(card, task, projects.find((project) => project.id === task.projectId), false);
    }
  }

  private async renderProjects(content: HTMLElement, token: number): Promise<void> {
    let workspace: ProjectWorkspaceSnapshot;
    try {
      workspace = await this.actions.projectWorkspace.snapshot();
      if (!workspace.migrationRequired) {
        workspace = await this.actions.projectWorkspace.ensureCanvas();
      }
    } catch (error) {
      if (token !== this.renderToken) return;
      this.renderPageTitle(content, "项目");
      content.createDiv({
        cls: "helix-card helix-error-card",
        text: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (token !== this.renderToken) return;
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
    this.projectWorkbench = new ProjectLineageWorkbench({
      snapshot: workspace,
      selectedProjectId: this.selectedProjectId,
      mode: this.projectLineageMode,
      onModeChange: (mode) => {
        this.projectLineageMode = mode;
        void this.render();
      },
      onSelectProject: (projectId) => {
        this.selectedProjectId = projectId;
        void this.render();
      },
      onCreateProject: () => this.actions.createProject(),
      onCreateCycle: (projectId, sourceCycleIds) =>
        this.actions.createCycle(projectId, sourceCycleIds),
      onDeleteCycle: (cycleId) => this.actions.deleteCycle(cycleId),
      onOpenNote: (path) => {
        void this.actions.openProjectFile(path);
      },
      onMoveNodes: async (moves) => {
        await this.actions.projectWorkspace.moveCanvasNodes(moves);
      },
      onManageRelation: (relationId) => this.actions.manageRelation(relationId),
      onConnectCycles: (sourceCycleId, targetCycleId) =>
        void this.openConnection(sourceCycleId, targetCycleId),
      onChooseConnectionTarget: (sourceCycleId, allowedTargetIds) => {
        new ConnectionTargetModal(
          this.app,
          workspace,
          sourceCycleId,
          allowedTargetIds,
          (targetCycleId) => void this.openConnection(sourceCycleId, targetCycleId),
        ).open();
      },
      onEditProjectColor: (projectId, color) => {
        void this.actions.projectWorkspace.updateProjectColor(projectId, color)
          .then(() => this.render())
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      onToggleCompletedCollapse: (projectId, collapsed) => {
        void this.actions.projectWorkspace.setCompletedProjectCollapsed(projectId, collapsed)
          .then(() => this.render())
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      onExpandCompletedProjects: (projectIds) => {
        void this.actions.projectWorkspace.setCompletedProjectsCollapsed(projectIds, false)
          .then(() => this.render())
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      onAutoLayout: () => {
        void this.actions.projectWorkspace.autoLayoutCanvas()
          .then(() => this.render())
          .catch((error) =>
            new Notice(error instanceof Error ? error.message : String(error), 8_000));
      },
      onError: (error) =>
        new Notice(error instanceof Error ? error.message : String(error), 8_000),
    });
    this.projectWorkbench.render(content);
  }

  private async openConnection(sourceCycleId: string, targetCycleId: string): Promise<void> {
    try {
      const plan = await this.actions.projectWorkspace.planConnection(
        sourceCycleId,
        targetCycleId,
      );
      new ConnectionConfirmModal(
        this.app,
        plan,
        async (confirmCrossProject) => {
          await this.actions.projectWorkspace.connectCycles(plan, {
            confirmCrossProject,
          });
          new Notice("阶段连接已建立，受影响分支已自动整理");
          await this.render();
        },
      ).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8_000);
    }
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
    const projects = this.state?.demoMode ? SAMPLE_PROJECTS : this.state?.projects ?? [];
    const tasks = this.state?.demoMode ? this.previewTasks : this.state?.tasks ?? [];
    return { projects, tasks };
  }

  private filterTasks(tasks: DidaTask[]): DidaTask[] {
    if (this.taskFilter === "completed") return tasks.filter((task) => task.status === 2);
    if (this.taskFilter === "in-progress") {
      const ids = new Set(this.state?.inProgress.map((entry) => entry.taskId) ?? []);
      return tasks.filter((task) => ids.has(task.id) && task.status !== 2);
    }
    if (this.taskFilter === "today") {
      const today = localDateKey(new Date());
      return tasks.filter(
        (task) =>
          task.status !== 2 &&
          (taskDateKey(task.startDate) === today || taskDateKey(task.dueDate) === today),
      );
    }
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

function formatFullDate(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

function formatShortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function formatHour(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
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

class TaskEditModal extends Modal {
  private title: string;
  private projectId: string;
  private content: string;
  private startDate: string;
  private dueDate: string;
  private isAllDay: boolean;
  private timeZone: string;
  private priority: number;

  constructor(
    app: HelixView["app"],
    private readonly task: DidaTask,
    private readonly projects: DidaProject[],
    private readonly submit: (task: DidaTask) => Promise<void>,
    private readonly preview = false,
  ) {
    super(app);
    this.title = task.title;
    this.projectId = task.projectId;
    this.content = task.content ?? task.desc ?? "";
    this.timeZone = safeTaskTimeZone(task.timeZone);
    this.startDate = instantToWallDateTime(task.startDate, this.timeZone);
    this.dueDate = instantToWallDateTime(task.dueDate, this.timeZone);
    this.isAllDay = task.isAllDay ?? false;
    this.priority = task.priority ?? 0;
  }

  onOpen(): void {
    this.setTitle(this.preview ? "编辑预览任务" : "编辑滴答任务");
    new Setting(this.contentEl)
      .setName("任务标题")
      .addText((text) =>
        text.setValue(this.title).onChange((value) => {
          this.title = value;
        }),
      );
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
        for (const project of this.projects) dropdown.addOption(project.id, project.name);
        if (!this.projects.some((project) => project.id === this.projectId)) {
          dropdown.addOption(this.projectId, "当前项目");
        }
        dropdown.setValue(this.projectId).onChange((value) => {
          this.projectId = value;
        });
      });
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
    new Setting(this.contentEl)
      .setName("全天")
      .addToggle((toggle) =>
        toggle.setValue(this.isAllDay).onChange((value) => {
          this.isAllDay = value;
        }),
      );
    new Setting(this.contentEl)
      .setName("时区")
      .addText((text) =>
        text.setValue(this.timeZone).onChange((value) => {
          this.timeZone = value;
        }),
      );
    new Setting(this.contentEl)
      .setName("优先级")
      .addDropdown((dropdown) => {
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
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const save = actions.createEl("button", {
      cls: "mod-cta",
      text: this.preview ? "保存预览" : "保存并同步",
    });
    save.addEventListener("click", () => {
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
      save.disabled = true;
      void this.submit({
        ...this.task,
        title,
        projectId: this.projectId,
        content: this.content,
        startDate,
        dueDate,
        isAllDay: this.isAllDay,
        timeZone,
        priority: this.priority,
      })
        .then(() => this.close())
        .catch((error) => {
          save.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
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

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
