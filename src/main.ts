import {
  Modal,
  Notice,
  Plugin,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import {
  journalPath,
  journalPeriodBounds,
  journalTemplate,
} from "./domain/journals";
import {
  CYCLE_RELATION_LABELS,
  stageCreationIntent,
  type CycleRelation,
  type CycleRelationKind,
  type StageCreationIntent,
} from "./domain/cycle-graph";
import type { JournalPeriod } from "./domain/entities";
import {
  deterministicEventId,
} from "./domain/events";
import { aggregateAnalytics } from "./domain/analytics";
import { patchManagedFrontmatter } from "./storage/frontmatter";
import { HelixService } from "./services/helix-service";
import { ProjectWorkspaceService } from "./services/project-workspace";
import type {
  ProjectWorkspaceMigrationItem,
  ProjectWorkspaceProject,
  StageDeletionPlan,
} from "./services/project-workspace";
import { HelixDataStore } from "./storage/data-store";
import {
  beginDataGeneration,
  invalidateDataGeneration,
  type DataGeneration,
} from "./storage/data-generation";
import { DEFAULT_SETTINGS, type HelixSettings } from "./storage/model";
import { HelixSecretStore } from "./storage/secrets";
import { HelixVaultRepository } from "./storage/vault-repository";
import { HELIX_VIEW_TYPE, HelixView } from "./ui/helix-view";
import { HelixSettingTab } from "./ui/settings-tab";

export default class HelixPlugin extends Plugin {
  settings: HelixSettings = { ...DEFAULT_SETTINGS };
  store!: HelixDataStore;
  secrets!: HelixSecretStore;
  service!: HelixService;
  vaultRepository!: HelixVaultRepository;
  projectWorkspace!: ProjectWorkspaceService;
  private syncIntervalId: number | null = null;
  private unloaded = false;
  private recoveryMode = false;
  private dataGeneration!: DataGeneration;
  private projectRefreshTimer: number | null = null;
  private projectMutationDepth = 0;
  private projectRefreshPending = false;

  async onload(): Promise<void> {
    this.unloaded = false;
    this.dataGeneration = beginDataGeneration();
    this.store = new HelixDataStore(this, this.dataGeneration);
    this.secrets = new HelixSecretStore(this.app);
    this.vaultRepository = new HelixVaultRepository(this.app.vault);
    this.projectWorkspace = new ProjectWorkspaceService(
      this.app,
      this.vaultRepository,
      () => this.settings.rootFolder,
      () => this.settings.lineageCanvasPath,
    );
    const data = await this.store.load();
    this.settings = data.settings;
    this.recoveryMode = data.recoveryIssues.length > 0;
    if (this.recoveryMode) {
      this.projectWorkspace.freezePendingStageDeletion(
        "Helix data.json 处于只读恢复模式，阶段删除事务不会自动执行，项目写入已冻结",
      );
    } else {
      try {
        const recovered = await this.projectWorkspace.recoverPendingStageDeletion();
        if (recovered !== "none") {
          new Notice(`Helix 已恢复未完成的阶段删除事务：${recovered}`);
        }
      } catch (error) {
        const message =
          `Helix 阶段删除事务需要人工检查：${
            error instanceof Error ? error.message : String(error)
          }`;
        this.projectWorkspace.freezePendingStageDeletion(message);
        this.recoveryMode = true;
        new Notice(message, 0);
      }
    }
    this.service = new HelixService(this.store, this.secrets);
    await this.service.initialize();
    if (!this.recoveryMode) await this.recoverClosedReviewEvents();

    this.registerView(
      HELIX_VIEW_TYPE,
      (leaf) => new HelixView(leaf, this.service, this.store, {
        openReview: (period) => this.openJournal(period),
        createProject: () => this.showCreateProjectModal(),
        createCycle: (projectId, sourceCycleIds) =>
          this.showCreateCycleModal(projectId, sourceCycleIds),
        deleteCycle: (cycleId) => this.showDeleteCycleModal(cycleId),
        manageRelation: (relationId) => this.showManageRelationModal(relationId),
        openProjectFile: (path) => this.openFile(path),
        projectWorkspace: this.projectWorkspace,
        reviewLegacyMigration: () => this.showLegacyMigrationModal(),
      }),
    );
    this.addRibbonIcon("orbit", "打开 Helix", () => void this.activateView());
    this.addCommand({
      id: "open-workbench",
      name: "打开工作台",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "sync-now",
      name: "立即同步滴答数据",
      callback: () => void this.service.sync().catch((error) => this.service.notifySyncError(error)),
    });
    this.addCommand({
      id: "create-project",
      name: "创建项目",
      callback: () => this.openProjectModal(),
    });
    this.addCommand({
      id: "open-daily-review",
      name: "打开或创建今日日记",
      callback: () => void this.openJournal("daily"),
    });
    this.addCommand({
      id: "open-weekly-review",
      name: "打开或创建本周复盘",
      callback: () => void this.openJournal("weekly"),
    });
    this.addCommand({
      id: "open-monthly-review",
      name: "打开或创建本月复盘",
      callback: () => void this.openJournal("monthly"),
    });
    this.addCommand({
      id: "open-yearly-review",
      name: "打开或创建本年复盘",
      callback: () => void this.openJournal("yearly"),
    });
    this.addCommand({
      id: "close-current-review",
      name: "关闭当前 Helix 复盘",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const frontmatter = file
          ? this.app.metadataCache.getFileCache(file)?.frontmatter
          : undefined;
        const canClose =
          !!file &&
          frontmatter?.["helix-kind"] === "helix-journal" &&
          frontmatter?.["helix-status"] === "open";
        if (!canClose) return false;
        if (!checking && file) {
          void this.closeReview(file).catch((error) => {
            new Notice(error instanceof Error ? error.message : String(error));
          });
        }
        return true;
      },
    });
    this.addSettingTab(new HelixSettingTab(this.app, this));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.isProjectWorkspaceFile(file.path)) this.scheduleProjectRefresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.isProjectWorkspaceFile(file.path)) this.scheduleProjectRefresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.isProjectWorkspaceFile(file.path)) this.scheduleProjectRefresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (
          this.isProjectWorkspaceFile(file.path) ||
          this.isProjectWorkspaceFile(oldPath)
        ) this.scheduleProjectRefresh();
      }),
    );

    this.refreshAutoSync();
  }

  onunload(): void {
    this.unloaded = true;
    if (this.projectRefreshTimer !== null) {
      window.clearTimeout(this.projectRefreshTimer);
      this.projectRefreshTimer = null;
    }
    this.service?.dispose();
    this.projectWorkspace?.dispose();
    if (this.dataGeneration) invalidateDataGeneration(this.dataGeneration);
    this.store?.dispose();
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    this.app.workspace.detachLeavesOfType(HELIX_VIEW_TYPE);
  }

  async saveSettings(): Promise<void> {
    await this.store.mutate((data) => {
      data.settings = { ...this.settings };
    });
    this.refreshAutoSync();
  }

  refreshAutoSync(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.recoveryMode || !this.settings.autoSync || !this.secrets.getDidaToken()) return;
    const interval = Math.max(5, this.settings.syncIntervalMinutes) * 60_000;
    this.syncIntervalId = window.setInterval(
      () => void this.service.sync().catch(() => undefined),
      interval,
    );
    this.registerInterval(this.syncIntervalId);
  }

  async activateView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(HELIX_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: HELIX_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  private openProjectModal(): void {
    if (this.recoveryMode) {
      new Notice("Helix 当前处于只读恢复模式，修复 data.json 前不能创建项目", 8_000);
      return;
    }
    new ProjectPromptModal(
      this.app,
      this.service.snapshot().projects,
      async (title, didaProjectId, color) => {
        this.assertWritable();
        await this.withProjectMutation(() =>
          this.projectWorkspace.createProject(title, didaProjectId, color));
        await this.service.refreshPersistedEvents();
        new Notice("项目和阶段 1 已加入当前工作区");
      },
    ).open();
  }

  showCreateProjectModal(): void {
    this.openProjectModal();
  }

  private showCreateCycleModal(projectId: string, sourceCycleIds: string[]): void {
    if (this.recoveryMode) {
      new Notice("Helix 当前处于只读恢复模式，修复 data.json 前不能创建阶段", 8_000);
      return;
    }
    void this.projectWorkspace.snapshot()
      .then((snapshot) => {
        const project = snapshot.projects.find((candidate) => candidate.id === projectId);
        if (!project) throw new Error("找不到项目");
        const intent = stageCreationIntent(sourceCycleIds, snapshot.relations);
        const sourceCycles = intent.predecessorIds.map((sourceId) => {
          const owner = snapshot.projects.find((candidate) =>
            candidate.cycles.some((cycle) => cycle.id === sourceId));
          const cycle = owner?.cycles.find((candidate) => candidate.id === sourceId);
          if (!owner || !cycle) throw new Error("找不到来源阶段");
          return { project: owner, cycle };
        });
        const crossProject = sourceCycles.some((source) =>
          source.project.id !== project.id);
        new CyclePromptModal(
          this.app,
          project,
          sourceCycles,
          intent,
          crossProject,
          snapshot.nextStageSequenceByProject[project.id]!,
          async (stageTitle, crossProjectConfirmed) => {
            this.assertWritable();
            await this.withProjectMutation(() =>
              this.projectWorkspace.createCycle(
                projectId,
                "auto",
                intent.predecessorIds,
                {
                  confirmCrossProject: crossProjectConfirmed,
                  expectedAutoIntent: {
                    relation: intent.relation,
                    convertedInheritanceRelationIds:
                      intent.convertedInheritanceRelationIds,
                  },
                  stageTitle,
                },
              ));
            await this.service.refreshPersistedEvents();
            new Notice(`${CYCLE_RELATION_LABELS[intent.relation]}阶段已加入当前工作区`);
          },
        ).open();
      })
      .catch((error) => {
        new Notice(error instanceof Error ? error.message : String(error), 8_000);
      });
  }

  private showDeleteCycleModal(cycleId: string): void {
    if (this.recoveryMode) {
      new Notice("Helix 当前处于只读恢复模式，修复 data.json 前不能删除阶段", 8_000);
      return;
    }
    void Promise.all([
      this.projectWorkspace.snapshot(),
      this.projectWorkspace.planCycleDeletion(cycleId),
    ])
      .then(([snapshot, plan]) => {
        const owner = snapshot.projects.find((project) =>
          project.cycles.some((cycle) => cycle.id === cycleId));
        const cycle = owner?.cycles.find((candidate) => candidate.id === cycleId);
        if (!owner || !cycle) throw new Error("找不到需要删除的阶段");
        new DeleteCycleModal(
          this.app,
          owner,
          snapshot.projects,
          cycle,
          snapshot.relations,
          plan,
          async (bridge, confirmCrossProject) => {
            this.assertWritable();
            await this.withProjectMutation(() =>
              this.projectWorkspace.deleteCycle(plan, {
                bridge,
                confirmCrossProject,
              }));
            new Notice(
              bridge
                ? "阶段已删除，前后关系已桥接并整理"
                : "阶段已删除，未自动桥接前后关系",
            );
          },
        ).open();
      })
      .catch((error) => {
        new Notice(error instanceof Error ? error.message : String(error), 8_000);
      });
  }

  private showManageRelationModal(relationId: string): void {
    if (this.recoveryMode) {
      new Notice("Helix 当前处于只读恢复模式，修复 data.json 前不能修改关系", 8_000);
      return;
    }
    void this.projectWorkspace.snapshot()
      .then((snapshot) => {
        const relation = snapshot.relations.find((candidate) => candidate.id === relationId);
        if (!relation) throw new Error("找不到需要管理的阶段关系");
        new RelationPromptModal(
          this.app,
          relation,
          snapshot.relations,
          snapshot.projects,
          async (kind, predecessorIds, crossProjectConfirmed) => {
            this.assertWritable();
            await this.withProjectMutation(() =>
              this.projectWorkspace.replaceRelation(
                relation.id,
                kind,
                predecessorIds,
                { confirmCrossProject: crossProjectConfirmed },
              ));
            new Notice("阶段关系已更新");
          },
          async () => {
            this.assertWritable();
            await this.withProjectMutation(() =>
              this.projectWorkspace.deleteRelation(relation.id));
            new Notice("阶段关系已删除");
          },
        ).open();
      })
      .catch((error) => {
        new Notice(error instanceof Error ? error.message : String(error), 8_000);
      });
  }

  private showLegacyMigrationModal(): void {
    void Promise.all([
      this.projectWorkspace.snapshot(),
      this.store.snapshot(),
    ])
      .then(([snapshot, persisted]) => {
        if (!snapshot.migrationRequired) {
          new Notice("没有待确认的旧项目数据");
          return;
        }
        new LegacyMigrationModal(
          this.app,
          snapshot.migrationItems,
          Boolean(persisted.lineageConflict),
          async (ids, archiveLegacyConflict) => {
            this.assertWritable();
            await this.withProjectMutation(() =>
              this.projectWorkspace.acknowledgeLegacyMigration(ids));
            if (archiveLegacyConflict) {
              await this.store.mutate((data) => {
                data.lineageConflict = undefined;
              });
            }
            await this.service.refreshPersistedEvents();
            new Notice(
              archiveLegacyConflict
                ? "旧数据已确认，旧版谱系冲突已归档"
                : "旧数据已确认，阶段节点身份已升级",
            );
          },
        ).open();
      })
      .catch((error) => {
        new Notice(error instanceof Error ? error.message : String(error), 8_000);
      });
  }

  private async openJournal(period: JournalPeriod): Promise<void> {
    const now = new Date();
    const path = journalPath(this.settings.rootFolder, period, now);
    const existing = await this.vaultRepository.read(path);
    if (!existing) {
      this.assertWritable();
      const names: Record<JournalPeriod, string> = {
        daily: formatDate(now),
        weekly: `${formatDate(now)} 所在周复盘`,
        monthly: `${now.getFullYear()} 年 ${now.getMonth() + 1} 月复盘`,
        yearly: `${now.getFullYear()} 年复盘`,
      };
      const bounds = journalPeriodBounds(period, now);
      const state = this.service.snapshot();
      const summary = aggregateAnalytics(state.events, {
        from: bounds.start,
        to: bounds.end,
      });
      const generatedSummary = [
        `- 完成任务：${summary.totalTasks}`,
        `- 习惯打卡：${summary.totalHabitCheckins}`,
        `- 专注时长：${summary.totalFocusMinutes} 分钟`,
        `- 活跃天数：${summary.activeDays}`,
      ].join("\n");
      const content = journalTemplate({
        period,
        title: names[period],
        periodStart: bounds.start,
        periodEnd: bounds.end,
      }).replace(
        "Helix 将在这里维护任务、习惯、专注与项目数据摘要。",
        generatedSummary,
      );
      await this.vaultRepository.create(
        path,
        content,
      );
    }
    await this.openFile(path);
  }

  private async closeReview(file: TFile): Promise<void> {
    this.assertWritable();
    const revision = await this.vaultRepository.read(file.path);
    if (!revision) throw new Error("复盘文件已经不存在");
    const now = new Date().toISOString();
    await this.vaultRepository.compareAndWrite(
      revision,
      patchManagedFrontmatter(revision.content, {
        "helix-status": "closed",
        "helix-closed": now,
      }),
    );
    await this.recordClosedReviewEvents([{ path: file.path, closedAt: now }]);
    new Notice("复盘已关闭并计入事件账本");
  }

  private async recoverClosedReviewEvents(files?: TFile[]): Promise<void> {
    const candidates = (files ?? this.app.vault.getMarkdownFiles()).flatMap((candidate) => {
      const frontmatter = this.app.metadataCache.getFileCache(candidate)?.frontmatter;
      if (
        frontmatter?.["helix-kind"] !== "helix-journal" ||
        frontmatter?.["helix-status"] !== "closed" ||
        typeof frontmatter["helix-closed"] !== "string" ||
        !Number.isFinite(Date.parse(frontmatter["helix-closed"]))
      ) {
        return [];
      }
      return [{
        path: candidate.path,
        closedAt: frontmatter["helix-closed"] as string,
      }];
    });
    await this.recordClosedReviewEvents(candidates);
  }

  private async recordClosedReviewEvents(
    candidates: Array<{ path: string; closedAt: string }>,
  ): Promise<void> {
    if (candidates.length === 0) return;
    await this.service.appendLocalEvents(
      candidates.map((candidate) => ({
          id: deterministicEventId({
            type: "review-closed",
            entityId: candidate.path,
            occurrenceKey: candidate.path,
            occurredAt: candidate.closedAt,
          }),
          type: "review-closed",
          entityId: candidate.path,
          occurrenceKey: candidate.path,
          occurredAt: candidate.closedAt,
        })),
    );
  }

  private scheduleProjectRefresh(): void {
    if (this.unloaded) return;
    if (this.projectMutationDepth > 0) {
      this.projectRefreshPending = true;
      return;
    }
    if (this.projectRefreshTimer !== null) {
      window.clearTimeout(this.projectRefreshTimer);
    }
    this.projectRefreshTimer = window.setTimeout(() => {
      this.projectRefreshTimer = null;
      if (!this.unloaded) void this.service.refreshPersistedEvents();
    }, 200);
  }

  private async withProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.projectMutationDepth === 0 && this.projectRefreshTimer !== null) {
      window.clearTimeout(this.projectRefreshTimer);
      this.projectRefreshTimer = null;
      this.projectRefreshPending = true;
    }
    this.projectMutationDepth += 1;
    try {
      return await operation();
    } finally {
      this.projectMutationDepth -= 1;
      if (this.projectMutationDepth === 0 && this.projectRefreshPending) {
        this.projectRefreshPending = false;
        this.scheduleProjectRefresh();
      }
    }
  }

  private isProjectWorkspaceFile(path: string): boolean {
    const projectsRoot = normalizePath(`${this.settings.rootFolder}/Projects`);
    const normalized = normalizePath(path);
    return (
      normalized === normalizePath(this.settings.lineageCanvasPath) ||
      (
        normalized.startsWith(`${projectsRoot}/`) &&
        normalized.endsWith(".md")
      )
    );
  }

  private assertWritable(): void {
    if (this.recoveryMode) {
      throw new Error("Helix 当前处于只读恢复模式，修复 data.json 前不能写入");
    }
    if (this.unloaded) throw new Error("Helix 已卸载，写入已取消");
  }

  private async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`无法打开文件：${path}`);
    const leaf: WorkspaceLeaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
  }
}

class ProjectPromptModal extends Modal {
  private title = "";
  private didaProjectId = "";
  private color = "#5870A8";

  constructor(
    app: HelixPlugin["app"],
    private readonly projects: Array<{ id: string; name: string }>,
    private readonly submit: (
      title: string,
      didaProjectId?: string,
      color?: string,
    ) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("创建 Helix 项目");
    new Setting(this.contentEl)
      .setName("项目名称")
      .setDesc("将创建稳定项目笔记和首个阶段。")
      .addText((text) =>
        text.setPlaceholder("例如：强化学习论文实验").onChange((value) => {
          this.title = value;
        }),
      );
    new Setting(this.contentEl)
      .setName("滴答清单映射")
      .setDesc("默认一个 Helix 项目对应一个滴答清单，也可以稍后配置。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "稍后映射");
        for (const project of this.projects) dropdown.addOption(project.id, project.name);
        dropdown.onChange((value) => {
          this.didaProjectId = value;
        });
      });
    new Setting(this.contentEl)
      .setName("项目颜色")
      .setDesc("用于项目卡片左侧的低调渐变，可随时修改。")
      .addColorPicker((picker) => {
        picker.setValue(this.color);
        picker.onChange((value) => {
          this.color = value.toUpperCase();
        });
      });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "创建项目与阶段 1" });
    confirm.addEventListener("click", () => {
      const title = this.title.trim();
      if (!title) {
        new Notice("请输入项目名称");
        return;
      }
      confirm.disabled = true;
      void this.submit(title, this.didaProjectId || undefined, this.color)
        .then(() => this.close())
        .catch((error) => {
          confirm.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class CyclePromptModal extends Modal {
  private stageTitle = "";
  private crossProjectConfirmed = false;
  private titleInput: HTMLInputElement | null = null;

  constructor(
    app: HelixPlugin["app"],
    private readonly project: ProjectWorkspaceProject,
    private readonly sources: Array<{
      project: ProjectWorkspaceProject;
      cycle: ProjectWorkspaceProject["cycles"][number];
    }>,
    private readonly intent: StageCreationIntent,
    private readonly crossProject: boolean,
    private readonly nextStageSequence: number,
    private readonly submit: (
      stageTitle: string,
      crossProjectConfirmed: boolean,
    ) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const singleSource = this.sources.length === 1 ? this.sources[0] : null;
    this.setTitle(this.intent.relation === "merge"
      ? `合并为 ${this.project.title} / 阶段 ${this.nextStageSequence}`
      : `添加阶段 ${this.nextStageSequence} · ${singleSource?.cycle.title ?? this.project.title}`);
    if (this.project.cycles.length === 0) {
      this.contentEl.createDiv({
        cls: "helix-modal-note",
        text: "当前项目没有阶段，请先重新扫描或创建项目。",
      });
      return;
    }
    const relation = this.contentEl.createDiv({ cls: "helix-stage-intent" });
    relation.createSpan({
      cls: `helix-relation-chip is-${this.intent.relation}`,
      text: CYCLE_RELATION_LABELS[this.intent.relation],
    });
    relation.createSpan({ text: this.intentSummary() });
    new Setting(this.contentEl)
      .setName("阶段标题")
      .setDesc(`序号将自动生成为“阶段 ${this.nextStageSequence}”`)
      .addText((text) => {
        this.titleInput = text.inputEl;
        text.setPlaceholder("例如：验证基线实验").onChange((value) => {
          this.stageTitle = value;
        });
      });
    if (this.crossProject) this.renderCrossProjectConfirmation();
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      cls: "mod-cta",
      text: `创建阶段 ${this.nextStageSequence}`,
    });
    const submitStage = (): void => {
      if (confirm.disabled) return;
      const stageTitle = this.stageTitle.trim();
      if (!stageTitle) {
        new Notice("请输入阶段标题");
        return;
      }
      if (this.crossProject && !this.crossProjectConfirmed) {
        new Notice("跨项目关系需要明确确认");
        return;
      }
      confirm.disabled = true;
      void this.submit(stageTitle, this.crossProjectConfirmed)
        .then(() => this.close())
        .catch((error) => {
          confirm.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    };
    confirm.addEventListener("click", submitStage);
    this.titleInput?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      submitStage();
    });
    window.setTimeout(() => this.titleInput?.focus(), 0);
  }

  private renderCrossProjectConfirmation(): void {
    const externalSources = this.sources
      .filter(({ project }) => project.id !== this.project.id)
      .map(({ project, cycle }) => `${project.title} / ${cycle.title}`)
      .join("、");
    const setting = new Setting(this.contentEl)
      .setName("跨项目合并")
      .setDesc(
        `新阶段归属“${this.project.title}”，并引用：${externalSources}`,
      );
    setting.addToggle((toggle) =>
      toggle.setValue(false).onChange((value) => {
        this.crossProjectConfirmed = value;
      }),
    );
  }

  private intentSummary(): string {
    const labels = this.sources.map(({ project, cycle }) =>
      project.id === this.project.id
        ? cycle.title
        : `${project.title} / ${cycle.title}`);
    if (this.intent.relation === "merge") {
      const converted = this.sources
        .filter(({ cycle }) =>
          this.intent.convertedInheritanceSourceIds.includes(cycle.id))
        .map(({ cycle }) => cycle.title);
      return converted.length > 0
        ? `${labels.join(" + ")}；${converted.join("、")}的已有后继同步改为分支`
        : labels.join(" + ");
    }
    if (this.intent.relation === "branch") {
      return this.intent.convertedInheritanceRelationIds.length > 0
        ? `从 ${labels[0]} 新建分支，已有后继同步改为分支`
        : `从 ${labels[0]} 新建分支`;
    }
    return `继承自 ${labels[0]}`;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DeleteCycleModal extends Modal {
  private confirmed = false;
  private bridge = true;
  private crossProjectConfirmed = false;

  constructor(
    app: HelixPlugin["app"],
    private readonly project: ProjectWorkspaceProject,
    private readonly projects: ProjectWorkspaceProject[],
    private readonly cycle: ProjectWorkspaceProject["cycles"][number],
    private readonly relations: CycleRelation[],
    private readonly plan: StageDeletionPlan,
    private readonly submit: (
      bridge: boolean,
      confirmCrossProject: boolean,
    ) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(`删除阶段 ${this.cycle.sequence}`);
    this.contentEl.createEl("p", {
      text: `${this.project.title} / ${this.cycle.title}`,
    });
    this.contentEl.createEl("p", {
      cls: "helix-modal-note",
      text: "阶段 Markdown 将移入 Obsidian 废纸篓；其他阶段笔记不会改写。",
    });
    const newEdges = this.plan.bridgeCandidates.filter((candidate) => !candidate.existing);
    const reusedEdges = this.plan.bridgeCandidates.filter((candidate) => candidate.existing);
    const crossProjectEdges = this.plan.bridgeCandidates.filter(
      (candidate) => candidate.crossProject,
    );
    this.bridge = !this.plan.bridgeLimitExceeded;
    const impactSummary = this.contentEl.createEl("p", {
      cls: "helix-modal-note",
    });
    const impactDetails = this.contentEl.createDiv({
      cls: "helix-deletion-impact-details",
    });
    if (newEdges.length > 0) {
      const details = this.contentEl.createEl("details");
      details.createEl("summary", { text: "查看桥接关系" });
      const list = details.createEl("ul");
      for (const edge of this.plan.bridgeCandidates) {
        list.createEl("li", {
          text: `${this.cycleLabel(edge.fromCycleId)} → ${this.cycleLabel(edge.toCycleId)}${
            edge.existing ? "（已存在）" : ""
          }${edge.crossProject ? "（跨项目）" : ""}`,
        });
      }
    }
    new Setting(this.contentEl)
      .setName("删除后衔接前后阶段")
      .setDesc(
        this.plan.bridgeLimitExceeded
          ? "候选新增边超过 24 条，已禁止一键桥接；删除后请手动连接。"
          : "默认保留路径连续性；关闭后只移除节点及相邻关系。",
      )
      .addToggle((toggle) => {
        toggle.setValue(!this.plan.bridgeLimitExceeded);
        toggle.setDisabled(this.plan.bridgeLimitExceeded);
        toggle.onChange((value) => {
          this.bridge = value;
          crossConfirmation.toggleClass("is-hidden", !value || crossProjectEdges.length === 0);
          this.renderImpact(impactSummary, impactDetails, newEdges.length, reusedEdges.length);
          this.updateRemoveButton(remove);
        });
      });
    const crossConfirmation = this.contentEl.createEl("label", {
      cls: `helix-branch-confirm${
        crossProjectEdges.length === 0 || !this.bridge ? " is-hidden" : ""
      }`,
    });
    const crossCheckbox = crossConfirmation.createEl("input", { type: "checkbox" });
    crossConfirmation.createSpan({
      text: `我确认新增或复用 ${crossProjectEdges.length} 条跨项目桥接`,
    });
    crossCheckbox.addEventListener("change", () => {
      this.crossProjectConfirmed = crossCheckbox.checked;
      this.updateRemoveButton(remove);
    });
    this.renderImpact(impactSummary, impactDetails, newEdges.length, reusedEdges.length);
    const confirmation = this.contentEl.createEl("label", {
      cls: "helix-branch-confirm",
    });
    const checkbox = confirmation.createEl("input", { type: "checkbox" });
    confirmation.createSpan({ text: "我确认删除这个阶段及其 Canvas 关系" });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const remove = actions.createEl("button", {
      cls: "mod-warning",
      text: "移入废纸篓",
    });
    remove.disabled = true;
    checkbox.addEventListener("change", () => {
      this.confirmed = checkbox.checked;
      this.updateRemoveButton(remove);
    });
    remove.addEventListener("click", () => {
      if (!this.confirmed) return;
      remove.disabled = true;
      void this.submit(this.bridge, this.crossProjectConfirmed)
        .then(() => this.close())
        .catch((error) => {
          remove.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  private updateRemoveButton(button: HTMLButtonElement): void {
    const needsCrossProject = this.bridge &&
      this.plan.bridgeCandidates.some((candidate) => candidate.crossProject);
    button.disabled = !this.confirmed ||
      (needsCrossProject && !this.crossProjectConfirmed);
  }

  private renderImpact(
    summary: HTMLElement,
    details: HTMLElement,
    newEdgeCount: number,
    reusedEdgeCount: number,
  ): void {
    const impact = this.bridge
      ? this.plan.impacts.bridge
      : this.plan.impacts.noBridge;
    summary.textContent = this.bridge
      ? `桥接：新增 ${newEdgeCount} 条、复用 ${reusedEdgeCount} 条；${
          impact.relabeledEdges.length
        } 条已有边重标，整理 ${impact.affectedNodeCount} 个节点。`
      : `不桥接：只删除节点及相邻边；${impact.relabeledEdges.length} 条已有边重标，整理 ${
          impact.affectedNodeCount
        } 个节点。`;
    details.empty();
    if (impact.relabeledEdges.length === 0) return;
    const disclosure = details.createEl("details");
    disclosure.createEl("summary", {
      text: `查看 ${impact.relabeledEdges.length} 条关系类型变化`,
    });
    const list = disclosure.createEl("ul");
    for (const edge of impact.relabeledEdges) {
      list.createEl("li", {
        text: `${this.cycleLabel(edge.fromCycleId)} → ${
          this.cycleLabel(edge.toCycleId)
        }：${CYCLE_RELATION_LABELS[edge.before]} → ${
          CYCLE_RELATION_LABELS[edge.after]
        }（${edge.edgeId}）`,
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private cycleLabel(cycleId: string): string {
    for (const project of this.projects) {
      const cycle = project.cycles.find((candidate) => candidate.id === cycleId);
      if (cycle) return `${project.title} / 阶段 ${cycle.sequence} · ${cycle.title}`;
    }
    return cycleId;
  }
}

class RelationPromptModal extends Modal {
  private selected: Set<string>;
  private picker: Setting | null = null;
  private crossProjectConfirmed = false;
  private crossProjectCheckbox: HTMLInputElement | null = null;
  private deleteArmed = false;

  constructor(
    app: HelixPlugin["app"],
    private readonly relation: CycleRelation,
    private readonly relations: CycleRelation[],
    private readonly projects: ProjectWorkspaceProject[],
    private readonly submit: (
      kind: CycleRelationKind,
      predecessorIds: string[],
      crossProjectConfirmed: boolean,
    ) => Promise<void>,
    private readonly remove: () => Promise<void>,
  ) {
    super(app);
    this.selected = new Set(relation.fromCycleIds);
  }

  onOpen(): void {
    this.setTitle("管理阶段关系");
    const target = this.findCycle(this.relation.toCycleId);
    new Setting(this.contentEl)
      .setName("目标阶段")
      .setDesc(target
        ? `${target.project.title} / 阶段 ${target.cycle.sequence} · ${target.cycle.title}`
        : this.relation.toCycleId);
    new Setting(this.contentEl)
      .setName("关系类型由拓扑自动判定")
      .setDesc("一个目标有多个前置时为合并；一个来源有多个后继时为分支；其余为继承。");
    this.picker = new Setting(this.contentEl);
    this.renderPicker();
    const crossProject = this.contentEl.createEl("label", {
      cls: "helix-branch-confirm",
    });
    const crossCheckbox = crossProject.createEl("input", { type: "checkbox" });
    this.crossProjectCheckbox = crossCheckbox;
    crossCheckbox.checked = this.crossProjectConfirmed;
    crossCheckbox.addEventListener("change", () => {
      this.crossProjectConfirmed = crossCheckbox.checked;
    });
    crossProject.createSpan({
      text: "我确认：允许从其他项目的阶段建立跨项目关系。",
    });
    const normalized = normalizedBranchesAfterRemoving(
      this.relations,
      [this.relation],
    );
    if (normalized.length > 0) {
      this.contentEl.createEl("p", {
        cls: "helix-modal-note is-warning",
        text: `删除这组关系后，${normalized.map((candidate) =>
          this.cycleLabel(candidate.toCycleId)).join("、")}的剩余分支关系将改为继承。`,
      });
    }

    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const remove = actions.createEl("button", {
      cls: "mod-warning",
      text: "删除关系",
    });
    remove.addEventListener("click", () => {
      if (!this.deleteArmed) {
        this.deleteArmed = true;
        remove.textContent = "再次点击确认删除";
        return;
      }
      remove.disabled = true;
      void this.remove()
        .then(() => this.close())
        .catch((error) => {
          remove.disabled = false;
          this.deleteArmed = false;
          remove.textContent = "删除关系";
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const save = actions.createEl("button", { cls: "mod-cta", text: "保存关系" });
    save.addEventListener("click", () => {
      const ids = [...this.selected];
      if (ids.length < 1) {
        new Notice("至少选择 1 个前置阶段");
        return;
      }
      if (this.isCrossProject() && !this.crossProjectConfirmed) {
        new Notice("跨项目关系需要明确确认");
        return;
      }
      save.disabled = true;
      const physicalKind: CycleRelationKind = ids.length >= 2 ? "merge" : "inherit";
      void this.submit(physicalKind, ids, this.crossProjectConfirmed)
        .then(() => this.close())
        .catch((error) => {
          save.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  private renderPicker(): void {
    if (!this.picker) return;
    this.picker.settingEl.empty();
    const picker = this.picker.settingEl.createDiv({ cls: "helix-cycle-picker" });
    picker.createEl("strong", {
      text: "选择前置阶段",
    });
    for (const project of this.projects) {
      for (const cycle of project.cycles) {
        if (cycle.id === this.relation.toCycleId) continue;
        const row = picker.createEl("label");
        const input = row.createEl("input", {
          type: "checkbox",
          attr: { name: "helix-relation-predecessor" },
        });
        input.checked = this.selected.has(cycle.id);
        input.addEventListener("change", () => {
          if (input.checked) this.selected.add(cycle.id);
          else this.selected.delete(cycle.id);
          this.resetCrossProjectConfirmation();
        });
        row.createSpan({
          text: `${project.title} / 阶段 ${cycle.sequence} · ${cycle.title}`,
        });
      }
    }
  }

  private findCycle(id: string): {
    project: ProjectWorkspaceProject;
    cycle: ProjectWorkspaceProject["cycles"][number];
  } | undefined {
    for (const project of this.projects) {
      const cycle = project.cycles.find((candidate) => candidate.id === id);
      if (cycle) return { project, cycle };
    }
    return undefined;
  }

  private isCrossProject(): boolean {
    const target = this.findCycle(this.relation.toCycleId);
    if (!target) return false;
    return [...this.selected].some((id) => this.findCycle(id)?.project.id !== target.project.id);
  }

  private resetCrossProjectConfirmation(): void {
    this.crossProjectConfirmed = false;
    if (this.crossProjectCheckbox) this.crossProjectCheckbox.checked = false;
  }

  private cycleLabel(cycleId: string): string {
    const found = this.findCycle(cycleId);
    return found
      ? `${found.project.title} / 阶段 ${found.cycle.sequence} · ${found.cycle.title}`
      : cycleId;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function normalizedBranchesAfterRemoving(
  relations: CycleRelation[],
  removedRelations: CycleRelation[],
): CycleRelation[] {
  const removedIds = new Set(removedRelations.map((relation) => relation.id));
  const remaining = relations.filter((relation) => !removedIds.has(relation.id));
  const normalized = new Map<string, CycleRelation>();
  for (const sourceId of new Set(
    removedRelations.flatMap((relation) => relation.fromCycleIds),
  )) {
    const outgoing = remaining.filter((relation) =>
      relation.fromCycleIds.includes(sourceId));
    if (outgoing.length === 1 && outgoing[0]!.kind === "branch") {
      normalized.set(outgoing[0]!.id, outgoing[0]!);
    }
  }
  return [...normalized.values()];
}

class LegacyMigrationModal extends Modal {
  private readonly confirmed = new Set<string>();
  private archiveLegacyConflict = false;

  constructor(
    app: HelixPlugin["app"],
    private readonly items: ProjectWorkspaceMigrationItem[],
    private readonly hasLegacyConflict: boolean,
    private readonly submit: (
      confirmedIds: string[],
      archiveLegacyConflict: boolean,
    ) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("确认旧项目数据");
    this.contentEl.createEl("p", {
      cls: "helix-modal-note",
      text: "逐项核对后勾选。旧关系字段和旧边只保留、不推断；同文件夹阶段只补充明确的项目 ID。",
    });
    const list = this.contentEl.createDiv({ cls: "helix-migration-list" });
    for (const item of this.items) {
      const row = list.createEl("label", { cls: "helix-migration-item" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      const copy = row.createDiv();
      copy.createEl("strong", { text: item.title });
      copy.createEl("code", { text: item.sourcePath });
      copy.createEl("span", { text: item.detail });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.confirmed.add(item.id);
        else this.confirmed.delete(item.id);
        confirm.disabled = this.confirmed.size !== this.items.length;
      });
    }
    if (this.hasLegacyConflict) {
      const archive = this.contentEl.createEl("label", { cls: "helix-branch-confirm" });
      const checkbox = archive.createEl("input", { type: "checkbox" });
      checkbox.addEventListener("change", () => {
        this.archiveLegacyConflict = checkbox.checked;
      });
      archive.createSpan({
        text: "迁移成功后归档旧版谱系冲突记录（不删除 Markdown 或 Canvas 数据）",
      });
    }
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      cls: "mod-cta",
      text: "保留旧数据并启用新工作区",
    });
    confirm.disabled = true;
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      void this.submit([...this.confirmed], this.archiveLegacyConflict)
        .then(() => this.close())
        .catch((error) => {
          confirm.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}
