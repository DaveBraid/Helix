import { Notice } from "obsidian";
import type {
  DidaColumn,
  DidaFocusRecord,
  DidaHabit,
  DidaHabitCheckin,
  DidaProject,
  DidaTask,
  EntityKind,
  EntitySnapshot,
  InProgressEntry,
} from "../domain/entities";
import { InProgressRegistry } from "../domain/in-progress";
import { didaAuthorizationBinding } from "../domain/dida-authorization";
import {
  DIDA_CONTRACT_PROBE_VERSION,
  validateTaskScheduleWrite,
  type TaskScheduleMode,
} from "../domain/task-schedule";
import {
  deterministicEventId,
  EventLedger,
  isHelixEvent,
  type HelixEvent,
} from "../domain/events";
import { focusMinutes } from "../domain/focus-duration";
import { challengeProgress, rotatingChallenges } from "../domain/gamification";
import { stableHash } from "../domain/stable";
import {
  PROJECTION_COLUMN_NAME,
  type ProjectionColumnBaseline,
  type ProjectionColumnCreationCheckpoint,
  type ProjectionColumnCreationPreview,
} from "../domain/dida-project-projection";
import { DidaApi, type DidaCapabilities } from "../integrations/dida/api";
import {
  DidaFocusService,
  DidaHabitService,
  DidaProjectAdapter,
  DidaTaskAdapter,
  sameTaskBoardPlacementInvariant,
  taskBoardPlacementPayload,
  taskSyncProjection,
} from "../integrations/dida/adapters";
import { ObsidianHttpTransport } from "../integrations/dida/http";
import {
  normalizeColumns,
  normalizeProject,
  normalizeTask,
} from "../integrations/dida/normalization";
import {
  DidaWriteContractRunner,
  verifiedBoardPlacementCapability,
  type DidaWriteContractProgress,
  type DidaWriteContractReport,
} from "../integrations/dida/write-contract";
import { OfflineQueue } from "../sync/offline-queue";
import { ingestRemoteRecords } from "../sync/remote-ingest";
import { createSnapshot } from "../sync/snapshots";
import { SyncEngine, type ResolvedConflict } from "../sync/sync-engine";
import { buildConflictFields } from "../sync/three-way-merge";
import type {
  ResolutionChoice,
  SyncConflict,
  SyncQueueOperation,
} from "../sync/types";
import { HelixDataStore } from "../storage/data-store";
import type { HelixPersistedData } from "../storage/model";
import { HelixSecretStore } from "../storage/secrets";
import {
  buildTaskUpdateOperation,
  migrateInProgressTaskId,
} from "./task-operations";
import { buildProjectUpdateOperation } from "./project-operations";
import { isInsideSyncWindow } from "./sync-window";
import { SingleFlight } from "./single-flight";
import { RemoteWriteGate } from "./remote-write-gate";
import type {
  ExistingHelixProjectionCatalogPort,
  ExistingHelixTaskQueuePort,
  ProjectionCatalogSnapshot,
  ProjectionDeleteReceipt,
  ProjectionRemoteIdentity,
  ProjectionWriteReceipt,
} from "./dida-project-projection";
import { claimNextQueueOperation } from "./queue-claim";
import {
  claimConflictApplication,
  releaseConflictApplication,
} from "./conflict-claim";

export interface HelixRuntimeState {
  loading: boolean;
  connected: boolean;
  authorizationConfigured: boolean;
  projects: DidaProject[];
  tasks: DidaTask[];
  habits: DidaHabit[];
  habitCheckins: DidaHabitCheckin[];
  focus: DidaFocusRecord[];
  events: HelixEvent[];
  inProgress: InProgressEntry[];
  capabilities: DidaCapabilities | null;
  taskScheduleMode: TaskScheduleMode;
  boardPlacementVerified: boolean;
  columnCreateVerified: boolean;
  taskCrudVerified: boolean;
  reminderWriteVerified: boolean;
  repeatWriteVerified: boolean;
  parentTaskVerified: boolean;
  taskReopenVerified: boolean;
  demoMode: boolean;
  syncWarnings: string[];
  lastSyncAt?: string;
  error?: string;
  attentionCount: number;
  recoveryIssues: string[];
}

export type DidaProjectViewModeSyncStatus = "synced" | "pending" | "conflict" | "attention";

export type StateListener = (state: HelixRuntimeState) => void;

const EMPTY_STATE: HelixRuntimeState = {
  loading: false,
  connected: false,
  authorizationConfigured: false,
  projects: [],
  tasks: [],
  habits: [],
  habitCheckins: [],
  focus: [],
  events: [],
  inProgress: [],
  capabilities: null,
  taskScheduleMode: "unknown",
  boardPlacementVerified: false,
  columnCreateVerified: false,
  taskCrudVerified: false,
  reminderWriteVerified: false,
  repeatWriteVerified: false,
  parentTaskVerified: false,
  taskReopenVerified: false,
  demoMode: false,
  syncWarnings: [],
  attentionCount: 0,
  recoveryIssues: [],
};

export class HelixService implements ExistingHelixTaskQueuePort, ExistingHelixProjectionCatalogPort {
  private readonly api: DidaApi;
  private readonly habitService: DidaHabitService;
  private readonly focusService: DidaFocusService;
  private taskEngine: SyncEngine<DidaTask> | null = null;
  private projectEngine: SyncEngine<DidaProject> | null = null;
  private readonly listeners = new Set<StateListener>();
  private state: HelixRuntimeState = { ...EMPTY_STATE };
  private readonly queueDrain = new SingleFlight();
  private syncPromise: Promise<void> | null = null;
  private readonly conflictApplications = new Map<string, Promise<void>>();
  private readonly remoteWriteGate = new RemoteWriteGate();
  private readonly boardPlacementWrites = new Map<string, Promise<void>>();
  private contractTestRunning = false;
  private lastDidaWriteContractReport: DidaWriteContractReport | null = null;
  private secretMutationAuthorized = false;
  private disposed = false;

  constructor(
    private readonly store: HelixDataStore,
    private readonly secrets: HelixSecretStore,
  ) {
    this.api = new DidaApi(new ObsidianHttpTransport(), () => secrets.getDidaToken());
    this.habitService = new DidaHabitService(this.api);
    this.focusService = new DidaFocusService(this.api);
    secrets.setMutationGuard?.(() =>
      this.secretMutationAuthorized
        ? null
        : "API 口令只能通过 Helix 的授权切换流程修改");
  }

  async initialize(): Promise<void> {
    this.assertActive();
    let data = await this.store.load();
    const currentToken = this.secrets.getDidaToken();
    const currentAuthorizationBinding = currentToken
      ? await didaAuthorizationBinding(currentToken)
      : undefined;
    const verifiedCapabilities =
      data.didaContractCapabilities?.authorizationBinding === currentAuthorizationBinding
        ? data.didaContractCapabilities
        : undefined;
    const recoveredQueue = new OfflineQueue(data.queue, { recoverInterrupted: true });
    const recoveredAttention = recoveredQueue.list().filter(needsAttention).length;
    const previousAttention = data.queue.filter(needsAttention).length;
    if (data.recoveryIssues.length === 0) {
      await this.store.mutate((draft) => {
        draft.queue = recoveredQueue.list();
        const checkpoint = draft.didaProjectionState?.columnCreation;
        if (checkpoint?.status === "prepared") {
          const { columnCreation: _columnCreation, ...state } = draft.didaProjectionState!;
          draft.didaProjectionState = state;
        } else if (checkpoint?.status === "running") {
          draft.didaProjectionState = {
            ...draft.didaProjectionState!,
            columnCreation: {
              ...checkpoint,
              status: "unknown",
              errorSummary: "插件在分栏创建收口前中断",
            },
          };
        }
      });
      data = await this.store.snapshot();
    }
    this.taskEngine = new SyncEngine({
      adapter: new DidaTaskAdapter(
        this.api,
        () => this.state.taskScheduleMode,
        () => this.state,
      ),
      snapshots: this.store,
      conflicts: this.store,
      deviceId: data.deviceId,
      deferConflictFinalization: true,
      validateWrite: (value, remoteBeforeWrite) =>
        validateTaskScheduleWrite(
          value,
          this.state.taskScheduleMode,
          remoteBeforeWrite,
        ),
    });
    this.projectEngine = new SyncEngine({
      adapter: new DidaProjectAdapter(this.api),
      snapshots: this.store,
      conflicts: this.store,
      deviceId: data.deviceId,
      deferConflictFinalization: true,
    });
    const projects = attachBoardSnapshots(cachedValues<DidaProject>(data, "project"), data);
    const tasks = cachedTaskValues(data);
    const habits = cachedValues<DidaHabit>(data, "habit");
    const habitCheckins = cachedValues<DidaHabitCheckin>(data, "habit-checkin");
    const focus = cachedValues<DidaFocusRecord>(data, "focus");
    const authorizationConfigured = Boolean(this.secrets.getDidaToken());
    const hasCachedDidaData =
      projects.length > 0 ||
      tasks.length > 0 ||
      habits.length > 0 ||
      habitCheckins.length > 0 ||
      focus.length > 0;
    this.state = {
      ...this.state,
      projects,
      tasks,
      habits,
      habitCheckins,
      focus,
      events: data.events.filter(isHelixEvent),
      inProgress: data.inProgress,
      lastSyncAt: data.lastSyncAt,
      attentionCount:
        recoveredAttention +
        data.conflicts.length +
        data.recoveryIssues.length +
        (data.lineageConflict ? 1 : 0),
      recoveryIssues: data.recoveryIssues,
      connected: false,
      authorizationConfigured,
      taskScheduleMode:
        verifiedCapabilities?.taskScheduleMode ?? "unknown",
      boardPlacementVerified:
        verifiedCapabilities?.boardPlacementVerified ?? false,
      columnCreateVerified: verifiedCapabilities?.columnCreateVerified ?? false,
      taskCrudVerified: verifiedCapabilities?.taskCrudVerified ?? false,
      reminderWriteVerified: verifiedCapabilities?.reminderWriteVerified ?? false,
      repeatWriteVerified: verifiedCapabilities?.repeatWriteVerified ?? false,
      parentTaskVerified: verifiedCapabilities?.parentTaskVerified ?? false,
      taskReopenVerified: verifiedCapabilities?.taskReopenVerified ?? false,
      demoMode:
        !authorizationConfigured &&
        !hasCachedDidaData &&
        data.settings.showSampleDataWhenDisconnected &&
        tasks.length === 0,
    };
    if (recoveredAttention > previousAttention) {
      new Notice("Helix 检测到中断的远端写入，已停止自动重试；请在“冲突”中人工核对。", 10_000);
    }
    if (data.recoveryIssues.length > 0) {
      new Notice("Helix 检测到需要人工处理的恢复问题，已进入只读恢复模式；请在“冲突”中查看详情。", 12_000);
    }
    this.emit();
  }

  snapshot(): HelixRuntimeState {
    return structuredClone(this.state);
  }

  reportRecoveryIssue(issue: string): void {
    if (this.state.recoveryIssues.includes(issue)) return;
    this.state = {
      ...this.state,
      recoveryIssues: [...this.state.recoveryIssues, issue],
      attentionCount: this.state.attentionCount + 1,
    };
    this.emit();
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async replaceDidaToken(token: string): Promise<void> {
    const normalized = token.trim();
    if (normalized.length < 10) throw new Error("API 口令长度异常");
    await this.changeDidaAuthorization(() => this.secrets.setDidaToken(normalized));
  }

  async clearDidaToken(): Promise<void> {
    await this.changeDidaAuthorization(() => this.secrets.clearDidaToken());
  }

  private async changeDidaAuthorization(mutateSecret: () => void): Promise<void> {
    this.assertActive();
    const releaseExclusive = this.remoteWriteGate.enterExclusive("API 口令切换");
    try {
      await this.store.mutate((data) => {
        delete data.didaContractCapabilities;
      });
      this.secretMutationAuthorized = true;
      try {
        mutateSecret();
      } finally {
        this.secretMutationAuthorized = false;
      }
      this.patch({
        connected: false,
        authorizationConfigured: Boolean(this.secrets.getDidaToken()),
        capabilities: null,
        taskScheduleMode: "unknown",
        boardPlacementVerified: false,
        columnCreateVerified: false,
        taskCrudVerified: false,
        reminderWriteVerified: false,
        repeatWriteVerified: false,
        parentTaskVerified: false,
        taskReopenVerified: false,
        demoMode:
          !this.secrets.getDidaToken() &&
          this.state.projects.length === 0 &&
          this.state.tasks.length === 0 &&
          this.state.habits.length === 0 &&
          this.state.habitCheckins.length === 0 &&
          this.state.focus.length === 0 &&
          (await this.store.snapshot()).settings.showSampleDataWhenDisconnected,
      });
    } finally {
      releaseExclusive();
    }
  }

  async sync(): Promise<void> {
    this.assertWritable();
    if (this.syncPromise) return this.syncPromise;
    const current = this.withAuthorizationLease(() => this.syncWithAuthorizationLease(false))
      .finally(() => {
        if (this.syncPromise === current) this.syncPromise = null;
      });
    this.syncPromise = current;
    return current;
  }

  async pullOnlySync(): Promise<void> {
    this.assertWritable();
    if (this.syncPromise) throw new Error("已有滴答同步正在进行，请完成后再执行只读拉取");
    const releaseExclusive = this.remoteWriteGate.enterExclusive("滴答只读拉取");
    const current = this.syncWithAuthorizationLease(true)
      .finally(() => {
        releaseExclusive();
        if (this.syncPromise === current) this.syncPromise = null;
      });
    this.syncPromise = current;
    return current;
  }

  private async syncWithAuthorizationLease(pullOnly: boolean): Promise<void> {
    this.patch({ loading: true, error: undefined, syncWarnings: [] });
    try {
      const capturedAt = new Date().toISOString();
      // 先完整读取所有项目；任何一页失败时保留上一次可用快照，避免发布“半份数据”。
      const projectPayload = await this.api.getProjects();
      if (!Array.isArray(projectPayload)) throw new Error("项目接口返回值不是数组");
      const projects = projectPayload.map((project) => projectSyncValue(normalizeProject(project)));
      // 清单详情只用于证明删除覆盖；单个详情失败不能阻断全局清单与任务发布。
      const projectCoverage = await Promise.allSettled(
        projects.map((project) => this.api.getProjectData(project.id)),
      );
      const verifiedProjectIds = new Set<string>();
      const boardDetailsByProject = new Map<string, {
        columns: DidaColumn[];
        taskColumnIds: Record<string, string | null>;
      }>();
      const projectDetailTasks: DidaTask[] = [];
      for (const [index, result] of projectCoverage.entries()) {
        if (result.status !== "fulfilled") continue;
        const expectedProject = projects[index]!;
        try {
          const detailProject = normalizeProject(result.value.project);
          if (detailProject.id !== expectedProject.id || !Array.isArray(result.value.tasks)) {
            continue;
          }
          const columns = normalizeColumns(result.value.columns);
          if (columns.some((column) => column.projectId !== expectedProject.id)) continue;
          const detailTasks = result.value.tasks.map(normalizeTask);
          if (detailTasks.some((task) => task.projectId !== expectedProject.id)) continue;
          boardDetailsByProject.set(expectedProject.id, {
            columns,
            taskColumnIds: Object.fromEntries(
              detailTasks
                .filter((task) => task.columnId !== undefined)
                .map((task) => [task.id, task.columnId ?? null]),
            ),
          });
          verifiedProjectIds.add(expectedProject.id);
          projectDetailTasks.push(...detailTasks.map(taskSyncValue));
        } catch {
          // 结构无效等同本清单覆盖未获证明；保留旧快照且不参与删除推断。
        }
      }
      const syncWarnings: string[] = [];
      const failedProjectCoverage = projectCoverage.length - verifiedProjectIds.size;
      if (failedProjectCoverage > 0) {
        syncWarnings.push(`${failedProjectCoverage} 个清单暂未完成删除覆盖校验`);
      }
      const completedFrom = new Date(Date.now() - 31 * 86_400_000).toISOString();
      const completedTo = new Date().toISOString();
      const [openPayload, completedPayload] = await Promise.all([
        this.api.filterTasks({ status: [0, -1] }),
        this.api.getCompletedTasks({ startDate: completedFrom, endDate: completedTo }),
      ]);
      if (!Array.isArray(openPayload) || !Array.isArray(completedPayload)) {
        throw new Error("任务接口返回值不是数组，拒绝发布不完整快照");
      }
      const tasks = deduplicateTasks([
        ...projectDetailTasks,
        ...openPayload.map(normalizeTaskWithoutBoardProjection),
        ...completedPayload.map(normalizeTaskWithoutBoardProjection),
      ]);

      const now = Date.now();
      const from = now - 31 * 86_400_000;
      let habits = this.state.habits;
      let habitCheckins = this.state.habitCheckins;
      let focus = this.state.focus;
      let habitCoverageComplete = false;
      let focusCoverageComplete = false;
      const capabilityErrors: string[] = [];
      const [habitResult, focusResult] = await Promise.allSettled([
        (async () => {
        const nextHabits = await this.habitService.list();
        const nextHabitCheckins = nextHabits.length > 0
          ? await this.habitService.checkins(nextHabits.map((habit) => habit.id), from, now)
          : [];
          return { habits: nextHabits, checkins: nextHabitCheckins };
        })(),
        this.focusService.list(
          new Date(from).toISOString(),
          new Date(now).toISOString(),
        ),
      ]);
      if (habitResult.status === "fulfilled") {
        habits = habitResult.value.habits;
        habitCheckins = habitResult.value.checkins;
        habitCoverageComplete = true;
      } else {
        capabilityErrors.push("habits: unavailable");
        syncWarnings.push("习惯数据暂不可用，已保留上次缓存");
      }
      if (focusResult.status === "fulfilled") {
        focus = focusResult.value;
        focusCoverageComplete = true;
      } else {
        capabilityErrors.push("focus: unavailable");
        syncWarnings.push("专注数据暂不可用，已保留上次缓存");
      }
      const capabilities: DidaCapabilities = {
        projects: "available",
        tasks: "available",
        habits: habitCoverageComplete ? "available" : "unavailable",
        focus: focusCoverageComplete ? "available" : "unavailable",
        checkedAt: new Date().toISOString(),
        errors: capabilityErrors,
      };
      if (this.disposed) return;
      await this.store.mutate((data) => {
        const ledger = new EventLedger(data.events.filter(isHelixEvent));
        for (const event of eventsFromDida(data, tasks, habitCheckins, focus, {
          capturedAt,
          habitCoverageComplete,
          focusCoverageComplete,
          coverageFrom: from,
          coverageTo: now,
        })) {
          if (event.type === "focus-completed") ledger.refreshDerivedFocusCompleted(event);
          else ledger.append(event);
        }
        appendEarnedChallengeAwards(ledger, capturedAt);
        data.events = ledger.list();
        const coveredProjectIds = new Set(
          Object.values(data.baseSnapshots)
            .filter((snapshot) => snapshot.kind === "project")
            .map((snapshot) => snapshot.entityId),
        );
        for (const project of projects) coveredProjectIds.add(project.id);
        ingestRemoteRecords(data, "project", projects, {
          capturedAt,
          coveredEntityIds: coveredProjectIds,
        });
        const remoteProjectIds = new Set(projects.map((project) => project.id));
        for (const projectId of Object.keys(data.boardSnapshots)) {
          if (!remoteProjectIds.has(projectId)) delete data.boardSnapshots[projectId];
        }
        for (const project of projects) {
          const boardDetails = boardDetailsByProject.get(project.id);
          if (boardDetails) {
            data.boardSnapshots[project.id] = {
              projectId: project.id,
              columns: boardDetails.columns,
              taskColumnIds: boardDetails.taskColumnIds,
              capturedAt,
              stale: false,
            };
          } else {
            const previousBoard = data.boardSnapshots[project.id];
            if (previousBoard) {
              data.boardSnapshots[project.id] = { ...previousBoard, stale: true };
            }
          }
        }
        const coveredTasks = new Set(tasks.map((task) => task.id));
        const lastSyncIsInsideCompletionWindow =
          !!data.lastSyncAt &&
          new Date(data.lastSyncAt).getTime() >= Date.now() - 31 * 86_400_000;
        if (lastSyncIsInsideCompletionWindow) {
          for (const snapshot of Object.values(data.baseSnapshots)) {
            if (snapshot.kind !== "task") continue;
            const value = snapshot.value as Partial<DidaTask>;
            if (
              value.status !== 2 &&
              value.projectId &&
              (verifiedProjectIds.has(value.projectId) || value.projectId.toLowerCase().includes("inbox"))
            ) {
              coveredTasks.add(snapshot.entityId);
            }
          }
        }
        ingestRemoteRecords(data, "task", tasks, {
          capturedAt,
          coveredEntityIds: coveredTasks,
        });
        data.inProgress = data.inProgress.map((entry) => {
          const task = data.localSnapshots[`task:${entry.taskId}`]?.value as
            | Partial<DidaTask>
            | null
            | undefined;
          return typeof task?.projectId === "string"
            ? { ...entry, projectId: task.projectId }
            : entry;
        });
        replaceReadOnlySnapshots(data, "habit", habits, capturedAt, (habit) => habit.id);
        replaceReadOnlySnapshots(
          data,
          "habit-checkin",
          habitCheckins,
          capturedAt,
          (checkin) => checkin.id ?? `${checkin.habitId}:${checkin.checkinTime}`,
        );
        replaceReadOnlySnapshots(data, "focus", focus, capturedAt, (record) => record.id);
        data.lastSyncAt = capturedAt;
      });
      if (this.disposed) return;
      if (!pullOnly) await this.drainQueue();
      if (this.disposed) return;
      const finalData = await this.store.snapshot();
      const finalTasks = cachedTaskValues(finalData);
      const finalProjects = addUnlistedProjects(
        attachBoardSnapshots(cachedValues<DidaProject>(finalData, "project"), finalData),
        finalTasks,
      );
      this.patch({
        loading: false,
        connected: true,
        projects: finalProjects,
        tasks: finalTasks,
        habits: cachedValues<DidaHabit>(finalData, "habit"),
        habitCheckins: cachedValues<DidaHabitCheckin>(finalData, "habit-checkin"),
        focus: cachedValues<DidaFocusRecord>(finalData, "focus"),
        events: finalData.events.filter(isHelixEvent),
        inProgress: finalData.inProgress,
        attentionCount:
          finalData.conflicts.length +
          finalData.queue.filter(needsAttention).length +
          finalData.recoveryIssues.length +
          (finalData.lineageConflict ? 1 : 0),
        recoveryIssues: finalData.recoveryIssues,
        capabilities,
        demoMode: false,
        syncWarnings,
        lastSyncAt: capturedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patch({ loading: false, connected: false, error: message });
      throw error;
    }
  }

  async probeConnection(): Promise<DidaCapabilities> {
    this.assertActive();
    return this.withAuthorizationLease(() => this.probeConnectionWithAuthorizationLease());
  }

  private async probeConnectionWithAuthorizationLease(): Promise<DidaCapabilities> {
    const capabilities = await this.api.probeCapabilities();
    if (capabilities.projects !== "available" || capabilities.tasks !== "available") {
      throw new Error(capabilities.errors.join("；") || "任务与项目接口不可用");
    }
    this.patch({ capabilities, connected: true, error: undefined });
    return capabilities;
  }

  async runDidaWriteContractTest(
    onProgress?: (progress: DidaWriteContractProgress) => void,
  ): Promise<DidaWriteContractReport> {
    this.assertWritable();
    if (this.state.loading) throw new Error("同步正在进行，请完成后再运行写入合同测试");
    const releaseExclusive = this.remoteWriteGate.enterExclusive("滴答写入合同测试");
    this.contractTestRunning = true;
    this.patch({ loading: true, error: undefined });
    try {
      // 任何远端写入前先让旧能力缓存失效并发布只读；失败则绝不启动合同。
      try {
        await this.store.mutate((data) => {
          delete data.didaContractCapabilities;
        });
      } catch (error) {
        this.publishContractReadOnly();
        throw error;
      }
      this.publishContractReadOnly();
      const contractApi = this.api.withRequestPolicy({ timeoutMs: 5_000, maxAttempts: 1 });
      const report = await new DidaWriteContractRunner(
        contractApi,
        undefined,
        undefined,
        undefined,
        onProgress,
      ).run();
      this.lastDidaWriteContractReport = report;
      const contractComplete = report.status === "passed" &&
        !report.remoteArtifactsRemaining &&
        !report.manualCleanupRequired &&
        report.taskScheduleMode !== "unknown";
      try {
        if (contractComplete) {
        const boardPlacementVerified = verifiedBoardPlacementCapability(report);
        const contractArtifactsClean = !report.remoteArtifactsRemaining;
        const columnCreateVerified = report.columnCreateVerified && contractArtifactsClean;
        const taskCrudVerified = report.taskCrudVerified && contractArtifactsClean;
        const reminderWriteVerified = report.reminderWriteVerified && contractArtifactsClean;
        const repeatWriteVerified = report.repeatWriteVerified && contractArtifactsClean;
        const parentTaskVerified = report.parentTaskVerified && contractArtifactsClean;
        const taskReopenVerified = report.taskReopenVerified && contractArtifactsClean;
        const token = this.secrets.getDidaToken();
        if (!token) throw new Error("写入合同结束时滴答授权已缺失");
        const authorizationBinding = await didaAuthorizationBinding(token);
        await this.store.mutate((data) => {
          data.didaContractCapabilities = {
            probeVersion: DIDA_CONTRACT_PROBE_VERSION,
            authorizationBinding,
            taskScheduleMode: report.taskScheduleMode as Exclude<TaskScheduleMode, "unknown">,
            boardPlacementVerified,
            columnCreateVerified,
            taskCrudVerified,
            reminderWriteVerified,
            repeatWriteVerified,
            parentTaskVerified,
            taskReopenVerified,
            verifiedAt: new Date().toISOString(),
          };
        });
        this.patch({
          taskScheduleMode: report.taskScheduleMode,
          boardPlacementVerified,
          columnCreateVerified,
          taskCrudVerified,
          reminderWriteVerified,
          repeatWriteVerified,
          parentTaskVerified,
          taskReopenVerified,
        });
        } else {
          await this.store.mutate((data) => {
            delete data.didaContractCapabilities;
          });
          this.publishContractReadOnly();
        }
      } catch (error) {
        this.publishContractReadOnly();
        throw error;
      }
      return report;
    } finally {
      this.contractTestRunning = false;
      releaseExclusive();
      this.patch({ loading: false });
    }
  }

  private publishContractReadOnly(): void {
    this.patch({
      taskScheduleMode: "unknown",
      boardPlacementVerified: false,
      columnCreateVerified: false,
      taskCrudVerified: false,
      reminderWriteVerified: false,
      repeatWriteVerified: false,
      parentTaskVerified: false,
      taskReopenVerified: false,
    });
  }

  didaWriteContractRuntimeSummary(): string {
    const capability = (name: string, value: boolean) => `${name}${value ? "已验证" : "只读"}`;
    const recent = this.lastDidaWriteContractReport
      ? `最近运行${this.lastDidaWriteContractReport.status === "passed" ? "通过" : "未通过"}` +
        `${this.lastDidaWriteContractReport.remoteArtifactsRemaining ? "，存在待人工核对对象" : "，测试对象已安全清理"}`
      : "本次插件运行尚未执行合同测试";
    return [
      `合同版本 ${DIDA_CONTRACT_PROBE_VERSION}`,
      capability("基础任务：", this.state.taskCrudVerified),
      capability("提醒：", this.state.reminderWriteVerified),
      capability("重复：", this.state.repeatWriteVerified),
      capability("父子：", this.state.parentTaskVerified),
      capability("看板：", this.state.boardPlacementVerified),
      capability("分栏创建：", this.state.columnCreateVerified),
      recent,
    ].join("；");
  }

  async verifyRemoteTask(projectId: string, taskId: string): Promise<DidaTask> {
    this.assertActive();
    return this.withAuthorizationLease(() =>
      this.verifyRemoteTaskWithAuthorizationLease(projectId, taskId));
  }

  async verifyRemoteProject(projectId: string): Promise<DidaProject> {
    this.assertActive();
    return this.withAuthorizationLease(async () => {
      const project = normalizeProject(await this.api.getProject(projectId));
      if (project.id !== projectId) {
        throw new Error("滴答复读返回的清单身份与待映射目标不一致");
      }
      return project;
    });
  }

  async readProjectionCatalog(projectId: string): Promise<ProjectionCatalogSnapshot> {
    return this.withAuthorizationLease(() => this.readProjectionCatalogWithLeaseHeld(projectId));
  }

  private async readProjectionCatalogWithLeaseHeld(
    projectId: string,
  ): Promise<ProjectionCatalogSnapshot> {
      this.assertActive();
      const [projectResponse, detailResponse, columnsResponse] = await Promise.all([
        this.api.getProject(projectId),
        this.api.getProjectData(projectId),
        this.api.getColumns(projectId),
      ]);
      const project = normalizeProject(projectResponse);
      const detailProject = normalizeProject(detailResponse.project);
      const detailColumns = normalizeColumns(detailResponse.columns);
      const endpointColumns = normalizeColumns(columnsResponse);
      if (project.id !== projectId || detailProject.id !== projectId) {
        throw new Error("投影目标清单精确复读身份不一致");
      }
      if (stableHash(projectSyncValue(project)) !== stableHash(projectSyncValue(detailProject))) {
        throw new Error("投影目标清单双源复读不一致");
      }
      if (!sameColumns(detailColumns, endpointColumns) ||
        endpointColumns.some((column) => column.projectId !== projectId)) {
        throw new Error("投影目标看板列双源复读不一致");
      }
      const data = await this.store.snapshot();
      const unknownOperationIds = new Set([
        ...data.queue.filter((operation) =>
          operation.status === "reconciliation" || operation.remoteOutcomeUnknown)
          .map((operation) => operation.id),
        ...data.projectionOperationReceipts.filter((receipt) => receipt.outcome === "unknown")
          .map((receipt) => receipt.operationId),
      ]);
      return {
        projects: [project],
        columns: endpointColumns,
        readiness: {
          writable: !this.contractTestRunning && data.recoveryIssues.length === 0,
          queueEmpty: data.queue.length === 0,
          authorizationCurrent: Boolean(this.secrets.getDidaToken()) && this.state.taskCrudVerified,
          parentTaskVerified: this.state.parentTaskVerified,
          boardPlacementVerified: this.state.boardPlacementVerified,
          boardFresh: true,
          taskReopenVerified: this.state.taskReopenVerified,
          unknownOutcomes: unknownOperationIds.size,
        },
      };
  }

  async previewProjectionColumnCreation(projectId: string): Promise<ProjectionColumnCreationPreview> {
    return this.withAuthorizationLease(() => this.previewProjectionColumnCreationWithLease(projectId));
  }

  async confirmProjectionColumnCreation(
    preview: ProjectionColumnCreationPreview,
    confirmedHash: string,
  ): Promise<DidaColumn> {
    const releaseExclusive = this.remoteWriteGate.enterExclusive("项目投影分栏创建");
    try {
      this.assertWritable();
      const fresh = await this.previewProjectionColumnCreationWithLease(preview.targetProjectId);
      if (confirmedHash !== preview.previewHash || fresh.previewHash !== preview.previewHash) {
        throw new Error("分栏创建预览已经变化，必须重新预览");
      }
      if (fresh.blockers.length > 0) throw new Error(`分栏创建被阻止：${fresh.blockers.join("；")}`);
      const checkpoint: ProjectionColumnCreationCheckpoint = {
        operationId: `projection-column:${crypto.randomUUID()}`,
        targetProjectId: fresh.targetProjectId,
        desiredName: PROJECTION_COLUMN_NAME,
        baselineColumns: structuredClone(fresh.baselineColumns),
        baselineHash: fresh.baselineHash,
        previewHash: fresh.previewHash,
        status: "prepared",
      };
      await this.store.mutate((data) => {
        const state = projectionStateOrDefault(data);
        if (state.columnCreation) throw new Error("已有分栏创建结果等待收口，禁止再次发送");
        data.didaProjectionState = { ...state, columnCreation: structuredClone(checkpoint) };
      });
      try {
        await this.updateProjectionColumnCheckpoint(checkpoint.operationId, (current) => ({
          ...current,
          status: "running",
        }));
      } catch (error) {
        await this.clearPreparedProjectionColumnCheckpoint(checkpoint.operationId);
        throw error;
      }
      let created: DidaColumn;
      try {
        created = normalizeColumns([
          await this.api.createColumn(checkpoint.targetProjectId, { name: PROJECTION_COLUMN_NAME }),
        ])[0]!;
        if (!created.id || created.projectId !== checkpoint.targetProjectId ||
          created.name !== PROJECTION_COLUMN_NAME) {
          throw new Error("分栏创建响应的 ID、名称或清单归属无效");
        }
        await this.updateProjectionColumnCheckpoint(checkpoint.operationId, (current) => ({
          ...current,
          remoteColumnId: created.id,
        }));
        const catalog = await this.readProjectionCatalogWithLeaseHeld(checkpoint.targetProjectId);
        if (uniqueCreatedProjectionColumnId(checkpoint, catalog.columns) !== created.id) {
          throw new Error("分栏创建后出现并发列变化或返回 ID 不一致");
        }
        verifyCreatedProjectionColumn(checkpoint, catalog.columns, created.id);
        await this.clearProjectionColumnCheckpoint(checkpoint.operationId);
        return created;
      } catch (error) {
        await this.freezeProjectionColumnCreation(checkpoint.operationId);
        throw new Error("分栏创建结果未知，已冻结；请前往冲突中心精确复核", { cause: error });
      }
    } finally {
      releaseExclusive();
    }
  }

  async reconcileProjectionColumnCreation(): Promise<DidaColumn> {
    this.assertWritable();
    return this.withAuthorizationLease(async () => {
      const data = await this.store.snapshot();
      const checkpoint = data.didaProjectionState?.columnCreation;
      if (!checkpoint || checkpoint.status !== "unknown") {
        throw new Error("没有等待复核的分栏创建结果");
      }
      const catalog = await this.readProjectionCatalogWithLeaseHeld(checkpoint.targetProjectId);
      const columnId = checkpoint.remoteColumnId ?? uniqueCreatedProjectionColumnId(checkpoint, catalog.columns);
      verifyCreatedProjectionColumn(checkpoint, catalog.columns, columnId);
      const column = catalog.columns.find((candidate) => candidate.id === columnId)!;
      await this.clearProjectionColumnCheckpoint(checkpoint.operationId);
      return column;
    });
  }

  private async previewProjectionColumnCreationWithLease(
    projectId: string,
  ): Promise<ProjectionColumnCreationPreview> {
    const catalog = await this.readProjectionCatalogWithLeaseHeld(projectId);
    const project = catalog.projects[0];
    if (!project || project.id !== projectId) throw new Error("分栏创建目标清单身份不一致");
    const baselineColumns = projectionColumnBaseline(catalog.columns, projectId);
    const baselineHash = stableHash(baselineColumns);
    const state = (await this.store.snapshot()).didaProjectionState;
    const blockers = [
      !catalog.readiness.writable ? "当前处于只读恢复状态" : undefined,
      !catalog.readiness.queueEmpty ? "待写队列非空" : undefined,
      !catalog.readiness.authorizationCurrent ? "当前授权的基础写入合同已失效" : undefined,
      !this.state.columnCreateVerified ? "当前授权尚未通过分栏创建合同" : undefined,
      catalog.readiness.unknownOutcomes > 0 ? "存在结果未知操作" : undefined,
      state?.columnCreation ? "已有分栏创建结果等待冲突中心收口" : undefined,
      state?.target && state.target.targetProjectId !== projectId
        ? `当前项目投影已绑定其他清单 ${state.target.targetProjectId}`
        : undefined,
      baselineColumns.some((column) => column.name === PROJECTION_COLUMN_NAME)
        ? `已存在同名分栏“${PROJECTION_COLUMN_NAME}”`
        : undefined,
    ].filter((item): item is string => Boolean(item));
    const previewHash = stableHash({
      targetProjectId: projectId,
      projectName: project.name,
      desiredName: PROJECTION_COLUMN_NAME,
      baselineColumns,
      baselineHash,
      blockers,
    });
    return {
      targetProjectId: projectId,
      projectName: project.name,
      desiredName: PROJECTION_COLUMN_NAME,
      baselineColumns,
      baselineHash,
      previewHash,
      blockers,
    };
  }

  private async updateProjectionColumnCheckpoint(
    operationId: string,
    update: (current: ProjectionColumnCreationCheckpoint) => ProjectionColumnCreationCheckpoint,
  ): Promise<void> {
    await this.store.mutate((data) => {
      const state = projectionStateOrDefault(data);
      if (!state.columnCreation || state.columnCreation.operationId !== operationId) {
        throw new Error("分栏创建 checkpoint 在持久化前发生竞争");
      }
      data.didaProjectionState = { ...state, columnCreation: update(state.columnCreation) };
    });
  }

  private async freezeProjectionColumnCreation(operationId: string): Promise<void> {
    try {
      await this.updateProjectionColumnCheckpoint(operationId, (current) => ({
        ...current,
        status: "unknown",
        errorSummary: "分栏创建远端结果未知",
      }));
    } catch {
      // 保留竞争后的权威持久状态；绝不为补写 checkpoint 重发远端请求。
    }
  }

  private async clearPreparedProjectionColumnCheckpoint(operationId: string): Promise<void> {
    try {
      await this.store.mutate((data) => {
        const state = projectionStateOrDefault(data);
        const checkpoint = state.columnCreation;
        if (!checkpoint) return;
        if (checkpoint.operationId === operationId && checkpoint.status === "prepared") {
          const { columnCreation: _columnCreation, ...rest } = state;
          data.didaProjectionState = rest;
          return;
        }
        const issue = "分栏创建 prepared→running 持久化发生竞争；未发送远端请求，已保留权威状态";
        if (!data.recoveryIssues.includes(issue)) data.recoveryIssues.push(issue);
      });
    } catch {
      // 原始持久化错误优先返回；prepared 仍证明请求未发送，重启恢复会安全清除。
    }
  }

  private async clearProjectionColumnCheckpoint(operationId: string): Promise<void> {
    await this.store.mutate((data) => {
      const state = projectionStateOrDefault(data);
      if (!state.columnCreation || state.columnCreation.operationId !== operationId) {
        throw new Error("分栏创建 checkpoint 在收口前发生竞争");
      }
      const { columnCreation: _columnCreation, ...rest } = state;
      data.didaProjectionState = rest;
    });
  }

  private async verifyRemoteTaskWithAuthorizationLease(
    projectId: string,
    taskId: string,
  ): Promise<DidaTask> {
    const task = normalizeTask(await this.api.getTask(projectId, taskId));
    if (task.id !== taskId || task.projectId !== projectId) {
      throw new Error("滴答复读返回的任务身份或清单与待绑定目标不一致");
    }
    return task;
  }

  async refreshPersistedEvents(): Promise<void> {
    this.assertActive();
    const data = await this.store.snapshot();
    this.patch({
      events: data.events.filter(isHelixEvent),
      attentionCount:
        data.conflicts.length +
        data.queue.filter(needsAttention).length +
        data.recoveryIssues.length +
        (data.lineageConflict ? 1 : 0),
    });
  }

  async appendLocalEvents(events: HelixEvent[]): Promise<void> {
    this.assertWritable();
    await this.store.mutate((data) => {
      const ledger = new EventLedger(data.events.filter(isHelixEvent));
      for (const event of events) {
        ledger.append(event);
        appendEarnedChallengeAwards(ledger, event.occurredAt);
      }
      data.events = ledger.list();
    });
    await this.refreshPersistedEvents();
  }

  async toggleInProgress(taskId: string): Promise<void> {
    this.assertWritable();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("找不到任务");
    const existing = this.state.inProgress.find((entry) => entry.taskId === taskId);
    const now = new Date().toISOString();
    await this.store.mutate((data) => {
      data.inProgress = existing
        ? data.inProgress.filter((entry) => entry.taskId !== taskId)
        : [
            ...data.inProgress,
            {
              taskId,
              projectId: task.projectId,
              markedAt: now,
              lastTouchedAt: now,
              activeFocus: false,
            },
          ];
    });
    const data = await this.store.snapshot();
    this.patch({ inProgress: data.inProgress });
  }

  async createTask(
    title: string,
    projectId: string,
    attributes: Partial<Pick<DidaTask, "content" | "tags" | "priority">> = {},
  ): Promise<void> {
    this.assertWritable();
    this.assertTaskCrudVerified();
    const releaseAuthorizationLease = this.remoteWriteGate.enterShared();
    try {
      await this.createTaskWithAuthorizationLease(title, projectId, attributes);
    } finally {
      releaseAuthorizationLease();
    }
  }

  async enqueueProjectionCreate(
    task: DidaTask,
    clientIdentity: string,
  ): Promise<ProjectionWriteReceipt> {
    const release = this.remoteWriteGate.enterShared();
    try {
      this.assertWritable();
      this.assertProjectionCapabilities(false);
      const existing = await this.recoverProjectionCreate(clientIdentity, task.projectId);
      if (existing) return existing;
      const now = new Date().toISOString();
      const localId = `local-projection-${stableHash(clientIdentity).slice(0, 24)}`;
      const localTask = { ...task, id: localId };
      const operation: SyncQueueOperation<DidaTask> = {
        id: `op-projection-${stableHash(clientIdentity).slice(0, 32)}`,
        kind: "task",
        entityId: localId,
        projectId: task.projectId,
        operation: "create",
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        status: "pending",
        idempotencyFingerprint: clientIdentity,
        local: createSnapshot("task", localId, localTask, { capturedAt: now }),
        writeFields: ["title", "content", "parentId", "columnId"],
      };
      await this.store.mutate((data) => {
        if (data.projectionOperationReceipts.some((item) => item.clientIdentity === clientIdentity) ||
          data.queue.some((item) => item.idempotencyFingerprint === clientIdentity)) {
          throw new Error("投影创建 client identity 已被占用，请恢复既有收据");
        }
        data.localSnapshots[`task:${localId}`] = operation.local as EntitySnapshot<unknown>;
        const queue = new OfflineQueue(data.queue);
        queue.enqueue(operation);
        data.queue = queue.list();
      });
      await this.queueDrain.run(() => this.runDrainQueueWithRemoteWrite());
      return (await this.recoverProjectionCreate(clientIdentity, task.projectId)) ?? {
        operationId: operation.id,
        outcome: "retryable",
        message: "投影创建已持久排队，尚未取得写后收据",
      };
    } finally {
      release();
    }
  }

  async recoverProjectionCreate(
    clientIdentity: string,
    projectId: string,
  ): Promise<ProjectionWriteReceipt | null> {
    const data = await this.store.snapshot();
    const receipt = data.projectionOperationReceipts.find((item) =>
      item.clientIdentity === clientIdentity && item.projectId === projectId);
    if (receipt) return projectionWriteReceipt(receipt, data);
    const operation = data.queue.find((item) =>
      item.kind === "task" && item.operation === "create" &&
      item.idempotencyFingerprint === clientIdentity && item.projectId === projectId);
    if (!operation) return null;
    return {
      operationId: operation.id,
      outcome: operation.remoteOutcomeUnknown || operation.status === "reconciliation"
        ? "unknown"
        : operation.status === "blocked" ? "conflict" : "retryable",
      message: operation.lastError ?? "投影创建仍在现有持久队列中",
      conflictId: operation.conflictId,
    };
  }

  async enqueueProjectionUpdate(task: DidaTask, writeFields: string[]): Promise<ProjectionWriteReceipt> {
    return this.enqueueProjectionExisting(task, "update", writeFields);
  }

  async enqueueProjectionComplete(task: DidaTask): Promise<ProjectionWriteReceipt> {
    return this.enqueueProjectionExisting(task, "complete", []);
  }

  async enqueueProjectionReopen(task: DidaTask): Promise<ProjectionWriteReceipt> {
    return this.enqueueProjectionExisting(task, "update", ["status"]);
  }

  async enqueueProjectionDelete(expected: ProjectionRemoteIdentity): Promise<ProjectionDeleteReceipt> {
    const release = this.remoteWriteGate.enterShared();
    try {
      this.assertWritable();
      this.assertProjectionCapabilities(false);
      const remote = await this.verifyRemoteTaskWithAuthorizationLease(
        expected.targetProjectId,
        expected.taskId,
      );
      if (remote.parentId !== expected.parentTaskId || remote.columnId !== expected.targetColumnId ||
        remote.content !== expected.marker) {
        return { operationId: `op-projection-delete-${crypto.randomUUID()}`, outcome: "conflict", message: "投影删除写前身份复读不一致" };
      }
      const now = new Date().toISOString();
      const base = createSnapshot("task", remote.id, remote, { capturedAt: now });
      const operation: SyncQueueOperation<DidaTask> = {
        id: `op-projection-delete-${crypto.randomUUID()}`,
        kind: "task",
        entityId: remote.id,
        projectId: remote.projectId,
        operation: "delete",
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        status: "pending",
        idempotencyFingerprint: `helix-delete:${expected.marker}`,
        base,
        local: createSnapshot("task", remote.id, null as unknown as DidaTask, { capturedAt: now }),
      };
      return this.enqueueAndDrainProjectionOperation(operation, true) as Promise<ProjectionDeleteReceipt>;
    } finally {
      release();
    }
  }

  private async createTaskWithAuthorizationLease(
    title: string,
    projectId: string,
    attributes: Partial<Pick<DidaTask, "content" | "tags" | "priority">>,
  ): Promise<void> {
    const normalized = title.trim();
    if (!normalized) throw new Error("任务标题不能为空");
    if (projectId.startsWith("local-project-")) {
      throw new Error("该清单尚未取得滴答远端 ID，请先在冲突中心完成核对");
    }
    const now = new Date().toISOString();
    const localId = `local-${crypto.randomUUID()}`;
    const task: DidaTask = {
      id: localId,
      projectId,
      title: normalized,
      status: 0,
      content: attributes.content,
      tags: attributes.tags
        ? [...new Set(attributes.tags.map((tag) => tag.trim()).filter(Boolean))].sort(
            (left, right) => left.localeCompare(right),
          )
        : undefined,
      priority: attributes.priority ?? 0,
    };
    const local = createSnapshot("task", localId, task, { capturedAt: now });
    const operation: SyncQueueOperation<DidaTask> = {
      id: `op-${crypto.randomUUID()}`,
      kind: "task",
      entityId: localId,
      projectId,
      operation: "create",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      status: "pending",
      idempotencyFingerprint: `${projectId}:${normalized}:${now.slice(0, 16)}`,
      local,
    };
    let effectiveOperationId = operation.id;
    await this.store.mutate((data) => {
      data.localSnapshots[`task:${localId}`] = local;
      const queue = new OfflineQueue(data.queue);
      effectiveOperationId = queue.enqueue(operation);
      data.queue = queue.list();
    });
    this.patch({ tasks: [...this.state.tasks, task] });
    await this.drainQueue();
    await this.throwIfOperationNeedsAttention(effectiveOperationId);
    this.patch({
      tasks: cachedTaskValues(await this.store.snapshot()),
    });
  }

  async createDidaProject(name: string, color?: string): Promise<void> {
    this.assertWritable();
    this.assertContractWriteVerified();
    const releaseAuthorizationLease = this.remoteWriteGate.enterShared();
    try {
      const normalized = name.trim();
      if (!normalized) throw new Error("清单名称不能为空");
      if (this.state.projects.some((project) => project.name === normalized)) {
        throw new Error("已经存在同名清单");
      }
      const normalizedColor = color?.trim();
      if (normalizedColor && !/^#[0-9a-f]{6}$/iu.test(normalizedColor)) {
        throw new Error("清单颜色必须为 #RRGGBB");
      }
      const now = new Date().toISOString();
      const localId = `local-project-${crypto.randomUUID()}`;
      const project: DidaProject = {
        id: localId,
        name: normalized,
        color: normalizedColor || undefined,
      };
      const local = createSnapshot("project", localId, project, { capturedAt: now });
      const operation: SyncQueueOperation<DidaProject> = {
        id: `op-${crypto.randomUUID()}`,
        kind: "project",
        entityId: localId,
        operation: "create",
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        status: "pending",
        idempotencyFingerprint: `project:${normalized}:${now.slice(0, 16)}`,
        local,
      };
      let effectiveOperationId = operation.id;
      await this.store.mutate((data) => {
        data.localSnapshots[`project:${localId}`] = local;
        const queue = new OfflineQueue(data.queue);
        effectiveOperationId = queue.enqueue(operation);
        data.queue = queue.list();
      });
      this.patch({ projects: [...this.state.projects, project] });
      await this.drainQueue();
      await this.throwIfOperationNeedsAttention(effectiveOperationId);
      this.patch({ projects: cachedValues<DidaProject>(await this.store.snapshot(), "project") });
    } finally {
      releaseAuthorizationLease();
    }
  }

  async setDidaProjectViewMode(projectId: string, viewMode: "list" | "kanban"): Promise<void> {
    this.assertWritable();
    this.assertContractWriteVerified();
    const releaseAuthorizationLease = this.remoteWriteGate.enterShared();
    try {
      const project = this.state.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error("找不到清单");
      if (project.id.startsWith("local-project-")) throw new Error("清单尚未完成远端创建核对");
      if (project.permission && project.permission !== "write") {
        throw new Error("该清单没有写入权限");
      }
      if (project.boardStale) throw new Error("清单详情已过期，请同步成功后再修改滴答默认视图");
      if (project.viewMode === viewMode) return;
      const data = await this.store.snapshot();
      const base = data.baseSnapshots[`project:${projectId}`] as
        | EntitySnapshot<DidaProject>
        | undefined;
      if (!base) throw new Error("清单缺少同步基线，请先完成一次同步");
      const now = new Date().toISOString();
      const next = { ...project, viewMode };
      const syncValue = projectSyncValue(next);
      const operation = buildProjectUpdateOperation(
        syncValue,
        base,
        now,
        `op-${crypto.randomUUID()}`,
      );
      let effectiveOperationId = operation.id;
      await this.store.mutate((draft) => {
        draft.localSnapshots[`project:${projectId}`] = operation.local;
        const queue = new OfflineQueue(draft.queue);
        effectiveOperationId = queue.enqueue(operation);
        draft.queue = queue.list();
      });
      this.patch({
        projects: this.state.projects.map((candidate) =>
          candidate.id === projectId ? next : candidate),
      });
      if (!this.state.connected) return;
      await this.drainQueue();
      await this.throwIfOperationNeedsAttention(effectiveOperationId);
      const finalData = await this.store.snapshot();
      this.patch({
        projects: attachBoardSnapshots(cachedValues<DidaProject>(finalData, "project"), finalData),
      });
    } finally {
      releaseAuthorizationLease();
    }
  }

  async getDidaProjectViewModeSyncStatus(
    projectId: string,
  ): Promise<DidaProjectViewModeSyncStatus> {
    const data = await this.store.snapshot();
    const conflict = data.conflicts.find(
      (candidate) => candidate.kind === "project" && candidate.entityId === projectId &&
        candidate.fields.some((field) => field.path === "viewMode"),
    );
    if (conflict) return "conflict";
    const operations = data.queue.filter(
      (operation) => operation.kind === "project" && operation.entityId === projectId,
    );
    if (operations.some((operation) => needsAttention(operation))) return "attention";
    if (operations.some((operation) => operation.status === "pending" || operation.status === "running")) {
      return "pending";
    }
    return "synced";
  }

  async completeTask(taskId: string): Promise<void> {
    this.assertWritable();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("找不到任务");
    if (task.status === 2) return;
    await this.queueTaskUpdate(
      { ...task, status: 2, completedTime: new Date().toISOString() },
      "complete",
    );
  }

  async queueTaskUpdate(
    task: DidaTask,
    operationType: "update" | "complete" = "update",
    writeFields: string[] = [],
  ): Promise<void> {
    this.assertWritable();
    this.assertTaskCrudVerified();
    const releaseAuthorizationLease = this.remoteWriteGate.enterShared();
    try {
      await this.queueTaskUpdateWithAuthorizationLease(task, operationType, writeFields);
    } finally {
      releaseAuthorizationLease();
    }
  }

  async moveTaskToBoardColumn(
    projectId: string,
    taskId: string,
    targetColumnId: string,
  ): Promise<void> {
    this.assertWritable();
    this.assertContractWriteVerified();
    if (!this.state.boardPlacementVerified) {
      throw new Error("当前滴答账号尚未通过看板归栏合同测试");
    }
    const previous = this.boardPlacementWrites.get(taskId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const releaseExclusive = this.remoteWriteGate.enterExclusive("看板卡片归栏");
      try {
        if (this.syncPromise || this.state.loading) {
          throw new Error("同步正在进行，请完成后再移动看板卡片");
        }
        const project = this.state.projects.find((candidate) => candidate.id === projectId);
        const task = this.state.tasks.find((candidate) => candidate.id === taskId);
        if (!project || !task || task.projectId !== projectId) throw new Error("找不到看板任务或清单");
        if (task.columnId === targetColumnId) return;
        if (!this.state.connected) throw new Error("离线时不能移动看板卡片，请恢复连接后重试");
        if (project.permission && project.permission !== "write") throw new Error("该清单没有写入权限");
        if (project.boardStale) throw new Error("看板详情已过期，请先同步");
        const persistedBefore = await this.store.snapshot();
        if (persistedBefore.queue.some((candidate) =>
          candidate.kind === "task" && candidate.entityId === taskId)) {
          throw new Error("该任务仍有待处理或待核对的普通同步操作，请先在冲突中心处理");
        }
        if (persistedBefore.conflicts.some((candidate) =>
          candidate.kind === "task" && candidate.entityId === taskId &&
          candidate.status !== "resolved" && candidate.status !== "superseded")) {
          throw new Error("该任务已有逐字段冲突，请先在冲突中心处理");
        }
        const baselineColumns = normalizeColumns(project.columns);
        if (!baselineColumns.some((column) => column.id === targetColumnId)) {
          throw new Error("目标分栏已不在当前看板快照中");
        }
        const data = await this.api.getProjectData(projectId);
        const remoteProject = normalizeProject(data.project);
        if (remoteProject.id !== projectId) throw new Error("看板写前清单身份复读不一致");
        const remoteColumns = normalizeColumns(data.columns);
        if (!sameColumns(remoteColumns, baselineColumns)) {
          throw new Error("看板分栏在操作期间已经变化，请同步后人工核对");
        }
        const detailTask = (Array.isArray(data.tasks) ? data.tasks : [])
          .map(normalizeTask)
          .find((candidate) => candidate.id === taskId);
        if (!detailTask || detailTask.projectId !== projectId) {
          throw new Error("任务在操作期间已离开当前清单，请同步后人工核对");
        }
        const remoteTask = normalizeTask(await this.api.getTask(projectId, taskId));
        if (remoteTask.id !== taskId || remoteTask.projectId !== projectId) {
          throw new Error("任务写前精确复读的身份或清单不一致");
        }
        if ((detailTask.columnId ?? null) !== (task.columnId ?? null) ||
          (detailTask.columnId ?? null) !== (remoteTask.columnId ?? null)) {
          throw new Error("看板详情、精确任务与本地快照的原分栏不一致，请同步后人工核对");
        }
        if ((remoteTask.columnId ?? null) !== (task.columnId ?? null)) {
          throw new Error("任务分栏在操作期间已经变化，请同步后人工核对");
        }
        if (remoteTask.columnId === targetColumnId) return;
        const baselineCapturedAt = project.boardCapturedAt;
        await this.store.mutate((draft) => {
          const board = draft.boardSnapshots[projectId];
          if (!board || board.stale || board.capturedAt !== baselineCapturedAt ||
            !sameColumns(board.columns, baselineColumns) ||
            (board.taskColumnIds[taskId] ?? null) !== (task.columnId ?? null)) {
            throw new Error("本地看板基线在写入前已经变化，请重新同步");
          }
          board.stale = true;
        });
        this.patch({
          projects: this.state.projects.map((candidate) =>
            candidate.id === projectId ? { ...candidate, boardStale: true } : candidate),
        });
        try {
          await this.api.updateTask(
            taskId,
            taskBoardPlacementPayload(remoteTask, targetColumnId),
          );
        } catch (error) {
          if (!hasUnknownRemoteOutcome(error)) {
            throw new Error(
              `看板归栏被远端拒绝；未重发，看板已冻结等待同步核对：` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          }
          let reconciled: DidaTask;
          try {
            reconciled = normalizeTask(await this.api.getTask(projectId, taskId));
          } catch {
            throw new Error("归栏写入结果未知且精确复读失败；未重发，看板已冻结等待同步核对");
          }
          if (reconciled.id !== taskId || reconciled.projectId !== projectId ||
            reconciled.columnId !== targetColumnId) {
            throw new Error("归栏写入结果未知且复读未证明目标分栏；未重发，看板已冻结等待同步核对");
          }
        }
        let reread: DidaTask;
        try {
          reread = normalizeTask(await this.api.getTask(projectId, taskId));
        } catch {
          throw new Error("远端可能已完成归栏，但写后复读失败；看板已冻结等待同步核对");
        }
        if (reread.id !== taskId || reread.projectId !== projectId ||
          reread.columnId !== targetColumnId) {
          throw new Error("看板卡片移动后未在目标分栏精确复读");
        }
        if (!sameTaskBoardPlacementInvariant(remoteTask, reread)) {
          await this.recordBoardPlacementConflict(remoteTask, reread);
          throw new Error("归栏改变了分栏以外的任务字段；看板已冻结，请逐字段处理冲突");
        }
        try {
          await this.store.mutate((draft) => {
            const board = draft.boardSnapshots[projectId];
            if (!board || !board.stale || board.capturedAt !== baselineCapturedAt ||
              !sameColumns(board.columns, baselineColumns) ||
              (board.taskColumnIds[taskId] ?? null) !== (task.columnId ?? null)) {
              throw new Error("本地看板核对意图在远端写入期间已经变化");
            }
            board.taskColumnIds[taskId] = targetColumnId;
            board.stale = false;
          });
        } catch {
          throw new Error("远端归栏已成功，但本地结果保存失败；看板保持冻结，请立即同步核对");
        }
        this.patch({
          tasks: this.state.tasks.map((candidate) =>
            candidate.id === taskId ? { ...candidate, columnId: targetColumnId } : candidate),
          projects: this.state.projects.map((candidate) =>
            candidate.id === projectId
              ? { ...candidate, boardStale: false }
              : candidate),
        });
      } finally {
        releaseExclusive();
      }
    });
    this.boardPlacementWrites.set(taskId, operation);
    try {
      await operation;
    } finally {
      if (this.boardPlacementWrites.get(taskId) === operation) {
        this.boardPlacementWrites.delete(taskId);
      }
    }
  }

  private async recordBoardPlacementConflict(baseValue: DidaTask, remoteValue: DidaTask): Promise<void> {
    const capturedAt = new Date().toISOString();
    const baseProjection = taskSyncProjection(baseValue);
    const remoteProjection = taskSyncProjection(remoteValue);
    const base = createSnapshot("task", baseProjection.id, baseProjection, { capturedAt });
    const local = createSnapshot("task", baseProjection.id, baseProjection, { capturedAt });
    const remote = createSnapshot("task", remoteProjection.id, remoteProjection, { capturedAt });
    await this.store.mutate((draft) => {
      const existing = draft.conflicts.find((conflict) =>
        conflict.kind === "task" && conflict.entityId === baseValue.id &&
        conflict.status !== "resolved" && conflict.status !== "superseded");
      if (existing) {
        existing.remote = remote;
        existing.fields = buildConflictFields(existing.base.value, existing.local.value, remote.value);
        existing.status = "open";
        existing.updatedAt = capturedAt;
        return;
      }
      draft.conflicts.push({
        id: `conflict-${stableHash(["task", baseValue.id, base.stamp.hash, remote.stamp.hash])}`,
        kind: "task",
        entityId: baseValue.id,
        title: baseValue.title,
        createdAt: capturedAt,
        updatedAt: capturedAt,
        status: "open",
        base,
        local,
        remote,
        fields: buildConflictFields(base.value, local.value, remote.value),
        remoteRecheckCount: 0,
        sourceDeviceId: draft.deviceId,
      });
    });
    const data = await this.store.snapshot();
    this.patch({
      attentionCount: data.queue.filter(needsAttention).length +
        data.conflicts.filter((conflict) => conflict.status !== "resolved" &&
          conflict.status !== "superseded").length +
        data.recoveryIssues.length +
        (data.lineageConflict ? 1 : 0),
    });
  }

  private async queueTaskUpdateWithAuthorizationLease(
    task: DidaTask,
    operationType: "update" | "complete",
    writeFields: string[] = [],
  ): Promise<void> {
    if (task.id.startsWith("local-")) {
      throw new Error("该任务尚未完成远端创建核对，暂不能继续修改");
    }
    if (task.projectId.startsWith("local-project-")) {
      throw new Error("目标清单尚未取得滴答远端 ID，请先在冲突中心完成核对");
    }
    const data = await this.store.snapshot();
    const base = data.baseSnapshots[`task:${task.id}`] as
      | EntitySnapshot<DidaTask>
      | undefined;
    if (!base) throw new Error("任务缺少同步基线，请先完成一次同步");
    validateTaskScheduleWrite(task, this.state.taskScheduleMode, base.value);
    if (operationType === "update" && writeFields.length === 0 && base.value.projectId === task.projectId) {
      return;
    }
    const now = new Date().toISOString();
    const operation = buildTaskUpdateOperation(
      taskSyncValue(task),
      base,
      operationType,
      now,
      `op-${crypto.randomUUID()}`,
      writeFields,
    );
    const local = operation.local;
    let effectiveOperationId = operation.id;
    await this.store.mutate((draft) => {
      draft.localSnapshots[`task:${task.id}`] = local;
      const queue = new OfflineQueue(draft.queue);
      effectiveOperationId = queue.enqueue(operation);
      draft.queue = queue.list();
      draft.inProgress = draft.inProgress.map((entry) =>
        entry.taskId === task.id
          ? { ...entry, projectId: task.projectId, lastTouchedAt: now }
          : entry,
      );
    });
    this.patch({
      tasks: this.state.tasks.map((candidate) =>
        candidate.id === task.id ? task : candidate,
      ),
    });
    await this.drainQueue();
    await this.throwIfOperationNeedsAttention(effectiveOperationId);
    this.patch({
      tasks: cachedTaskValues(await this.store.snapshot()),
      inProgress: (await this.store.snapshot()).inProgress,
    });
  }

  private async enqueueProjectionExisting(
    task: DidaTask,
    operationType: "update" | "complete",
    writeFields: string[],
  ): Promise<ProjectionWriteReceipt> {
    const release = this.remoteWriteGate.enterShared();
    try {
      this.assertWritable();
      this.assertProjectionCapabilities(operationType === "update" && writeFields.includes("status"));
      const base = (await this.store.snapshot()).baseSnapshots[`task:${task.id}`] as
        | EntitySnapshot<DidaTask>
        | undefined;
      if (!base) return {
        operationId: `op-projection-${crypto.randomUUID()}`,
        outcome: "conflict",
        message: "投影任务缺少现有同步 Base",
      };
      const now = new Date().toISOString();
      const operation = buildTaskUpdateOperation(
        taskSyncValue(task),
        base,
        operationType,
        now,
        `op-projection-${crypto.randomUUID()}`,
        writeFields,
      );
      operation.idempotencyFingerprint = `helix-write:${operation.id}`;
      return this.enqueueAndDrainProjectionOperation(operation, true) as Promise<ProjectionWriteReceipt>;
    } finally {
      release();
    }
  }

  private async enqueueAndDrainProjectionOperation(
    operation: SyncQueueOperation<DidaTask>,
    authorizationLeaseHeld = false,
  ): Promise<ProjectionWriteReceipt | ProjectionDeleteReceipt> {
    const release = authorizationLeaseHeld ? () => undefined : this.remoteWriteGate.enterShared();
    try {
      await this.store.mutate((data) => {
        const queue = new OfflineQueue(data.queue);
        queue.enqueue(operation);
        data.queue = queue.list();
        data.localSnapshots[`task:${operation.entityId}`] = operation.local as EntitySnapshot<unknown>;
      });
      await this.queueDrain.run(() => this.runDrainQueueWithRemoteWrite());
      const data = await this.store.snapshot();
      const receipt = data.projectionOperationReceipts.find((item) => item.operationId === operation.id);
      if (!receipt) return {
        operationId: operation.id,
        outcome: "retryable",
        message: "投影写入已持久排队，尚未取得收据",
      };
      return receipt.outcome === "verified-absent"
        ? { operationId: receipt.operationId, outcome: "verified-absent", conflictId: receipt.conflictId }
        : projectionWriteReceipt(receipt, data);
    } finally {
      release();
    }
  }

  private assertProjectionCapabilities(reopen: boolean): void {
    this.assertTaskCrudVerified();
    if (!this.state.parentTaskVerified || !this.state.boardPlacementVerified) {
      throw new Error("当前授权尚未验证投影所需的父子任务与看板归栏能力");
    }
    if (reopen && !this.state.taskReopenVerified) {
      throw new Error("当前授权尚未验证任务重开能力");
    }
  }

  private assertTaskCrudVerified(): void {
    if (!this.state.taskCrudVerified) {
      throw new Error("当前滴答账号尚未通过任务基础写入合同测试");
    }
  }

  private assertContractWriteVerified(): void {
    if (!this.state.taskCrudVerified) {
      throw new Error("当前滴答授权未持有完整有效的写入合同，所有生产写入保持只读");
    }
  }

  async listConflicts(): Promise<SyncConflict[]> {
    return this.store.list();
  }

  async listQueue(): Promise<SyncQueueOperation[]> {
    return new OfflineQueue((await this.store.snapshot()).queue).list();
  }

  async diagnosticSummary(): Promise<Record<string, unknown>> {
    const data = await this.store.snapshot();
    return {
      generatedAt: new Date().toISOString(),
      schemaVersion: data.schemaVersion,
      lastSyncAt: data.lastSyncAt,
      queue: data.queue.map((operation) => ({
        id: operation.id,
        kind: operation.kind,
        entityId: operation.entityId,
        operation: operation.operation,
        status: operation.status,
        attempts: operation.attempts,
        conflictId: operation.conflictId,
        remoteOutcomeUnknown: operation.remoteOutcomeUnknown,
        lastError: operation.lastError,
      })),
      conflicts: data.conflicts.map((conflict) => ({
        id: conflict.id,
        kind: conflict.kind,
        entityId: conflict.entityId,
        status: conflict.status,
        unresolvedFields: conflict.fields
          .filter((field) => !field.choice)
          .map((field) => field.path),
      })),
      lineageConflict: data.lineageConflict,
      recoveryIssues: data.recoveryIssues,
    };
  }

  async resolveUnknownCreate(
    operationId: string,
    resolution: "not-created" | "confirmed",
    remoteId?: string,
  ): Promise<void> {
    this.assertWritable();
    await this.withAuthorizationLease(() =>
      this.resolveUnknownCreateWithAuthorizationLease(operationId, resolution, remoteId));
  }

  private async resolveUnknownCreateWithAuthorizationLease(
    operationId: string,
    resolution: "not-created" | "confirmed",
    remoteId?: string,
  ): Promise<void> {
    const data = await this.store.snapshot();
    const operation = data.queue.find((candidate) => candidate.id === operationId);
    if (!operation || operation.status !== "reconciliation" || operation.operation !== "create") {
      throw new Error("该操作不在创建结果待核对状态");
    }
    if (resolution === "not-created") {
      throw new Error("远端结果未知时禁止自动重试；请在滴答 App 核对后绑定已生效记录");
    }
    const normalizedRemoteId = remoteId?.trim();
    if (!normalizedRemoteId) throw new Error("请填写你在滴答中确认的远端记录 ID");
    let adopted: EntitySnapshot<unknown>;
    let adoptedTask: DidaTask | null = null;
    if (operation.kind === "task") {
      if (!operation.projectId) throw new Error("待核对任务缺少 projectId");
      const remote = normalizeTask(await this.api.getTask(operation.projectId, normalizedRemoteId));
      const local = operation.local.value as DidaTask;
      if (!matchesCreatedTask(local, remote)) {
        throw new Error("远端任务与待创建内容不匹配，拒绝自动绑定");
      }
      adopted = createSnapshot("task", remote.id, remote);
      adoptedTask = remote;
    } else if (operation.kind === "project") {
      const remote = normalizeProject(await this.api.getProject(normalizedRemoteId));
      const local = operation.local.value as DidaProject;
      if (local.name !== remote.name) throw new Error("远端项目名称不匹配，拒绝自动绑定");
      adopted = createSnapshot("project", remote.id, remote);
    } else {
      throw new Error("当前仅支持任务和项目创建结果核对");
    }
    await this.store.mutate((draft) => {
      const latest = new OfflineQueue(draft.queue);
      const current = latest.list().find((candidate) => candidate.id === operationId);
      if (
        !current ||
        current.status !== "reconciliation" ||
        current.operation !== "create"
      ) {
        throw new Error("该创建操作已经被其他流程处理");
      }
      draft.baseSnapshots[`${adopted.kind}:${adopted.entityId}`] = adopted;
      draft.localSnapshots[`${adopted.kind}:${adopted.entityId}`] = adopted;
      delete draft.baseSnapshots[`${operation.kind}:${operation.entityId}`];
      delete draft.localSnapshots[`${operation.kind}:${operation.entityId}`];
      if (adoptedTask) {
        draft.inProgress = migrateInProgressTaskId(
          draft.inProgress,
          operation.entityId,
          adoptedTask,
        );
      }
      latest.resolveReconciliation(operationId, "confirmed");
      draft.queue = latest.list();
    });
    this.patch({ inProgress: (await this.store.snapshot()).inProgress });
    await this.sync();
  }

  async resolveUnknownWrite(
    operationId: string,
    resolution: "continue" | "adopt-remote",
  ): Promise<void> {
    this.assertWritable();
    await this.withAuthorizationLease(() =>
      this.resolveUnknownWriteWithAuthorizationLease(operationId, resolution));
  }

  private async resolveUnknownWriteWithAuthorizationLease(
    operationId: string,
    resolution: "continue" | "adopt-remote",
  ): Promise<void> {
    const data = await this.store.snapshot();
    const queue = new OfflineQueue(data.queue);
    const operation = queue.list().find((candidate) => candidate.id === operationId);
    if (!operation || operation.status !== "reconciliation" || operation.operation === "create") {
      throw new Error("该操作不在非创建写入的待核对状态");
    }
    if (resolution === "continue") {
      throw new Error("远端结果未知时禁止继续重发；请在滴答 App 核对远端结果");
    }
    let adopted: EntitySnapshot<unknown> | null = null;
    if (operation.kind === "task") {
      const adapter = new DidaTaskAdapter(
        this.api,
        () => this.state.taskScheduleMode,
        () => this.state,
      );
      const desiredProjectId = (operation.local.value as Partial<DidaTask>).projectId;
      const remoteAtTarget = desiredProjectId
        ? await adapter.get(operation.entityId, { projectId: desiredProjectId })
        : null;
      const remote = remoteAtTarget ?? await adapter.get(operation.entityId, {
        projectId: operation.projectId,
      });
      if (remote) {
        adopted = createSnapshot("task", remote.id, remote);
      }
    } else if (operation.kind === "project") {
      const remote = await new DidaProjectAdapter(this.api).get(operation.entityId);
      if (remote) {
        adopted = createSnapshot("project", remote.id, remote);
      }
    } else {
      throw new Error("当前仅支持任务和项目写入核对");
    }
    await this.store.mutate((draft) => {
      const key = `${operation.kind}:${operation.entityId}`;
      const latest = new OfflineQueue(draft.queue);
      if (adopted) {
        draft.baseSnapshots[`${adopted.kind}:${adopted.entityId}`] = adopted;
        draft.localSnapshots[`${adopted.kind}:${adopted.entityId}`] = adopted;
        if (adopted.entityId !== operation.entityId) {
          delete draft.baseSnapshots[key];
          delete draft.localSnapshots[key];
        }
        latest.resolveOperationWithSnapshot(operationId, adopted);
      } else {
        throw new Error("无法只读证明远端写入已生效；请在滴答 App 人工核对，队列将保持冻结");
      }
      draft.queue = latest.list();
    });
    const adoptedData = await this.store.snapshot();
    this.patch({ inProgress: adoptedData.inProgress });
    await this.sync();
  }

  async retryFailedOperation(operationId: string): Promise<void> {
    this.assertWritable();
    await this.withAuthorizationLease(() =>
      this.retryFailedOperationWithAuthorizationLease(operationId));
  }

  private async retryFailedOperationWithAuthorizationLease(
    operationId: string,
  ): Promise<void> {
    await this.mutateQueue((queue) => queue.retryFailed(operationId));
    await this.drainQueue();
    await this.throwIfOperationNeedsAttention(operationId);
  }

  async chooseConflict(
    conflictId: string,
    path: string,
    choice: ResolutionChoice,
    customValue?: unknown,
  ): Promise<SyncConflict> {
    this.assertWritable();
    const conflict = await this.store.get(conflictId);
    if (!conflict) throw new Error("冲突不存在或已经解决");
    if (conflict.status === "applying") {
      throw new Error("冲突正在写回或等待人工核对，当前不可修改字段选择");
    }
    const engine = conflict.kind === "project" ? this.projectEngine : this.taskEngine;
    if (!engine) throw new Error("Helix 尚未初始化");
    return engine.choose(conflictId, path, choice, customValue);
  }

  applyConflict(conflictId: string): Promise<void> {
    this.assertWritable();
    this.assertContractWriteVerified();
    const existing = this.conflictApplications.get(conflictId);
    if (existing) return existing;
    const operation = this.applyConflictOnce(conflictId).finally(() => {
      if (this.conflictApplications.get(conflictId) === operation) {
        this.conflictApplications.delete(conflictId);
      }
    });
    this.conflictApplications.set(conflictId, operation);
    return operation;
  }

  async releaseApplyingConflict(conflictId: string): Promise<void> {
    this.assertWritable();
    void conflictId;
    throw new Error("远端结果未知时不得解锁重试；请在滴答 App 核对后复读采纳已生效结果");
  }

  async adoptAppliedConflict(conflictId: string, remoteEntityId?: string): Promise<void> {
    this.assertWritable();
    await this.withAuthorizationLease(() =>
      this.adoptAppliedConflictWithAuthorizationLease(conflictId, remoteEntityId));
  }

  private async adoptAppliedConflictWithAuthorizationLease(
    conflictId: string,
    remoteEntityId?: string,
  ): Promise<void> {
    const conflict = await this.store.get(conflictId);
    if (!conflict || conflict.status !== "applying") {
      throw new Error("该冲突不在等待远端核对状态");
    }
    if (conflict.kind !== "task" && conflict.kind !== "project") {
      throw new Error("当前版本仅支持任务与项目冲突核对");
    }
    const engine = conflict.kind === "project" ? this.projectEngine : this.taskEngine;
    if (!engine) throw new Error("Helix 尚未初始化");
    const context = conflict.kind === "task" ? taskContextFromConflict(conflict) : undefined;
    const result = await engine.verifyAppliedConflict(
      conflictId,
      context,
      remoteEntityId,
    );
    if (this.disposed) return;
    await this.finalizeResolvedConflict(conflict, result);
    await this.drainQueue();
    await this.sync();
  }

  private async applyConflictOnce(conflictId: string): Promise<void> {
    const releaseRemoteWrite = this.remoteWriteGate.enterShared();
    try {
      await this.applyConflictWithRemoteWrite(conflictId);
    } finally {
      releaseRemoteWrite();
    }
  }

  private async applyConflictWithRemoteWrite(conflictId: string): Promise<void> {
    let previousStatus: SyncConflict["status"] = "open";
    await this.store.mutate((data) => {
      previousStatus = claimConflictApplication(data.conflicts, conflictId);
    });
    let conflict: SyncConflict;
    let context: { projectId?: string } | undefined;
    let engine: SyncEngine<DidaTask> | SyncEngine<DidaProject>;
    try {
      const claimed = await this.store.get(conflictId);
      if (!claimed) throw new Error("冲突不存在或已经解决");
      if (claimed.kind !== "task" && claimed.kind !== "project") {
        throw new Error("当前版本仅支持任务与项目冲突写回");
      }
      conflict = claimed;
      context = conflict.kind === "task"
        ? taskContextFromConflict(conflict)
        : undefined;
      const selectedEngine =
        conflict.kind === "project" ? this.projectEngine : this.taskEngine;
      if (!selectedEngine) throw new Error("Helix 尚未初始化");
      engine = selectedEngine;
    } catch (error) {
      await this.store.mutate((data) => {
        releaseConflictApplication(data.conflicts, conflictId, previousStatus);
      });
      throw error;
    }
    let remoteResolutionCompleted = false;
    try {
      const result = await engine.applyConflict(conflictId, context);
      if (result.outcome === "remote-changed") {
        throw new Error("应用前远端再次变化，已刷新字段，请重新核对");
      }
      if (this.disposed) return;
      remoteResolutionCompleted = true;
      await this.finalizeResolvedConflict(conflict, result);
      await this.drainQueue();
      await this.sync();
    } catch (error) {
      if (this.disposed) return;
      if (!remoteResolutionCompleted && !hasUnknownRemoteOutcome(error)) {
        await this.store.mutate((data) => {
          releaseConflictApplication(data.conflicts, conflictId, previousStatus);
        });
      }
      throw error;
    }
  }

  private async finalizeResolvedConflict(
    conflict: SyncConflict,
    result: ResolvedConflict<DidaTask> | ResolvedConflict<DidaProject>,
  ): Promise<void> {
    await this.store.mutate((data) => {
      const oldKey = `${conflict.kind}:${conflict.entityId}`;
      if (result.previousEntityId) {
        delete data.baseSnapshots[`${conflict.kind}:${result.previousEntityId}`];
        delete data.localSnapshots[`${conflict.kind}:${result.previousEntityId}`];
      }
      if (result.snapshot.value === null) {
        delete data.baseSnapshots[oldKey];
        delete data.localSnapshots[oldKey];
      } else {
        data.baseSnapshots[`${conflict.kind}:${result.snapshot.entityId}`] =
          result.snapshot as EntitySnapshot<unknown>;
        data.localSnapshots[`${conflict.kind}:${result.snapshot.entityId}`] =
          result.snapshot as EntitySnapshot<unknown>;
      }
      data.resolutionAudit.push(result.audit);
      data.conflicts = data.conflicts.filter((candidate) => candidate.id !== conflict.id);
      const queue = new OfflineQueue(data.queue);
      queue.resolveBlockedConflict(conflict.id, result.snapshot);
      data.queue = queue.list();
      if (conflict.kind === "task") {
        if (result.snapshot.value === null) {
          data.inProgress = data.inProgress.filter(
            (entry) => entry.taskId !== conflict.entityId,
          );
        } else if (result.previousEntityId) {
          data.inProgress = data.inProgress.map((entry) =>
            entry.taskId === result.previousEntityId
              ? {
                  ...entry,
                  taskId: result.snapshot.entityId,
                  projectId:
                    (result.snapshot.value as Partial<DidaTask>).projectId ??
                    entry.projectId,
                }
              : entry,
          );
        }
      }
    });
    const latest = await this.store.snapshot();
    this.patch({
      inProgress: latest.inProgress,
      events: latest.events.filter(isHelixEvent),
    });
  }

  visibleInProgress(expanded: boolean): Array<{
    entry: InProgressEntry;
    task: DidaTask;
    project?: DidaProject;
  }> {
    const selected = new InProgressRegistry(
      this.state.inProgress.filter((entry) =>
        this.state.tasks.some((task) => task.id === entry.taskId && task.status !== 2),
      ),
    ).top(expanded ? Number.MAX_SAFE_INTEGER : 3);
    return selected.flatMap((entry) => {
      const task = this.state.tasks.find((candidate) => candidate.id === entry.taskId);
      if (!task) return [];
      const currentEntry =
        entry.projectId === task.projectId ? entry : { ...entry, projectId: task.projectId };
      return [{
        entry: currentEntry,
        task,
        project: this.state.projects.find((project) => project.id === task.projectId),
      }];
    });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.store.dispose();
  }

  notifySyncError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`Helix 同步失败：${message}`, 8_000);
  }

  private async drainQueue(): Promise<void> {
    // 合同失效时同步仍可读取，但不得认领或改变任何生产远端写入队列。
    if (!this.state.taskCrudVerified) return;
    return this.queueDrain.run(() => this.runDrainQueue());
  }

  private async runDrainQueue(): Promise<void> {
    const releaseRemoteWrite = this.remoteWriteGate.enterShared();
    try {
      await this.runDrainQueueWithRemoteWrite();
    } finally {
      releaseRemoteWrite();
    }
  }

  private async runDrainQueueWithRemoteWrite(): Promise<void> {
    while (true) {
      if (this.disposed) return;
      let operation: SyncQueueOperation | null = null;
      await this.store.mutate((data) => {
        const claimed = claimNextQueueOperation(data.queue);
        data.queue = claimed.operations;
        operation = claimed.claimed;
      });
      if (!operation) return;
      try {
        const claimedOperation = operation as SyncQueueOperation;
        const engine = claimedOperation.kind === "project" ? this.projectEngine : this.taskEngine;
        if (!engine || (claimedOperation.kind !== "task" && claimedOperation.kind !== "project")) {
          throw new Error(`不支持的队列对象：${claimedOperation.kind}`);
        }
        const result = claimedOperation.kind === "project"
          ? await this.projectEngine!.process(claimedOperation as SyncQueueOperation<DidaProject>)
          : await this.taskEngine!.process(claimedOperation as SyncQueueOperation<DidaTask>);
        if (this.disposed) return;
        await this.store.mutate((data) => {
          const latest = new OfflineQueue(data.queue);
          if (result.outcome === "conflict") latest.markBlocked(claimedOperation.id, result.conflict.id);
          else latest.complete(claimedOperation.id);
          data.queue = latest.list();
          persistProjectionOperationReceipt(data, claimedOperation, result);
          if (
            claimedOperation.operation === "create" &&
            result.outcome === "pushed" &&
            result.snapshot.entityId !== claimedOperation.entityId &&
            claimedOperation.kind === "task"
          ) {
            data.inProgress = migrateInProgressTaskId(
              data.inProgress,
              claimedOperation.entityId,
              result.snapshot.value as DidaTask,
            );
          }
          if (
            claimedOperation.kind === "task" &&
            claimedOperation.operation === "complete" &&
            result.outcome === "pushed"
          ) {
            const task = result.snapshot.value as DidaTask;
            if (task.status === 2 && task.completedTime) {
              const ledger = new EventLedger(data.events.filter(isHelixEvent));
              ledger.append({
                id: deterministicEventId({
                  type: "task-completed",
                  entityId: task.id,
                  occurrenceKey: task.completedTime,
                  occurredAt: task.completedTime,
                }),
                type: "task-completed",
                entityId: task.id,
                projectId: task.projectId,
                occurrenceKey: task.completedTime,
                occurredAt: task.completedTime,
                difficulty: difficultyFromPriority(task.priority),
              });
              appendEarnedChallengeAwards(ledger, task.completedTime);
              data.events = ledger.list();
            }
          }
        });
        const latestData = await this.store.snapshot();
        this.patch({
          inProgress: latestData.inProgress,
          events: latestData.events.filter(isHelixEvent),
        });
      } catch (error) {
        if (this.disposed) return;
        const claimedOperation = operation as SyncQueueOperation;
        await this.store.mutate((data) => {
          const latest = new OfflineQueue(data.queue);
          latest.markFailed(claimedOperation.id, error);
          data.queue = latest.list();
          persistProjectionFailureReceipt(data, claimedOperation, error);
        });
      }
    }
  }

  private async mutateQueue(mutator: (queue: OfflineQueue) => void): Promise<void> {
    await this.store.mutate((data) => {
      const queue = new OfflineQueue(data.queue);
      mutator(queue);
      data.queue = queue.list();
    });
    const data = await this.store.snapshot();
    this.patch({
      attentionCount:
        data.conflicts.length +
        data.queue.filter(needsAttention).length +
        data.recoveryIssues.length +
        (data.lineageConflict ? 1 : 0),
      recoveryIssues: data.recoveryIssues,
    });
  }

  private async throwIfOperationNeedsAttention(operationId: string): Promise<void> {
    const operation = new OfflineQueue((await this.store.snapshot()).queue)
      .list()
      .find((candidate) => candidate.id === operationId);
    if (!operation) return;
    if (
      operation.status === "failed" ||
      operation.status === "reconciliation" ||
      operation.status === "blocked"
    ) {
      throw new Error(
        operation.lastError ??
          (operation.status === "blocked"
            ? "写入与远端变化发生冲突，请到冲突中心处理"
            : "写入尚未完成，请到冲突中心处理"),
      );
    }
  }

  private patch(values: Partial<HelixRuntimeState>): void {
    this.state = { ...this.state, ...values };
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Helix 已卸载，已拒绝继续执行后台操作");
  }

  private assertWritable(): void {
    this.assertActive();
    if (this.contractTestRunning) {
      throw new Error("滴答写入合同测试正在运行，其他写入已暂时冻结");
    }
    if (this.state.recoveryIssues.length > 0) {
      throw new Error("Helix 当前处于只读恢复模式，处理冲突中心列出的恢复问题前不能写入");
    }
  }

  private async withAuthorizationLease<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.remoteWriteGate.enterShared();
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function projectionStateOrDefault(
  data: HelixPersistedData,
): NonNullable<HelixPersistedData["didaProjectionState"]> {
  return data.didaProjectionState ?? { enabled: false, ledger: [], parentCheckpoints: [] };
}

function projectionColumnBaseline(columns: DidaColumn[], projectId: string): ProjectionColumnBaseline[] {
  return columns.map((column) => {
    if (!column.id || column.projectId !== projectId || !column.name) {
      throw new Error("分栏基线含无效身份、名称或清单归属");
    }
    return { id: column.id, projectId: column.projectId, name: column.name };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function verifyProjectionColumnBaseline(
  checkpoint: ProjectionColumnCreationCheckpoint,
  columns: DidaColumn[],
): void {
  if (stableHash(checkpoint.baselineColumns) !== checkpoint.baselineHash) {
    throw new Error("分栏创建 checkpoint 的基线哈希无效");
  }
  const current = new Map(projectionColumnBaseline(columns, checkpoint.targetProjectId)
    .map((column) => [column.id, column]));
  for (const baseline of checkpoint.baselineColumns) {
    const value = current.get(baseline.id);
    if (!value || value.projectId !== baseline.projectId || value.name !== baseline.name) {
      throw new Error("分栏创建后既有列基线发生竞争变化");
    }
  }
}

function uniqueCreatedProjectionColumnId(
  checkpoint: ProjectionColumnCreationCheckpoint,
  columns: DidaColumn[],
): string {
  verifyProjectionColumnBaseline(checkpoint, columns);
  const baselineIds = new Set(checkpoint.baselineColumns.map((column) => column.id));
  const additions = columns.filter((column) => !baselineIds.has(column.id));
  if (additions.length !== 1 || additions[0]!.projectId !== checkpoint.targetProjectId ||
    additions[0]!.name !== checkpoint.desiredName) {
    throw new Error("相对基线不存在唯一且名称精确匹配的新分栏，保持冻结");
  }
  return additions[0]!.id;
}

function verifyCreatedProjectionColumn(
  checkpoint: ProjectionColumnCreationCheckpoint,
  columns: DidaColumn[],
  columnId: string,
): void {
  verifyProjectionColumnBaseline(checkpoint, columns);
  const column = columns.find((candidate) => candidate.id === columnId);
  if (!column || column.projectId !== checkpoint.targetProjectId || column.name !== checkpoint.desiredName) {
    throw new Error("待收口分栏的 ID、名称或清单归属不一致，保持冻结");
  }
}

function deduplicateTasks(tasks: DidaTask[]): DidaTask[] {
  const byId = new Map<string, DidaTask>();
  for (const task of tasks) {
    byId.set(task.id, task);
  }
  return [...byId.values()];
}

function normalizeTaskWithoutBoardProjection(task: DidaTask): DidaTask {
  const { columnId: _columnId, ...value } = task;
  return taskSyncValue(normalizeTask(value as DidaTask));
}

function taskSyncValue(task: DidaTask): DidaTask {
  return taskSyncProjection(task);
}

function addUnlistedProjects(projects: DidaProject[], tasks: DidaTask[]): DidaProject[] {
  const known = new Set(projects.map((project) => project.id));
  const extraIds = new Set(
    tasks.map((task) => task.projectId).filter((projectId) => !known.has(projectId)),
  );
  return [
    ...projects,
    ...[...extraIds].map((id) => ({
      id,
      name: id.toLowerCase().includes("inbox") ? "收集箱" : "未列出清单",
      color: "#8891a7",
      permission: "write",
    } satisfies DidaProject)),
  ];
}

function projectSyncValue(project: DidaProject): DidaProject {
  const { columns: _columns, boardCapturedAt: _boardCapturedAt, boardStale: _boardStale, ...value } = project;
  return value;
}

function attachBoardSnapshots(
  projects: DidaProject[],
  data: HelixPersistedData,
): DidaProject[] {
  return projects.map((project) => {
    const board = data.boardSnapshots[project.id];
    return board
      ? {
        ...projectSyncValue(project),
        columns: structuredClone(board.columns),
        boardCapturedAt: board.capturedAt,
        boardStale: board.stale,
      }
      : projectSyncValue(project);
  });
}

function cachedTaskValues(data: HelixPersistedData): DidaTask[] {
  return cachedValues<DidaTask>(data, "task").map((task) => {
    const board = data.boardSnapshots[task.projectId];
    if (!board || !Object.prototype.hasOwnProperty.call(board.taskColumnIds, task.id)) {
      return taskSyncValue(task);
    }
    return {
      ...taskSyncValue(task),
      columnId: board.taskColumnIds[task.id] ?? null,
    };
  });
}

function cachedValues<T>(
  data: HelixPersistedData,
  kind: EntityKind,
): T[] {
  return Object.values(data.localSnapshots)
    .filter((snapshot) => snapshot.kind === kind && snapshot.value !== null)
    .map((snapshot) => structuredClone(snapshot.value) as T);
}

function replaceReadOnlySnapshots<T>(
  data: HelixPersistedData,
  kind: EntityKind,
  values: T[],
  capturedAt: string,
  idOf: (value: T) => string,
): void {
  for (const key of Object.keys(data.baseSnapshots)) {
    if (key.startsWith(`${kind}:`)) delete data.baseSnapshots[key];
  }
  for (const key of Object.keys(data.localSnapshots)) {
    if (key.startsWith(`${kind}:`)) delete data.localSnapshots[key];
  }
  for (const value of values) {
    const id = idOf(value);
    const snapshot = createSnapshot(kind, id, value, { capturedAt });
    data.baseSnapshots[`${kind}:${id}`] = snapshot;
    data.localSnapshots[`${kind}:${id}`] = snapshot;
  }
}

function hasUnknownRemoteOutcome(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    "remoteOutcomeUnknown" in error &&
    error.remoteOutcomeUnknown === true;
}

function eventsFromDida(
  data: HelixPersistedData,
  tasks: DidaTask[],
  checkins: DidaHabitCheckin[],
  focus: DidaFocusRecord[],
  options: {
    capturedAt: string;
    habitCoverageComplete: boolean;
    focusCoverageComplete: boolean;
    coverageFrom: number;
    coverageTo: number;
  },
): HelixEvent[] {
  const events: HelixEvent[] = [];
  for (const task of tasks) {
    const previous = data.baseSnapshots[`task:${task.id}`]?.value as DidaTask | undefined;
    if (task.status === 2 && task.completedTime) {
      const occurrenceKey = task.completedTime;
      events.push({
        id: deterministicEventId({
          type: "task-completed",
          entityId: task.id,
          occurrenceKey,
          occurredAt: task.completedTime,
        }),
        type: "task-completed",
        entityId: task.id,
        projectId: task.projectId,
        occurrenceKey,
        occurredAt: task.completedTime,
        difficulty: difficultyFromPriority(task.priority),
      });
    } else if (previous?.status === 2 && previous.completedTime) {
      const occurredAt = task.modifiedTime ?? new Date().toISOString();
      events.push({
        id: deterministicEventId({
          type: "task-reopened",
          entityId: task.id,
          occurrenceKey: previous.completedTime,
          occurredAt,
        }),
        type: "task-reopened",
        entityId: task.id,
        projectId: task.projectId,
        occurrenceKey: previous.completedTime,
        occurredAt,
      });
    }
  }
  for (const checkin of checkins) {
    const occurredAt = toIsoTime(checkin.checkinTime);
    const occurrenceKey = checkin.id ?? `${checkin.habitId}:${occurredAt}`;
    events.push({
      id: deterministicEventId({
        type: "habit-checkin",
        entityId: checkin.habitId,
        occurrenceKey,
        occurredAt,
      }),
      type: "habit-checkin",
      entityId: checkin.habitId,
      occurrenceKey,
      occurredAt,
    });
  }
  if (options.habitCoverageComplete) {
    const current = new Set(
      checkins.map((checkin) => checkin.id ?? `${checkin.habitId}:${checkin.checkinTime}`),
    );
    for (const snapshot of Object.values(data.baseSnapshots)) {
      if (snapshot.kind !== "habit-checkin" || snapshot.value === null) continue;
      if (current.has(snapshot.entityId)) continue;
      const previous = snapshot.value as DidaHabitCheckin;
      if (!isInsideSyncWindow(previous.checkinTime, options.coverageFrom, options.coverageTo)) continue;
      const occurrenceKey = previous.id ?? `${previous.habitId}:${toIsoTime(previous.checkinTime)}`;
      events.push({
        id: deterministicEventId({
          type: "habit-unchecked",
          entityId: previous.habitId,
          occurrenceKey,
          occurredAt: options.capturedAt,
        }),
        type: "habit-unchecked",
        entityId: previous.habitId,
        occurrenceKey,
        occurredAt: options.capturedAt,
      });
    }
  }
  for (const record of focus) {
    const occurredAt = record.endTime ?? record.startTime ?? new Date().toISOString();
    events.push({
      id: deterministicEventId({
        type: "focus-completed",
        entityId: record.id,
        occurrenceKey: record.id,
        occurredAt,
      }),
      type: "focus-completed",
      entityId: record.id,
      projectId: undefined,
      occurrenceKey: record.id,
      occurredAt,
      minutes: focusMinutes(record),
      metadata: {
        taskId: record.taskId,
        habitId: record.habitId,
      },
    });
  }
  if (options.focusCoverageComplete) {
    const current = new Set(focus.map((record) => record.id));
    for (const snapshot of Object.values(data.baseSnapshots)) {
      if (snapshot.kind !== "focus" || snapshot.value === null || current.has(snapshot.entityId)) {
        continue;
      }
      const previous = snapshot.value as DidaFocusRecord;
      if (!isInsideSyncWindow(
        previous.endTime ?? previous.startTime,
        options.coverageFrom,
        options.coverageTo,
      )) continue;
      events.push({
        id: deterministicEventId({
          type: "focus-deleted",
          entityId: previous.id,
          occurrenceKey: previous.id,
          occurredAt: options.capturedAt,
        }),
        type: "focus-deleted",
        entityId: previous.id,
        occurrenceKey: previous.id,
        occurredAt: options.capturedAt,
        minutes: focusMinutes(previous),
      });
    }
  }
  return events;
}

function difficultyFromPriority(priority = 0): 1 | 2 | 3 | 4 | 5 {
  if (priority >= 5) return 4;
  if (priority >= 3) return 3;
  if (priority >= 1) return 2;
  return 1;
}

function toIsoTime(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Dida 事件时间格式无效");
  return date.toISOString();
}

function needsAttention(operation: SyncQueueOperation): boolean {
  return (
    operation.status === "reconciliation" ||
    operation.status === "failed" ||
    operation.status === "blocked"
  );
}

function sameColumns(left: DidaColumn[], right: DidaColumn[]): boolean {
  return left.length === right.length && left.every((column, index) => {
    const other = right[index];
    return !!other && column.id === other.id && column.projectId === other.projectId &&
      column.name === other.name && column.sortOrder === other.sortOrder &&
      column.sortOrderUnsafe === other.sortOrderUnsafe;
  });
}

function matchesCreatedTask(local: DidaTask, remote: DidaTask): boolean {
  return (
    local.projectId === remote.projectId &&
    local.title === remote.title &&
    (local.content ?? "") === (remote.content ?? "") &&
    (local.desc ?? "") === (remote.desc ?? "")
  );
}

function appendEarnedChallengeAwards(
  ledger: EventLedger,
  occurredAt: string,
): void {
  const events = ledger.list();
  for (const challenge of rotatingChallenges(new Date(occurredAt))) {
    if (challengeProgress(challenge, events) < challenge.target) continue;
    if (events.some((event) =>
      event.type === "challenge-completed" &&
      event.entityId === challenge.id &&
      event.occurrenceKey === challenge.id)) continue;
    ledger.append({
      id: deterministicEventId({
        type: "challenge-completed",
        entityId: challenge.id,
        occurrenceKey: challenge.id,
        occurredAt,
      }),
      type: "challenge-completed",
      entityId: challenge.id,
      occurrenceKey: challenge.id,
      occurredAt,
      metadata: {
        rewardXp: challenge.rewardXp,
        ruleVersion: 1,
        title: challenge.title,
        metric: challenge.metric,
        target: challenge.target,
        period: challenge.period,
        startsAt: challenge.startsAt,
        endsAt: challenge.endsAt,
      },
    });
  }
}

function taskContextFromConflict(
  conflict: SyncConflict,
): { projectId: string } | undefined {
  for (const value of [
    conflict.remote.value,
    conflict.base.value,
    conflict.local.value,
  ]) {
    if (!value || typeof value !== "object") continue;
    const projectId = (value as Partial<DidaTask>).projectId;
    if (typeof projectId === "string" && projectId.length > 0) {
      return { projectId };
    }
  }
  return undefined;
}

function isProjectionQueueOperation(operation: SyncQueueOperation): boolean {
  return operation.kind === "task" &&
    typeof operation.idempotencyFingerprint === "string" &&
    operation.idempotencyFingerprint.startsWith("helix-");
}

function persistProjectionOperationReceipt(
  data: HelixPersistedData,
  operation: SyncQueueOperation,
  result:
    | Awaited<ReturnType<SyncEngine<DidaTask>["process"]>>
    | Awaited<ReturnType<SyncEngine<DidaProject>["process"]>>,
): void {
  if (!isProjectionQueueOperation(operation)) return;
  const clientIdentity = operation.idempotencyFingerprint!;
  const conflictId = result.outcome === "conflict" ? result.conflict.id : undefined;
  const task = "snapshot" in result && result.snapshot.value
    ? result.snapshot.value as DidaTask
    : undefined;
  const outcome = result.outcome === "conflict"
    ? "conflict"
    : result.outcome === "deleted" ? "verified-absent" : "verified";
  upsertProjectionReceipt(data, {
    clientIdentity,
    projectId: operation.projectId ?? (operation.local.value as DidaTask).projectId,
    operationId: operation.id,
    outcome,
    marker: projectionOperationMarker(operation),
    remoteTaskId: task?.id,
    conflictId,
    message: result.outcome === "conflict" ? "投影写入进入逐字段冲突" : undefined,
  });
}

function persistProjectionFailureReceipt(
  data: HelixPersistedData,
  operation: SyncQueueOperation,
  error: unknown,
): void {
  if (!isProjectionQueueOperation(operation)) return;
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const category = String(record?.category ?? "");
  const outcome = record?.remoteOutcomeUnknown === true || category === "unknown-outcome"
    ? "unknown"
    : category === "authentication" || category === "authorization"
      ? "authorization"
      : category === "permanent" || category === "invalid-response"
        ? "capability"
        : "retryable";
  upsertProjectionReceipt(data, {
    clientIdentity: operation.idempotencyFingerprint!,
    projectId: operation.projectId ?? (operation.local.value as DidaTask).projectId,
    operationId: operation.id,
    marker: projectionOperationMarker(operation),
    outcome,
    message: error instanceof Error ? error.message : String(error),
  });
}

function upsertProjectionReceipt(
  data: HelixPersistedData,
  receipt: HelixPersistedData["projectionOperationReceipts"][number],
): void {
  data.projectionOperationReceipts = [
    ...data.projectionOperationReceipts.filter((item) => item.clientIdentity !== receipt.clientIdentity),
    receipt,
  ];
}

function projectionOperationMarker(operation: SyncQueueOperation): string {
  const local = operation.local.value as DidaTask | null;
  const base = operation.base?.value as DidaTask | null | undefined;
  return String(local?.content ?? base?.content ?? operation.idempotencyFingerprint ?? operation.id);
}

function projectionWriteReceipt(
  receipt: HelixPersistedData["projectionOperationReceipts"][number],
  data: HelixPersistedData,
): ProjectionWriteReceipt {
  const snapshot = receipt.remoteTaskId
    ? data.baseSnapshots[`task:${receipt.remoteTaskId}`] as EntitySnapshot<DidaTask> | undefined
    : undefined;
  const task = snapshot?.value;
  if (receipt.outcome === "verified" && task && task.id === receipt.remoteTaskId &&
    task.projectId === receipt.projectId && task.content === receipt.marker) {
    return {
      operationId: receipt.operationId,
      outcome: "verified",
      task,
      conflictId: receipt.conflictId,
    };
  }
  if (receipt.outcome === "verified") {
    return {
      operationId: receipt.operationId,
      outcome: "conflict",
      message: "投影 verified 收据缺少任务快照",
      conflictId: receipt.conflictId,
    };
  }
  return {
    operationId: receipt.operationId,
    outcome: receipt.outcome === "verified-absent" ? "conflict" : receipt.outcome,
    message: receipt.message ?? "投影写入未取得可验证任务快照",
    conflictId: receipt.conflictId,
  };
}
