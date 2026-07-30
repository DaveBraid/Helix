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
import { cycleTemplate, projectTemplate } from "./domain/projects";
import {
  assertExistingInitialCycleIdentity,
  assertExistingProjectIdentity,
} from "./domain/project-identity";
import { assertUniqueDidaProjectMapping } from "./domain/project-mapping";
import type { JournalPeriod } from "./domain/entities";
import {
  deterministicEventId,
} from "./domain/events";
import { aggregateAnalytics } from "./domain/analytics";
import { patchManagedFrontmatter } from "./storage/frontmatter";
import { HelixService } from "./services/helix-service";
import { LineageService } from "./services/lineage-service";
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
import { CancelableTimer } from "./services/cancelable-timer";
import { lineageBatchDecision } from "./services/lineage-batch";

export default class HelixPlugin extends Plugin {
  settings: HelixSettings = { ...DEFAULT_SETTINGS };
  store!: HelixDataStore;
  secrets!: HelixSecretStore;
  service!: HelixService;
  vaultRepository!: HelixVaultRepository;
  lineageService!: LineageService;
  private syncIntervalId: number | null = null;
  private lineageTimer = new CancelableTimer();
  private unloaded = false;
  private recoveryMode = false;
  private knownProjectPaths = new Set<string>();
  private dataGeneration!: DataGeneration;
  private pendingLineageCanvas = false;
  private pendingLineageProjects = false;

  async onload(): Promise<void> {
    this.unloaded = false;
    this.pendingLineageCanvas = false;
    this.pendingLineageProjects = false;
    this.lineageTimer = new CancelableTimer();
    this.dataGeneration = beginDataGeneration();
    this.store = new HelixDataStore(this, this.dataGeneration);
    this.secrets = new HelixSecretStore(this.app);
    this.vaultRepository = new HelixVaultRepository(this.app.vault);
    this.lineageService = new LineageService(
      this.app,
      this.vaultRepository,
      () => this.settings.lineageCanvasPath,
    );
    const data = await this.store.load();
    this.settings = data.settings;
    this.recoveryMode = data.recoveryIssues.length > 0;
    this.service = new HelixService(this.store, this.secrets);
    await this.service.initialize();
    if (!this.recoveryMode) await this.recoverClosedReviewEvents();
    if (!this.recoveryMode) {
      try {
        this.lineageService.assertProjectIntegrity();
        this.knownProjectPaths = new Set(this.lineageService.projectPaths());
      } catch (error) {
        await this.recordLineageConflict(error, "project-integrity");
      }
    }

    this.registerView(
      HELIX_VIEW_TYPE,
      (leaf) => new HelixView(leaf, this.service, this.store, {
        openReview: (period) => this.openJournal(period),
        createProject: () => this.showCreateProjectModal(),
        resolveLineage: (choice) => this.resolveLineageConflict(choice),
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
    this.addCommand({
      id: "open-lineage-canvas",
      name: "打开项目继承 Canvas",
      callback: () => void this.openLineageCanvas(),
    });
    this.addCommand({
      id: "advance-active-cycle",
      name: "关闭当前 Cycle 并创建下一轮",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const isCycle =
          !!file &&
          this.app.metadataCache.getFileCache(file)?.frontmatter?.["helix-kind"] ===
            "helix-cycle";
        if (!isCycle) return false;
        if (!checking && file) {
          void this.advanceCycle(file).catch((error) => {
            new Notice(error instanceof Error ? error.message : String(error), 8_000);
          });
        }
        return true;
      },
    });
    this.addCommand({
      id: "rebuild-lineage-canvas",
      name: "从项目笔记重建项目谱系 Canvas",
      callback: () =>
        void this.resolveLineageConflict("projects")
          .then(() => this.openLineageCanvas())
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error))),
    });
    this.addCommand({
      id: "apply-lineage-canvas",
      name: "将项目谱系 Canvas 写回项目父级",
      callback: () =>
        void this.resolveLineageConflict("canvas")
          .then(() => new Notice("项目谱系已写回项目笔记"))
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error))),
    });
    this.addSettingTab(new HelixSettingTab(this.app, this));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.lineageService.consumeSelfWrite(file.path)) return;
        const isCanvas = file.path === normalizePath(this.settings.lineageCanvasPath);
        const wasProject = this.knownProjectPaths.has(normalizePath(file.path));
        const isProject = this.isHelixProjectFile(file);
        if (isProject) this.knownProjectPaths.add(normalizePath(file.path));
        else this.knownProjectPaths.delete(normalizePath(file.path));
        if (isCanvas || isProject || wasProject) this.scheduleLineageSync(isCanvas);
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.lineageService.consumeSelfWrite(file.path)) return;
        const isCanvas = file.path === normalizePath(this.settings.lineageCanvasPath);
        const isProject = this.isHelixProjectFile(file);
        if (isProject) this.knownProjectPaths.add(normalizePath(file.path));
        if (isCanvas || isProject) this.scheduleLineageSync(isCanvas);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        const isCanvas = file.path === normalizePath(this.settings.lineageCanvasPath);
        const normalized = normalizePath(file.path);
        const wasProject = this.knownProjectPaths.delete(normalized);
        if (isCanvas || wasProject || this.isHelixProjectPath(file.path)) {
          this.scheduleLineageSync(isCanvas);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.lineageService.consumeSelfWrite(file.path)) return;
        const canvasPath = normalizePath(this.settings.lineageCanvasPath);
        const touchesCanvas = oldPath === canvasPath || file.path === canvasPath;
        const wasProject = this.knownProjectPaths.delete(normalizePath(oldPath));
        const isProject = this.isHelixProjectFile(file);
        if (isProject) this.knownProjectPaths.add(normalizePath(file.path));
        if (
          touchesCanvas ||
          wasProject ||
          this.isHelixProjectPath(oldPath) ||
          isProject
        ) {
          this.scheduleLineageSync(touchesCanvas);
        }
      }),
    );

    this.refreshAutoSync();
  }

  onunload(): void {
    this.unloaded = true;
    this.pendingLineageCanvas = false;
    this.pendingLineageProjects = false;
    this.lineageTimer.dispose();
    this.lineageService?.dispose();
    this.service?.dispose();
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
      async (title, didaProjectId) => {
        this.assertWritable();
        const now = new Date().toISOString();
        const safeTitle = sanitizeFileName(title);
        const folder = normalizePath(`${this.settings.rootFolder}/Projects/${safeTitle}`);
        const path = `${folder}/Project.md`;
        const cyclePath = `${folder}/Cycle-01.md`;
        assertUniqueDidaProjectMapping(
          this.app.vault.getMarkdownFiles().flatMap((file) => {
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (frontmatter?.["helix-kind"] !== "helix-project") return [];
            return [{
              path: file.path,
              didaProjectId:
                typeof frontmatter["helix-dida-project-id"] === "string"
                  ? frontmatter["helix-dida-project-id"]
                  : undefined,
            }];
          }),
          didaProjectId,
          path,
        );
        let revision = await this.vaultRepository.read(path);
        if (revision) {
          assertExistingProjectIdentity(revision.content, { title, didaProjectId }, path);
        }
        let cycle = await this.vaultRepository.read(cyclePath);
        if (cycle) assertExistingInitialCycleIdentity(cycle.content, cyclePath);
        else {
          cycle = await this.vaultRepository.create(
            cyclePath,
            cycleTemplate({
              id: crypto.randomUUID(),
              projectLink: "[[Project]]",
              sequence: 1,
              startedAt: now,
            }),
          );
        }
        if (!revision) {
          revision = await this.vaultRepository.create(
            path,
            projectTemplate({
              id: crypto.randomUUID(),
              title,
              createdAt: now,
              didaProjectId,
              activeCycleLink: "[[Cycle-01]]",
            }),
          );
        }
        await this.openFile(revision.path);
        this.scheduleLineageSync(false);
        new Notice("项目与首个 Cycle 已创建。请在滴答项目映射后生成任务。");
      },
    ).open();
  }

  showCreateProjectModal(): void {
    this.openProjectModal();
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

  private async openLineageCanvas(): Promise<void> {
    const path = normalizePath(this.settings.lineageCanvasPath);
    if (!(await this.vaultRepository.read(path))) {
      this.assertWritable();
      await this.vaultRepository.create(path, JSON.stringify({ nodes: [], edges: [] }, null, 2));
    }
    await this.openFile(path);
  }

  private async advanceCycle(file: TFile): Promise<void> {
    this.assertWritable();
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const currentStatus = frontmatter?.["helix-status"];
    if (currentStatus !== "active" && currentStatus !== "closed") {
      throw new Error("只有 active 或推进中断后的 closed Cycle 可以推进到下一轮");
    }
    if (!frontmatter) throw new Error("当前 Cycle 缺少 Helix 元数据");
    const sequence = Number(frontmatter["helix-sequence"]);
    const cycleId = String(frontmatter["helix-id"] ?? "");
    if (!Number.isInteger(sequence) || sequence < 1 || !cycleId) {
      throw new Error("当前 Cycle 的 Helix 元数据不完整");
    }
    const folder = file.parent?.path;
    if (!folder) throw new Error("Cycle 必须位于项目文件夹内");
    const nextSequence = sequence + 1;
    const nextName = `Cycle-${String(nextSequence).padStart(2, "0")}.md`;
    const nextPath = normalizePath(`${folder}/${nextName}`);
    const now = String(frontmatter["helix-closed"] ?? new Date().toISOString());
    let nextRevision = await this.vaultRepository.read(nextPath);
    if (nextRevision) {
      assertHelixKind(nextRevision.content, "helix-cycle", nextPath);
      const nextSequenceMatch = /^helix-sequence:\s*(\d+)\s*$/m.exec(nextRevision.content);
      const predecessorMatch = /^helix-predecessor:\s*"?([^"\r\n]+)"?\s*$/m.exec(nextRevision.content);
      if (
        Number(nextSequenceMatch?.[1]) !== nextSequence ||
        predecessorMatch?.[1] !== `[[${file.basename}]]`
      ) {
        throw new Error(`下一轮文件与当前 Cycle 不匹配，拒绝覆盖：${nextPath}`);
      }
    } else {
      nextRevision = await this.vaultRepository.create(
        nextPath,
        cycleTemplate({
          id: crypto.randomUUID(),
          projectLink: String(frontmatter["helix-project"] ?? "[[Project]]"),
          sequence: nextSequence,
          startedAt: now,
          predecessorLink: `[[${file.basename}]]`,
          status: "planned",
        }),
      );
    }
    const current = await this.vaultRepository.read(file.path);
    if (!current) throw new Error("当前 Cycle 在推进过程中被删除");
    if (currentStatus === "active") {
      await this.vaultRepository.compareAndWrite(
        current,
        patchManagedFrontmatter(current.content, {
          "helix-status": "closed",
          "helix-closed": now,
        }),
      );
    }
    const projectPath = normalizePath(`${folder}/Project.md`);
    const project = await this.vaultRepository.read(projectPath);
    if (project) {
      await this.vaultRepository.compareAndWrite(
        project,
        patchManagedFrontmatter(project.content, {
          "helix-active-cycle": `[[${nextName.replace(/\.md$/, "")}]]`,
          "helix-updated": now,
        }),
      );
    }
    const activeNext = /^helix-status:\s*"?active"?\s*$/m.test(nextRevision.content)
      ? nextRevision
      : await this.vaultRepository.compareAndWrite(
          nextRevision,
          patchManagedFrontmatter(nextRevision.content, {
            "helix-status": "active",
          }),
        );
    await this.service.appendLocalEvents([
      {
        id: deterministicEventId({
          type: "cycle-closed",
          entityId: cycleId,
          occurredAt: now,
        }),
        type: "cycle-closed",
        entityId: cycleId,
        occurredAt: now,
      },
    ]);
    await this.openFile(activeNext.path);
    new Notice(`Cycle ${String(sequence).padStart(2, "0")} 已关闭，下一轮已创建`);
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

  private scheduleLineageSync(fromCanvas: boolean): void {
    if (this.recoveryMode) return;
    if (fromCanvas) this.pendingLineageCanvas = true;
    else this.pendingLineageProjects = true;
    this.lineageTimer.schedule(() => {
      if (this.unloaded) return;
      const applyCanvas = this.pendingLineageCanvas;
      const rebuildProjects = this.pendingLineageProjects;
      this.pendingLineageCanvas = false;
      this.pendingLineageProjects = false;
      const operation = async () => {
        const decision = lineageBatchDecision(applyCanvas, rebuildProjects);
        if (decision === "manual-conflict") {
          await this.store.mutate((data) => {
            data.lineageConflict ??= {
              detectedAt: new Date().toISOString(),
              canvasPath: normalizePath(this.settings.lineageCanvasPath),
              kind: "lineage-concurrent",
              message:
                "Canvas 与项目笔记在同一窗口内都被修改。Helix 不会静默选择胜方，请检查两侧后明确选择。",
            };
          });
          await this.service.refreshPersistedEvents();
          new Notice(
            "Canvas 与项目笔记在同一窗口内都被修改，Helix 已暂停谱系同步。请人工选择“将 Canvas 写回项目父级”或“从项目笔记重建 Canvas”。",
            12_000,
          );
          return;
        }
        if ((await this.store.snapshot()).lineageConflict) return;
        if (decision === "apply-canvas") await this.lineageService.applyCanvasToProjects();
        if (decision === "rebuild-canvas") await this.lineageService.rebuildCanvasFromProjects();
        this.knownProjectPaths = new Set(this.lineageService.projectPaths());
      };
      void operation().catch(async (error) => {
        console.error("Helix lineage sync paused", error);
        await this.recordLineageConflict(error, "lineage-write");
        new Notice(
          `Helix 项目谱系同步已暂停：${error instanceof Error ? error.message : String(error)}`,
          10_000,
        );
      });
    }, 750);
  }

  private async resolveLineageConflict(
    choice: "canvas" | "projects",
  ): Promise<void> {
    this.assertWritable();
    try {
      if (choice === "canvas") await this.lineageService.applyCanvasToProjects();
      else await this.lineageService.rebuildCanvasFromProjects();
      this.knownProjectPaths = new Set(this.lineageService.projectPaths());
      await this.store.mutate((data) => {
        delete data.lineageConflict;
      });
      await this.service.refreshPersistedEvents();
    } catch (error) {
      await this.recordLineageConflict(error, "lineage-write");
      throw error;
    }
  }

  private async recordLineageConflict(
    error: unknown,
    kind: "project-integrity" | "lineage-write",
  ): Promise<void> {
    if (this.unloaded) return;
    const message = error instanceof Error ? error.message : String(error);
    await this.store.mutate((data) => {
      data.lineageConflict = {
        detectedAt: new Date().toISOString(),
        canvasPath: normalizePath(this.settings.lineageCanvasPath),
        kind,
        message,
      };
    });
    if (this.service) await this.service.refreshPersistedEvents();
  }

  private isHelixProjectFile(file: { path: string }): boolean {
    if (file instanceof TFile) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter?.["helix-kind"] === "helix-project") return true;
    }
    return this.isHelixProjectPath(file.path);
  }

  private isHelixProjectPath(path: string): boolean {
    const projectsRoot = normalizePath(`${this.settings.rootFolder}/Projects`);
    const normalized = normalizePath(path);
    return normalized.startsWith(`${projectsRoot}/`) && normalized.endsWith("/Project.md");
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

function assertHelixKind(content: string, expected: string, path: string): void {
  const match = /^helix-kind:\s*"?([^"\r\n]+)"?\s*$/m.exec(content);
  if (match?.[1] !== expected) {
    throw new Error(`已有文件不是 ${expected}，拒绝覆盖：${path}`);
  }
}

class ProjectPromptModal extends Modal {
  private title = "";
  private didaProjectId = "";

  constructor(
    app: HelixPlugin["app"],
    private readonly projects: Array<{ id: string; name: string }>,
    private readonly submit: (title: string, didaProjectId?: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("创建 Helix 项目");
    new Setting(this.contentEl)
      .setName("项目名称")
      .setDesc("将创建稳定项目笔记和首个不可变 Cycle。")
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
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "创建项目与 Cycle 01" });
    confirm.addEventListener("click", () => {
      const title = this.title.trim();
      if (!title) {
        new Notice("请输入项目名称");
        return;
      }
      confirm.disabled = true;
      void this.submit(title, this.didaProjectId || undefined)
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

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "未命名项目";
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}
