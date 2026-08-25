import {
  Modal,
  MarkdownView,
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
  patchJournalSummary,
} from "./domain/journals";
import {
  CYCLE_RELATION_LABELS,
  stageCreationIntent,
  type CycleRelation,
  type CycleRelationKind,
  type StageCreationIntent,
} from "./domain/cycle-graph";
import type { JournalPeriod } from "./domain/entities";
import type { DidaProjectProjectionContractContext } from "./integrations/dida/write-contract";
import {
  deterministicEventId,
} from "./domain/events";
import { aggregateAnalytics } from "./domain/analytics";
import { patchManagedFrontmatter } from "./storage/frontmatter";
import { HelixService } from "./services/helix-service";
import {
  canSilentlyRepairProjectCanvas,
  ProjectWorkspaceService,
} from "./services/project-workspace";
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
  ProjectWorkspaceSnapshot,
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
import { maintainedStageCodes, parseStageCode } from "./domain/stage-numbering";
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

import {
  PROJECT_PROJECTION_ACTIVATION_VERSION,
  hasProjectionActivationFootprint,
  isCurrentProjectionTargetResume,
  PROJECTION_NO_COLUMN_ID,
  PROJECTION_PROJECT_NAME,
  type DidaProjectionTarget,
  type ProjectionActivationPreview,
  type ProjectionActionState,
  type ProjectionColumnCreationPreview,
} from "./domain/dida-project-projection";
import {
  confirmProjectionActivation,
  confirmProjectionActivationWithLease,
  projectionCounts,
  projectionInputFromProject,
  projectionInputsFromProject,
  projectionInputFromStage,
  projectionStageInProject,
} from "./services/dida-project-projection-coordinator";
import { stableHash } from "./domain/stable";
import {
  ProjectAutoSyncCoordinator,
  type ProjectAutoSyncReport,
} from "./services/project-auto-sync";
import { helixMarkerVisibilityExtension } from "./editor/helix-marker-visibility";
import { ProjectRefreshBatch } from "./services/project-refresh-batch";
import {
  derivedLocalProjectStageStatus,
  LocalProjectTaskService,
  type LocalProjectTaskDraft,
  type LocalProjectTaskSnapshot,
} from "./services/local-project-tasks";
import {
  DIDA_CONTRACT_TEST_AVAILABLE,
  DIDA_READ_AVAILABLE,
  DIDA_TASK_WRITE_AVAILABLE,
  PROJECT_DIDA_PROJECTION_AVAILABLE,
  assertProjectDidaProjectionAvailable,
} from "./release-capabilities";

const FOCUS_BRIDGE_RECOVERY_PREFIX = "Helix 阶段聚焦桥接需要人工检查：";

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
  localProjectTasks!: LocalProjectTaskService;
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
  private projectStartupReady = false;
  private dataGeneration!: DataGeneration;
  private projectRefreshTimer: number | null = null;
  private projectMutationDepth = 0;
  private projectRefreshBatch!: ProjectRefreshBatch;
  private projectCanvasRefreshPending = false;
  private readonly projectMarkdownRefreshPaths = new Set<string>();
  private readonly deferredProjectEditorRefreshPaths = new Set<string>();
  private readonly deferredProjectEditorBlurListeners = new Map<HTMLElement, EventListener>();
  private readonly projectIdentityProbeTimers = new Map<string, number>();
  private readonly projectMutationRunner = new SerializedRunner();
  private readonly projectProjectionBootstrapRunner = new SerializedRunner();
  /** 远端投影单独串行；网络等待不得占用项目工作区锁并阻塞 UI。 */
  private readonly projectProjectionSyncRunner = new SerializedRunner();
  private readonly settingsMutationRunner = new SerializedRunner();
  private readonly taskMatrixRuleUpdater = new TaskMatrixRuleUpdater(this.settingsMutationRunner);
  private projectStatusItem: HTMLElement | null = null;
  private projectStatusSignature: string | null = null;
  /**
   * 任务页只消费最近一次稳定项目快照的派生结果。禁止每次服务状态变化或
   * 页面 render 都重新扫描全部 Project／Stage，更不能在 render 中补写身份。
   */
  private localProjectTaskSnapshotCache: LocalProjectTaskSnapshot | null = null;
  private focusBridgeConflictCountCache = 0;
  /** 派生项目视图缓存每次完成一致性重建后递增，供 UI 区分真实变化与无状态广播。 */
  private projectViewRevision = 0;
  private readonly persistentNotices = new Set<Notice>();

  async onload(): Promise<void> {
    this.unloaded = false;
    this.projectRefreshBatch = new ProjectRefreshBatch(() => this.scheduleProjectRefresh());
    this.dataGeneration = beginDataGeneration();
    this.store = new HelixDataStore(this, this.dataGeneration);
    this.secrets = new HelixSecretStore(this.app);
    const data = await this.store.load();
    this.dismissResolvedRecoveryNotices(data.recoveryIssues);
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
    this.localProjectTasks = new LocalProjectTaskService(
      new VaultProjectionMarkdownAdapter(this.vaultRepository),
    );
    const staleFocusBridgeIssues = data.recoveryIssues.filter((issue) =>
      issue.startsWith(FOCUS_BRIDGE_RECOVERY_PREFIX));
    // Vault 在插件 onload 时仍可能逐文件触发 create；聚焦桥接问题必须等布局就绪、
    // Markdown 索引完整后再复核。此前用不完整 getMarkdownFiles() 扫描会制造假冲突。
    this.recoveryMode = data.recoveryIssues.some((issue) =>
      !issue.startsWith(FOCUS_BRIDGE_RECOVERY_PREFIX));
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
        this.showPersistentNotice(message);
      }
      if (templateStartupAction(this.recoveryMode, this.settings.templateSetupCompleted) === "ensure-existing") {
        try {
          await runTemplateStartup("ensure-existing", this.templateManager);
        } catch (error) {
          new Notice(`Helix 默认模板未完全补齐：${error instanceof Error ? error.message : String(error)}`, 10_000);
        }
      }
    }
    this.service = new HelixService(this.store, this.secrets, {
      didaReadAvailable: DIDA_READ_AVAILABLE,
      didaTaskWriteAvailable: DIDA_TASK_WRITE_AVAILABLE,
      didaContractTestAvailable: DIDA_CONTRACT_TEST_AVAILABLE,
      projectDidaProjectionAvailable: PROJECT_DIDA_PROJECTION_AVAILABLE,
    });
    await this.service.initialize();
    this.service.setVaultProjectProjectionContractProbe((context) =>
      this.runVaultProjectProjectionContractProbe(context));
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
    let observedDidaPullAt: string | undefined;
    this.register(this.service.subscribe((state) => {
      void projectionReadinessRunner.run(async () => {
        const didCompletePull = Boolean(state.lastSyncAt && state.lastSyncAt !== observedDidaPullAt);
        if (didCompletePull) {
          observedDidaPullAt = state.lastSyncAt;
          // 服务状态会在授权租约 finally 释放前发布；延后一拍，避免把瞬时 inProgress 锁死为长期未就绪。
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        await this.ensureAutomaticProjectProjection();
        const readiness = await this.service.projectProjectionWriteReadiness();
        this.projectAutoSync.updateReadiness(
          PROJECT_DIDA_PROJECTION_AVAILABLE && this.settings.autoSync && readiness.ready,
        );
        // 普通滴答拉取完成后重新比较候选指纹；只有远端状态变化的项目会进入同步。
        if (didCompletePull) this.projectAutoSync.request();
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
        insertCycle: (relationId, sourceCycleId, targetCycleId, projectId, onCreated) =>
          this.showInsertCycleModal(
            relationId,
            sourceCycleId,
            targetCycleId,
            projectId,
            onCreated,
          ),
        deleteCycle: (cycleId, onDeleted) => this.showDeleteCycleModal(cycleId, onDeleted),
        deleteProject: (projectId, onDeleted) =>
          this.showDeleteProjectModal(projectId, onDeleted),
        renameProject: (projectId, currentTitle, currentColor, onRenamed) =>
          this.showRenameProjectModal(projectId, currentTitle, currentColor, onRenamed),
        renameCycle: (cycleId, currentTitle, onRenamed) =>
          this.showRenameCycleModal(cycleId, currentTitle, onRenamed),
        manageRelation: (relationId, onChanged) =>
          this.showManageRelationModal(relationId, onChanged),
        openProjectFile: (path) => this.openFile(path),
        projectWorkspace: this.projectWorkspace,
        readLocalProjectTasks: () => this.readLocalProjectTasks(),
        createLocalProjectTask: (input) => this.createLocalProjectTask(input),
        updateLocalProjectTask: (input) => this.updateLocalProjectTask(input),
        saveLocalProjectTask: (input) => this.saveLocalProjectTask(input),
        deleteLocalProjectTask: (input) => this.deleteLocalProjectTask(input),
        readFocusBridgeConflictCount: () => this.readFocusBridgeConflictCount(),
        readProjectViewRevision: () => this.projectViewRevision,
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
    if (DIDA_READ_AVAILABLE) this.registerDidaReadCommands();
    if (DIDA_CONTRACT_TEST_AVAILABLE) this.registerDidaContractCommands();
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
        if (this.isProjectWorkspaceFile(file.path)) {
          if (this.deferProjectRefreshForActiveEditor(file.path)) return;
          this.scheduleProjectRefresh(file.path);
          return;
        }
        this.scheduleProjectIdentityProbe(file.path);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.refreshActiveStatusForPaths(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.refreshActiveStatusForPaths(file.path);
        if (this.isProjectWorkspaceFile(file.path)) {
          this.scheduleProjectRefresh(file.path);
          return;
        }
        this.scheduleProjectIdentityProbe(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.refreshActiveStatusForPaths(file.path);
        if (this.isProjectWorkspaceFile(file.path)) {
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
    this.app.workspace.onLayoutReady(() => {
      void this.finishProjectStartup(staleFocusBridgeIssues);
    });
    // 重启后从 Markdown/Canvas 权威源重扫；队列与写门仍由既有同步管线负责。
    this.projectAutoSync.invalidate();
  }

  private async finishProjectStartup(staleFocusBridgeIssues: readonly string[]): Promise<void> {
    if (this.unloaded || this.projectStartupReady) return;
    try {
      if (staleFocusBridgeIssues.length > 0) {
        // 布局就绪后再读取双稳定快照；只有权威 Markdown/Canvas 确实一致才清旧锁。
        await this.projectWorkspace.loadStableWorkspace();
        await this.store.resolveRecoveryIssuesAfterValidation(staleFocusBridgeIssues);
      }
      if (!this.recoveryMode) {
        let snapshot = await this.projectWorkspace.loadStableWorkspace();
        snapshot = await this.reconcileProjectStageFileNames(snapshot);
        // 稳定 ID 先完成路径重绑定，聚焦桥再用新路径观察旧展示。
        await this.projectWorkspace.initializeFocusBridgeState();
        snapshot = await this.projectWorkspace.loadStableWorkspace();
        await this.repairDerivedProjectCanvasCache(snapshot);
        let localTasks = await this.localProjectTasks.snapshot(
          snapshot,
          { adoptUnmanaged: true },
        );
        if (await this.reconcileLocalProjectStageStatuses(snapshot, localTasks)) {
          snapshot = await this.projectWorkspace.loadStableWorkspace();
          localTasks = await this.localProjectTasks.snapshot(snapshot);
        }
        this.localProjectTaskSnapshotCache = localTasks;
        this.focusBridgeConflictCountCache =
          (await this.projectWorkspace.listFocusBridgeConflicts()).length;
        this.projectViewRevision += 1;
      }
    } catch (error) {
      const message = `${FOCUS_BRIDGE_RECOVERY_PREFIX}${
        error instanceof Error ? error.message : String(error)}`;
      await this.enterProjectRecoveryMode(message);
      this.showPersistentNotice(message);
    } finally {
      this.projectStartupReady = true;
    }
    await this.service.refreshPersistedEvents();
    if (!this.recoveryMode) this.projectAutoSync.request();
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
    const file = this.app.workspace.getActiveFile();
    const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const target = this.activeHelixStatusTarget();
    const signature = target
      ? `${file?.path ?? ""}:${target.kind}:${target.status}`
      : file && (frontmatter?.["helix-kind"] === "helix-project" ||
          frontmatter?.["helix-kind"] === "helix-stage" ||
          frontmatter?.["helix-kind"] === "helix-cycle")
        ? `${file.path}:invalid:${String(frontmatter?.["helix-status"] ?? "")}`
        : `${file?.path ?? ""}:hidden`;
    // CodeMirror 会在每个输入事务后触发 vault.modify。状态未变时销毁并重建
    // 状态栏控件会让 Obsidian 的焦点恢复链把光标从编辑器移走。
    if (signature === this.projectStatusSignature) return;
    this.projectStatusSignature = signature;
    item.empty();
    item.onclick = null;
    item.onkeydown = null;
    item.removeAttribute("role");
    item.removeAttribute("tabindex");
    item.removeAttribute("title");
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
    for (const notice of this.persistentNotices) notice.hide();
    this.persistentNotices.clear();
    this.didaWriteContractSettingsConfirmation.disarm();
    this.didaContractAdoptConfirmation.disarm();
    this.didaWriteContractCommands?.dispose();
    this.projectAutoSync?.dispose();
    this.projectRefreshBatch?.dispose();
    if (this.projectRefreshTimer !== null) {
      window.clearTimeout(this.projectRefreshTimer);
      this.projectRefreshTimer = null;
    }
    for (const timer of this.projectIdentityProbeTimers.values()) {
      window.clearTimeout(timer);
    }
    this.projectIdentityProbeTimers.clear();
    for (const [element, listener] of this.deferredProjectEditorBlurListeners) {
      element.removeEventListener("focusout", listener, true);
    }
    this.deferredProjectEditorBlurListeners.clear();
    this.deferredProjectEditorRefreshPaths.clear();
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

  /** 合同临时清单内运行真实 Vault→Markdown→投影→生产队列主链路。 */
  private async runVaultProjectProjectionContractProbe(
    context: DidaProjectProjectionContractContext,
  ): Promise<void> {
    const title = `Helix 合同项目 ${crypto.randomUUID()}`;
    let created: ProjectWorkspaceProject | undefined;
    let projectionUnitId: string | undefined;
    const trackedRemoteIds = new Set<string>();
    const unknownDeleteIds = new Set<string>();
    const track = async (taskId: string) => {
      if (trackedRemoteIds.has(taskId)) return;
      await context.trackTask(await context.api.getTask(context.project.id, taskId));
      trackedRemoteIds.add(taskId);
    };
    const untrack = async (taskId: string) => {
      if (!trackedRemoteIds.delete(taskId)) return;
      await context.untrackTask(taskId);
    };
    const markDeleteUnknown = async (taskId: string) => {
      if (!trackedRemoteIds.has(taskId) || unknownDeleteIds.has(taskId)) return;
      await context.markTaskDeleteUnknown(taskId);
      unknownDeleteIds.add(taskId);
    };
    const previous = await this.projectProjection.readConfiguration();
    const target = { targetProjectId: context.project.id, targetColumnId: context.column.id };
    if (previous.enabled || previous.ledger.length > 0 || previous.parentCheckpoints.length > 0 ||
      (previous.parentBases?.length ?? 0) > 0 || (previous.receiptCleanupPending?.length ?? 0) > 0) {
      throw new Error("Vault 项目合同探针要求远端项目联动处于完全关闭且无历史绑定的纯净状态");
    }
    const contractProjection = new DidaProjectProjectionService(
      new VaultProjectionMarkdownAdapter(this.vaultRepository),
      new ExistingHelixTaskPipelineAdapter(this.service),
      new PersistedProjectionStatePort(this.store),
      { read: async () => ({
        projects: [context.project],
        columns: [context.column],
        readiness: {
          writable: true,
          queueEmpty: true,
          authorizationCurrent: true,
          taskParentingVerified: true,
          itemsRoundTripVerified: true,
          itemIdStableVerified: true,
          boardPlacementVerified: true,
          boardFresh: true,
          taskReopenVerified: true,
          unknownOutcomes: 0,
        },
      }) },
      () => new Date().toISOString(),
      new PersistedProjectionDiagnosticsPort(this.store),
    );
    try {
      created = await this.withWritableProjectMutation(() =>
        this.projectWorkspace.createProject(title, "合同首阶段"));
      const stage = created.cycles[0]!;
      projectionUnitId = stage.id;
      await this.withWritableProjectMutation(async () => {
        // 生产投影只首次创建“进行中” Stage；合同夹具必须先进入同一真实前置状态。
        const statusPlan = await this.projectWorkspace.prepareCycleStatusUpdate(stage.id);
        await this.projectWorkspace.updateCycleStatus(statusPlan, "active");
        await this.localProjectTasks.createTask(
          await this.projectWorkspace.loadStableWorkspace(),
          { projectId: created!.id, stageId: stage.id, title: `${context.marker} Vault 行动` },
        );
      });
      const counts = { projectCount: 1, actionCount: 1 };
      const preview = await contractProjection.previewActivation(target, counts);
      if (preview.blockers.length > 0) throw new Error(`Vault 项目链路探针无法激活：${preview.blockers.join("；")}`);
      await contractProjection.activate(preview, preview.previewHash);
      const input = projectionInputFromProject((await this.projectWorkspace.snapshot()).projects
        .find((project) => project.id === created!.id)!);
      // 投影会在远端请求之间回填 Project／Stage Markdown；整个同步必须加入自写批次，
      // 否则前序 createTask 的延迟 Vault 事件可能在回填瞬间启动扫描并制造假 markdown-race。
      const first = await this.withWritableProjectMutation(() =>
        contractProjection.synchronizeProject(input));
      if (first.createdParents !== 1 || first.createdActions !== 1 || first.frozen.length > 0) {
        throw new Error("Vault 项目链路探针首次同步未完整收口");
      }
      const model = await contractProjection.readProject(input);
      const parentId = model.project.parentTaskId;
      const actionId = model.stages[0]?.managed[0]?.remoteId;
      if (!parentId || !actionId) throw new Error("Vault 项目探针未回填远端稳定身份");
      await track(parentId);
      await track(actionId);
      await this.withWritableProjectMutation(async () => {
        const workspace = await this.projectWorkspace.loadStableWorkspace();
        const task = (await this.localProjectTasks.snapshot(workspace)).tasks.find((item) =>
          item.projectId === created!.id)!;
        await this.localProjectTasks.updateTask(workspace, {
          projectId: created!.id,
          stageId: stage.id,
          uuid: task.uuid,
          expectedHash: task.revisionHash,
          title: `${context.marker} Vault 行动已编辑`,
          state: "completed",
        });
      });
      const secondInput = projectionInputFromProject((await this.projectWorkspace.snapshot()).projects
        .find((project) => project.id === created!.id)!);
      const second = await this.withWritableProjectMutation(() =>
        contractProjection.synchronizeProject(secondInput));
      if (second.updatedActions !== 1 || second.completedActions !== 1 || second.frozen.length > 0) {
        throw new Error("Vault 项目链路探针编辑与完成未完整收口");
      }
      await contractProjection.deleteProject(secondInput);
      await untrack(actionId);
      await untrack(parentId);
      await this.withWritableProjectMutation(() => this.projectWorkspace.deleteProject(created!.id));
      await contractProjection.finalizeProjectDeletion(secondInput.projectId);
      created = undefined;
    } finally {
      if (created) {
        try {
          const input = projectionInputFromProject((await this.projectWorkspace.snapshot()).projects
            .find((project) => project.id === created!.id)!);
          const model = await contractProjection.readProject(input);
          if (model.project.parentTaskId) {
            await track(model.project.parentTaskId);
          }
          for (const taskId of model.stages.flatMap((stage) => stage.managed.flatMap((action) => action.remoteId ? [action.remoteId] : []))) {
            await track(taskId);
          }
          await contractProjection.deleteProject(input);
          for (const taskId of [...trackedRemoteIds]) await untrack(taskId);
          await this.withWritableProjectMutation(() => this.projectWorkspace.deleteProject(created!.id));
          await contractProjection.finalizeProjectDeletion(input.projectId);
        } catch {
          const state = await contractProjection.readConfiguration();
          const unitId = projectionUnitId;
          const ownedEntries = state.ledger.filter((item) => item.projectId === unitId);
          for (const entry of ownedEntries) {
            if (entry.remoteId) {
              try { await track(entry.remoteId); } catch { /* 外层清理仍可按已登记身份复核。 */ }
              if (entry.tombstone && entry.frozen === "unknown-outcome") await markDeleteUnknown(entry.remoteId);
            } else if (entry.frozen === "unknown-outcome") {
              await context.markUntrackedCreate();
            }
          }
          const parent = state.parentCheckpoints.find((item) => item.projectId === unitId);
          if (parent?.remoteId) {
            try { await track(parent.remoteId); } catch { /* 外层清理仍可按已登记身份复核。 */ }
            if (parent.tombstone && parent.frozen === "unknown-outcome") await markDeleteUnknown(parent.remoteId);
          } else if (parent?.frozen === "unknown-outcome") {
            await context.markUntrackedCreate();
          }
          try {
            const stagePaths = (await this.projectWorkspace.snapshot()).projects
              .find((project) => project.id === created!.id)?.cycles.flatMap((stage) => [stage.notePath]) ?? [];
            for (const path of stagePaths) {
              const revision = await this.vaultRepository.read(path);
              const parentMatch = revision?.content.match(/^helix-dida-parent-task-id:\s*(.+)$/mu)?.[1]?.trim();
              if (parentMatch) await track(parentMatch);
              const ids = [...(revision?.content.matchAll(/remoteId=([^\s>]+)/gu) ?? [])]
                .map((match) => decodeURIComponent(match[1]!))
                .filter((id) => id !== "-");
              for (const id of ids) await track(id);
            }
          } catch {
            // 无法从本地回填身份时保持合同清理计划与恢复状态，不按标题猜测。
          }
          const ownedParentId = state.parentBases?.find((item) => item.projectId === unitId)?.remoteId ??
            state.parentCheckpoints.find((item) => item.projectId === unitId)?.remoteId;
          const ownedRemoteIds = [...new Set([
            ...ownedEntries.flatMap((entry) => entry.remoteId ? [entry.remoteId] : []),
            ...(ownedParentId ? [ownedParentId] : []),
          ])];
          const hasUntrackedIdentity = ownedEntries.some((entry) => !entry.remoteId) ||
            (!ownedParentId && (ownedEntries.length > 0 ||
              state.parentCheckpoints.some((item) => item.projectId === unitId)));
          if (!hasUntrackedIdentity && ownedRemoteIds.every((id) => trackedRemoteIds.has(id))) {
            const operationIds = new Set(ownedEntries.flatMap((entry) =>
              entry.operationId ? [entry.operationId] : []));
            const conflictIds = new Set(ownedEntries.flatMap((entry) =>
              entry.conflictId ? [entry.conflictId] : []));
            // 先让用户可见的临时 Project／Stage／Canvas 完成原子删除；若随后派生状态
            // 清理失败，只会留下可重试诊断，绝不出现文件仍在而身份账本先被抹掉。
            await this.withWritableProjectMutation(() => this.projectWorkspace.deleteProject(created!.id));
            await this.store.mutate((data) => {
              data.queue = data.queue.filter((operation) =>
                !ownedRemoteIds.includes(operation.entityId) && !operationIds.has(operation.id));
              data.conflicts = data.conflicts.filter((conflict) =>
                !ownedRemoteIds.includes(conflict.entityId) && !conflictIds.has(conflict.id));
              data.projectionOperationReceipts = data.projectionOperationReceipts.filter((receipt) =>
                !ownedRemoteIds.includes(receipt.remoteTaskId ?? "") &&
                !operationIds.has(receipt.operationId));
              data.events = data.events.filter((event) =>
                !event || typeof event !== "object" || Array.isArray(event) ||
                (event as Record<string, unknown>).projectId !== context.project.id);
              for (const remoteId of ownedRemoteIds) {
                delete data.baseSnapshots[`task:${remoteId}`];
                delete data.localSnapshots[`task:${remoteId}`];
              }
              const projection = data.didaProjectionState;
              if (projection) {
                const next = {
                  ...projection,
                  ledger: projection.ledger.filter((entry) => entry.projectId !== unitId),
                  parentCheckpoints: projection.parentCheckpoints.filter((entry) => entry.projectId !== unitId),
                  parentBases: projection.parentBases?.filter((entry) => entry.projectId !== unitId),
                  receiptCleanupPending: projection.receiptCleanupPending?.filter((entry) =>
                    entry.projectId !== unitId),
                };
                const empty = next.ledger.length === 0 && next.parentCheckpoints.length === 0 &&
                  (next.parentBases?.length ?? 0) === 0 && (next.receiptCleanupPending?.length ?? 0) === 0;
                data.didaProjectionState = empty ? structuredClone(previous) : next;
              }
            });
            created = undefined;
          }
        }
      }
      const current = await contractProjection.readConfiguration();
      if (current.ledger.length === 0 && current.parentCheckpoints.length === 0) {
        await new PersistedProjectionStatePort(this.store).write(current, previous);
      }
    }
  }

  async readProjectProjection(projectId: string): Promise<ProjectionProjectReadModel> {
    return this.withProjectWorkspaceRead(async () => {
      const snapshot = await this.projectWorkspace.snapshot();
      const project = snapshot.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error("找不到要读取滴答任务关联的 Helix 项目");
      const models = await Promise.all(projectionInputsFromProject(project).map((input) =>
        this.projectProjection.readProject(input)));
      const configuration = await this.projectProjection.readConfiguration();
      return {
        enabled: configuration.enabled,
        target: configuration.target ? { ...configuration.target } : undefined,
        columnCreation: configuration.columnCreation
          ? structuredClone(configuration.columnCreation)
          : undefined,
        project: {
          id: project.id,
          path: project.notePath,
          title: project.title,
          status: project.status,
        },
        stages: models.flatMap((model) => model.stages.map((stage) => ({
          ...stage,
          title: project.cycles.find((candidate) => candidate.id === stage.id)?.title,
        }))),
        receipts: models.flatMap((model) => model.receipts),
        receiptCleanupPending: models.flatMap((model) => model.receiptCleanupPending),
        orphanDiagnostics: models.flatMap((model) => model.orphanDiagnostics),
      };
    });
  }

  async readLocalProjectTasks(): Promise<LocalProjectTaskSnapshot> {
    this.assertWritable();
    if (this.localProjectTaskSnapshotCache) return this.localProjectTaskSnapshotCache;
    return this.withProjectWorkspaceRead(async () => {
      if (this.localProjectTaskSnapshotCache) return this.localProjectTaskSnapshotCache;
      this.localProjectTaskSnapshotCache = await this.localProjectTasks.snapshot(
        await this.projectWorkspace.loadStableWorkspace(),
        { adoptUnmanaged: false },
      );
      return this.localProjectTaskSnapshotCache;
    });
  }

  readFocusBridgeConflictCount(): number {
    return this.focusBridgeConflictCountCache;
  }

  async createLocalProjectTask(input: {
    projectId: string;
    stageId: string;
    title: string;
    parentUuid?: string;
  }): Promise<string> {
    return this.withWritableProjectMutation(async () => {
      const workspace = await this.projectWorkspace.loadStableWorkspace();
      const taskId = await this.localProjectTasks.createTask(workspace, input);
      await this.reconcileLocalProjectStageCompletion(workspace, input.projectId, input.stageId);
      return taskId;
    });
  }

  async updateLocalProjectTask(input: {
    projectId: string;
    stageId: string;
    uuid: string;
    expectedHash: string;
    title?: string;
    state?: ProjectionActionState;
  }): Promise<void> {
    await this.withWritableProjectMutation(async () => {
      const workspace = await this.projectWorkspace.loadStableWorkspace();
      await this.localProjectTasks.updateTask(workspace, input);
      await this.reconcileLocalProjectStageCompletion(workspace, input.projectId, input.stageId);
    });
  }

  async deleteLocalProjectTask(input: {
    projectId: string;
    stageId: string;
    uuid: string;
    expectedHash: string;
  }): Promise<void> {
    await this.withWritableProjectMutation(async () => {
      const workspace = await this.projectWorkspace.loadStableWorkspace();
      await this.localProjectTasks.deleteTask(workspace, input);
      await this.reconcileLocalProjectStageCompletion(workspace, input.projectId, input.stageId);
    });
  }

  async saveLocalProjectTask(input: {
    projectId: string;
    stageId: string;
    uuid: string;
    expectedHash: string;
    draft: LocalProjectTaskDraft;
  }): Promise<void> {
    await this.withWritableProjectMutation(async () => {
      const workspace = await this.projectWorkspace.loadStableWorkspace();
      await this.localProjectTasks.saveTask(workspace, input);
      await this.reconcileLocalProjectStageCompletion(workspace, input.projectId, input.stageId);
    });
  }

  private async reconcileLocalProjectStageCompletion(
    workspace: ProjectWorkspaceSnapshot,
    projectId: string,
    stageId: string,
  ): Promise<void> {
    const snapshot = await this.localProjectTasks.snapshot(workspace);
    const project = workspace.projects.find((candidate) => candidate.id === projectId);
    if (!project?.cycles.some((cycle) => cycle.id === stageId)) {
      throw new Error("找不到需要更新完成状态的阶段");
    }
    await this.reconcileLocalProjectStageStatuses(workspace, snapshot, new Set([stageId]));
  }

  private async reconcileLocalProjectStageStatuses(
    workspace: ProjectWorkspaceSnapshot,
    snapshot: LocalProjectTaskSnapshot,
    stageIds?: ReadonlySet<string>,
  ): Promise<boolean> {
    let changed = false;
    for (const project of workspace.projects) {
      for (const stage of project.cycles) {
        if (stageIds && !stageIds.has(stage.id)) continue;
        const nextStatus = derivedLocalProjectStageStatus(
          stage.status,
          snapshot.roots.filter((task) => task.stageId === stage.id),
        );
        if (!nextStatus) continue;
        const plan = await this.projectWorkspace.prepareCycleStatusUpdate(stage.id);
        await this.projectWorkspace.updateCycleStatus(plan, nextStatus);
        changed = true;
      }
    }
    return changed;
  }

  async readProjectProjectionConfiguration(): Promise<ProjectionPersistentState> {
    return this.withProjectWorkspaceRead(() => this.projectProjection.readConfiguration());
  }

  /** 普通自动同步开启后，唯一地连接 Helix Projects 清单和无分栏阶段任务目标。 */
  private ensureAutomaticProjectProjection(): Promise<void> {
    return this.projectProjectionBootstrapRunner.run(async () => {
      if (!PROJECT_DIDA_PROJECTION_AVAILABLE || this.recoveryMode || !this.settings.autoSync ||
        !this.secrets.getDidaToken()) return;
      const runtime = this.service.snapshot();
      if (!runtime.authorizationConfigured || !runtime.taskCrudVerified ||
        !runtime.taskParentingVerified || !runtime.projectProjectionVerified) return;
      const configuration = await this.projectProjection.readConfiguration();
      if (configuration.enabled &&
        configuration.activationVersion === PROJECT_PROJECTION_ACTIVATION_VERSION &&
        configuration.target && configuration.confirmedPreviewHash) return;
      const snapshot = await this.projectWorkspace.loadStableWorkspace();
      const hasRecoveryIdentity = configuration.ledger.length > 0 ||
        configuration.parentCheckpoints.length > 0 ||
        (configuration.parentBases?.length ?? 0) > 0 ||
        (configuration.receiptCleanupPending?.length ?? 0) > 0 ||
        configuration.columnCreation !== undefined;
      const remoteProjects = this.service.snapshot().projects.filter((project) =>
        !project.id.startsWith("local-project-"));
      const retainedProjects = configuration.target
        ? remoteProjects.filter((project) => project.id === configuration.target!.targetProjectId)
        : [];
      const retainedTarget = retainedProjects.length === 1 ? {
        targetProjectId: retainedProjects[0]!.id,
        targetColumnId: PROJECTION_NO_COLUMN_ID,
      } : undefined;
      const sameTargetResume = retainedTarget !== undefined &&
        isCurrentProjectionTargetResume(configuration, retainedTarget);
      if (hasRecoveryIdentity && !sameTargetResume) {
        throw new Error("旧版或异目标项目任务同步仍有身份记录，必须先在冲突中心完成收口");
      }
      if (hasProjectionActivationFootprint(configuration) && !sameTargetResume) {
        throw new Error("停用的项目任务同步仍保留旧目标；请先显式清理停用配置");
      }
      // 已持久化的精确清单 ID 优先于展示名；用户改名后也不能另建第二个目标。
      let matches = sameTargetResume
        ? retainedProjects
        : remoteProjects.filter((project) => project.name === PROJECTION_PROJECT_NAME);
      if (matches.length > 1) throw new Error(`存在多个“${PROJECTION_PROJECT_NAME}”清单，已停止自动选择`);
      if (matches.length === 0) {
        await this.service.createDidaProject(PROJECTION_PROJECT_NAME);
        matches = this.service.snapshot().projects.filter((project) =>
          project.name === PROJECTION_PROJECT_NAME && !project.id.startsWith("local-project-"));
      }
      if (matches.length !== 1) throw new Error(`无法唯一确认“${PROJECTION_PROJECT_NAME}”清单`);
      const targetProject = matches[0]!;
      const target = {
        targetProjectId: targetProject.id,
        targetColumnId: PROJECTION_NO_COLUMN_ID,
      };
      await this.localProjectTasks.snapshot(snapshot, { adoptUnmanaged: true });
      const counts = await projectionCounts(snapshot, this.projectProjection);
      const preview = await this.projectProjection.previewActivation(target, counts);
      await this.service.withProjectProjectionActivationLease((readCatalog) =>
        confirmProjectionActivationWithLease(
          snapshot,
          this.projectProjection,
          preview,
          preview.previewHash,
          readCatalog,
        ));
      this.projectAutoSync.request(true);
      new Notice(`项目任务已自动连接到“${PROJECTION_PROJECT_NAME}”清单`, 6_000);
    });
  }

  readProjectProjectionWriteReadiness() {
    return this.service.projectProjectionWriteReadiness();
  }

  async readProjectProjectionCatalog(projectId: string): Promise<ProjectionCatalogSnapshot> {
    if (!this.service.snapshot().projects.some((project) => project.id === projectId) ||
      projectId.startsWith("local-project-")) {
      throw new Error("请选择已同步且身份明确的滴答清单");
    }
    return this.service.readProjectionCatalog(projectId);
  }

  async previewProjectProjection(target: DidaProjectionTarget): Promise<ProjectionActivationPreview> {
    this.assertProjectProjectionAvailable();
    return this.withWritableProjectMutation(async () => {
      const snapshot = await this.projectWorkspace.loadStableWorkspace();
      await this.localProjectTasks.snapshot(snapshot, { adoptUnmanaged: true });
      const counts = await projectionCounts(snapshot, this.projectProjection);
      return this.projectProjection.previewActivation(target, counts);
    });
  }

  async confirmProjectProjection(
    preview: ProjectionActivationPreview,
    confirmedHash: string,
  ): Promise<void> {
    this.assertProjectProjectionAvailable();
    await this.service.withProjectProjectionActivationLease((readCatalog) =>
      this.withWritableProjectMutation(async () => {
        const snapshot = await this.projectWorkspace.loadStableWorkspace();
        await this.localProjectTasks.snapshot(snapshot, { adoptUnmanaged: true });
        await confirmProjectionActivationWithLease(
          snapshot,
          this.projectProjection,
          preview,
          confirmedHash,
          readCatalog,
        );
      }));
    const readiness = await this.service.projectProjectionWriteReadiness();
    this.projectAutoSync.updateReadiness(
      PROJECT_DIDA_PROJECTION_AVAILABLE && this.settings.autoSync && readiness.ready,
    );
    this.projectAutoSync.request(true);
  }

  async disableProjectProjection(): Promise<void> {
    await this.withWritableProjectMutation(() => this.projectProjection.disable());
    this.projectAutoSync.updateReadiness(false);
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
    this.projectAutoSync.invalidate(input.projectId);
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
    this.projectAutoSync.invalidate(input.projectId);
  }

  async reconcileProjectProjectionFrozen(input:
    | { kind: "action"; projectId: string; stageId: string; uuid: string }
    | { kind: "parent"; projectId: string; stageId: string }): Promise<void> {
    this.assertProjectProjectionAvailable();
    await this.withWritableProjectMutation(async () => {
      const snapshot = await this.projectWorkspace.snapshot();
      const project = snapshot.projects.find((candidate) => candidate.id === input.projectId);
      const stage = project?.cycles.find((candidate) => candidate.id === input.stageId);
      if (!project || !stage) throw new Error("找不到要复核的阶段任务");
      const projectionInput = projectionInputFromStage(project, stage);
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
    return this.projectProjectionSyncRunner.run(async () => {
      const inputs = await this.projectionInputs(projectId);
      const summary = await this.projectProjection.synchronizeProjects(inputs);
      if (projectionSummaryMutationCount(summary) > 0) this.localProjectTaskSnapshotCache = null;
      return summary;
    });
  }

  private async projectAutoSyncScan() {
    if (!PROJECT_DIDA_PROJECTION_AVAILABLE || !this.settings.autoSync) {
      return { candidates: [], failures: [] };
    }
    return this.withProjectWorkspaceRead(async () => {
      const configuration = await this.projectProjection.readConfiguration();
      if (!configuration.enabled ||
        configuration.activationVersion !== PROJECT_PROJECTION_ACTIVATION_VERSION ||
        !configuration.target || !configuration.confirmedPreviewHash) {
        return { candidates: [], failures: [] };
      }
      const snapshot = await this.projectWorkspace.snapshot();
      const remoteTasks = new Map(this.service.snapshot().tasks.map((task) => [task.id, task]));
      const candidates = [];
      const failures = [];
      for (const project of snapshot.projects) {
        const inputs = projectionInputsFromProject(project);
        const fallbackFingerprint = stableHash(inputs);
        try {
          const models = await Promise.all(inputs.map((input) => this.projectProjection.readProject(input)));
          candidates.push({
            projectId: project.id,
            fingerprint: stableHash({
              project: { id: project.id, title: project.title, status: project.status },
              stages: models.flatMap((model) => model.stages.map((stage) => ({
                id: stage.id, path: stage.path, revisionHash: stage.revisionHash,
                parentTaskId: stage.parentTaskId,
                remoteStatuses: stage.managed
                  .filter((action) => action.remoteId)
                  .map((action) => ({
                    id: action.remoteId,
                    status: remoteTasks.get(action.remoteId!)?.status ?? null,
                  })),
              }))),
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
    if (report.mutations > 0) {
      new Notice(`滴答项目同步完成：${report.synchronized} 个项目，${report.mutations} 项变更`, 6_000);
    }
  }

  private async projectionInputs(projectId: string): Promise<ProjectionProjectInput[]> {
    const snapshot = await this.projectWorkspace.snapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("找不到要同步到滴答的 Helix 项目");
    return projectionInputsFromProject(project);
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
    if (!DIDA_READ_AVAILABLE) return;
    if (!this.settings.autoSync) this.projectAutoSync.updateReadiness(false);
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

  private registerDidaReadCommands(): void {
    this.addCommand({
      id: "sync-now",
      name: "立即同步滴答数据",
      callback: () => void this.service.sync().catch((error) => this.service.notifySyncError(error)),
    });
  }

  private registerDidaContractCommands(): void {
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
      async (title, initialStageTitle, color) => {
        this.assertWritable();
        const created = await this.withWritableProjectMutation(() =>
          this.projectWorkspace.createProject(title, initialStageTitle, undefined, color));
        onCreated?.(created.id);
        await this.service.refreshPersistedEvents();
        new Notice("项目和阶段 1 已加入当前工作区");
      },
    ).open();
  }

  showCreateProjectModal(onCreated?: (projectId: string) => void): void {
    this.openProjectModal(onCreated);
  }

  private showRenameProjectModal(
    projectId: string,
    currentTitle: string,
    currentColor: string,
    onRenamed?: () => void,
  ): void {
    new EditProjectModal(this.app, currentTitle, currentColor, async (title, color) => {
      this.assertWritable();
      await this.withWritableProjectMutation(async () => {
        if (title !== currentTitle) await this.projectWorkspace.renameProject(projectId, title);
        if (color !== currentColor) await this.projectWorkspace.updateProjectColor(projectId, color);
      });
      await this.service.refreshPersistedEvents();
      onRenamed?.();
      new Notice("项目名称与颜色已更新");
    }).open();
  }

  private showRenameCycleModal(
    cycleId: string,
    currentTitle: string,
    onRenamed?: () => void,
  ): void {
    new RenameEntityModal(this.app, "阶段", currentTitle, async (title) => {
      this.assertWritable();
      await this.withWritableProjectMutation(() =>
        this.projectWorkspace.renameCycle(cycleId, title));
      await this.service.refreshPersistedEvents();
      onRenamed?.();
      new Notice("阶段名称已更新");
    }).open();
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
        const previewId = "helix-stage-preview";
        const projectCycleIds = new Set(project.cycles.map((cycle) => cycle.id));
        const relations = snapshot.relations
          .filter((relation) =>
            projectCycleIds.has(relation.toCycleId) &&
            relation.fromCycleIds.every((id) => projectCycleIds.has(id)))
          .map((relation) => intent.convertedInheritanceRelationIds.includes(relation.id)
            ? { ...relation, kind: "branch" as const }
            : relation);
        relations.push({
          id: "preview",
          kind: intent.relation,
          fromCycleIds: intent.predecessorIds,
          toCycleId: previewId,
        });
        const previewCode = maintainedStageCodes([
          ...project.cycles.map((cycle) => ({
            id: cycle.id,
            code: cycle.stageCode,
            sequence: cycle.sequence,
          })),
          {
            id: previewId,
            code: String(snapshot.nextStageSequenceByProject[project.id]!),
            sequence: snapshot.nextStageSequenceByProject[project.id]!,
          },
        ], relations).get(previewId) ?? String(snapshot.nextStageSequenceByProject[project.id]!);
        new CyclePromptModal(
          this.app,
          project,
          sourceCycles,
          intent,
          crossProject,
          previewCode,
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

  private showInsertCycleModal(
    relationId: string,
    sourceCycleId: string,
    targetCycleId: string,
    projectId: string,
    onCreated?: (cycleId: string) => void,
  ): void {
    if (this.recoveryMode) {
      new Notice("Helix 当前处于只读恢复模式，不能插入阶段", 8_000);
      return;
    }
    void this.projectWorkspace.snapshot().then((snapshot) => {
      const project = snapshot.projects.find((candidate) => candidate.id === projectId);
      const source = snapshot.projects.flatMap((candidate) => candidate.cycles)
        .find((cycle) => cycle.id === sourceCycleId);
      const target = project?.cycles.find((cycle) => cycle.id === targetCycleId);
      const relation = snapshot.relations.find((candidate) => candidate.id === relationId);
      if (!project || !source || !target || !relation ||
          !relation.fromCycleIds.includes(sourceCycleId) || relation.toCycleId !== targetCycleId) {
        throw new Error("关系已经变化，请重新点击箭头");
      }
      new InsertCycleModal(this.app, source, target, async (stageTitle) => {
        this.assertWritable();
        const created = await this.withWritableProjectMutation(async () => {
          const intent = stageCreationIntent([sourceCycleId], snapshot.relations);
          const next = await this.projectWorkspace.createCycle(
            projectId,
            "auto",
            [sourceCycleId],
            {
              expectedAutoIntent: {
                relation: intent.relation,
                convertedInheritanceRelationIds: intent.convertedInheritanceRelationIds,
              },
              confirmCrossProject: sourceCycleId !== targetCycleId &&
                !project.cycles.some((cycle) => cycle.id === sourceCycleId),
              stageTitle,
            },
          );
          const nextPredecessors = relation.kind === "merge"
            ? relation.fromCycleIds.map((id) => id === sourceCycleId ? next.id : id)
            : [next.id];
          await this.projectWorkspace.replaceRelation(
            relationId,
            nextPredecessors.length > 1 ? "merge" : "inherit",
            nextPredecessors,
            {
              confirmCrossProject: true,
              insertedPredecessorId: next.id,
              insertedBranchRank: parseStageCode(target.stageCode)?.branch,
            },
          );
          if (next.status !== target.status) {
            const plan = await this.projectWorkspace.prepareCycleStatusUpdate(next.id);
            await this.projectWorkspace.updateCycleStatus(plan, target.status);
          }
          return next;
        });
        await this.service.refreshPersistedEvents();
        onCreated?.(created.id);
        new Notice("新阶段已插入，前后关系已更新为推进");
      }).open();
    }).catch((error) => new Notice(error instanceof Error ? error.message : String(error), 8_000));
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
            await this.withWritableProjectMutation(async () => {
              const projectionInput = projectionInputFromStage(owner, cycle);
              await this.projectProjection.deleteProject(projectionInput);
              await this.projectWorkspace.deleteCycle(plan, {
                bridge,
                confirmCrossProject,
              });
              await this.projectProjection.finalizeProjectDeletion(projectionInput.projectId);
            });
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

  private showDeleteProjectModal(projectId: string, onDeleted?: () => void): void {
    if (this.recoveryMode) {
      new Notice("Helix 当前处于只读恢复模式，处理恢复问题前不能删除项目", 8_000);
      return;
    }
    void this.withProjectWorkspaceRead(() => this.projectWorkspace.snapshot())
      .then((snapshot) => {
        const project = snapshot.projects.find((candidate) => candidate.id === projectId);
        if (!project) throw new Error("找不到需要删除的项目");
        new DeleteProjectModal(this.app, project, async () => {
          this.assertWritable();
          await this.withWritableProjectMutation(async () => {
            const projectionInputs = projectionInputsFromProject(project);
            for (const input of projectionInputs) {
              await this.projectProjection.deleteProject(input);
            }
            await this.projectWorkspace.deleteProject(projectId);
            for (const input of projectionInputs) {
              await this.projectProjection.finalizeProjectDeletion(input.projectId);
            }
          });
          onDeleted?.();
          new Notice(`项目“${project.title}”及其 ${project.cycles.length} 个阶段已移入废纸篓`);
        }).open();
      })
      .catch((error) =>
        new Notice(error instanceof Error ? error.message : String(error), 8_000));
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
      `- 完成复盘：${summary.totalReviews}`,
      `- 活跃天数：${summary.activeDays}`,
    ].join("\n");
    const existing = await this.vaultRepository.read(path);
    if (!existing) {
      this.assertWritable();
      const names: Record<JournalPeriod, string> = {
        daily: formatDate(now),
        weekly: `${formatDate(now)} 所在周复盘`,
        monthly: `${now.getFullYear()} 年 ${now.getMonth() + 1} 月复盘`,
        yearly: `${now.getFullYear()} 年复盘`,
      };
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
    } else {
      const file = this.app.vault.getAbstractFileByPath(path);
      const frontmatter = file instanceof TFile
        ? this.app.metadataCache.getFileCache(file)?.frontmatter
        : undefined;
      if (
        frontmatter?.["helix-kind"] === "helix-journal" &&
        frontmatter["helix-period"] === period
      ) {
        try {
          const updated = patchJournalSummary(existing.content, generatedSummary);
          if (updated !== existing.content) {
            this.assertWritable();
            await this.vaultRepository.compareAndWrite(existing, updated);
          }
        } catch (error) {
          new Notice(`复盘已打开，但自动摘要未更新：${
            error instanceof Error ? error.message : String(error)}`, 8_000);
        }
      }
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
    if (this.unloaded || !this.projectStartupReady) return;
    if (changedPath && changedPath.endsWith(".md")) {
      this.projectMarkdownRefreshPaths.add(normalizePath(changedPath));
    }
    if (
      changedPath &&
      normalizePath(changedPath) === normalizePath(this.settings.lineageCanvasPath)
    ) {
      this.projectCanvasRefreshPending = true;
    }
    if (this.projectRefreshBatch.recordEvent()) return;
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
        // 扫描本身不是自写事务，禁止 begin/end：end 会安排下一轮扫描，
        // 进而形成无限刷新。真正的 Markdown/Canvas 写入仍由各 mutation
        // 或 repairDerivedProjectCanvasCache 单独进入 quiet-window。
        if (observeCanvas) await this.projectWorkspace.observeCanvasChange();
        if (!this.recoveryMode) {
          // 本轮只读取一次稳定工作区，供 Canvas 派生修复和任务派生共同使用。
          let snapshot = await this.projectWorkspace.loadStableWorkspace();
          const beforeStagePaths = new Map(snapshot.projects.flatMap((project) =>
            project.cycles.map((stage) => [stage.id, stage.notePath] as const)));
          snapshot = await this.reconcileProjectStageFileNames(snapshot);
          if (markdownPaths.length > 0) {
            const focusPaths = new Set(markdownPaths.map((path) => normalizePath(path)));
            for (const stage of snapshot.projects.flatMap((project) => project.cycles)) {
              const beforePath = beforeStagePaths.get(stage.id);
              if (beforePath && beforePath !== stage.notePath) {
                focusPaths.add(beforePath);
                focusPaths.add(stage.notePath);
              }
            }
            await this.projectWorkspace.observeFocusBridgeChanges([...focusPaths]);
            snapshot = await this.projectWorkspace.loadStableWorkspace();
          }
          await this.repairDerivedProjectCanvasCache(snapshot);
          let localTasks = await this.localProjectTasks.snapshot(
            snapshot,
            { adoptUnmanaged: markdownPaths.length > 0 },
          );
          if (await this.reconcileLocalProjectStageStatuses(snapshot, localTasks)) {
            snapshot = await this.projectWorkspace.loadStableWorkspace();
            localTasks = await this.localProjectTasks.snapshot(snapshot);
          }
          this.localProjectTaskSnapshotCache = localTasks;
          this.focusBridgeConflictCountCache =
            (await this.projectWorkspace.listFocusBridgeConflicts()).length;
          this.projectViewRevision += 1;
        }
        await this.service.refreshPersistedEvents();
        this.projectAutoSync.request();
      }).catch(async (error) => {
        const recoveryIssue = this.projectWorkspace.recoveryIssueMessage();
        const message = error instanceof Error ? error.message : String(error);
        if (recoveryIssue) {
          await this.enterProjectRecoveryMode(`Helix 项目工作区需要人工检查：${recoveryIssue}`);
        }
        if (recoveryIssue) this.showPersistentNotice(message);
        else new Notice(message, 8_000);
      });
    }, 200);
  }

  /** 用户持续输入时不运行会重建派生视图的项目扫描；编辑器失焦后合并为一次刷新。 */
  private deferProjectRefreshForActiveEditor(path: string): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const normalized = normalizePath(path);
    const activeElement = view?.contentEl.ownerDocument.activeElement;
    const editingInsideView = !!view && (
      view.editor.hasFocus() || (!!activeElement && view.contentEl.contains(activeElement))
    );
    if (!view || normalizePath(view.file?.path ?? "") !== normalized || !editingInsideView) {
      return false;
    }
    this.deferredProjectEditorRefreshPaths.add(normalized);
    const element = view.contentEl;
    if (this.deferredProjectEditorBlurListeners.has(element)) return true;
    const ownerWindow = element.ownerDocument.defaultView ?? window;
    const listener: EventListener = () => {
      ownerWindow.requestAnimationFrame(() => {
        const nextActiveElement = view.contentEl.ownerDocument.activeElement;
        if (this.unloaded || view.editor.hasFocus() ||
          (!!nextActiveElement && view.contentEl.contains(nextActiveElement))) return;
        element.removeEventListener("focusout", listener, true);
        this.deferredProjectEditorBlurListeners.delete(element);
        const paths = [...this.deferredProjectEditorRefreshPaths];
        this.deferredProjectEditorRefreshPaths.clear();
        for (const changedPath of paths) this.scheduleProjectRefresh(changedPath);
      });
    };
    element.addEventListener("focusout", listener, true);
    this.deferredProjectEditorBlurListeners.set(element, listener);
    return true;
  }

  /** 已持有 projectMutationRunner；只对可重建派生字段开启自写事件批次。 */
  private async reconcileProjectStageFileNames(
    snapshot: ProjectWorkspaceSnapshot,
  ): Promise<ProjectWorkspaceSnapshot> {
    const beforePaths = snapshot.projects.flatMap((project) =>
      project.cycles.map((cycle) => `${cycle.id}\u0000${cycle.notePath}`)).sort();
    this.projectRefreshBatch.begin();
    try {
      const reconciled = await this.projectWorkspace.reconcileStageFileNames(snapshot);
      const afterPaths = reconciled.projects.flatMap((project) =>
        project.cycles.map((cycle) => `${cycle.id}\u0000${cycle.notePath}`)).sort();
      if (JSON.stringify(beforePaths) === JSON.stringify(afterPaths)) return reconciled;
      await this.projectWorkspace.initializeFocusBridgeState();
      return this.projectWorkspace.loadStableWorkspace();
    } finally {
      this.projectRefreshBatch.end();
    }
  }

  /** 已持有 projectMutationRunner；只对可重建派生字段开启自写事件批次。 */
  private async repairDerivedProjectCanvasCache(
    snapshot?: ProjectWorkspaceSnapshot,
  ): Promise<void> {
    const stable = snapshot ?? await this.projectWorkspace.loadStableWorkspace();
    if (!canSilentlyRepairProjectCanvas(stable)) return;
    this.projectRefreshBatch.begin();
    try {
      await this.projectWorkspace.repairDerivedCanvasCache(stable);
    } finally {
      this.projectRefreshBatch.end();
    }
  }

  private scheduleProjectIdentityProbe(path: string): void {
    if (this.unloaded || !this.projectStartupReady || !path.endsWith(".md")) return;
    const normalized = normalizePath(path);
    const existing = this.projectIdentityProbeTimers.get(normalized);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.projectIdentityProbeTimers.delete(normalized);
      if (this.unloaded || this.isProjectWorkspaceFile(normalized)) return;
      void this.projectWorkspace.hasProjectWorkspaceIdentity(normalized)
        .then((isProjectWorkspaceMarkdown) => {
          if (isProjectWorkspaceMarkdown) this.scheduleProjectRefresh(normalized);
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
      }
      this.projectRefreshBatch.begin();
      this.projectMutationDepth += 1;
      try {
        const result = await operation();
        // 项目写入返回后，详情页或任务页可能立即复读。不能等待 watcher 的
        // quiet-window 才更新，否则会再次拿到旧 Stage 行动快照。
        this.localProjectTaskSnapshotCache = null;
        return result;
      } finally {
        this.projectMutationDepth -= 1;
        this.projectRefreshBatch.end();
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
    if (!this.projectStartupReady) {
      throw new Error("Helix 正在等待 Obsidian 完成项目索引，稍后即可写入");
    }
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
      this.showPersistentNotice(`Helix 无法持久化恢复问题：${
        persistError instanceof Error ? persistError.message : String(persistError)}`);
    }
  }

  private showPersistentNotice(message: string): void {
    const notice = new Notice(message, 0);
    notice.noticeEl.addClass("helix-persistent-notice");
    this.persistentNotices.add(notice);
  }

  private dismissResolvedRecoveryNotices(activeIssues: readonly string[]): void {
    const documents = new Set<Document>([document]);
    this.app.workspace.iterateAllLeaves((leaf) => {
      documents.add(leaf.view.containerEl.ownerDocument);
    });
    for (const ownerDocument of documents) {
      for (const notice of ownerDocument.querySelectorAll<HTMLElement>(".notice")) {
        const message = notice.textContent?.trim() ?? "";
        if (!message.startsWith("Helix ") || !message.includes("需要人工检查")) continue;
        if (activeIssues.some((issue) => message.includes(issue) || issue.includes(message))) continue;
        notice.remove();
      }
    }
  }

  private async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`无法打开文件：${path}`);
    const leaf: WorkspaceLeaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const ownerWindow = leaf.view.containerEl.ownerDocument.defaultView ?? window;
    ownerWindow.requestAnimationFrame(() => {
      if (
        this.app.workspace.activeLeaf !== leaf ||
        !(leaf.view instanceof MarkdownView) ||
        leaf.view.file?.path !== file.path
      ) return;
      leaf.view.editor.focus();
    });
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
  private initialStageTitle = "";
  private color = "#5870A8";

  constructor(
    app: HelixPlugin["app"],
    private readonly submit: (
      title: string,
      initialStageTitle: string,
      color?: string,
    ) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("创建 Helix 项目");
    new Setting(this.contentEl)
      .setName("项目名称")
      .setDesc("用于项目笔记和关系图容器。")
      .addText((text) =>
        text.setPlaceholder("例如：强化学习论文实验").onChange((value) => {
          this.title = value;
        }),
      );
    new Setting(this.contentEl)
      .setName("首阶段名称")
      .setDesc("与项目同时创建，可在之后继续修改。")
      .addText((text) =>
        text.setPlaceholder("例如：确定实验方案").onChange((value) => {
          this.initialStageTitle = value;
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
      const initialStageTitle = this.initialStageTitle.trim();
      if (!title) {
        new Notice("请输入项目名称");
        return;
      }
      if (!initialStageTitle) {
        new Notice("请输入首阶段名称");
        return;
      }
      confirm.disabled = true;
      void this.submit(title, initialStageTitle, this.color)
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

class RenameEntityModal extends Modal {
  private title: string;

  constructor(
    app: HelixPlugin["app"],
    private readonly entityLabel: "项目" | "阶段",
    currentTitle: string,
    private readonly submit: (title: string) => Promise<void>,
  ) {
    super(app);
    this.title = currentTitle;
  }

  onOpen(): void {
    this.setTitle(`重命名${this.entityLabel}`);
    let input: HTMLInputElement;
    new Setting(this.contentEl)
      .setName(`${this.entityLabel}名称`)
      .addText((text) => {
        input = text.inputEl;
        text.setValue(this.title).onChange((value) => { this.title = value; });
      });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "保存" });
    const submit = (): void => {
      const title = this.title.trim();
      if (!title) {
        new Notice(`请输入${this.entityLabel}名称`);
        return;
      }
      confirm.disabled = true;
      void this.submit(title)
        .then(() => this.close())
        .catch((error) => {
          confirm.disabled = false;
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        });
    };
    confirm.addEventListener("click", submit);
    input!.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      submit();
    });
    window.setTimeout(() => {
      input!.focus();
      input!.select();
    }, 0);
  }

  onClose(): void { this.contentEl.empty(); }
}

class EditProjectModal extends Modal {
  private title: string;
  private color: string;

  constructor(
    app: HelixPlugin["app"],
    currentTitle: string,
    currentColor: string,
    private readonly submit: (title: string, color: string) => Promise<void>,
  ) {
    super(app);
    this.title = currentTitle;
    this.color = currentColor;
  }

  onOpen(): void {
    this.setTitle("编辑项目");
    let input: HTMLInputElement;
    new Setting(this.contentEl).setName("项目名称").addText((text) => {
      input = text.inputEl;
      text.setValue(this.title).onChange((value) => { this.title = value; });
    });
    new Setting(this.contentEl).setName("项目颜色").addColorPicker((picker) => {
      picker.setValue(this.color).onChange((value) => { this.color = value; });
    });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "保存" });
    const save = (): void => {
      const title = this.title.trim();
      if (!title) {
        new Notice("请输入项目名称");
        return;
      }
      confirm.disabled = true;
      void this.submit(title, this.color).then(() => this.close()).catch((error) => {
        confirm.disabled = false;
        new Notice(error instanceof Error ? error.message : String(error), 8_000);
      });
    };
    confirm.addEventListener("click", save);
    input!.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      save();
    });
    window.setTimeout(() => { input!.focus(); input!.select(); }, 0);
  }

  onClose(): void { this.contentEl.empty(); }
}

class DeleteProjectModal extends Modal {
  private static readonly CONFIRMATION = "我确认删除该项目。";
  private confirmation = "";

  constructor(
    app: HelixPlugin["app"],
    private readonly project: ProjectWorkspaceProject,
    private readonly submit: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(`删除项目：${this.project.title}`);
    this.contentEl.createEl("p", {
      cls: "helix-modal-note",
      text: `项目笔记、${this.project.cycles.length} 个阶段笔记、项目容器及其 Helix 关系将一并移入 Obsidian 废纸篓；已由 Helix 创建的对应阶段任务及子任务也会从滴答删除，但不会删除“${PROJECTION_PROJECT_NAME}”清单或其他任务。`,
    });
    this.contentEl.createEl("p", {
      text: `请输入“${DeleteProjectModal.CONFIRMATION}”以继续。`,
    });
    let remove: HTMLButtonElement;
    new Setting(this.contentEl)
      .setName("严格确认")
      .addText((text) => text
        .setPlaceholder(DeleteProjectModal.CONFIRMATION)
        .onChange((value) => {
          this.confirmation = value;
          if (remove) remove.disabled = value !== DeleteProjectModal.CONFIRMATION;
        }));
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    remove = actions.createEl("button", {
      cls: "mod-warning",
      text: "删除项目",
    });
    remove.disabled = true;
    remove.addEventListener("click", () => {
      if (this.confirmation !== DeleteProjectModal.CONFIRMATION) return;
      remove.disabled = true;
      void this.submit()
        .then(() => this.close())
        .catch((error) => {
          remove.disabled = false;
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
    private readonly nextStageCode: string,
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
      ? `合并为 ${this.project.title} / 阶段 ${this.nextStageCode}`
      : `添加阶段 ${this.nextStageCode} · ${singleSource?.cycle.title ?? this.project.title}`);
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
      .setDesc(`展示编号将自动生成为“阶段 ${this.nextStageCode}”`)
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
      text: `创建阶段 ${this.nextStageCode}`,
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

class InsertCycleModal extends Modal {
  private stageTitle = "";

  constructor(
    app: HelixPlugin["app"],
    private readonly source: ProjectWorkspaceProject["cycles"][number],
    private readonly target: ProjectWorkspaceProject["cycles"][number],
    private readonly submit: (stageTitle: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("在推进关系中插入阶段");
    this.contentEl.createDiv({
      cls: "helix-modal-note",
      text: `${this.source.title} → 新阶段 → ${this.target.title}`,
    });
    let input: HTMLInputElement;
    new Setting(this.contentEl).setName("阶段标题").addText((text) => {
      input = text.inputEl;
      text.setPlaceholder("例如：补充验证").onChange((value) => { this.stageTitle = value; });
    });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "插入阶段" });
    const save = (): void => {
      const title = this.stageTitle.trim();
      if (!title) {
        new Notice("请输入阶段标题");
        return;
      }
      confirm.disabled = true;
      void this.submit(title).then(() => this.close()).catch((error) => {
        confirm.disabled = false;
        new Notice(error instanceof Error ? error.message : String(error), 8_000);
      });
    };
    confirm.addEventListener("click", save);
    input!.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      save();
    });
    window.setTimeout(() => input!.focus(), 0);
  }

  onClose(): void { this.contentEl.empty(); }
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

function projectionSummaryMutationCount(summary: ProjectionSyncSummary): number {
  return summary.createdParents + summary.updatedParents + summary.completedParents +
    summary.createdActions + summary.updatedActions + summary.completedActions + summary.deletedActions;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}
