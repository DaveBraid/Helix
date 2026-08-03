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
import { challengeProgress, rotatingChallenges } from "../domain/gamification";
import { DidaApi, type DidaCapabilities } from "../integrations/dida/api";
import {
  DidaFocusService,
  DidaHabitService,
  DidaProjectAdapter,
  DidaTaskAdapter,
} from "../integrations/dida/adapters";
import { ObsidianHttpTransport } from "../integrations/dida/http";
import {
  normalizeColumns,
  normalizeProject,
  normalizeTask,
} from "../integrations/dida/normalization";
import {
  DidaWriteContractRunner,
  type DidaWriteContractProgress,
  type DidaWriteContractReport,
} from "../integrations/dida/write-contract";
import { OfflineQueue } from "../sync/offline-queue";
import { ingestRemoteRecords } from "../sync/remote-ingest";
import { createSnapshot } from "../sync/snapshots";
import { SyncEngine, type ResolvedConflict } from "../sync/sync-engine";
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
  demoMode: false,
  syncWarnings: [],
  attentionCount: 0,
  recoveryIssues: [],
};

export class HelixService {
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
  private contractTestRunning = false;
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
    const recoveredQueue = new OfflineQueue(data.queue, { recoverInterrupted: true });
    const recoveredAttention = recoveredQueue.list().filter(needsAttention).length;
    const previousAttention = data.queue.filter(needsAttention).length;
    if (data.recoveryIssues.length === 0) {
      await this.store.mutate((draft) => {
        draft.queue = recoveredQueue.list();
      });
      data = await this.store.snapshot();
    }
    this.taskEngine = new SyncEngine({
      adapter: new DidaTaskAdapter(this.api, () => this.state.taskScheduleMode),
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
        data.didaContractCapabilities?.taskScheduleMode ?? "unknown",
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
      new Notice("Helix 检测到 data.json 结构损坏，已进入只读恢复模式；请在“冲突”中复制诊断摘要。", 12_000);
    }
    this.emit();
  }

  snapshot(): HelixRuntimeState {
    return structuredClone(this.state);
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
          ledger.append(event);
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
      const contractApi = this.api.withRequestPolicy({ timeoutMs: 5_000, maxAttempts: 1 });
      const report = await new DidaWriteContractRunner(
        contractApi,
        undefined,
        undefined,
        undefined,
        onProgress,
      ).run();
      if (report.taskScheduleMode !== "unknown") {
        this.patch({ taskScheduleMode: report.taskScheduleMode });
        await this.store.mutate((data) => {
          data.didaContractCapabilities = {
            probeVersion: DIDA_CONTRACT_PROBE_VERSION,
            taskScheduleMode: report.taskScheduleMode as Exclude<TaskScheduleMode, "unknown">,
            verifiedAt: new Date().toISOString(),
          };
        });
      }
      return report;
    } finally {
      this.contractTestRunning = false;
      releaseExclusive();
      this.patch({ loading: false });
    }
  }

  async verifyRemoteTask(projectId: string, taskId: string): Promise<DidaTask> {
    this.assertActive();
    return this.withAuthorizationLease(() =>
      this.verifyRemoteTaskWithAuthorizationLease(projectId, taskId));
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
    const releaseAuthorizationLease = this.remoteWriteGate.enterShared();
    try {
      await this.createTaskWithAuthorizationLease(title, projectId, attributes);
    } finally {
      releaseAuthorizationLease();
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
  ): Promise<void> {
    this.assertWritable();
    const releaseAuthorizationLease = this.remoteWriteGate.enterShared();
    try {
      await this.queueTaskUpdateWithAuthorizationLease(task, operationType);
    } finally {
      releaseAuthorizationLease();
    }
  }

  private async queueTaskUpdateWithAuthorizationLease(
    task: DidaTask,
    operationType: "update" | "complete",
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
    const now = new Date().toISOString();
    const operation = buildTaskUpdateOperation(
      taskSyncValue(task),
      base,
      operationType,
      now,
      `op-${crypto.randomUUID()}`,
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
      await this.mutateQueue((latest) =>
        latest.resolveReconciliation(operationId, "not-created"),
      );
      await this.drainQueue();
      return;
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
      await this.mutateQueue((latest) =>
        latest.resolveReconciliation(operationId, "not-created"),
      );
      await this.drainQueue();
      await this.throwIfOperationNeedsAttention(operationId);
      return;
    }
    let adopted: EntitySnapshot<unknown> | null = null;
    if (operation.kind === "task") {
      const adapter = new DidaTaskAdapter(this.api, () => this.state.taskScheduleMode);
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
        delete draft.baseSnapshots[key];
        delete draft.localSnapshots[key];
        latest.resolveReconciliation(operationId, "confirmed");
        if (operation.kind === "task") {
          draft.inProgress = draft.inProgress.filter(
            (entry) => entry.taskId !== operation.entityId,
          );
        }
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
    await this.store.mutate((data) => {
      const conflict = data.conflicts.find((candidate) => candidate.id === conflictId);
      if (!conflict || conflict.status !== "applying") {
        throw new Error("该冲突不在等待人工核对状态");
      }
      const previousStatus = conflict.fields.some(
        (field) => !field.sameResult && !field.choice,
      )
        ? "open"
        : "staged";
      releaseConflictApplication(data.conflicts, conflictId, previousStatus);
    });
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
        await this.mutateQueue((latest) => latest.markFailed(claimedOperation.id, error));
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
      throw new Error("Helix 当前处于只读恢复模式，修复 data.json 前不能写入");
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
  const { columnId: _columnId, ...value } = task;
  return value;
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

function focusMinutes(record: DidaFocusRecord): number {
  if (typeof record.duration === "number") return Math.max(0, Math.round(record.duration / 60));
  if (record.startTime && record.endTime) {
    return Math.max(
      0,
      Math.round((new Date(record.endTime).getTime() - new Date(record.startTime).getTime()) / 60_000),
    );
  }
  return 0;
}

function needsAttention(operation: SyncQueueOperation): boolean {
  return (
    operation.status === "reconciliation" ||
    operation.status === "failed" ||
    operation.status === "blocked"
  );
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
