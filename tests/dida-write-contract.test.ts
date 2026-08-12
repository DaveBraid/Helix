import { describe, expect, it, vi } from "vitest";
import type { DidaColumn, DidaProject, DidaTask } from "../src/domain/entities";
import type { DidaTaskUpdateWirePayload } from "../src/integrations/dida/api";
import { DidaHttpError } from "../src/integrations/dida/http-contract";
import {
  assertOwnedChecklistAppend,
  assertSentinelChecklistCreate,
  DidaWriteContractRunner,
  ItemsOwnedAppendContractError,
  ItemsSentinelContractError,
  verifiedBoardPlacementCapability,
} from "../src/integrations/dida/write-contract";

class ContractApiFake {
  projects = new Map<string, DidaProject>([
    ["original-project", { id: "original-project", name: "用户原有清单" }],
  ]);
  tasks = new Map<string, DidaTask>([
    ["original-task", {
      id: "original-task",
      projectId: "original-project",
      title: "用户原有任务",
      status: 0,
    }],
  ]);
  deletedProjects: string[] = [];
  deletedTasks: string[] = [];
  injectForeignTaskOnMove = false;
  injectForeignCompletedTaskOnMove = false;
  throwAfterMove = false;
  moveNotAppliedUnknown = false;
  moveResponse: unknown = undefined;
  moveCollectionVisibility: "normal" | "both-once" | "none-once" | "both-always" | "none-always" = "normal";
  moveProjectIdentityMismatch?: "source" | "target";
  corruptMovedContent = false;
  failTargetReadAfterMove = false;
  failTargetCollectionReadAfterMove = false;
  failSourceCollectionReadAfterMove = false;
  moveCalls = 0;
  returnMoveTombstoneAtSource = false;
  duplicateSourceCollectionAfterMove = false;
  sourceTombstoneReads = 0;
  throwAfterComplete = false;
  updateOutcome: "success" | "applied-unknown" | "not-applied-unknown" = "success";
  placementOutcome: "success" | "applied-unknown" | "not-applied-unknown" = "success";
  reminderUpdateOutcome?: "applied-unknown" | "not-applied-unknown";
  parentUpdateOutcome?: "applied-unknown" | "not-applied-unknown";
  updateCalls = 0;
  updatePayloads: DidaTaskUpdateWirePayload[] = [];
  failUpdateRereadOnce = false;
  returnWrongIdOnUpdateReread = false;
  corruptUpdatedAllDay = false;
  corruptPlacementContent = false;
  placementColumnNameAfterMutation?: string;
  placementContentAfterMutation?: string;
  placementErrorAfterMutation?: string;
  rejectReminderWrites: false | string = false;
  ignoreReminderClear = false;
  addEmptyChildIdsWhenClearingReminder = false;
  replaceChildIdsWhenClearingReminder = false;
  returnStaleReminderOnClearRead = false;
  rejectRepeatWrites: false | string = false;
  advanceEtimestampOnUpdate = false;
  rejectParentCreate: false | string = false;
  rejectParentingWrites: false | string = false;
  addChecklistServerDefaults = false;
  corruptSentinelStatus = false;
  sentinelMutation?: "parent-fields" | "kind" | "count" | "id-not-preserved" | "semantics";
  forcedNewChecklistItemId?: string;
  reorderNewChecklistItem = false;
  regenerateChecklistIdsEveryWrite = false;
  ownedAppendMutation?: "parent-fields" | "kind" | "baseline-missing" | "id-regenerated" |
    "added-zero" | "added-multiple" | "id-unstable" | "client-id-changed" | "semantics" | "existing-fields";
  rejectPlacementWrites: false | string = false;
  throwAfterFirstProjectCreate = false;
  reuseOriginalProjectId = false;
  throwAfterDelete = false;
  rateLimitProjectCollectionAfterDeleteOnce = false;
  staleReadsAfterDelete = 0;
  completedVisibilityDelay = 0;
  throwCompletedReads = false;
  collapseScheduleToPoint = false;
  corruptSchedule = false;
  keepTaskOnDelete = false;
  injectForeignColumnOnTaskDelete = false;
  renameKnownColumnOnTaskDelete = false;
  corruptCreateColumnResponse = false;
  throwAfterColumnCreate = false;
  injectConcurrentColumnOnKanbanData = false;
  private staleProjects = new Map<string, { value: DidaProject; remaining: number }>();
  private staleTasks = new Map<string, { value: DidaTask; remaining: number }>();
  private moveSourceTombstones = new Map<string, DidaTask>();
  private moveSourceCollectionGhosts = new Map<string, DidaTask>();
  private projectSequence = 0;
  private taskSequence = 0;
  projectReadCount = 0;
  renameProjectOnRead?: number;
  changeProjectViewModeOnRead?: number;
  updateProjectCalls = 0;
  forceProjectDataListMode = false;
  startWithoutColumns = false;
  private readonly columns = new Map<string, DidaColumn[]>();
  private columnSequence = 0;
  private itemSequence = 0;
  private updateRereadPending = false;
  private wrongUpdateIdPending = false;
  private staleReminderClearRead?: DidaTask;
  private projectCollectionRateLimited = false;
  private moveCollectionReadRound = 0;

  async getProjects(): Promise<DidaProject[]> {
    if (
      this.rateLimitProjectCollectionAfterDeleteOnce &&
      this.deletedProjects.length > 0 &&
      !this.projectCollectionRateLimited
    ) {
      this.projectCollectionRateLimited = true;
      throw new DidaHttpError("rate-limit", "查询限流，稍后只读复核", 500, 60_000);
    }
    const projects = [...this.projects.values()].map((project) => ({ ...project }));
    for (const stale of this.staleProjects.values()) {
      if (stale.remaining <= 0) continue;
      stale.remaining -= 1;
      projects.push({ ...stale.value });
    }
    return projects;
  }

  async createProject(value: Partial<DidaProject> & Pick<DidaProject, "name">): Promise<DidaProject> {
    this.projectSequence += 1;
    const project = {
      id: this.reuseOriginalProjectId ? "original-project" : `test-project-${this.projectSequence}`,
      name: value.name,
    };
    this.projects.set(project.id, project);
    if (this.throwAfterFirstProjectCreate && this.projectSequence === 1) {
      throw new DidaHttpError("unknown-outcome", "project create unknown", 503, undefined, true);
    }
    return project;
  }

  async getProject(projectId: string): Promise<DidaProject> {
    this.projectReadCount += 1;
    const project = this.projects.get(projectId);
    if (!project) {
      const stale = this.staleProjects.get(projectId);
      if (!stale || stale.remaining <= 0) throw notFound();
      stale.remaining -= 1;
      return { ...stale.value };
    }
    if (this.renameProjectOnRead === this.projectReadCount) {
      const renamed = { ...project, name: "并发改名" };
      this.projects.set(projectId, renamed);
      return renamed;
    }
    if (this.changeProjectViewModeOnRead === this.projectReadCount) {
      const changed = { ...project, viewMode: project.viewMode === "list" ? "kanban" : "list" };
      this.projects.set(projectId, changed);
      return changed;
    }
    return { ...project };
  }

  async updateProject(projectId: string, value: Partial<DidaProject>): Promise<DidaProject> {
    this.updateProjectCalls += 1;
    const current = this.projects.get(projectId);
    if (!current) throw notFound();
    const updated = { ...current, ...value, id: projectId };
    this.projects.set(projectId, updated);
    return { ...updated };
  }

  async getColumns(projectId: string): Promise<DidaColumn[]> {
    if (!this.projects.has(projectId)) throw notFound();
    const stored = this.columns.get(projectId);
    if (stored) return stored.map((column) => ({ ...column }));
    if (this.startWithoutColumns) return [];
    return [
      { id: `${projectId}-todo`, projectId, name: "待处理" },
      { id: `${projectId}-doing`, projectId, name: "进行中" },
      { id: `${projectId}-done`, projectId, name: "已完成" },
    ];
  }

  async createColumn(projectId: string, value: Pick<DidaColumn, "name">): Promise<DidaColumn> {
    this.columnSequence += 1;
    const column = { id: `test-column-${this.columnSequence}`, projectId, name: value.name };
    this.columns.set(projectId, [...await this.getColumns(projectId), column]);
    if (this.throwAfterColumnCreate) {
      throw new DidaHttpError("unknown-outcome", "column create unknown", 503, undefined, true);
    }
    return this.corruptCreateColumnResponse
      ? { ...column, projectId: "wrong-project" }
      : { ...column };
  }

  async updateColumn(
    projectId: string,
    columnId: string,
    value: Pick<DidaColumn, "name">,
  ): Promise<DidaColumn> {
    const columns = await this.getColumns(projectId);
    const current = columns.find((column) => column.id === columnId);
    if (!current) throw notFound();
    const updated = { ...current, name: value.name };
    this.columns.set(projectId, columns.map((column) =>
      column.id === columnId ? updated : column));
    return { ...updated };
  }

  async getProjectData(projectId: string): Promise<{
    project: DidaProject;
    tasks: DidaTask[];
    columns: Array<{ id: string; projectId: string; name: string }>;
  }> {
    if (
      this.failTargetCollectionReadAfterMove &&
      projectId === "test-project-2" &&
      this.tasks.get("test-task-1")?.projectId === projectId
    ) {
      throw new Error("target collection reread unavailable");
    }
    if (
      this.failSourceCollectionReadAfterMove &&
      projectId === "test-project-1" &&
      this.tasks.get("test-task-1")?.projectId === "test-project-2"
    ) {
      throw new Error("source collection reread unavailable");
    }
    if (
      this.injectConcurrentColumnOnKanbanData &&
      this.projects.get(projectId)?.viewMode === "kanban"
    ) {
      this.injectConcurrentColumnOnKanbanData = false;
      this.columns.set(projectId, [
        ...await this.getColumns(projectId),
        { id: "concurrent-kanban-column", projectId, name: "用户竞争分栏" },
      ]);
    }
    if (this.moveCalls > 0 && projectId === "test-project-1") this.moveCollectionReadRound += 1;
    const isMoveCollection = this.moveCalls > 0 &&
      (projectId === "test-project-1" || projectId === "test-project-2");
    const visibility = this.moveCollectionVisibility;
    const transient = (visibility === "both-once" || visibility === "none-once") &&
      this.moveCollectionReadRound === 1;
    const forceBoth = visibility === "both-always" || (visibility === "both-once" && transient);
    const forceNone = visibility === "none-always" || (visibility === "none-once" && transient);
    const project = this.forceProjectDataListMode
        ? { ...await this.getProject(projectId), viewMode: "list" }
        : await this.getProject(projectId);
    const tasks = [
        ...[...this.tasks.values()].filter(
          (task) => task.projectId === projectId && task.status !== 2,
        ),
        ...[...this.moveSourceCollectionGhosts.values()].filter(
          (task) => task.projectId === projectId && task.status !== 2,
        ),
      ];
    if (isMoveCollection && forceBoth && projectId === "test-project-1") {
      const moved = this.tasks.get("test-task-1");
      if (moved) tasks.push({ ...moved, projectId });
    }
    const visibleTasks = isMoveCollection && forceNone
      ? tasks.filter((task) => task.id !== "test-task-1")
      : tasks;
    return {
      project: this.moveProjectIdentityMismatch === "source" && isMoveCollection &&
          projectId === "test-project-1"
        ? { ...project, id: "wrong-source-project" }
        : this.moveProjectIdentityMismatch === "target" && isMoveCollection &&
            projectId === "test-project-2"
          ? { ...project, id: "wrong-target-project" }
          : project,
      tasks: visibleTasks,
      columns: await this.getColumns(projectId),
    };
  }

  async getCompletedTasks(filter: Record<string, unknown>): Promise<DidaTask[]> {
    if (this.throwCompletedReads) throw new Error("completed endpoint timeout");
    const projectIds = new Set(Array.isArray(filter.projectIds) ? filter.projectIds : []);
    const start = Date.parse(String(filter.startDate));
    const end = Date.parse(String(filter.endDate));
    const inRange = (task: DidaTask): boolean => {
      const completed = Date.parse(task.completedTime ?? "");
      return Number.isFinite(completed) && completed >= start && completed <= end;
    };
    const activeCompleted = [...this.tasks.values()]
      .filter((task) => task.status === 2 && projectIds.has(task.projectId) && inRange(task));
    if (activeCompleted.length > 0 && this.completedVisibilityDelay > 0) {
      this.completedVisibilityDelay -= 1;
    }
    const tasks = activeCompleted
      .filter(() => this.completedVisibilityDelay <= 0)
      .map((task) => ({ ...task }));
    for (const stale of this.staleTasks.values()) {
      if (
        stale.remaining <= 0 ||
        stale.value.status !== 2 ||
        !projectIds.has(stale.value.projectId) ||
        !inRange(stale.value)
      ) {
        continue;
      }
      stale.remaining -= 1;
      tasks.push({ ...stale.value });
    }
    return tasks;
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = this.projects.get(projectId);
    this.deletedProjects.push(projectId);
    this.projects.delete(projectId);
    if (project && this.staleReadsAfterDelete > 0) {
      this.staleProjects.set(projectId, {
        value: { ...project },
        remaining: this.staleReadsAfterDelete,
      });
    }
    if (this.throwAfterDelete) throw new Error("empty response parse failure");
  }

  async createTask(
    value: Partial<DidaTask> & Pick<DidaTask, "title" | "projectId">,
  ): Promise<DidaTask> {
    if (this.rejectParentingWrites && value.parentId) {
      throw new DidaHttpError("permanent", this.rejectParentingWrites, 400);
    }
    const task: DidaTask = {
      ...value,
      id: `test-task-${++this.taskSequence}`,
      title: value.title,
      projectId: value.projectId,
      status: 0,
      kind: value.kind ?? "TEXT",
    };
    if (this.collapseScheduleToPoint && task.dueDate) task.startDate = task.dueDate;
    if (this.corruptSchedule) task.dueDate = "2030-01-01T00:00:00.000Z";
    this.tasks.set(task.id, task);
    return { ...task };
  }

  async getTask(projectId: string, taskId: string): Promise<DidaTask> {
    if (this.updateRereadPending) {
      this.updateRereadPending = false;
      throw new Error("update reread unavailable");
    }
    const task = this.tasks.get(taskId);
    if (this.failTargetReadAfterMove && projectId === "test-project-2" && task?.projectId === projectId) {
      throw new Error("target reread unavailable");
    }
    if (task && this.wrongUpdateIdPending) {
      this.wrongUpdateIdPending = false;
      return { ...task, id: "wrong-task-id" };
    }
    if (task && this.staleReminderClearRead?.id === taskId) {
      const stale = this.staleReminderClearRead;
      this.staleReminderClearRead = undefined;
      return { ...stale };
    }
    if (!task || task.projectId !== projectId) {
      const moveTombstone = this.moveSourceTombstones.get(`${projectId}:${taskId}`);
      if (this.returnMoveTombstoneAtSource && moveTombstone) {
        this.sourceTombstoneReads += 1;
        return { ...moveTombstone };
      }
      const stale = this.staleTasks.get(`${projectId}:${taskId}`);
      if (!stale || stale.remaining <= 0) throw notFound();
      stale.remaining -= 1;
      return { ...stale.value };
    }
    return { ...task };
  }

  async updateTask(taskId: string, value: DidaTaskUpdateWirePayload): Promise<DidaTask> {
    this.updateCalls += 1;
    this.updatePayloads.push({ ...value });
    const current = this.tasks.get(taskId);
    if (!current) throw notFound();
    if (this.rejectReminderWrites && Object.hasOwn(value, "reminders")) {
      throw new DidaHttpError("permanent", this.rejectReminderWrites, 400);
    }
    if (this.rejectRepeatWrites && Object.hasOwn(value, "repeatFlag")) {
      throw new DidaHttpError("permanent", this.rejectRepeatWrites, 400);
    }
    if (this.rejectParentCreate && Object.hasOwn(value, "items")) {
      throw new DidaHttpError("permanent", this.rejectParentCreate, 400);
    }
    const placement = Object.prototype.hasOwnProperty.call(value, "columnId") &&
      !Object.prototype.hasOwnProperty.call(value, "title");
    if (placement && this.rejectPlacementWrites) {
      throw new DidaHttpError("permanent", this.rejectPlacementWrites, 400);
    }
    const outcome = placement
      ? this.placementOutcome
      : Object.hasOwn(value, "reminders")
        ? (this.reminderUpdateOutcome ?? this.updateOutcome)
        : Object.hasOwn(value, "items")
          ? (this.parentUpdateOutcome ?? this.updateOutcome)
          : this.updateOutcome;
    if (outcome === "not-applied-unknown") {
      if (this.failUpdateRereadOnce) this.updateRereadPending = true;
      throw new DidaHttpError("unknown-outcome", "update unknown", 503, undefined, true);
    }
    const updated = {
      ...current,
      ...value,
      reminders: value.reminders === null
        ? (this.ignoreReminderClear ? current.reminders : [])
        : (value.reminders ?? current.reminders),
      ...(this.advanceEtimestampOnUpdate
        ? { etimestamp: Number(current.etimestamp ?? 0) + 1 }
        : {}),
    };
    if (Object.hasOwn(value, "items")) {
      if (value.kind !== "CHECKLIST") {
        updated.items = current.items;
        updated.kind = current.kind;
      } else {
      updated.items = (value.items ?? []).flatMap((item) => {
        const hasId = Object.hasOwn(item, "id");
        const isNew = !current.items?.some((candidate) => candidate.id === item.id);
        // 保留历史故障模型以防回归：空串 ID 会被忽略；当前生产与合同均不会走此路径。
        if (hasId && item.id === "") return [];
        return [{
          ...item,
          id: isNew && this.forcedNewChecklistItemId !== undefined
            ? this.forcedNewChecklistItemId
            : hasId ? item.id : `test-item-${++this.itemSequence}`,
          ...(isNew && this.addChecklistServerDefaults
            ? { ...(item.sortOrder === undefined ? { sortOrder: 987 } : {}), isAllDay: false, timeZone: "Asia/Shanghai", completedTime: undefined }
            : {}),
        }];
      }).map((item) => {
        const before = current.items?.find((candidate) => candidate.id === item.id);
        if (before?.status === 0 && item.status === 2) {
          return { ...item, completedTime: "2026-07-31T00:00:00.000Z" };
        }
        if (before?.status === 2 && item.status === 0) {
          const reopened = { ...item };
          delete reopened.completedTime;
          return reopened;
        }
        return item;
      });
      if (this.regenerateChecklistIdsEveryWrite) {
        updated.items = updated.items.map((item) => ({ ...item, id: `server-item-${++this.itemSequence}` }));
      }
      if (this.corruptSentinelStatus && current.items === undefined && updated.items[0]) {
        updated.items[0] = { ...updated.items[0], status: 2 };
      }
      if (current.items === undefined && this.sentinelMutation) {
        if (this.sentinelMutation === "parent-fields") updated.desc = "server-mutated-parent";
        if (this.sentinelMutation === "kind") updated.kind = "TASK";
        if (this.sentinelMutation === "count") updated.items = [];
        if (this.sentinelMutation === "id-not-preserved" && updated.items[0]) {
          updated.items[0] = { ...updated.items[0], id: "server-regenerated-id" };
        }
        if (this.sentinelMutation === "semantics" && updated.items[0]) {
          updated.items[0] = { ...updated.items[0], status: 2 };
        }
      }
      if (this.reorderNewChecklistItem && current.items?.length === 1 && updated.items.length === 2) {
        updated.items = [...updated.items].reverse();
      }
      if (current.items?.length === 1 && updated.items.length === 2 && this.ownedAppendMutation) {
        const existingId = current.items[0]!.id;
        const newIndex = updated.items.findIndex((item) => item.id !== existingId);
        if (this.ownedAppendMutation === "parent-fields") updated.desc = "server-recomputed-parent-field";
        if (this.ownedAppendMutation === "kind") updated.kind = "TASK";
        if (this.ownedAppendMutation === "baseline-missing") updated.items = updated.items.filter((item) => item.id !== existingId);
        if (this.ownedAppendMutation === "id-regenerated") {
          const existingIndex = updated.items.findIndex((item) => item.id === existingId);
          if (existingIndex >= 0) updated.items[existingIndex] = { ...updated.items[existingIndex]!, id: "regenerated-existing-id" };
        }
        if (this.ownedAppendMutation === "added-zero") updated.items = [...current.items];
        if (this.ownedAppendMutation === "added-multiple") {
          updated.items.push({ id: "unexpected-second-new", title: "unexpected", status: 0 });
        }
        if (this.ownedAppendMutation === "id-unstable" && newIndex >= 0) updated.items[newIndex] = { ...updated.items[newIndex]!, id: " " };
        if (this.ownedAppendMutation === "client-id-changed" && newIndex >= 0) updated.items[newIndex] = { ...updated.items[newIndex]!, id: "1999999999999" };
        if (this.ownedAppendMutation === "semantics" && newIndex >= 0) updated.items[newIndex] = { ...updated.items[newIndex]!, status: 2 };
        if (this.ownedAppendMutation === "existing-fields") {
          const existingIndex = updated.items.findIndex((item) => item.id === existingId);
          if (existingIndex >= 0) updated.items[existingIndex] = { ...updated.items[existingIndex]!, sortOrder: 321 };
        }
      }
      }
    }
    if (this.collapseScheduleToPoint && updated.dueDate) updated.startDate = updated.dueDate;
    if (this.corruptSchedule) updated.dueDate = "2030-01-01T00:00:00.000Z";
    if (this.corruptUpdatedAllDay) updated.isAllDay = true;
    if (
      this.addEmptyChildIdsWhenClearingReminder &&
      (value.reminders === null ||
        (Array.isArray(value.reminders) && value.reminders.length === 0))
    ) {
      updated.childIds = [];
    }
    if (
      this.replaceChildIdsWhenClearingReminder &&
      (value.reminders === null ||
        (Array.isArray(value.reminders) && value.reminders.length === 0))
    ) {
      updated.childIds = ["unexpected-child-id"];
    }
    if (
      this.returnStaleReminderOnClearRead &&
      (value.reminders === null ||
        (Array.isArray(value.reminders) && value.reminders.length === 0))
    ) {
      this.staleReminderClearRead = { ...current };
    }
    if (placement && this.corruptPlacementContent) {
      updated.content = this.placementContentAfterMutation ?? "被归栏意外改写";
    }
    if (placement && this.placementColumnNameAfterMutation !== undefined) {
      updated.columnName = this.placementColumnNameAfterMutation;
    }
    this.tasks.set(taskId, updated);
    if (placement && this.placementErrorAfterMutation) {
      throw new DidaHttpError("permanent", this.placementErrorAfterMutation, 400);
    }
    if (outcome === "applied-unknown") {
      if (this.failUpdateRereadOnce) this.updateRereadPending = true;
      if (this.returnWrongIdOnUpdateReread) this.wrongUpdateIdPending = true;
      throw new DidaHttpError("unknown-outcome", "update unknown", 503, undefined, true);
    }
    return { ...updated };
  }

  async moveTask(input: {
    fromProjectId: string;
    toProjectId: string;
    taskId: string;
  }): Promise<unknown> {
    this.moveCalls += 1;
    if (this.moveNotAppliedUnknown) {
      throw new DidaHttpError("unknown-outcome", "move not applied unknown", 503, undefined, true);
    }
    const task = await this.getTask(input.fromProjectId, input.taskId);
    this.moveSourceTombstones.set(`${input.fromProjectId}:${task.id}`, { ...task });
    if (this.duplicateSourceCollectionAfterMove) {
      this.moveSourceCollectionGhosts.set(`${input.fromProjectId}:${task.id}`, { ...task });
    }
    this.tasks.set(task.id, {
      ...task,
      projectId: input.toProjectId,
      ...(this.corruptMovedContent ? { content: "move corrupted content" } : {}),
    });
    if (this.injectForeignTaskOnMove) {
      this.tasks.set("foreign-task", {
        id: "foreign-task",
        projectId: input.toProjectId,
        title: "用户意外放入的任务",
        status: 0,
      });
    }
    if (this.injectForeignCompletedTaskOnMove) {
      this.tasks.set("foreign-completed-task", {
        id: "foreign-completed-task",
        projectId: input.toProjectId,
        title: "用户意外放入并完成的任务",
        status: 2,
        completedTime: "2000-01-01T00:00:00.000Z",
      });
    }
    if (this.throwAfterMove) {
      throw new DidaHttpError("unknown-outcome", "move unknown", 503, undefined, true);
    }
    return this.moveResponse ?? { id: task.id };
  }

  async completeTask(projectId: string, taskId: string): Promise<void> {
    const task = await this.getTask(projectId, taskId);
    this.tasks.set(task.id, {
      ...task,
      status: 2,
      completedTime: "2026-07-31T00:00:00.000Z",
    });
    if (this.throwAfterComplete) {
      throw new DidaHttpError("unknown-outcome", "complete unknown", 503, undefined, true);
    }
  }

  async deleteTask(projectId: string, taskId: string): Promise<void> {
    const task = await this.getTask(projectId, taskId);
    this.deletedTasks.push(taskId);
    if (!this.keepTaskOnDelete) this.tasks.delete(taskId);
    if (this.injectForeignColumnOnTaskDelete && taskId === "test-task-1") {
      this.columns.set(projectId, [
        ...await this.getColumns(projectId),
        { id: "foreign-column", projectId, name: "用户新增分栏" },
      ]);
    }
    if (this.renameKnownColumnOnTaskDelete && taskId === "test-task-1") {
      const columns = await this.getColumns(projectId);
      this.columns.set(projectId, columns.map((column, index) =>
        index === 0 ? { ...column, name: "用户并发改名" } : column));
    }
    if (this.staleReadsAfterDelete > 0) {
      this.staleTasks.set(`${projectId}:${taskId}`, {
        value: { ...task },
        remaining: this.staleReadsAfterDelete,
      });
    }
    if (this.throwAfterDelete) throw new Error("empty response parse failure");
  }
}

describe("DidaWriteContractRunner", () => {
  it("never unlocks production placement while test artifacts may remain", () => {
    expect(verifiedBoardPlacementCapability({
      boardPlacementVerified: true,
      remoteArtifactsRemaining: true,
    })).toBe(false);
    expect(verifiedBoardPlacementCapability({
      boardPlacementVerified: true,
      remoteArtifactsRemaining: false,
    })).toBe(true);
  });
  it("does not absorb a concurrently added column after switching to kanban", async () => {
    const api = new ContractApiFake();
    api.injectConcurrentColumnOnKanbanData = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-kanban-baseline-race",
      fixedNow,
    ).run();
    expect(report.status).toBe("failed");
    expect(report.failure).toMatch(/切换看板后列基线出现未知变化/);
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(api.projects.has("test-project-1")).toBe(true);
  });

  it("refuses to delete a test project whose column set changed concurrently", async () => {
    const api = new ContractApiFake();
    api.injectForeignColumnOnTaskDelete = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-column-race",
      fixedNow,
    ).run();
    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.columnCreateVerified).toBe(false);
    expect(report.cleanupErrors.join(" ")).toMatch(/分栏集合.*未知变化/);
    expect(api.projects.has("test-project-2")).toBe(true);
    expect(api.projects.has("original-project")).toBe(true);
  });

  it("refuses to delete a test project after a same-ID column rename", async () => {
    const api = new ContractApiFake();
    api.renameKnownColumnOnTaskDelete = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-column-rename-race",
      fixedNow,
    ).run();
    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.cleanupErrors.join(" ")).toMatch(/分栏集合.*未知变化/);
    expect(api.projects.has("test-project-2")).toBe(true);
  });

  it.each([
    ["invalid response", (api: ContractApiFake) => { api.corruptCreateColumnResponse = true; }],
    ["unknown outcome", (api: ContractApiFake) => { api.throwAfterColumnCreate = true; }],
  ])("keeps the marked project for manual review after %s from column create", async (_label, arrange) => {
    const api = new ContractApiFake();
    api.startWithoutColumns = true;
    arrange(api);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-column-create-failure",
      fixedNow,
    ).run();
    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(api.projects.has("test-project-1")).toBe(true);
    expect(api.projects.has("original-project")).toBe(true);
  });

  it("refuses to overwrite a run-created project renamed before the first view-mode write", async () => {
    const api = new ContractApiFake();
    api.renameProjectOnRead = 3;
    const report = await new DidaWriteContractRunner(api, () => "run-view-race", fixedNow).run();
    expect(report.status).toBe("failed");
    expect(report.failureStage).toBe("验证专用清单列表与看板默认视图");
    expect(report.failure).toMatch(/身份、标记或视图基线已变化/);
    expect(api.updateProjectCalls).toBe(0);
  });

  it("does not accept stale columns after the detail project has returned to list mode", async () => {
    const api = new ContractApiFake();
    api.forceProjectDataListMode = true;
    const report = await new DidaWriteContractRunner(api, () => "run-stale-columns", fixedNow).run();
    expect(report.status).toBe("failed");
    expect(report.failureStage).toBe("验证专用清单列表与看板默认视图");
    expect(report.failure).toMatch(/视图状态不一致/);
  });

  it("refuses to overwrite a concurrent view-mode change between verified steps", async () => {
    const api = new ContractApiFake();
    api.changeProjectViewModeOnRead = 5;
    const report = await new DidaWriteContractRunner(api, () => "run-view-baseline", fixedNow).run();
    expect(report.status).toBe("failed");
    expect(report.failureStage).toBe("验证专用清单列表与看板默认视图");
    expect(report.failure).toMatch(/视图基线已变化/);
    expect(api.updateProjectCalls).toBe(1);
  });
  const fixedNow = () => new Date("2026-07-31T00:00:00.000Z");

  it("tests only run-created IDs and removes every temporary artifact", async () => {
    const api = new ContractApiFake();
    const report = await new DidaWriteContractRunner(api, () => "run-safe", fixedNow).run();

    expect(report.failure).toBeUndefined();
    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
      taskCrudVerified: true,
      reminderWriteVerified: true,
      repeatWriteVerified: true,
      itemsRoundTripVerified: true,
      itemIdStableVerified: true,
      taskReopenVerified: true,
    });
    expect(api.updatePayloads).toContainEqual(expect.objectContaining({
      reminders: ["TRIGGER:-PT10M"],
    }));
    expect(api.updatePayloads).toContainEqual(expect.objectContaining({
      repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
    }));
    expect(api.updatePayloads).toContainEqual(expect.objectContaining({
      reminders: null,
    }));
    expect(api.updatePayloads).toContainEqual(expect.objectContaining({ repeatFlag: null }));
    expect(api.updatePayloads.filter((payload) => Object.hasOwn(payload, "items"))).toHaveLength(5);
    expect(api.updatePayloads.filter((payload) => Object.hasOwn(payload, "parentId"))).toEqual([
      { id: "test-task-4", projectId: "test-project-1", parentId: "" },
      { id: "test-task-4", projectId: "test-project-1", parentId: "test-task-1" },
    ]);
    expect(api.updatePayloads.filter((payload) => Object.hasOwn(payload, "status"))).toEqual([{
      id: "test-task-7",
      projectId: "test-project-1",
      status: 0,
    }]);
    expect(report.steps.join(" ")).toMatch(/创建唯一标记分栏.*列表→看板→列表.*4 个看板列/);
    expect(report.columnCreateVerified).toBe(true);
    expect(report.cleanupPlan).toBeUndefined();
    expect(api.projects.get("original-project")?.name).toBe("用户原有清单");
    expect(api.tasks.get("original-task")?.title).toBe("用户原有任务");
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.deletedTasks).toEqual(["test-task-2", "test-task-3", "test-task-4", "test-task-5", "test-task-6", "test-task-1", "test-task-7"]);
    expect([...api.projects]).toHaveLength(1);
    expect([...api.tasks]).toHaveLength(1);
  });

  it("accepts server defaults on a newly created checklist item and preserves them afterward", async () => {
    const api = new ContractApiFake();
    api.addChecklistServerDefaults = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-items-server-defaults",
      fixedNow,
    ).run();
    expect(report).toMatchObject({
      status: "passed",
      itemsRoundTripVerified: true,
      itemIdStableVerified: true,
      capabilityFailureCodes: [],
      remoteArtifactsRemaining: false,
    });
    const itemWrites = api.updatePayloads.filter((payload) => Object.hasOwn(payload, "items"));
    expect(itemWrites.every((payload) => payload.kind === "CHECKLIST")).toBe(true);
    expect(itemWrites.slice(1).some((payload) => payload.items?.[0]?.timeZone === "Asia/Shanghai")).toBe(true);
    expect(itemWrites[0]?.items?.[0]).toMatchObject({
      id: "1785456000000",
      sortOrder: 0,
    });
    expect(itemWrites.slice(1).every((payload) => payload.items?.[0]?.sortOrder === 0)).toBe(true);
  });

  it("preserves the persisted client ID when the server repositions the new item by sortOrder", async () => {
    const api = new ContractApiFake();
    api.reorderNewChecklistItem = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-items-server-reorder",
      fixedNow,
    ).run();
    expect(report).toMatchObject({
      status: "passed",
      itemsRoundTripVerified: true,
      itemIdStableVerified: true,
      capabilityFailureCodes: [],
      remoteArtifactsRemaining: false,
    });
    const itemWrites = api.updatePayloads.filter((payload) => Object.hasOwn(payload, "items"));
    const reorderedIds = itemWrites[2]?.items?.map((item) => item.id);
    expect(reorderedIds).toEqual(["1785456000001", "1785456000000"]);
  });

  it.each([
    ["parent-fields", "ITEMS_OWNED_APPEND_PARENT_FIELDS"],
    ["kind", "ITEMS_OWNED_APPEND_KIND"],
    ["baseline-missing", "ITEMS_OWNED_APPEND_ADDED_ZERO"],
    ["added-zero", "ITEMS_OWNED_APPEND_ADDED_ZERO"],
    ["added-multiple", "ITEMS_OWNED_APPEND_ADDED_MULTIPLE"],
    ["id-unstable", "ITEMS_OWNED_APPEND_ID_UNSTABLE"],
    ["semantics", "ITEMS_OWNED_APPEND_SEMANTICS"],
    ["existing-fields", "ITEMS_OWNED_APPEND_EXISTING_FIELDS"],
  ] as const)("reports the redacted owned-append subcode for %s", async (mutation, code) => {
    const api = new ContractApiFake();
    api.ownedAppendMutation = mutation;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-secret-owned-append",
      fixedNow,
    ).run();
    expect(report).toMatchObject({
      status: "passed",
      itemsRoundTripVerified: false,
      itemIdStableVerified: false,
      capabilityFailureCodes: [code],
      remoteArtifactsRemaining: false,
    });
    expect(JSON.stringify(report.capabilityFailureCodes)).not.toMatch(/run-secret|test-item|test-task/iu);
  });

  it.each([
    ["ITEMS_OWNED_APPEND_PARENT_FIELDS", (task: DidaTask) => ({ ...task, desc: "changed" })],
    ["ITEMS_OWNED_APPEND_KIND", (task: DidaTask) => ({ ...task, kind: "TASK" })],
    ["ITEMS_OWNED_APPEND_ADDED_ZERO", (task: DidaTask) => ({ ...task, items: [task.items![0]!, task.items![2]!] })],
    ["ITEMS_OWNED_APPEND_ADDED_ZERO", (task: DidaTask) => ({ ...task, items: task.items!.slice(1) })],
    ["ITEMS_OWNED_APPEND_ADDED_MULTIPLE", (task: DidaTask) => ({ ...task, items: [task.items![0]!, { id: "extra", title: "extra", status: 0 }, ...task.items!.slice(1)] })],
    ["ITEMS_OWNED_APPEND_ID_UNSTABLE", (task: DidaTask) => ({ ...task, items: [{ ...task.items![0]!, id: " " }, ...task.items!.slice(1)] })],
    ["ITEMS_OWNED_APPEND_SEMANTICS", (task: DidaTask) => ({ ...task, items: [{ ...task.items![0]!, status: 2 }, ...task.items!.slice(1)] })],
    ["ITEMS_OWNED_APPEND_EXISTING_FIELDS", (task: DidaTask) => ({ ...task, items: [task.items![0]!, { ...task.items![1]!, sortOrder: 999 }, task.items![2]!] })],
    ["ITEMS_OWNED_APPEND_EXISTING_ORDER", (task: DidaTask) => ({ ...task, items: [task.items![0]!, task.items![2]!, task.items![1]!] })],
  ] as const)("maps the append invariant to fixed code %s", (code, mutate) => {
    const before: DidaTask = {
      id: "parent", projectId: "list", title: "parent", status: 0, kind: "CHECKLIST",
      items: [
        { id: "sentinel-a", title: "A", status: 0, sortOrder: 2 },
        { id: "sentinel-b", title: "B", status: 0, sortOrder: 1 },
      ],
    };
    const reread: DidaTask = {
      ...before,
      items: [{ id: "owned", title: "owned title", status: 0, sortOrder: 3 }, ...before.items!],
    };
    expect(() => assertOwnedChecklistAppend(before, mutate(reread), reread.items![0]!))
      .toThrow(expect.objectContaining<Partial<ItemsOwnedAppendContractError>>({ code }));
  });

  it("reports a fixed redacted items stage code for semantic sentinel failure", async () => {
    const api = new ContractApiFake();
    api.corruptSentinelStatus = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-secret-items-stage",
      fixedNow,
    ).run();
    expect(report).toMatchObject({
      status: "passed",
      itemsRoundTripVerified: false,
      itemIdStableVerified: false,
      capabilityFailureCodes: ["ITEMS_SENTINEL_SEMANTICS"],
      remoteArtifactsRemaining: false,
    });
    expect(JSON.stringify(report.capabilityFailureCodes)).not.toMatch(/run-secret|test-item|test-task/iu);
  });

  it.each(["", "   ", " item-with-spaces ", "item-with\nnewline"])(
    "rejects an unstable server checklist ID with a redacted sentinel-stage code: %j",
    async (serverId) => {
      const api = new ContractApiFake();
      api.forcedNewChecklistItemId = serverId;
      const report = await new DidaWriteContractRunner(
        api,
        () => "run-unstable-item-id",
        fixedNow,
      ).run();
      expect(report).toMatchObject({
        status: "passed",
        itemsRoundTripVerified: false,
        itemIdStableVerified: false,
        capabilityFailureCodes: ["ITEMS_SENTINEL_ID_UNSTABLE"],
        remoteArtifactsRemaining: false,
      });
      if (serverId) expect(JSON.stringify(report.capabilityFailureCodes)).not.toContain(serverId);
    },
  );

  it.each([
    ["parent-fields", "ITEMS_SENTINEL_PARENT_FIELDS"],
    ["kind", "ITEMS_SENTINEL_KIND"],
    ["count", "ITEMS_SENTINEL_COUNT"],
    ["semantics", "ITEMS_SENTINEL_SEMANTICS"],
  ] as const)("reports the redacted sentinel subcode for %s", async (mutation, code) => {
    const api = new ContractApiFake();
    api.sentinelMutation = mutation;
    const report = await new DidaWriteContractRunner(
      api, () => "run-secret-sentinel", fixedNow,
    ).run();
    expect(report).toMatchObject({
      status: "passed",
      itemsRoundTripVerified: false,
      itemIdStableVerified: false,
      capabilityFailureCodes: [code],
      remoteArtifactsRemaining: false,
    });
    expect(JSON.stringify(report.capabilityFailureCodes)).not.toMatch(/run-secret|test-item|test-task/iu);
  });

  it.each([
    ["ITEMS_SENTINEL_PARENT_FIELDS", (task: DidaTask) => ({ ...task, desc: "changed" })],
    ["ITEMS_SENTINEL_KIND", (task: DidaTask) => ({ ...task, kind: "TASK" })],
    ["ITEMS_SENTINEL_COUNT", (task: DidaTask) => ({ ...task, items: [] })],
    ["ITEMS_SENTINEL_ID_UNSTABLE", (task: DidaTask) => ({ ...task, items: [{ ...task.items![0]!, id: " " }] })],
    ["ITEMS_SENTINEL_SEMANTICS", (task: DidaTask) => ({ ...task, items: [{ ...task.items![0]!, sortOrder: 8 }] })],
  ] as const)("maps the sentinel invariant to fixed code %s", (code, mutate) => {
    const before: DidaTask = { id: "parent", projectId: "list", title: "parent", status: 0 };
    const expected = { id: "1785456000000", title: "sentinel", status: 0, sortOrder: 0 };
    const reread: DidaTask = { ...before, kind: "CHECKLIST", items: [expected] };
    expect(() => assertSentinelChecklistCreate(before, mutate(reread), expected))
      .toThrow(expect.objectContaining<Partial<ItemsSentinelContractError>>({ code }));
  });

  it.each([
    ["sentinel", "id-not-preserved"],
    ["owned", "client-id-changed"],
  ] as const)("accepts a known successful %s ID replacement but records client-ID instability", async (stage, mutation) => {
    const api = new ContractApiFake();
    if (stage === "sentinel") api.sentinelMutation = mutation;
    else api.ownedAppendMutation = mutation;
    const report = await new DidaWriteContractRunner(
      api, () => `run-known-${stage}-replacement`, fixedNow,
    ).run();
    expect(report).toMatchObject({
      status: "passed",
      itemsRoundTripVerified: true,
      itemIdStableVerified: false,
      capabilityFailureCodes: [],
      remoteArtifactsRemaining: false,
    });
  });

  it("accepts known-success full-chain ID regeneration while keeping the account unstable", async () => {
    const api = new ContractApiFake();
    api.regenerateChecklistIdsEveryWrite = true;

    const report = await new DidaWriteContractRunner(
      api, () => "run-known-full-id-regeneration", fixedNow,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      itemsRoundTripVerified: true,
      itemIdStableVerified: false,
      capabilityFailureCodes: [],
      remoteArtifactsRemaining: false,
    });
  });

  it("does not adopt a replacement ID but safely isolates an unknown sentinel outcome", async () => {
    const api = new ContractApiFake();
    api.sentinelMutation = "id-not-preserved";
    api.parentUpdateOutcome = "applied-unknown";
    const report = await new DidaWriteContractRunner(
      api, () => "run-unknown-id-replacement", fixedNow,
    ).run();
    expect(report).toMatchObject({
      status: "passed",
      itemsRoundTripVerified: false,
      itemIdStableVerified: false,
      boardPlacementVerified: true,
      remoteArtifactsRemaining: false,
    });
    expect(report.capabilityFailures).toContain("检查项：未通过写入合同，保持只读");
  });

  it("checkpoints sent-unknown before every temporary task and project delete", async () => {
    const api = new ContractApiFake();
    let latest: import("../src/domain/dida-contract-cleanup").DidaContractCleanupPlan | undefined;
    const taskArmed: Array<{ taskId: string; armed: boolean }> = [];
    const projectArmed: boolean[] = [];
    const originalDeleteTask = api.deleteTask.bind(api);
    api.deleteTask = async (projectId, taskId) => {
      taskArmed.push({
        taskId,
        armed: latest?.tasks.find((task) => task.id === taskId)?.deleteState === "sent-unknown",
      });
      return originalDeleteTask(projectId, taskId);
    };
    const originalDeleteProject = api.deleteProject.bind(api);
    api.deleteProject = async (projectId) => {
      projectArmed.push(latest?.projects.find((project) => project.id === projectId)?.deleteState === "sent-unknown");
      return originalDeleteProject(projectId);
    };
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-delete-checkpoint",
      fixedNow,
      undefined,
      undefined,
      undefined,
      async (plan) => { latest = structuredClone(plan); },
    ).run();
    expect(report.status).toBe("passed");
    expect(taskArmed.length).toBeGreaterThan(0);
    expect(taskArmed.filter((entry) => !entry.armed)).toEqual([]);
    expect(projectArmed).toEqual([true, true]);
    expect(latest).toBeUndefined();
  });

  it("keeps the successful contract at the recorded 122-call local-fake upper bound", async () => {
    const api = new ContractApiFake();
    let calls = 0;
    const counted = new Proxy(api, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function"
          ? (...args: unknown[]) => {
              calls += 1;
              return value.apply(target, args);
            }
          : value;
      },
    });
    const report = await new DidaWriteContractRunner(
      counted,
      () => "run-request-count",
      fixedNow,
    ).run();

    expect(report.status).toBe("passed");
    // 此数只记录无传输重试的本地合同假体调用；不推断真实服务的分钟配额。
    expect(calls).toBeLessThanOrEqual(122);
  });

  it("creates and renames uniquely marked columns when a new board has none", async () => {
    const api = new ContractApiFake();
    api.startWithoutColumns = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-empty-board",
      fixedNow,
    ).run();
    expect(report.status).toBe("passed");
    expect(report.boardPlacementVerified).toBe(true);
    expect(report.steps.join(" ")).toMatch(/创建唯一标记分栏.*复读 3 个看板列/);
    expect(report.columnCreateVerified).toBe(true);
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
  });

  it("keeps reminder and repeat capabilities independent after a safe rejection", async () => {
    const api = new ContractApiFake();
    api.rejectReminderWrites = "reminders unsupported";
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-independent-capabilities",
      fixedNow,
    ).run();

    expect(report.status).toBe("passed");
    expect(report.taskCrudVerified).toBe(true);
    expect(report.reminderWriteVerified).toBe(false);
    expect(report.repeatWriteVerified).toBe(true);
    expect(report.itemsRoundTripVerified).toBe(true);
    expect(report.boardPlacementVerified).toBe(true);
    expect(report.capabilityFailures).toEqual(["提醒：未通过写入合同，保持只读"]);
    expect(report.remoteArtifactsRemaining).toBe(false);
  });

  it("keeps the core contract passed when a reminder clear is silently ignored on its isolated task", async () => {
    const api = new ContractApiFake();
    api.ignoreReminderClear = true;

    const report = await new DidaWriteContractRunner(
      api,
      () => "run-reminder-clear-ignored",
      fixedNow,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      taskCrudVerified: true,
      reminderWriteVerified: false,
      repeatWriteVerified: true,
      itemsRoundTripVerified: true,
      boardPlacementVerified: true,
      remoteArtifactsRemaining: false,
      cleanupErrors: [],
    });
    expect(report.capabilityFailures).toEqual(["提醒：未通过写入合同，保持只读"]);
    expect(api.tasks.has("original-task")).toBe(true);
    expect([...api.tasks]).toHaveLength(1);
  });

  it("globally fails without publishing later capabilities when a reminder update outcome is unknown and unproven", async () => {
    const api = new ContractApiFake();
    api.reminderUpdateOutcome = "not-applied-unknown";

    const report = await new DidaWriteContractRunner(
      api,
      () => "run-reminder-unknown-unproven",
      fixedNow,
    ).run();

    expect(report).toMatchObject({
      status: "failed",
      reminderWriteVerified: false,
      repeatWriteVerified: false,
      itemsRoundTripVerified: false,
      boardPlacementVerified: false,
      remoteArtifactsRemaining: false,
      cleanupErrors: [],
    });
    expect(report.failure).toMatch(/属性写入响应未知.*未重发/);
    expect(api.updatePayloads).toHaveLength(2);
    expect(api.deletedTasks).toEqual(["test-task-2", "test-task-1"]);
    expect([...api.tasks]).toHaveLength(1);
  });

  it("does not mistake a server-added empty childIds field for a reminder-clear mutation", async () => {
    const api = new ContractApiFake();
    api.addEmptyChildIdsWhenClearingReminder = true;

    const report = await new DidaWriteContractRunner(
      api,
      () => "run-reminder-child-ids",
      fixedNow,
    ).run();

    expect(report.status).toBe("passed");
    expect(report.reminderWriteVerified).toBe(true);
    expect(report.remoteArtifactsRemaining).toBe(false);
  });

  it("rejects a real childIds mutation while clearing a reminder", async () => {
    const api = new ContractApiFake();
    api.replaceChildIdsWhenClearingReminder = true;

    const report = await new DidaWriteContractRunner(
      api,
      () => "run-reminder-child-ids-mutated",
      fixedNow,
    ).run();

    expect(report).toMatchObject({
      status: "failed",
      reminderWriteVerified: false,
      remoteArtifactsRemaining: false,
      cleanupErrors: [],
    });
    expect(report.failure).toMatch(/未恢复到安全基线.*childIds/);
    expect(report.failure).not.toContain("unexpected-child-id");
    expect(api.deletedTasks).toEqual(["test-task-2", "test-task-1"]);
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.tasks.get("original-task")?.title).toBe("用户原有任务");
  });

  it("labels an otherwise-empty field difference without leaking reminder values", async () => {
    const api = new ContractApiFake();
    api.returnStaleReminderOnClearRead = true;

    const report = await new DidaWriteContractRunner(
      api,
      () => "run-reminder-empty-difference",
      fixedNow,
    ).run();

    expect(report.status).toBe("passed");
    expect(report.reminderWriteVerified).toBe(false);
    expect(report.capabilityFailures).toEqual(["提醒：未通过写入合同，保持只读"]);
    expect(report.remoteArtifactsRemaining).toBe(false);
  });

  it("keeps task CRUD verified when parent creation is safely rejected", async () => {
    const api = new ContractApiFake();
    api.rejectParentCreate = "parent unsupported";
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-parent-independent",
      fixedNow,
    ).run();

    expect(report.status).toBe("passed");
    expect(report.itemsRoundTripVerified).toBe(false);
    expect(report.taskCrudVerified).toBe(true);
    expect(report.capabilityFailures).toEqual(["检查项：未通过写入合同，保持只读"]);
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(api.deletedTasks).toEqual(["test-task-2", "test-task-3", "test-task-4", "test-task-5", "test-task-6", "test-task-1", "test-task-7"]);
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
  });

  it.each([
    ["提醒", "提醒远端秘密正文", (api: ContractApiFake, secret: string) => { api.rejectReminderWrites = secret; }],
    ["重复规则", "重复规则远端秘密正文", (api: ContractApiFake, secret: string) => { api.rejectRepeatWrites = secret; }],
    ["检查项", "检查项远端秘密正文", (api: ContractApiFake, secret: string) => { api.rejectParentCreate = secret; }],
    ["真实子任务", "子任务远端秘密正文", (api: ContractApiFake, secret: string) => { api.rejectParentingWrites = secret; }],
    ["看板归栏", "看板归栏远端秘密正文", (api: ContractApiFake, secret: string) => { api.rejectPlacementWrites = secret; }],
  ])("uses only a fixed settings-visible summary for a safely rejected %s capability", async (
    capability,
    secret,
    arrange,
  ) => {
    const api = new ContractApiFake();
    arrange(api, secret);
    const report = await new DidaWriteContractRunner(
      api,
      () => `run-${capability}-secret`,
      fixedNow,
    ).run();

    const expected = `${capability}：未通过写入合同，保持只读`;
    const settingsVisibleSummary = `以下能力保持只读：${report.capabilityFailures.join("；")}`;
    expect(report.status).toBe("passed");
    expect(report.capabilityFailures).toEqual([expected]);
    expect(settingsVisibleSummary).toContain(expected);
    expect(settingsVisibleSummary).not.toContain(secret);
  });

  it("isolates an unknown parent update after safe task cleanup and continues other capabilities", async () => {
    const api = new ContractApiFake();
    api.parentUpdateOutcome = "not-applied-unknown";

    const report = await new DidaWriteContractRunner(
      api,
      () => "run-parent-unknown-unproven",
      fixedNow,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      itemsRoundTripVerified: false,
      boardPlacementVerified: true,
      remoteArtifactsRemaining: false,
      cleanupErrors: [],
    });
    expect(report.capabilityFailures).toContain("检查项：未通过写入合同，保持只读");
    expect(api.updatePayloads.some((payload) => "columnId" in payload)).toBe(true);
    expect([...api.tasks]).toHaveLength(1);
  });

  it("does not let a progress observer interrupt cleanup", async () => {
    const api = new ContractApiFake();
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-progress-observer",
      fixedNow,
      undefined,
      () => {
        throw new Error("settings view was closed");
      },
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.deletedTasks).toEqual(["test-task-2", "test-task-3", "test-task-4", "test-task-5", "test-task-6", "test-task-1", "test-task-7"]);
  });

  it("classifies a server-collapsed schedule as point mode and completes the core contract", async () => {
    const api = new ContractApiFake();
    api.collapseScheduleToPoint = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-point-schedule",
      fixedNow,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      taskScheduleMode: "point",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(report.steps.join(" ")).toMatch(/单点任务时间/);
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.deletedTasks).toEqual(["test-task-2", "test-task-3", "test-task-4", "test-task-5", "test-task-6", "test-task-1", "test-task-7"]);
  });

  it("treats server-managed etimestamp changes as metadata across all field probes", async () => {
    const api = new ContractApiFake();
    api.advanceEtimestampOnUpdate = true;

    const report = await new DidaWriteContractRunner(
      api,
      () => "run-etimestamp-metadata",
      fixedNow,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      taskCrudVerified: true,
      reminderWriteVerified: true,
      repeatWriteVerified: true,
      itemsRoundTripVerified: true,
      remoteArtifactsRemaining: false,
    });
  });

  it("continues after one unknown update response when an exact reread proves the write", async () => {
    const api = new ContractApiFake();
    api.updateOutcome = "applied-unknown";
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-update-applied-unknown",
      fixedNow,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(report.steps.join(" ")).toMatch(/未重发.*精确复读已证明字段生效/);
    expect(api.updateCalls).toBe(14);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("places a task with only identity and column fields while preserving every other field", async () => {
    const api = new ContractApiFake();
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-minimal-placement",
      fixedNow,
    ).run();

    expect(report.status).toBe("passed");
    expect(api.updatePayloads.find((payload) => "columnId" in payload)).toEqual({
      id: "test-task-6",
      projectId: "test-project-1",
      columnId: "test-project-1-doing",
    });
    expect(report.steps.join(" ")).toMatch(/最小白名单归栏.*其他任务字段未变化/);
  });

  it("accepts the server-derived columnName change caused by a verified board placement", async () => {
    const api = new ContractApiFake();
    api.placementColumnNameAfterMutation = "进行中";
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-placement-column-name",
      fixedNow,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      boardPlacementVerified: true,
      remoteArtifactsRemaining: false,
    });
  });

  it("fails and cleans up when a minimal board placement changes another task field", async () => {
    const api = new ContractApiFake();
    api.corruptPlacementContent = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-placement-corruption",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.boardPlacementVerified).toBe(false);
    expect(report.failureStage).toBe("以最小载荷验证测试任务看板归栏");
    expect(report.failure).toMatch(/归栏修改出现非目标字段；差异字段 content/);
    expect(report.failure).not.toContain("被归栏意外改写");
    expect(report.remoteArtifactsRemaining).toBe(false);
  });

  it("never exposes remote error or task content in the settings-displayable board failure", async () => {
    const api = new ContractApiFake();
    const secretTaskContent = "绝不可展示的秘密任务正文";
    const secretRemoteError = "远端内部错误包含秘密任务正文";
    api.corruptPlacementContent = true;
    api.placementContentAfterMutation = secretTaskContent;
    api.placementErrorAfterMutation = secretRemoteError;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-placement-secret-error",
      fixedNow,
    ).run();

    expect(report).toMatchObject({
      status: "failed",
      failureStage: "以最小载荷验证测试任务看板归栏",
      remoteArtifactsRemaining: false,
    });
    expect(report.failure).toBe("以最小载荷验证测试任务看板归栏：看板归栏合同失败：归栏修改出现非目标字段；差异字段 content");
    // 设置页直接展示 report.failure；该摘要必须同样无远端或任务正文。
    expect(report.failure).not.toContain(secretTaskContent);
    expect(report.failure).not.toContain(secretRemoteError);
  });

  it("does not resend an unknown minimal placement when an exact reread proves it", async () => {
    const api = new ContractApiFake();
    api.placementOutcome = "applied-unknown";
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-placement-applied-unknown",
      fixedNow,
    ).run();

    expect(report.status).toBe("passed");
    expect(report.boardPlacementVerified).toBe(true);
    expect(api.updatePayloads.filter((payload) => "columnId" in payload)).toHaveLength(1);
    expect(report.steps.join(" ")).toMatch(/归栏响应未知.*未重发/);
  });

  it("does not resend or accept an unknown minimal placement that was not applied", async () => {
    const api = new ContractApiFake();
    api.placementOutcome = "not-applied-unknown";
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-placement-not-applied-unknown",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.failureStage).toBe("以最小载荷验证测试任务看板归栏");
    expect(report.failure).toMatch(/未证明安全写入.*未重发/);
    expect(api.updatePayloads.filter((payload) => "columnId" in payload)).toHaveLength(1);
    expect(report.remoteArtifactsRemaining).toBe(false);
  });

  it("fails without resending when an exact reread cannot prove an unknown update", async () => {
    const api = new ContractApiFake();
    api.updateOutcome = "not-applied-unknown";
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-update-not-applied-unknown",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.failureStage).toBe("编辑并复读测试任务");
    expect(report.failure).toMatch(/编辑并复读测试任务.*未证明写入生效.*未重发/);
    expect(api.updateCalls).toBe(1);
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("fails with the exact stage and never resends when the unknown update reread fails", async () => {
    const api = new ContractApiFake();
    api.updateOutcome = "applied-unknown";
    api.failUpdateRereadOnce = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-update-reread-failed",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.failureStage).toBe("编辑并复读测试任务");
    expect(report.failure).toMatch(/精确复读失败.*未重发.*update reread unavailable/);
    expect(api.updateCalls).toBe(1);
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("does not accept a different task ID as proof of an unknown update", async () => {
    const api = new ContractApiFake();
    api.updateOutcome = "applied-unknown";
    api.returnWrongIdOnUpdateReread = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-update-wrong-id",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.failure).toMatch(/未证明写入生效.*任务身份/);
    expect(api.updateCalls).toBe(1);
    expect(report.remoteArtifactsRemaining).toBe(false);
  });

  it("does not accept a changed all-day value as proof of an unknown update", async () => {
    const api = new ContractApiFake();
    api.updateOutcome = "applied-unknown";
    api.corruptUpdatedAllDay = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-update-all-day-mismatch",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.failure).toMatch(/未证明写入生效.*全天状态/);
    expect(api.updateCalls).toBe(1);
    expect(report.remoteArtifactsRemaining).toBe(false);
  });

  it("fails on an unexpected schedule transformation while still cleaning test artifacts", async () => {
    const api = new ContractApiFake();
    api.corruptSchedule = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-corrupt-schedule",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.taskScheduleMode).toBe("unknown");
    expect(report.failure).toMatch(/时间与提交值不一致/);
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(api.projects.has("original-project")).toBe(true);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("accepts a failed delete response only after a 404 reread proves deletion", async () => {
    const api = new ContractApiFake();
    api.throwAfterDelete = true;
    const report = await new DidaWriteContractRunner(api, () => "run-delete-reread", fixedNow).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect([...api.projects]).toHaveLength(1);
    expect([...api.tasks]).toHaveLength(1);
    expect(api.projects.has("original-project")).toBe(true);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("does not wait on a rate-limited contract read and uses the reserved cleanup path", async () => {
    const api = new ContractApiFake();
    api.rateLimitProjectCollectionAfterDeleteOnce = true;
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-cleanup-rate-limit",
      fixedNow,
      sleep,
      undefined,
      () => 0,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(report.cleanupErrors).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("waits through bounded eventual-consistency reads after deletion", async () => {
    const api = new ContractApiFake();
    api.staleReadsAfterDelete = 2;
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-eventual-delete",
      fixedNow,
      sleep,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(sleep).toHaveBeenCalled();
    expect([...api.projects]).toHaveLength(1);
    expect([...api.tasks]).toHaveLength(1);
  });

  it("waits until a completed task appears before attempting its deletion", async () => {
    const api = new ContractApiFake();
    api.completedVisibilityDelay = 2;
    const sleep = vi.fn(async () => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-completed-visible",
      fixedNow,
      sleep,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(sleep).toHaveBeenCalled();
  });

  it("does not multiply transport failures across consistency attempts", async () => {
    const api = new ContractApiFake();
    api.throwCompletedReads = true;
    const sleep = vi.fn(async () => undefined);
    const progress = vi.fn();
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-read-timeout",
      fixedNow,
      sleep,
      progress,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.failure).toMatch(/completed endpoint timeout/);
    expect(report.cleanupErrors.join(" ")).toMatch(/completed endpoint timeout/);
    expect(sleep).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      stage: "等待任务进入可观察集合",
      attempt: 1,
      maxAttempts: 20,
    }));
  });

  it("still succeeds when deletion becomes visible near the observation deadline", async () => {
    const api = new ContractApiFake();
    api.staleReadsAfterDelete = 18;
    const sleep = vi.fn(async () => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-near-deadline-delete",
      fixedNow,
      sleep,
    ).run();

    expect(report).toMatchObject({
      status: "passed",
      cleanupErrors: [],
      remoteArtifactsRemaining: false,
    });
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(18);
    expect([...api.projects]).toHaveLength(1);
    expect([...api.tasks]).toHaveLength(1);
  });

  it("remains conservative when deletion is still readable past the observation deadline", async () => {
    const api = new ContractApiFake();
    api.staleReadsAfterDelete = 25;
    const sleep = vi.fn(async () => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-past-deadline-delete",
      fixedNow,
      sleep,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.failure).toMatch(/仍存在于可观察任务集合/);
    expect(report.cleanupErrors.length).toBeGreaterThan(0);
    expect(api.projects.has("original-project")).toBe(true);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("stops scheduling consistency retries when the wall-clock budget is exhausted", async () => {
    const api = new ContractApiFake();
    api.keepTaskOnDelete = true;
    let nowMs = 0;
    const readCompleted = api.getCompletedTasks.bind(api);
    api.getCompletedTasks = async (filter) => {
      nowMs += 6_000;
      return readCompleted(filter);
    };
    const sleep = vi.fn(async (milliseconds: number) => {
      nowMs += milliseconds;
    });
    const progress: Array<{ stage: string; attempt?: number }> = [];
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-wall-clock-budget",
      fixedNow,
      sleep,
      (value) => progress.push(value),
      () => nowMs,
    ).run();

    const deletionAttempts = progress
      .filter((value) => value.stage === "等待任务集合确认删除")
      .map((value) => value.attempt ?? 0);
    expect(report.status).toBe("failed");
    expect(deletionAttempts.some((attempt) => attempt < 20)).toBe(true);
    expect(api.deletedProjects).toEqual([]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("reconciles an applied unknown move without resending and completes the contract", async () => {
    const api = new ContractApiFake();
    api.throwAfterMove = true;
    api.returnMoveTombstoneAtSource = true;
    const report = await new DidaWriteContractRunner(api, () => "run-unknown", fixedNow).run();

    expect(report.status).toBe("passed");
    expect(report.failure).toBeUndefined();
    expect(report.steps).toContain(
      "移动响应未知；未重发，目标清单精确复读且来源清单确认移出",
    );
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(api.deletedTasks).toEqual(["test-task-2", "test-task-3", "test-task-4", "test-task-5", "test-task-6", "test-task-1", "test-task-7"]);
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.tasks.has("original-task")).toBe(true);
    expect(api.sourceTombstoneReads).toBe(0);
  });

  it("refuses to choose a task location while both candidate collections contain its ID", async () => {
    const api = new ContractApiFake();
    api.throwAfterMove = true;
    api.duplicateSourceCollectionAfterMove = true;
    const sleep = vi.fn(async () => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-dual-location",
      fixedNow,
      sleep,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.cleanupErrors.join(" ")).toMatch(/停止自动清理/);
    expect(api.deletedTasks).toEqual(["test-task-2", "test-task-3", "test-task-4", "test-task-5", "test-task-6"]);
    expect(api.deletedProjects).toEqual([]);
    expect(report.manualCleanupRequired).toMatchObject({
      taskId: "test-task-1",
      candidateProjectIds: ["test-project-1", "test-project-2"],
    });
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("cleans all test artifacts after a confirmed not-applied unknown move without resending", async () => {
    const api = new ContractApiFake();
    api.moveNotAppliedUnknown = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-move-not-applied-unknown",
      fixedNow,
      async () => undefined,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(report.manualCleanupRequired).toBeUndefined();
    expect(api.moveCalls).toBe(1);
    expect(api.deletedTasks).toEqual(["test-task-2", "test-task-3", "test-task-4", "test-task-5", "test-task-6", "test-task-1"]);
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.tasks.has("test-task-1")).toBe(false);
  });

  it("holds artifacts when a successful move changes a non-placement task field", async () => {
    const api = new ContractApiFake();
    api.corruptMovedContent = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-move-corruption",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.failure).toMatch(/清单归属以外的任务字段/);
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(api.moveCalls).toBe(1);
    expect(api.deletedProjects).toEqual([]);
  });

  it("ignores a non-object 2xx move response and proves the move from candidate task lists", async () => {
    const api = new ContractApiFake();
    api.moveResponse = "OK";
    const report = await new DidaWriteContractRunner(api, () => "run-move-text-response", fixedNow).run();

    expect(report.status).toBe("passed");
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(api.moveCalls).toBe(1);
  });

  it("holds artifacts when the target task cannot be reread after one move", async () => {
    const api = new ContractApiFake();
    api.failTargetCollectionReadAfterMove = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-move-target-read-failure",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.manualCleanupRequired?.reason).toMatch(/target collection reread unavailable/);
    expect(api.moveCalls).toBe(1);
    expect(api.deletedProjects).toEqual([]);
  });

  it("holds artifacts when the source collection cannot be reread after one move", async () => {
    const api = new ContractApiFake();
    api.failSourceCollectionReadAfterMove = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-move-source-read-failure",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.manualCleanupRequired?.reason).toMatch(/source collection reread unavailable/);
    expect(api.moveCalls).toBe(1);
    expect(api.deletedProjects).toEqual([]);
  });

  it("holds artifacts after a successful move while the source collection still has the same ID", async () => {
    const api = new ContractApiFake();
    api.duplicateSourceCollectionAfterMove = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-move-success-dual-location",
      fixedNow,
      async () => undefined,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.manualCleanupRequired?.reason).toMatch(/持续同时存在于两个候选清单/);
    expect(api.moveCalls).toBe(1);
    expect(api.deletedProjects).toEqual([]);
  });

  it.each([
    ["both", "both-once" as const],
    ["none", "none-once" as const],
  ])("retries a transient %s location until target-only proof without resending", async (_name, visibility) => {
    const api = new ContractApiFake();
    api.moveCollectionVisibility = visibility;
    const progress: Array<{ stage: string; attempt?: number }> = [];
    const report = await new DidaWriteContractRunner(
      api,
      () => `run-transient-${visibility}`,
      fixedNow,
      async () => undefined,
      (value) => progress.push(value),
    ).run();

    expect(report.status).toBe("passed");
    expect(api.moveCalls).toBe(1);
    expect(progress.filter((value) => value.stage === "复读移动任务位置").length).toBe(2);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it.each([
    ["both", "both-always" as const, /持续同时存在/],
    ["none", "none-always" as const, /持续不在任一候选/],
  ])("requires manual review after bounded permanent %s location ambiguity", async (
    _name,
    visibility,
    reason,
  ) => {
    const api = new ContractApiFake();
    api.moveCollectionVisibility = visibility;
    const progress: Array<{ stage: string; attempt?: number }> = [];
    const report = await new DidaWriteContractRunner(
      api,
      () => `run-permanent-${visibility}`,
      fixedNow,
      async () => undefined,
      (value) => progress.push(value),
    ).run();

    expect(report.status).toBe("failed");
    expect(report.manualCleanupRequired?.reason).toMatch(reason);
    expect(api.moveCalls).toBe(1);
    expect(progress.filter((value) => value.stage === "复读移动任务位置")).toHaveLength(20);
    expect(api.deletedProjects).toEqual([]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it.each(["source", "target"] as const)("requires manual review when the %s project identity mismatches", async (side) => {
    const api = new ContractApiFake();
    api.moveProjectIdentityMismatch = side;
    const report = await new DidaWriteContractRunner(
      api,
      () => `run-project-id-${side}`,
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.manualCleanupRequired?.reason).toMatch(/候选清单项目身份不匹配/);
    expect(api.moveCalls).toBe(1);
    expect(api.deletedProjects).toEqual([]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it.each([
    ["source-only", "normal" as const, true, false],
    ["both", "both-always" as const, false, true],
  ])("never sleeps a negative duration when the monotonic clock jumps during %s reconciliation", async (
    _name,
    visibility,
    notApplied,
    requiresManual,
  ) => {
    const api = new ContractApiFake();
    api.moveCollectionVisibility = visibility;
    api.moveNotAppliedUnknown = notApplied;
    const clockValues = [1, 20_000];
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    let reconcilingMove = false;
    const report = await new DidaWriteContractRunner(
      api,
      () => `run-clock-jump-${visibility}`,
      fixedNow,
      sleep,
      (progress) => { if (progress.stage === "复读移动任务位置") reconcilingMove = true; },
      () => reconcilingMove ? (clockValues.shift() ?? 20_000) : 0,
    ).run();

    expect(sleep.mock.calls.flatMap(([milliseconds]) => [milliseconds])).toEqual([750]);
    expect(sleep.mock.calls.flatMap(([milliseconds]) => [milliseconds]).every(
      (milliseconds) => typeof milliseconds === "number" && milliseconds >= 0 && milliseconds <= 750,
    )).toBe(true);
    expect(api.moveCalls).toBe(1);
    expect(api.tasks.has("original-task")).toBe(true);
    expect(report.manualCleanupRequired !== undefined).toBe(requiresManual);
    expect(report.remoteArtifactsRemaining).toBe(requiresManual);
  });

  it("finds a remotely completed task when the complete response outcome is unknown", async () => {
    const api = new ContractApiFake();
    api.throwAfterComplete = true;
    const report = await new DidaWriteContractRunner(api, () => "run-complete-unknown", fixedNow).run();

    expect(report.status).toBe("failed");
    expect(report.failure).toMatch(/complete unknown/);
    expect(report.remoteArtifactsRemaining).toBe(false);
    expect(api.deletedTasks).toEqual(["test-task-2", "test-task-3", "test-task-4", "test-task-5", "test-task-6", "test-task-1"]);
    expect(api.deletedProjects).toEqual(["test-project-2", "test-project-1"]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("does not delete test projects when task cleanup cannot prove absence", async () => {
    const api = new ContractApiFake();
    api.keepTaskOnDelete = true;
    const sleep = vi.fn(async () => undefined);
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-task-cleanup-failed",
      fixedNow,
      sleep,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.cleanupErrors.join(" ")).toMatch(/可观察任务集合/);
    expect(report.cleanupPlan).toMatchObject({
      runId: "run-task-cleanup-failed",
      marker: "[Helix 合同测试 run-task-cleanup-failed]",
      projects: [
        { id: "test-project-1", baselineSource: "contract" },
        { id: "test-project-2", baselineSource: "contract" },
      ],
    });
    expect(report.cleanupPlan?.tasks.length).toBeGreaterThan(0);
    expect(api.deletedProjects).toEqual([]);
    expect(api.projects.has("test-project-1")).toBe(true);
    expect(api.projects.has("test-project-2")).toBe(true);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("refuses to delete a test project containing a foreign completed task", async () => {
    const api = new ContractApiFake();
    api.injectForeignCompletedTaskOnMove = true;
    const report = await new DidaWriteContractRunner(
      api,
      () => "run-foreign-completed",
      fixedNow,
    ).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.cleanupErrors.join(" ")).toMatch(/非本轮已完成任务/);
    expect(api.projects.has("test-project-2")).toBe(true);
    expect(api.tasks.has("foreign-completed-task")).toBe(true);
    expect(api.deletedProjects).toEqual(["test-project-1"]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("refuses to delete a test list when any non-run task appears", async () => {
    const api = new ContractApiFake();
    api.injectForeignTaskOnMove = true;
    const report = await new DidaWriteContractRunner(api, () => "run-foreign", fixedNow).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.cleanupErrors.join(" ")).toMatch(/非本轮任务/);
    expect(api.projects.has("test-project-2")).toBe(true);
    expect(api.tasks.get("foreign-task")?.title).toBe("用户意外放入的任务");
    expect(api.deletedProjects).toEqual(["test-project-1"]);
    expect(api.deletedTasks).toEqual(["test-task-2", "test-task-3", "test-task-4", "test-task-5", "test-task-6", "test-task-1", "test-task-7"]);
    expect(api.tasks.has("original-task")).toBe(true);
  });

  it("reports a possible leftover without guessing an ID after unknown project creation", async () => {
    const api = new ContractApiFake();
    api.throwAfterFirstProjectCreate = true;
    const report = await new DidaWriteContractRunner(api, () => "run-untracked", fixedNow).run();

    expect(report.status).toBe("failed");
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(report.cleanupPlan).toMatchObject({
      runId: "run-untracked",
      marker: "[Helix 合同测试 run-untracked]",
      projects: [],
      tasks: [],
    });
    expect(api.deletedProjects).toEqual([]);
    expect(api.deletedTasks).toEqual([]);
    expect(api.projects.get("original-project")?.name).toBe("用户原有清单");
    expect(api.tasks.get("original-task")?.title).toBe("用户原有任务");
  });

  it("never deletes a project ID that existed before the test", async () => {
    const api = new ContractApiFake();
    api.reuseOriginalProjectId = true;
    const report = await new DidaWriteContractRunner(api, () => "run-collision", fixedNow).run();

    expect(report.status).toBe("failed");
    expect(report.failure).toMatch(/测试前已存在/);
    expect(report.remoteArtifactsRemaining).toBe(true);
    expect(api.deletedProjects).toEqual([]);
    expect(api.deletedTasks).toEqual([]);
  });
});

function notFound(): DidaHttpError {
  return new DidaHttpError("permanent", "not found", 404);
}
