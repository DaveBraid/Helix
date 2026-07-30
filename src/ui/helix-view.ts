import {
  ItemView,
  Modal,
  Notice,
  Setting,
  TFile,
  WorkspaceLeaf,
  setIcon,
  type IconName,
} from "obsidian";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { DidaProject, DidaTask } from "../domain/entities";
import { aggregateAnalytics } from "../domain/analytics";
import { localDateKey, localDateKeyFromInstant } from "../domain/local-date";
import {
  challengeProgress,
  deriveProgress,
  rotatingChallenges,
} from "../domain/gamification";
import type { HelixRuntimeState } from "../services/helix-service";
import { HelixService } from "../services/helix-service";
import { HelixDataStore } from "../storage/data-store";
import type { ResolutionChoice, SyncConflict } from "../sync/types";
import { analyticsChartSeries } from "./chart-series";
import { inProgressPresentation } from "./in-progress-presentation";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
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
  private projectView: "board" | "list" = "board";
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
      resolveLineage: (choice: "canvas" | "projects") => Promise<void>;
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
    this.unsubscribe?.();
    this.disposeCharts();
  }

  private async render(): Promise<void> {
    if (!this.state) return;
    this.disposeCharts();
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "helix-shell" });
    this.renderSidebar(shell);
    const main = shell.createDiv({ cls: "helix-main" });
    this.renderHeader(main);
    const content = main.createDiv({ cls: "helix-content" });
    if (this.section === "today") await this.renderToday(content);
    else if (this.section === "tasks") this.renderTasks(content);
    else if (this.section === "projects") this.renderProjects(content);
    else if (this.section === "reviews") this.renderReviews(content);
    else if (this.section === "analytics") this.renderAnalytics(content);
    else if (this.section === "challenges") this.renderChallenges(content);
    else await this.renderConflicts(content);
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

  private async renderToday(content: HTMLElement): Promise<void> {
    const state = this.displayState();
    const hero = content.createDiv({ cls: "helix-today-heading" });
    const copy = hero.createDiv();
    copy.createEl("p", { cls: "helix-eyebrow", text: formatFullDate(new Date()) });
    copy.createEl("h2", { text: "早上好，今天推进什么？" });
    copy.createEl("p", {
      cls: "helix-muted",
      text: this.state?.connected
        ? "把注意力留给正在发生的工作。"
        : "连接滴答后，这里会展示你的真实任务和项目。",
    });
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
    const header = card.createDiv({ cls: "helix-section-header" });
    const title = header.createDiv();
    title.createEl("h3", { text: "正在进行" });
    title.createEl("p", {
      text: this.state?.demoMode
        ? "演示条目；连接后只显示由 Helix 独立标记的任务"
        : "由 Helix 独立标记，不会污染滴答标签",
    });
    const allRealItems = this.service.visibleInProgress(true);
    const realPresentation = inProgressPresentation(
      allRealItems,
      this.expandedInProgress,
    );
    const realItems = realPresentation.visible;
    const items = realItems.length > 0
      ? realItems
      : this.state?.demoMode
        ? tasks.slice(0, this.expandedInProgress ? tasks.length : 3).map((task) => ({
          task,
          project: projects.find((project) => project.id === task.projectId),
        }))
        : [];
    if (items.length === 0) {
      card.createDiv({ cls: "helix-empty", text: "还没有标记正在进行的任务。" });
      return;
    }
    const list = card.createDiv({ cls: "helix-task-list" });
    for (const item of items) this.renderTaskRow(list, item.task, item.project, true);
    if ((this.state?.demoMode && tasks.length > 3) || realPresentation.canExpand) {
      const expand = card.createEl("button", {
        cls: "helix-link-button",
        text: this.expandedInProgress ? "收起" : "展开全部",
      });
      expand.addEventListener("click", () => {
        this.expandedInProgress = !this.expandedInProgress;
        void this.render();
      });
    }
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
      action.disabled = true;
      edit.disabled = true;
      check.disabled = true;
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
      this.section = "challenges";
      void this.render();
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
    this.renderPageIntro(content, "任务总览", "滴答清单是任务事实源；Helix 负责项目语境、进行中标记和冲突控制。");
    if (this.state?.connected && this.state.projects.length > 0) {
      const composer = content.createDiv({ cls: "helix-card helix-task-composer" });
      const input = composer.createEl("input", {
        type: "text",
        placeholder: "快速创建滴答任务…",
        attr: { "aria-label": "任务标题" },
      });
      const select = composer.createEl("select", { attr: { "aria-label": "所属项目" } });
      for (const project of this.state.projects) {
        select.createEl("option", { text: project.name, value: project.id });
      }
      const submit = composer.createEl("button", {
        cls: "helix-primary-button",
        text: "加入同步队列",
      });
      const create = (): void => {
        submit.disabled = true;
        void this.service.createTask(input.value, select.value)
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

  private renderProjects(content: HTMLElement): void {
    const { projects: remoteProjects, tasks } = this.displayState();
    const intro = content.createDiv({ cls: "helix-page-intro helix-page-intro-actions" });
    const copy = intro.createDiv();
    copy.createEl("h2", { text: "项目组合" });
    copy.createEl("p", { text: "每个稳定项目维护不可变 Cycle 记录；项目继承关系写入全局 Canvas 并保持 DAG。" });
    const create = intro.createEl("button", {
      cls: "helix-primary-button",
      text: "创建项目与 Cycle 01",
    });
    create.addEventListener("click", () => this.actions.createProject());
    const localProjects = this.localProjects();
    const projects = localProjects.length > 0
      ? localProjects
      : this.state?.demoMode
        ? remoteProjects.map((project) => ({
            id: project.id,
            title: project.name,
            didaProjectId: project.id,
            activeCycle: "Cycle 01",
            file: null,
          }))
        : [];
    const controls = content.createDiv({ cls: "helix-filter-row" });
    for (const [id, label] of [["board", "看板"], ["list", "列表"]] as const) {
      const button = controls.createEl("button", {
        text: label,
        cls: this.projectView === id ? "is-active" : "",
      });
      button.addEventListener("click", () => {
        this.projectView = id;
        void this.render();
      });
    }
    const grid = content.createDiv({
      cls: `helix-project-grid${this.projectView === "list" ? " is-list" : ""}`,
    });
    if (projects.length === 0) {
      grid.createDiv({
        cls: "helix-card helix-empty",
        text: "尚未创建 Helix 项目。点击上方按钮生成稳定项目笔记和首个 Cycle。",
      });
    }
    for (const project of projects) {
      const card = grid.createDiv({ cls: "helix-card helix-project-card" });
      const accent = card.createDiv({ cls: "helix-project-accent" });
      const remote = remoteProjects.find((candidate) => candidate.id === project.didaProjectId);
      accent.style.backgroundColor = remote?.color ?? "#4f6ce1";
      card.createEl("h3", { text: project.title });
      card.createEl("p", {
        text: project.didaProjectId
          ? `${tasks.filter((task) => task.projectId === project.didaProjectId && task.status !== 2).length} 个开放任务`
          : "尚未映射滴答清单",
      });
      const footer = card.createDiv({ cls: "helix-project-footer" });
      footer.createSpan({ text: project.activeCycle ?? "Cycle 尚未关联" });
      const icon = footer.createSpan();
      setIcon(icon, "arrow-up-right");
      if (project.file) {
        card.addEventListener("click", () => {
          void this.app.workspace.getLeaf("tab").openFile(project.file!);
        });
      }
    }
  }

  private renderReviews(content: HTMLElement): void {
    this.renderPageIntro(content, "周期复盘", "以日记为最小记录单位，用固定问题降低启动成本，并把任务和项目证据带回复盘。");
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
    this.renderPageIntro(content, "数据分析", "指标由不可变事件账本重算；重复完成不会重复计分，重新打开会撤销奖励。");
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
    const heatCard = chartGrid.createDiv({ cls: "helix-card helix-chart-card" });
    heatCard.createEl("h3", { text: "本周活跃热度" });
    const bars = heatCard.createDiv({ cls: "helix-chart" });
    this.mountActivityChart(bars, chartSeries.week);
  }

  private renderChallenges(content: HTMLElement): void {
    this.renderPageIntro(content, "挑战", "默认采用正向激励；挑战按周、月确定性轮换，规则版本固定，避免同步设备间漂移。");
    const showcase = content.createDiv({ cls: "helix-challenge-showcase" });
    this.renderWeeklyChallengeCard(showcase);
    this.renderMonthlyChallengeCard(showcase);
    const side = showcase.createDiv({ cls: "helix-card helix-achievement-panel" });
    side.createEl("h3", { text: "成就陈列" });
    const unlocked = new Set(deriveProgress(this.state?.events ?? []).badges);
    for (const [iconName, badge, title, desc] of [
      ["git-branch", "完成首轮迭代", "迭代者", "关闭首个项目 Cycle"],
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
  }

  private async renderConflicts(content: HTMLElement): Promise<void> {
    this.renderPageIntro(content, "冲突中心", "Base、本地和远端逐字段并排；所有竞争字段必须由你明确选择，应用前还会重新读取远端。");
    const conflicts = await this.store.list();
    const persisted = await this.store.snapshot();
    const queue = await this.service.listQueue();
    if (persisted.lineageConflict) {
      const card = content.createDiv({ cls: "helix-card helix-reconciliation-card" });
      const resolvable = persisted.lineageConflict.kind === undefined ||
        persisted.lineageConflict.kind === "lineage-concurrent";
      card.createEl("span", {
        cls: "helix-chip is-danger",
        text: resolvable ? "谱系双侧竞争" : "谱系写入已冻结",
      });
      card.createEl("h3", {
        text: resolvable ? "Canvas 与项目笔记都发生了修改" : "项目谱系需要人工修复",
      });
      card.createEl("p", {
        text: persisted.lineageConflict.message ??
          (resolvable
            ? "Helix 已暂停自动谱系写入，不会静默选择胜方。请检查两侧内容后明确选择一次。"
            : "Helix 已暂停自动谱系写入。请按提示修复项目笔记或 Canvas 后再重试。"),
      });
      if (!resolvable) {
        card.createEl("code", { text: persisted.lineageConflict.canvasPath });
        const retry = card.createEl("button", {
          cls: "helix-secondary-button",
          text: "我已修复，重新验证并重建 Canvas",
        });
        retry.addEventListener("click", () => {
          retry.disabled = true;
          void this.actions.resolveLineage("projects")
            .then(() => this.render())
            .catch((error) => {
              retry.disabled = false;
              new Notice(error instanceof Error ? error.message : String(error), 8_000);
            });
        });
      } else {
      const actions = card.createDiv({ cls: "helix-reconciliation-actions" });
      const canvas = actions.createEl("button", {
        cls: "helix-primary-button",
        text: "以 Canvas 为准",
      });
      const projects = actions.createEl("button", {
        cls: "helix-secondary-button",
        text: "以项目笔记为准",
      });
      const resolve = (choice: "canvas" | "projects") => {
        canvas.disabled = true;
        projects.disabled = true;
        void this.actions.resolveLineage(choice)
          .then(() => this.render())
          .catch((error) => {
            canvas.disabled = false;
            projects.disabled = false;
            new Notice(error instanceof Error ? error.message : String(error), 8_000);
          });
      };
      canvas.addEventListener("click", () => resolve("canvas"));
      projects.addEventListener("click", () => resolve("projects"));
      }
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

  private renderPageIntro(content: HTMLElement, title: string, description: string): void {
    const intro = content.createDiv({ cls: "helix-page-intro" });
    intro.createEl("h2", { text: title });
    intro.createEl("p", { text: description });
  }

  private displayState(): { projects: DidaProject[]; tasks: DidaTask[] } {
    const projects = this.state?.demoMode ? SAMPLE_PROJECTS : this.state?.projects ?? [];
    const tasks = this.state?.demoMode ? SAMPLE_TASKS : this.state?.tasks ?? [];
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

  private localProjects(): Array<{
    id: string;
    title: string;
    didaProjectId?: string;
    activeCycle?: string;
    file: TFile | null;
  }> {
    return this.app.vault.getMarkdownFiles().flatMap((file) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter?.["helix-kind"] !== "helix-project") return [];
      const id = frontmatter["helix-id"];
      if (typeof id !== "string") return [];
      return [{
        id,
        title: file.parent?.name ?? file.basename,
        didaProjectId:
          typeof frontmatter["helix-dida-project-id"] === "string"
            ? frontmatter["helix-dida-project-id"]
            : undefined,
        activeCycle:
          typeof frontmatter["helix-active-cycle"] === "string"
            ? frontmatter["helix-active-cycle"].replace(/\[\[|\]\]/g, "")
            : undefined,
        file,
      }];
    });
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

  private mountActivityChart(
    element: HTMLElement,
    points: Array<{ label: string; value: number }>,
  ): void {
    const chart = echarts.init(element, undefined, { renderer: "canvas" });
    chart.setOption({
      grid: { left: 34, right: 14, top: 18, bottom: 26 },
      xAxis: { type: "category", data: points.map((point) => point.label), axisTick: { show: false }, axisLine: { show: false } },
      yAxis: { type: "value", show: false, max: 12 },
      tooltip: { trigger: "axis" },
      series: [{ type: "bar", data: points.map((point) => point.value), barWidth: 20, itemStyle: { color: "#2aa37d", borderRadius: [6, 6, 0, 0] } }],
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

class TaskEditModal extends Modal {
  private title: string;
  private projectId: string;

  constructor(
    app: HelixView["app"],
    private readonly task: DidaTask,
    private readonly projects: DidaProject[],
    private readonly submit: (task: DidaTask) => Promise<void>,
  ) {
    super(app);
    this.title = task.title;
    this.projectId = task.projectId;
  }

  onOpen(): void {
    this.setTitle("编辑滴答任务");
    new Setting(this.contentEl)
      .setName("任务标题")
      .addText((text) =>
        text.setValue(this.title).onChange((value) => {
          this.title = value;
        }),
      );
    new Setting(this.contentEl)
      .setName("所属项目")
      .setDesc("修改后会按移动→更新→完成的幂等顺序同步。")
      .addDropdown((dropdown) => {
        for (const project of this.projects) dropdown.addOption(project.id, project.name);
        if (!this.projects.some((project) => project.id === this.projectId)) {
          dropdown.addOption(this.projectId, "当前项目");
        }
        dropdown.setValue(this.projectId).onChange((value) => {
          this.projectId = value;
        });
      });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const save = actions.createEl("button", { cls: "mod-cta", text: "保存并同步" });
    save.addEventListener("click", () => {
      const title = this.title.trim();
      if (!title) {
        new Notice("任务标题不能为空");
        return;
      }
      save.disabled = true;
      void this.submit({ ...this.task, title, projectId: this.projectId })
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
