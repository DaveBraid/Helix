import {
  Modal,
  Notice,
  Plugin,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  type App,
} from "obsidian";
import {
  journalPath,
  journalPeriodBounds,
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
import { TaskReferenceService } from "./services/task-references";
import { SerializedRunner } from "./services/serialized-runner";
import { TaskMatrixRuleUpdater } from "./services/task-view-settings";
import { autoSyncPlan } from "./services/auto-sync";
import type {
  ProjectWorkspaceCycleStatus,
  ProjectWorkspaceCycleStatusUpdatePlan,
  ProjectWorkspaceMigrationItem,
  ProjectWorkspaceProject,
  ProjectWorkspaceProjectStatus,
  ProjectWorkspaceProjectStatusUpdatePlan,
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
import {
  HelixTemplateManager,
} from "./services/template-manager";
import { runTemplateStartup, templateStartupAction } from "./services/template-setup";
import { createJournalDocument } from "./services/journal-creation";
import { configureTemplateSettings } from "./services/template-settings-coordinator";
import { HELIX_VIEW_TYPE, HelixView } from "./ui/helix-view";
import {
  CYCLE_STATUS_OPTIONS,
  PROJECT_STATUS_OPTIONS,
  WorkspaceStatusModal,
} from "./ui/helix-view";
import {
  PROJECT_STATUS_LABELS,
  STAGE_STATUS_LABELS,
} from "./domain/project-status";
import { activeHelixStatusTarget, type ActiveHelixStatusTarget } from "./domain/active-project-status";
import { HelixSettingTab } from "./ui/settings-tab";
import { DidaWriteContractConfirmationGate } from "./ui/dida-write-contract-confirmation";
import { DidaWriteContractCommandController } from "./ui/dida-write-contract-command";
import {
  DidaProjectProjectionService,
  ExistingHelixProjectionCatalogAdapter,
  ExistingHelixTaskPipelineAdapter,
  PersistedProjectionDiagnosticsPort,
  PersistedProjectionStatePort,
  VaultProjectionMarkdownAdapter,
  type ProjectionProjectInput,
  type ProjectionProjectReadModel,
  type ProjectionCatalogSnapshot,
  type ProjectionPersistentState,
  type ProjectionSyncSummary,
} from "./services/dida-project-projection";
import type {
  DidaProjectionTarget,
  ProjectionActivationPreview,
  ProjectionActionState,
  ProjectionColumnCreationPreview,
} from "./domain/dida-project-projection";
import {
  confirmProjectionActivation,
  projectionCounts,
  projectionInputFromProject,
  projectionStageInProject,
} from "./services/dida-project-projection-coordinator";
import { stableHash } from "./domain/stable";
import {
  ProjectAutoSyncCoordinator,
  type ProjectAutoSyncReport,
} from "./services/project-auto-sync";
import { helixMarkerVisibilityExtension } from "./editor/helix-marker-visibility";
import {
  PROJECT_DIDA_PROJECTION_AVAILABLE,
  assertProjectDidaProjectionAvailable,
} from "./release-capabilities";

export default class HelixPlugin extends Plugin {
  settings: HelixSettings = {
    ...DEFAULT_SETTINGS,
    taskMatrixRules: { ...DEFAULT_SETTINGS.taskMatrixRules },
  };
  store!: HelixDataStore;
  secrets!: HelixSecretStore;
  service!: HelixService;
  vaultRepository!: HelixVaultRepository;
  templateManager!: HelixTemplateManager;
  projectWorkspace!: ProjectWorkspaceService;
  taskReferences!: TaskReferenceService;
  projectProjection!: DidaProjectProjectionService;
  private projectAutoSync!: ProjectAutoSyncCoordinator;
  /** 设置页和命令面板使用同一确认规则，但绝不允许跨入口确认。 */
  readonly didaWriteContractSettingsConfirmation = new DidaWriteContractConfirmationGate();
  private readonly didaWriteContractCommandConfirmation = new DidaWriteContractConfirmationGate();
  private readonly didaContractAdoptConfirmation = new DidaWriteContractConfirmationGate();
  private didaWriteContractCommands!: DidaWriteContractCommandController;
  private syncIntervalId: number | null = null;
  private immediateSyncTimerId: number | null = null;
  private unloaded = false;
  private recoveryMode = false;
  private dataGeneration!: DataGeneration;
  private projectRefreshTimer: number | null = null;
  private projectMutationDepth = 0;
  private projectRefreshPending = false;
  private projectCanvasRefreshPending = false;
  private readonly projectMarkdownRefreshPaths = new Set<string>();
  private readonly projectIdentityProbeTimers = new Map<string, number>();
  private readonly projectMutationRunner = new SerializedRunner();
  private readonly settingsMutationRunner = new SerializedRunner();
  private readonly taskMatrixRuleUpdater = new TaskMatrixRuleUpdater(this.settingsMutationRunner);
  private projectStatusItem: HTMLElement | null = null;

  async onload(): Promise<void> {
    this.unloaded = false;
    this.dataGeneration = beginDataGeneration();
    this.store = new HelixDataStore(this, this.dataGeneration);
    this.secrets = new HelixSecretStore(this.app);
    const data = await this.store.load();
    this.settings = data.settings;
    const transactionRoot = normalizePath(`${this.settings.rootFolder}/.transactions`);
    this.vaultRepository = new HelixVaultRepository(this.app.vault, [
      normalizePath(`${transactionRoot}/stage-delete.json`),
      normalizePath(`${transactionRoot}/workspace-history.json`),
      normalizePath(`${transactionRoot}/stage-focus-bridge.json`),
    ]);
    this.templateManager = new HelixTemplateManager(
      this.vaultRepository,
      () => this.settings.templateFolder,
      () => this.settings.templateSetupCompleted,
    );
    this.projectWorkspace = new ProjectWorkspaceService(
      this.app,
      this.vaultRepository,
      () => this.settings.rootFolder,
      () => this.settings.lineageCanvasPath,
      (requests) => this.templateManager.renderMany(requests),
    );
    this.taskReferences = new TaskReferenceService(
      this.app,
      this.vaultRepository,
      this.projectWorkspace,
      () => this.settings.rootFolder,
    );
    this.recoveryMode = data.recoveryIssues.length > 0;
    if (this.recoveryMode) {
      this.projectWorkspace.freezePendingStageDeletion(
        "Helix 处于只读恢复模式，阶段删除事务不会自动执行，项目写入已冻结；请处理冲突中心列出的恢复问题",
      );
    } else {
      try {
        const restoredClaims =
          await this.vaultRepository.recoverDeletionClaims(this.settings.rootFolder);
        if (restoredClaims.length > 0) {
          new Notice(`Helix 已恢复 ${restoredClaims.length} 个中断的文件删除认领`);
        }
        const historyRecovered =
          await this.projectWorkspace.recoverPendingWorkspaceHistory();
        if (historyRecovered !== "none") {
          new Notice(`Helix 已恢复未完成的图谱撤销事务：${historyRecovered}`);
        }
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
      if (templateStartupAction(this.recoveryMode, this.settings.templateSetupCompleted) === "ensure-existing") {
        try {
          await runTemplateStartup("ensure-existing", this.templateManager);
        } catch (error) {
          new Notice(`Helix 默认模板未完全补齐：${error instanceof Error ? error.message : String(error)}`, 10_000);
        }
      }
    }
    if (!this.recoveryMode) {
      try {
        await this.projectWorkspace.initializeFocusBridgeState();
      } catch (error) {
        const message = `Helix 阶段聚焦桥接需要人工检查：${
          error instanceof Error ? error.message : String(error)}`;
        await this.enterProjectRecoveryMode(message);
        new Notice(message, 0);
      }
    }
    this.service = new HelixService(this.store, this.secrets);
    await this.service.initialize();
    this.projectProjection = new DidaProjectProjectionService(
      new VaultProjectionMarkdownAdapter(this.vaultRepository),
      new ExistingHelixTaskPipelineAdapter(this.service),
      new PersistedProjectionStatePort(this.store),
      new ExistingHelixProjectionCatalogAdapter(this.service),
      () => new Date().toISOString(),
      new PersistedProjectionDiagnosticsPort(this.store),
    );
    this.projectAutoSync = new ProjectAutoSyncCoordinator({
      scan: () => this.projectAutoSyncScan(),
      synchronize: (projectId) => this.syncProjectProjection(projectId),
      report: (report) => this.reportProjectAutoSync(report),
    });
    const projectionReadinessRunner = new SerializedRunner();
    this.register(this.service.subscribe(() => {
      void projectionReadinessRunner.run(async () => {
        const readiness = await this.service.projectProjectionWriteReadiness();
        this.projectAutoSync.updateReadiness(
          PROJECT_DIDA_PROJECTION_AVAILABLE && readiness.ready,
        );
      }).catch((error) => console.warn("Helix 无法刷新滴答项目后台写入条件", error));
    }));
    await this.projectProjection.retryReceiptCleanup();
    this.registerEditorExtension(helixMarkerVisibilityExtension);
    if (templateStartupAction(this.recoveryMode, this.settings.templateSetupCompleted) === "prompt") {
      this.showInitialTemplateFolderPrompt();
    }
    this.didaWriteContractCommands = new DidaWriteContractCommandController(
      this.didaWriteContractCommandConfirmation,
      {
        runtimeSummary: () => this.service.didaWriteContractRuntimeSummary(),
        run: () => this.service.runDidaWriteContractTest(),
        notice: (message, timeout) => new Notice(message, timeout),
      },
    );
    if (!this.recoveryMode) await this.recoverClosedReviewEvents();

    this.registerView(
      HELIX_VIEW_TYPE,
      (leaf) => new HelixView(leaf, this.service, this.store, {
        openReview: (period) => this.openJournal(period),
        createProject: (onCreated) => this.showCreateProjectModal(onCreated),
        createCycle: (projectId, sourceCycleIds, onCreated) =>
          this.showCreateCycleModal(projectId, sourceCycleIds, onCreated),
        deleteCycle: (cycleId, onDeleted) => this.showDeleteCycleModal(cycleId, onDeleted),
        manageRelation: (relationId, onChanged) =>
          this.showManageRelationModal(relationId, onChanged),
        openProjectFile: (path) => this.openFile(path),
        projectWorkspace: this.projectWorkspace,
        taskReferences: this.taskReferences,
        readProjectWorkspace: (operation) => this.withProjectWorkspaceRead(operation),
        mutateProjectWorkspace: (operation) => this.withWritableProjectMutation(operation),
        repairProjectCanvas: () => this.repairProjectCanvas(),
        updateProjectStatus: (plan, status) => this.updateProjectStatus(plan, status),
        updateCycleStatus: (plan, status) => this.updateCycleStatus(plan, status),
        reviewLegacyMigration: () => this.showLegacyMigrationModal(),
        getTaskMatrixRules: () => ({ ...this.settings.taskMatrixRules }),
        updateTaskMatrixRules: (rules) => this.updateTaskMatrixRules(rules),
        readProjectProjection: (projectId) => this.readProjectProjection(projectId),
        reconcileProjectProjectionFrozen: (input) => this.reconcileProjectProjectionFrozen(input),
        recoverPendingProjectProjectionReceiptCleanup: () =>
          this.recoverPendingProjectProjectionReceiptCleanup(),
        removeResolvedProjectProjectionReceipt: (operationId) =>
          this.removeResolvedProjectProjectionReceipt(operationId),
        reconcileProjectProjectionColumn: async () => {
          await this.reconcileProjectProjectionColumn();
        },
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
      id: "show-dida-write-contract-status",
      name: "显示滴答写入合同状态",
      callback: () => this.didaWriteContractCommands.showStatus(),
    });
    this.addCommand({
      id: "run-dida-write-contract-test",
      name: "运行滴答写入合同测试",
      callback: () => this.didaWriteContractCommands.requestRun(),
    });
    this.addCommand({
      id: "strict-adopt-dida-contract-residual",
      name: "严格检查并领养滴答合同残留",
      callback: () => {
        if (this.didaContractAdoptConfirmation.request() === "armed") {
          new Notice("已武装：请在 15 秒内再次运行此命令，才会严格检查并领养唯一测试组。", 10_000);
          return;
        }
        void this.service.adoptPendingContractRunFromRemote()
          .then(() => new Notice("合同残留严格检查已完成；如已领养，请到冲突中心继续安全清理。", 10_000))
          .catch(() => new Notice("安全操作未完成；对象保持冻结，请查看脱敏诊断", 8_000));
      },
    });
    this.addCommand({
      id: "create-project",
      name: "创建项目",
      callback: () => this.openProjectModal(),
    });
    this.addCommand({
      id: "edit-active-project-or-stage-status",
      name: "修改当前 Helix 项目或阶段状态",
      checkCallback: (checking) => {
        const available = this.activeHelixStatusTarget() !== null;
        if (!checking && available) void this.openActiveHelixStatusModal();
        return available;
      },
    });
    this.addCommand({
      id: "undo-project-workspace",
      name: "撤销上一次项目图谱操作",
      checkCallback: (checking) => {
        const available = this.projectWorkspace.historyState().undoCount > 0;
        if (!checking && available) {
          void this.withWritableProjectMutation(() =>
            this.projectWorkspace.undoLastWorkspaceChange())
            .then(() => this.service.refreshPersistedEvents())
            .catch((error) =>
              new Notice(error instanceof Error ? error.message : String(error), 8_000));
        }
        return available;
      },
    });
    this.addCommand({
      id: "redo-project-workspace",
      name: "重做上一次项目图谱操作",
      checkCallback: (checking) => {
        const available = this.projectWorkspace.historyState().redoCount > 0;
        if (!checking && available) {
          void this.withWritableProjectMutation(() =>
            this.projectWorkspace.redoLastWorkspaceChange())
            .then(() => this.service.refreshPersistedEvents())
            .catch((error) =>
              new Notice(error instanceof Error ? error.message : String(error), 8_000));
        }
        return available;
      },
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
        this.refreshActiveStatusForPaths(file.path);
        if (this.isProjectWorkspaceFile(file.path)) {
          this.scheduleProjectRefresh(file.path);
          return;
        }
        if (this.taskReferences.isKnownTaskReferencePath(file.path)) {
          this.scheduleProjectRefresh();
          return;
        }
        this.scheduleProjectIdentityProbe(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.refreshActiveStatusForPaths(file.path);
        if (this.isProjectWorkspaceFile(file.path)) {
          this.scheduleProjectRefresh(file.path);
          return;
        }
        if (this.taskReferences.isKnownTaskReferencePath(file.path)) {
          this.scheduleProjectRefresh();
          return;
        }
        this.scheduleProjectIdentityProbe(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.refreshActiveStatusForPaths(file.path);
        if (
          this.isProjectWorkspaceFile(file.path) ||
          this.taskReferences.isKnownTaskReferencePath(file.path)
        ) {
          this.scheduleProjectRefresh(file.path);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.refreshActiveStatusForPaths(file.path, oldPath);
        if (
          this.isProjectWorkspaceFile(file.path) ||
          this.isProjectWorkspaceFile(oldPath)
        ) {
          this.scheduleProjectRefresh(
            this.isProjectWorkspaceFile(file.path) ? file.path : oldPath,
          );
          return;
        }
        if (
          this.taskReferences.isKnownTaskReferencePath(file.path) ||
          this.taskReferences.isKnownTaskReferencePath(oldPath)
        ) {
          this.scheduleProjectRefresh();
          return;
        }
        this.scheduleProjectIdentityProbe(file.path);
      }),
    );
    this.projectStatusItem = this.addStatusBarItem();
    this.projectStatusItem.addClass("helix-active-status-control");
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      void this.refreshActiveHelixStatusControl();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      void this.refreshActiveHelixStatusControl();
    }));
    void this.refreshActiveHelixStatusControl();

    this.refreshAutoSync(this.settings.autoSync);
    // 重启后从 Markdown/Canvas 权威源重扫；队列与写门仍由既有同步管线负责。
    this.projectAutoSync.request();
  }

  private activeHelixStatusTarget(): ActiveHelixStatusTarget | null {
    const file = this.app.workspace.getActiveFile();
    const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    return activeHelixStatusTarget(frontmatter, file?.basename);
  }

  private refreshActiveStatusForPaths(...paths: string[]): void {
    const activePath = this.app.workspace.getActiveFile()?.path;
    if (activePath && paths.includes(activePath)) {
      void this.refreshActiveHelixStatusControl();
    }
  }

  private async refreshActiveHelixStatusControl(): Promise<void> {
    const item = this.projectStatusItem;
    if (!item) return;
    item.empty();
    item.onclick = null;
    item.onkeydown = null;
    item.removeAttribute("role");
    item.removeAttribute("tabindex");
    item.removeAttribute("title");
    const file = this.app.workspace.getActiveFile();
    const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const target = this.activeHelixStatusTarget();
    if (!target) {
      if (file && (frontmatter?.["helix-kind"] === "helix-project" ||
        frontmatter?.["helix-kind"] === "helix-stage" || frontmatter?.["helix-kind"] === "helix-cycle")) {
        item.setText("Helix · 状态异常");
        item.setAttribute("aria-label", "Helix 状态异常，请在属性中修正；不会自动写入");
        item.setAttribute("title", "状态异常，请在属性中修正；Helix 不会自动写入");
        item.show();
      } else item.hide();
      return;
    }
    item.show();
    const label = target.kind === "project"
      ? PROJECT_STATUS_LABELS[target.status as keyof typeof PROJECT_STATUS_LABELS]
      : STAGE_STATUS_LABELS[target.status as keyof typeof STAGE_STATUS_LABELS];
    item.setText(`Helix · ${target.kind === "project" ? "项目" : "阶段"}：${label}`);
    item.setAttribute("aria-label", `修改当前 ${target.kind === "project" ? "项目" : "阶段"}状态`);
    item.setAttribute("title", "点击或按 Enter/Space 修改状态");
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.onclick = () => void this.openActiveHelixStatusModal();
    item.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void this.openActiveHelixStatusModal();
    };
  }

  private async openActiveHelixStatusModal(): Promise<void> {
    const target = this.activeHelixStatusTarget();
    if (!target) return;
    try {
      if (target.kind === "project") {
        const plan = await this.projectWorkspace.prepareProjectStatusUpdate(target.id);
        new WorkspaceStatusModal(this.app, "修改项目状态", target.title, plan.currentStatus,
          PROJECT_STATUS_OPTIONS, async (status) => {
            await this.updateProjectStatus(plan, status);
            await this.refreshActiveHelixStatusControl();
          }).open();
      } else {
        const plan = await this.projectWorkspace.prepareCycleStatusUpdate(target.id);
        new WorkspaceStatusModal(this.app, "修改阶段状态", target.title, plan.currentStatus,
          CYCLE_STATUS_OPTIONS, async (status) => {
            await this.updateCycleStatus(plan, status);
            await this.refreshActiveHelixStatusControl();
          }).open();
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8_000);
    }
  }

  onunload(): void {
    this.unloaded = true;
    this.didaWriteContractSettingsConfirmation.disarm();
    this.didaContractAdoptConfirmation.disarm();
    this.didaWriteContractCommands?.dispose();
    this.projectAutoSync?.dispose();
    if (this.projectRefreshTimer !== null) {
      window.clearTimeout(this.projectRefreshTimer);
      this.projectRefreshTimer = null;
    }
    for (const timer of this.projectIdentityProbeTimers.values()) {
      window.clearTimeout(timer);
    }
    this.projectIdentityProbeTimers.clear();
    this.service?.dispose();
    this.projectWorkspace?.dispose();
    if (this.dataGeneration) invalidateDataGeneration(this.dataGeneration);
    this.store?.dispose();
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.immediateSyncTimerId !== null) {
      window.clearTimeout(this.immediateSyncTimerId);
      this.immediateSyncTimerId = null;
    }
    this.app.workspace.detachLeavesOfType(HELIX_VIEW_TYPE);
  }

  async saveSettings(runImmediately = false): Promise<void> {
    await this.settingsMutationRunner.run(() => {
      const snapshot = this.settingsSnapshot();
      return this.store.mutate((data) => {
        data.settings = snapshot;
      });
    });
    this.refreshAutoSync(runImmediately);
  }

  async readProjectProjection(projectId: string): Promise<ProjectionProjectReadModel> {
    return this.withProjectWorkspaceRead(async () =>
      this.projectProjection.readProject(await this.projectionInput(projectId)));
  }

  async readProjectProjectionConfiguration(): Promise<ProjectionPersistentState> {
    return this.withProjectWorkspaceRead(() => this.projectProjection.readConfiguration());
  }

  async readProjectProjectionCatalog(): Promise<ProjectionCatalogSnapshot[]> {
    const projectIds = [...new Set(this.service.snapshot().projects
      .map((project) => project.id)
      .filter((id) => !id.startsWith("local-project-")))];
    return Promise.all(projectIds.map((projectId) => this.service.readProjectionCatalog(projectId)));
  }

  async previewProjectProjection(target: DidaProjectionTarget): Promise<ProjectionActivationPreview> {
    this.assertProjectProjectionAvailable();
    return this.withProjectWorkspaceRead(async () => {
      const snapshot = await this.projectWorkspace.snapshot();
      const counts = await projectionCounts(snapshot, this.projectProjection);
      return this.projectProjection.previewActivation(target, counts);
    });
  }

  async confirmProjectProjection(
    preview: ProjectionActivationPreview,
    confirmedHash: string,
  ): Promise<void> {
    this.assertProjectProjectionAvailable();
    await this.withWritableProjectMutation(async () => {
      const snapshot = await this.projectWorkspace.snapshot();
      await confirmProjectionActivation(snapshot, this.projectProjection, preview, confirmedHash);
    });
    this.projectAutoSync.request(true);
  }

  async disableProjectProjection(): Promise<void> {
    await this.withWritableProjectMutation(() => this.projectProjection.disable());
  }

  previewProjectProjectionColumn(projectId: string): Promise<ProjectionColumnCreationPreview> {
    this.assertProjectProjectionAvailable();
    return this.service.previewProjectionColumnCreation(projectId);
  }

  confirmProjectProjectionColumn(
    preview: ProjectionColumnCreationPreview,
    confirmedHash: string,
  ) {
    this.assertProjectProjectionAvailable();
    return this.service.confirmProjectionColumnCreation(preview, confirmedHash);
  }

  reconcileProjectProjectionColumn() {
    this.assertProjectProjectionAvailable();
    return this.service.reconcileProjectionColumnCreation();
  }

  async adoptProjectAction(input: {
    projectId: string;
    stageId: string;
    expectedHash: string;
    line: number;
  }): Promise<void> {
    await this.withWritableProjectMutation(async () => {
      const stage = await this.requireProjectionStage(input.projectId, input.stageId);
      await this.projectProjection.adoptAction({
        stagePath: stage.notePath,
        expectedStageId: stage.id,
        expectedHash: input.expectedHash,
        line: input.line,
      });
    });
    this.projectAutoSync.request();
  }

  async editProjectAction(input: {
    projectId: string;
    stageId: string;
    expectedHash: string;
    uuid: string;
    title?: string;
    state?: ProjectionActionState;
  }): Promise<void> {
    await this.withWritableProjectMutation(async () => {
      const stage = await this.requireProjectionStage(input.projectId, input.stageId);
      await this.projectProjection.editAction({
        stagePath: stage.notePath,
        expectedStageId: stage.id,
        expectedHash: input.expectedHash,
        uuid: input.uuid,
        title: input.title,
        state: input.state,
      });
    });
    this.projectAutoSync.request();
  }

  async reconcileProjectProjectionFrozen(input:
    | { kind: "action"; projectId: string; stageId: string; uuid: string }
    | { kind: "parent"; projectId: string }): Promise<void> {
    this.assertProjectProjectionAvailable();
    await this.withWritableProjectMutation(async () => {
      const projectionInput = await this.projectionInput(input.projectId);
      if (input.kind === "action") {
        const stage = await this.requireProjectionStage(input.projectId, input.stageId);
        await this.projectProjection.reconcileFrozen({
          kind: "action",
          projectId: input.projectId,
          stageId: stage.id,
          stagePath: stage.notePath,
          uuid: input.uuid,
        });
      } else {
        await this.projectProjection.reconcileFrozen({
          kind: "parent",
          projectId: input.projectId,
          projectPath: projectionInput.projectPath,
          title: projectionInput.projectTitle,
          status: projectionInput.projectStatus,
        });
      }
    });
    this.projectAutoSync.invalidate(input.projectId);
  }

  async removeResolvedProjectProjectionReceipt(operationId: string): Promise<void> {
    await this.withWritableProjectMutation(() =>
      this.projectProjection.removeResolvedReceipt(operationId));
  }

  async recoverPendingProjectProjectionReceiptCleanup(): Promise<void> {
    await this.withWritableProjectMutation(() => this.projectProjection.retryReceiptCleanup());
    this.projectAutoSync.invalidate();
  }

  async syncProjectProjection(projectId: string): Promise<ProjectionSyncSummary> {
    this.assertProjectProjectionAvailable();
    return this.withWritableProjectMutation(async () =>
      this.projectProjection.synchronizeProject(await this.projectionInput(projectId)));
  }

  private async projectAutoSyncScan() {
    if (!PROJECT_DIDA_PROJECTION_AVAILABLE) return { candidates: [], failures: [] };
    return this.withProjectWorkspaceRead(async () => {
      const configuration = await this.projectProjection.readConfiguration();
      if (!configuration.enabled || !configuration.target || !configuration.confirmedPreviewHash) {
        return { candidates: [], failures: [] };
      }
      const snapshot = await this.projectWorkspace.snapshot();
      const candidates = [];
      const failures = [];
      for (const project of snapshot.projects) {
        const input = projectionInputFromProject(project);
        const fallbackFingerprint = stableHash(input);
        try {
          const model = await this.projectProjection.readProject(input);
          candidates.push({
            projectId: project.id,
            fingerprint: stableHash({
              project: model.project,
              stages: model.stages.map((stage) => ({
                id: stage.id,
                path: stage.path,
                revisionHash: stage.revisionHash,
              })),
            }),
          });
        } catch {
          failures.push({ projectId: project.id, fingerprint: fallbackFingerprint });
        }
      }
      return { candidates, failures };
    });
  }

  private reportProjectAutoSync(report: ProjectAutoSyncReport): void {
    if (this.unloaded) return;
    if (report.failed > 0) {
      new Notice(`滴答项目后台同步：暂缓 ${report.blocked} 项，失败 ${report.failed} 项；请查看冲突中心`, 10_000);
      return;
    }
    if (report.blocked > 0) {
      const frozen = report.frozen > 0 ? `（冻结 ${report.frozen} 个对象）` : "";
      new Notice(`滴答项目同步暂缓 ${report.blocked} 项${frozen}；请查看冲突中心或同步设置`, 10_000);
      return;
    }
  }

  private async projectionInput(projectId: string): Promise<ProjectionProjectInput> {
    const snapshot = await this.projectWorkspace.snapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("找不到要同步到滴答的 Helix 项目");
    return projectionInputFromProject(project);
  }

  private async requireProjectionStage(projectId: string, stageId: string) {
    const snapshot = await this.projectWorkspace.snapshot();
    return projectionStageInProject(snapshot, projectId, stageId);
  }

  private assertProjectProjectionAvailable(): void {
    assertProjectDidaProjectionAvailable();
  }

  async saveTemplateFolderAndEnsure(folder: string): Promise<string[]> {
    this.assertWritable();
    return configureTemplateSettings({
      recoveryMode: this.recoveryMode,
      folder,
      manager: this.templateManager,
      persist: async (candidate) => {
        let committed!: HelixSettings;
        await this.settingsMutationRunner.run(() => {
          return this.store.mutate((data) => {
            committed = {
              ...data.settings,
              taskMatrixRules: { ...data.settings.taskMatrixRules },
              templateFolder: candidate,
              templateSetupCompleted: true,
            };
            data.settings = committed;
          });
        });
        return committed;
      },
      publish: (next) => {
        this.settings.templateFolder = next.templateFolder;
        this.settings.templateSetupCompleted = next.templateSetupCompleted;
      },
    });
  }

  private showInitialTemplateFolderPrompt(): void {
    new TemplateFolderSetupModal(this.app, this.settings.templateFolder, async (folder) => {
      const created = await this.saveTemplateFolderAndEnsure(folder);
      new Notice(created.length > 0 ? `已创建 ${created.length} 份 Helix 默认模板` : "Helix 默认模板已就绪");
    }).open();
  }

  private async updateTaskMatrixRules(rules: HelixSettings["taskMatrixRules"]): Promise<void> {
    await this.taskMatrixRuleUpdater.update(
      rules,
      async (snapshot) => {
        const settings = {
          ...this.settingsSnapshot(),
          taskMatrixRules: { ...snapshot },
        };
        await this.store.mutate((data) => {
          data.settings = settings;
        });
      },
      (snapshot) => {
        this.settings.taskMatrixRules = { ...snapshot };
      },
    );
  }

  private settingsSnapshot(): HelixSettings {
    return {
      ...this.settings,
      taskMatrixRules: { ...this.settings.taskMatrixRules },
    };
  }

  refreshAutoSync(runImmediately = false): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.immediateSyncTimerId !== null) {
      window.clearTimeout(this.immediateSyncTimerId);
      this.immediateSyncTimerId = null;
    }
    const plan = autoSyncPlan({
      recoveryMode: this.recoveryMode,
      tokenConfigured: Boolean(this.secrets.getDidaToken()),
      autoSync: this.settings.autoSync,
      runImmediately,
      intervalMinutes: this.settings.syncIntervalMinutes,
    });
    if (plan.runImmediately) {
      this.immediateSyncTimerId = window.setTimeout(
        () => {
          this.immediateSyncTimerId = null;
          if (this.unloaded || this.recoveryMode || !this.secrets.getDidaToken()) return;
          void this.service.sync().catch((error) => this.service.notifySyncError(error));
        },
        0,
      );
    }
    if (plan.intervalMs === null) return;
    this.syncIntervalId = window.setInterval(
      () => void this.service.sync().catch((error) => this.service.notifySyncError(error)),
      plan.intervalMs,
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

  private openProjectModal(onCreated?: (projectId: string) => void): void {
    if (this.recoveryMode) {
      new Notice("Helix 当前处于只读恢复模式，处理冲突中心列出的恢复问题前不能创建项目", 8_000);
      return;
    }
    new ProjectPromptModal(
      this.app,
      async (title, color) => {
        this.assertWritable();
        const created = await this.withWritableProjectMutation(() =>
          this.projectWorkspace.createProject(title, undefined, color));
        onCreated?.(created.id);
        await this.service.refreshPersistedEvents();
        new Notice("项目和阶段 1 已加入当前工作区");
      },
    ).open();
  }

  showCreateProjectModal(onCreated?: (projectId: string) => void): void {
    this.openProjectModal(onCreated);
  }

  private showCreateCycleModal(
    projectId: string,
    sourceCycleIds: string[],
    onCreated?: (cycleId: string) => void,
  ): void {
    if (this.recoveryMode) {
      new Notice("Helix 当前处于只读恢复模式，处理冲突中心列出的恢复问题前不能创建阶段", 8_000);
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
            const created = await this.withWritableProjectMutation(() =>
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
            onCreated?.(created.id);
            await this.service.refreshPersistedEvents();
            new Notice(`${CYCLE_RELATION_LABELS[intent.relation]}阶段已加入当前工作区`);
          },
        ).open();
      })
      .catch((error) => {
        new Notice(error instanceof Error ? error.message : String(error), 8_000);
      });
  }

  private showDeleteCycleModal(
    cycleId: string,
    onDeleted?: (focusEntityId: string) => void,
  ): void {
    if (this.recoveryMode) {
      new Notice("Helix 当前处于只读恢复模式，处理冲突中心列出的恢复问题前不能删除阶段", 8_000);
      return;
    }
    void this.withProjectWorkspaceRead(async () => {
      const snapshot = await this.projectWorkspace.snapshot();
      const plan = await this.projectWorkspace.planCycleDeletion(cycleId);
      return [snapshot, plan] as const;
    })
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
            await this.withWritableProjectMutation(() =>
              this.projectWorkspace.deleteCycle(plan, {
                bridge,
                confirmCrossProject,
              }));
            const focusEntityId = snapshot.relations
              .filter((relation) =>
                relation.fromCycleIds.includes(cycleId) ||
                relation.toCycleId === cycleId)
              .flatMap((relation) => [
                ...(relation.toCycleId === cycleId ? relation.fromCycleIds : []),
                ...(relation.fromCycleIds.includes(cycleId)
                  ? [relation.toCycleId]
                  : []),
              ])
              .find((candidate) => candidate !== cycleId) ?? owner.id;
            onDeleted?.(focusEntityId);
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

  private showManageRelationModal(
    relationId: string,
    onChanged?: (focusEntityId: string) => void,
  ): void {
    if (this.recoveryMode) {
      new Notice("Helix 当前处于只读恢复模式，处理冲突中心列出的恢复问题前不能修改关系", 8_000);
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
            await this.withWritableProjectMutation(() =>
              this.projectWorkspace.replaceRelation(
                relation.id,
                kind,
                predecessorIds,
                { confirmCrossProject: crossProjectConfirmed },
              ));
            onChanged?.(relation.toCycleId);
            new Notice("阶段关系已更新");
          },
          async () => {
            this.assertWritable();
            await this.withWritableProjectMutation(() =>
              this.projectWorkspace.deleteRelation(relation.id));
            onChanged?.(relation.toCycleId);
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
            await this.withWritableProjectMutation(() =>
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
      const content = await createJournalDocument({
        period,
        title: names[period],
        periodStart: bounds.start,
        periodEnd: bounds.end,
        generatedSummary,
        renderTemplate: (kind, values) => this.templateManager.render(kind, values),
      });
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

  private scheduleProjectRefresh(changedPath?: string): void {
    if (this.unloaded) return;
    if (changedPath && changedPath.endsWith(".md")) {
      this.projectMarkdownRefreshPaths.add(normalizePath(changedPath));
    }
    if (
      changedPath &&
      normalizePath(changedPath) === normalizePath(this.settings.lineageCanvasPath)
    ) {
      this.projectCanvasRefreshPending = true;
    }
    if (this.projectMutationDepth > 0) {
      this.projectRefreshPending = true;
      return;
    }
    if (this.projectRefreshTimer !== null) {
      window.clearTimeout(this.projectRefreshTimer);
    }
    this.projectRefreshTimer = window.setTimeout(() => {
      this.projectRefreshTimer = null;
      if (this.unloaded) return;
      const observeCanvas = this.projectCanvasRefreshPending;
      this.projectCanvasRefreshPending = false;
      const markdownPaths = [...this.projectMarkdownRefreshPaths];
      this.projectMarkdownRefreshPaths.clear();
      void this.projectMutationRunner.run(async () => {
        if (observeCanvas) await this.projectWorkspace.observeCanvasChange();
        if (!this.recoveryMode && markdownPaths.length > 0) {
          await this.projectWorkspace.observeFocusBridgeChanges(markdownPaths);
        }
        await this.service.refreshPersistedEvents();
        this.projectAutoSync.request();
      }).catch(async (error) => {
        const recoveryIssue = this.projectWorkspace.recoveryIssueMessage();
        const message = error instanceof Error ? error.message : String(error);
        if (recoveryIssue) {
          await this.enterProjectRecoveryMode(`Helix 项目工作区需要人工检查：${recoveryIssue}`);
        }
        new Notice(message, recoveryIssue ? 0 : 8_000);
      });
    }, 200);
  }

  private scheduleProjectIdentityProbe(path: string): void {
    if (this.unloaded || !path.endsWith(".md")) return;
    const normalized = normalizePath(path);
    const existing = this.projectIdentityProbeTimers.get(normalized);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.projectIdentityProbeTimers.delete(normalized);
      if (this.unloaded || this.isProjectWorkspaceFile(normalized)) return;
      void Promise.all([
        this.projectWorkspace.hasProjectWorkspaceIdentity(normalized),
        this.taskReferences.hasTaskReferenceIdentity(normalized),
      ])
        .then(([isProjectWorkspaceMarkdown, isTaskReferenceMarkdown]) => {
          if (isProjectWorkspaceMarkdown || isTaskReferenceMarkdown) {
            this.scheduleProjectRefresh(normalized);
          }
        })
        .catch((error) => {
          console.warn("Helix 无法检查 Markdown 的项目身份", error);
        });
    }, 120);
    this.projectIdentityProbeTimers.set(normalized, timer);
  }

  private async withProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.projectMutationRunner.run(async () => {
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
    });
  }

  private async withProjectWorkspaceRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.projectMutationRunner.run(operation);
  }

  private async withWritableProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertWritable();
    return this.withProjectMutation(operation);
  }

  private async repairProjectCanvas(): Promise<void> {
    await this.withWritableProjectMutation(() => this.projectWorkspace.ensureCanvas());
  }

  private async updateProjectStatus(
    plan: ProjectWorkspaceProjectStatusUpdatePlan,
    status: ProjectWorkspaceProjectStatus,
  ): Promise<void> {
    await this.withWritableProjectMutation(() => this.projectWorkspace.updateProjectStatus(plan, status));
  }

  private async updateCycleStatus(
    plan: ProjectWorkspaceCycleStatusUpdatePlan,
    status: ProjectWorkspaceCycleStatus,
  ): Promise<void> {
    await this.withWritableProjectMutation(() => this.projectWorkspace.updateCycleStatus(plan, status));
  }

  private isProjectWorkspaceFile(path: string): boolean {
    const projectsRoot = normalizePath(`${this.settings.rootFolder}/Projects`);
    const normalized = normalizePath(path);
    return (
      normalized === normalizePath(this.settings.lineageCanvasPath) ||
      this.projectWorkspace?.isKnownProjectMarkdownPath(normalized) ||
      (
        normalized.startsWith(`${projectsRoot}/`) &&
        normalized.endsWith(".md")
      )
    );
  }

  private assertWritable(): void {
    if (this.recoveryMode) {
      throw new Error("Helix 当前处于只读恢复模式，处理冲突中心列出的恢复问题前不能写入");
    }
    if (this.unloaded) throw new Error("Helix 已卸载，写入已取消");
  }

  private async enterProjectRecoveryMode(message: string): Promise<void> {
    this.projectWorkspace.freezePendingStageDeletion(message);
    this.recoveryMode = true;
    try {
      await this.store.mutate((draft) => {
        if (!draft.recoveryIssues.includes(message)) draft.recoveryIssues.push(message);
      });
      this.service?.reportRecoveryIssue(message);
    } catch (persistError) {
      new Notice(`Helix 无法持久化恢复问题：${
        persistError instanceof Error ? persistError.message : String(persistError)}`, 0);
    }
  }

  private async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`无法打开文件：${path}`);
    const leaf: WorkspaceLeaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
  }
}

class TemplateFolderSetupModal extends Modal {
  private folder: string;

  constructor(
    app: App,
    initialFolder: string,
    private readonly submit: (folder: string) => Promise<void>,
  ) {
    super(app);
    this.folder = initialFolder;
  }

  onOpen(): void {
    this.setTitle("设置 Helix 模板目录");
    this.contentEl.createEl("p", {
      text: "Helix 首次使用需要创建项目、阶段和四种复盘模板。默认目录为 Template，实际文件只会创建在 Template/Helix/ 下；已有同名文件绝不覆盖。",
    });
    new Setting(this.contentEl)
      .setName("模板目录")
      .setDesc("Vault 内相对路径，例如 Template；不能包含 .. 或绝对路径。")
      .addText((text) => text.setValue(this.folder).onChange((value) => { this.folder = value; }));
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "创建默认模板" });
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      void this.submit(this.folder)
        .then(() => this.close())
        .catch((error) => {
          confirm.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    });
  }

  onClose(): void { this.contentEl.empty(); }
}

class ProjectPromptModal extends Modal {
  private title = "";
  private color = "#5870A8";

  constructor(
    app: HelixPlugin["app"],
    private readonly submit: (
      title: string,
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
      void this.submit(title, this.color)
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
