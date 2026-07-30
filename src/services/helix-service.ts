import { Notice } from "obsidian";
import type {
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
import { normalizeProject, normalizeTask } from "../integrations/dida/normalization";
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
import { isInsideSyncWindow } from "./sync-window";
import { SingleFlight } from "./single-flight";
import { claimNextQueueOperation } from "./queue-claim";
import {
  claimConflictApplication,
  releaseConflictApplication,
} from "./conflict-claim";

export interface HelixRuntimeState {
  loading: boolean;
  connected: boolean;
  projects: DidaProject[];
  tasks: DidaTask[];
  habits: DidaHabit[];
  habitCheckins: DidaHabitCheckin[];
  focus: DidaFocusRecord[];
  events: HelixEvent[];
  inProgress: InProgressEntry[];
  capabilities: DidaCapabilities | null;
  demoMode: boolean;
  lastSyncAt?: string;
  error?: string;
  attentionCount: number;
  recoveryIssues: string[];
}

export type StateListener = (state: HelixRuntimeState) => void;

const EMPTY_STATE: HelixRuntimeState = {
  loading: false,
  connected: false,
  projects: [],
  tasks: [],
  habits: [],
  habitCheckins: [],
  focus: [],
  events: [],
  inProgress: [],
  capabilities: null,
  demoMode: false,
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
  private readonly conflictApplications = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly store: HelixDataStore,
    secrets: HelixSecretStore,
  ) {
    this.api = new DidaApi(new ObsidianHttpTransport(), () => secrets.getDidaToken());
    this.habitService = new DidaHabitService(this.api);
    this.focusService = new DidaFocusService(this.api);
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
      adapter: new DidaTaskAdapter(this.api),
      snapshots: this.store,
      conflicts: this.store,
      deviceId: data.deviceId,
      deferConflictFinalization: true,
    });
    this.projectEngine = new SyncEngine({
      adapter: new DidaProjectAdapter(this.api),
      snapshots: this.store,
      conflicts: this.store,
      deviceId: data.deviceId,
      deferConflictFinalization: true,
    });
    this.state = {
      ...this.state,
      projects: cachedValues<DidaProject>(data, "project"),
      tasks: cachedValues<DidaTask>(data, "task"),
      habits: cachedValues<DidaHabit>(data, "habit"),
      habitCheckins: cachedValues<DidaHabitCheckin>(data, "habit-checkin"),
      focus: cachedValues<DidaFocusRecord>(data, "focus"),
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
      demoMode:
        data.settings.showSampleDataWhenDisconnected &&
        cachedValues<DidaTask>(data, "task").length === 0,
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

  async sync(): Promise<void> {
    this.assertWritable();
    if (this.state.loading) return;
    this.patch({ loading: true, error: undefined });
    try {
      const capabilities = await this.api.probeCapabilities();
      if (capabilities.projects !== "available" || capabilities.tasks !== "available") {
        throw new Error(capabilities.errors.join("；") || "任务与项目接口不可用");
      }

      // 先完整读取所有项目；任何一页失败时保留上一次可用快照，避免发布“半份数据”。
      const projectPayload = await this.api.getProjects();
      if (!Array.isArray(projectPayload)) throw new Error("项目接口返回值不是数组");
      const projects = projectPayload.map(normalizeProject);
      // 项目 data 逐一成功是删除推断的必要前提；全局 filter 负责包含收集箱。
      await Promise.all(
        projects.map((project) => this.api.getProjectData(project.id)),
      );
      const completedFrom = new Date(Date.now() - 31 * 86_400_000).toISOString();
      const completedTo = new Date().toISOString();
      const [openPayload, completedPayload] = await Promise.all([
        this.api.filterTasks({ status: [0, -1] }),
        this.api.getCompletedTasks({ startDate: completedFrom, endDate: completedTo }),
      ]);
      if (!Array.isArray(openPayload) || !Array.isArray(completedPayload)) {
        throw new Error("任务接口返回值不是数组，拒绝发布不完整快照");
      }
      const tasks = deduplicateTasks([...openPayload, ...completedPayload].map(normalizeTask));

      const habits =
        capabilities.habits === "available"
          ? await this.habitService.list()
          : this.state.habits;
      const now = Date.now();
      const from = now - 31 * 86_400_000;
      const habitCheckins =
        habits.length > 0 && capabilities.habits === "available"
          ? await this.habitService.checkins(habits.map((habit) => habit.id), from, now)
          : this.state.habitCheckins;
      const focus =
        capabilities.focus === "available"
          ? await this.focusService.list(
              new Date(from).toISOString(),
              new Date(now).toISOString(),
            )
          : this.state.focus;
      const capturedAt = new Date().toISOString();

      if (this.disposed) return;
      await this.store.mutate((data) => {
        const ledger = new EventLedger(data.events.filter(isHelixEvent));
        for (const event of eventsFromDida(data, tasks, habitCheckins, focus, {
          capturedAt,
          habitCoverageComplete: capabilities.habits === "available",
          focusCoverageComplete: capabilities.focus === "available",
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
        const coveredProjects = new Set(projects.map((project) => project.id));
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
              (coveredProjects.has(value.projectId) || value.projectId.toLowerCase().includes("inbox"))
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
      await this.drainQueue();
      if (this.disposed) return;
      const finalData = await this.store.snapshot();
      const finalTasks = cachedValues<DidaTask>(finalData, "task");
      const finalProjects = addUnlistedProjects(
        cachedValues<DidaProject>(finalData, "project"),
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
    const capabilities = await this.api.probeCapabilities();
    if (capabilities.projects !== "available" || capabilities.tasks !== "available") {
      throw new Error(capabilities.errors.join("；") || "任务与项目接口不可用");
    }
    this.patch({ capabilities, connected: true, error: undefined });
    return capabilities;
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

  async createTask(title: string, projectId: string): Promise<void> {
    this.assertWritable();
    const normalized = title.trim();
    if (!normalized) throw new Error("任务标题不能为空");
    const now = new Date().toISOString();
    const localId = `local-${crypto.randomUUID()}`;
    const task: DidaTask = {
      id: localId,
      projectId,
      title: normalized,
      status: 0,
      priority: 0,
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
      tasks: cachedValues<DidaTask>(await this.store.snapshot(), "task"),
    });
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
    if (task.id.startsWith("local-")) {
      throw new Error("该任务尚未完成远端创建核对，暂不能继续修改");
    }
    const data = await this.store.snapshot();
    const base = data.baseSnapshots[`task:${task.id}`] as
      | EntitySnapshot<DidaTask>
      | undefined;
    if (!base) throw new Error("任务缺少同步基线，请先完成一次同步");
    const now = new Date().toISOString();
    const operation = buildTaskUpdateOperation(
      task,
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
      tasks: cachedValues<DidaTask>(await this.store.snapshot(), "task"),
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
      const adapter = new DidaTaskAdapter(this.api);
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
    const selected = conflict.fields.find((field) => field.path === path);
    if (selected?.group === "schedule" && choice !== "custom") {
      let updated = conflict;
      for (const field of conflict.fields.filter((candidate) => candidate.group === "schedule")) {
        updated = await engine.choose(conflictId, field.path, choice, customValue);
      }
      return updated;
    }
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
    if (this.state.recoveryIssues.length > 0) {
      throw new Error("Helix 当前处于只读恢复模式，修复 data.json 前不能写入");
    }
  }
}

function deduplicateTasks(tasks: DidaTask[]): DidaTask[] {
  const byId = new Map<string, DidaTask>();
  for (const task of tasks) byId.set(task.id, task);
  return [...byId.values()];
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
