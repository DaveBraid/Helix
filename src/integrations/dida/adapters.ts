import type {
  DidaFocusRecord,
  DidaHabit,
  DidaHabitCheckin,
  DidaProject,
  DidaTask,
} from "../../domain/entities";
import { didaTaskWithoutRemoteMetadata } from "../../domain/dida-task-metadata";
import { deepEqual } from "../../domain/stable";
import {
  validateTaskScheduleWrite,
  type TaskScheduleMode,
} from "../../domain/task-schedule";
import type { RemoteEntityAdapter, RemoteWriteContext } from "../../sync/types";
import { DidaApi, type DidaTaskUpdateWirePayload, type DidaTaskWriteWirePayload } from "./api";
import {
  normalizeFocus,
  normalizeHabit,
  normalizeHabitCheckin,
  normalizeProject,
  normalizeTask,
} from "./normalization";
import { serializeDidaChecklistItems, serializeDidaDate } from "./serialization";

export class DidaTaskAdapter implements RemoteEntityAdapter<DidaTask> {
  readonly kind = "task" as const;

  constructor(
    private readonly api: DidaApi,
    private readonly scheduleMode: () => TaskScheduleMode = () => "duration",
    private readonly writeCapabilities: () => DidaTaskWriteCapabilities = () => ({}),
  ) {}

  async get(entityId: string, context?: { projectId?: string }): Promise<DidaTask | null> {
    if (!context?.projectId) throw new Error("Task lookup requires projectId");
    try {
      return taskSyncProjection(normalizeTask(await this.api.getTask(context.projectId, entityId)));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async create(value: DidaTask): Promise<DidaTask> {
    this.assertTaskCrudVerified();
    validateTaskScheduleWrite(value, this.scheduleMode());
    return taskSyncProjection(normalizeTask(await this.api.createTask(
      taskCreatePayload(value, this.writeCapabilities()),
    )));
  }

  async update(
    entityId: string,
    value: DidaTask,
    context?: RemoteWriteContext,
  ): Promise<DidaTask> {
    this.assertTaskCrudVerified();
    let remoteBeforeWrite = await this.get(entityId, { projectId: value.projectId });
    let scheduleValidated = false;
    if (context?.projectId && context.projectId !== value.projectId) {
      if (!remoteBeforeWrite) {
        const stillAtSource = await this.get(entityId, { projectId: context.projectId });
        if (!stillAtSource) {
          throw new Error("任务既不在原清单也不在目标清单，必须人工核对远端位置");
        }
        validateTaskScheduleWrite(value, this.scheduleMode(), stillAtSource);
        scheduleValidated = true;
        try {
          await this.api.moveTask({
            fromProjectId: context.projectId,
            toProjectId: value.projectId,
            taskId: entityId,
          });
        } catch (error) {
          const movedAfterError = await this.get(entityId, { projectId: value.projectId });
          if (!movedAfterError) throw error;
        }
        const moved = await this.get(entityId, { projectId: value.projectId });
        if (!moved) throw new Error("任务迁移后无法在目标清单复读");
        remoteBeforeWrite = moved;
      }
    }
    if (!remoteBeforeWrite) throw new Error("任务更新前无法在目标清单复读");
    if (!scheduleValidated) {
      validateTaskScheduleWrite(value, this.scheduleMode(), remoteBeforeWrite);
    }
    const verified = this.writeCapabilities();
    const writeFields = new Set(context?.writeFields ?? []);
    const changedCapabilities: DidaTaskWriteCapabilities = {
      reminderWriteVerified: verified.reminderWriteVerified === true && writeFields.has("reminders"),
      repeatWriteVerified: verified.repeatWriteVerified === true && writeFields.has("repeatFlag"),
      parentTaskVerified: verified.parentTaskVerified === true && writeFields.has("parentId"),
      taskReopenVerified: verified.taskReopenVerified === true && writeFields.has("status"),
    };
    // 纯跨清单迁移已由 moveTask 表达；不得再发送只有身份字段的空业务更新。
    if (writeFields.size > 0) {
      await this.api.updateTask(entityId, taskUpdatePayload(value, changedCapabilities, writeFields));
    }
    let current = await this.get(entityId, { projectId: value.projectId });
    if (!current) throw new Error("任务更新后无法复读");
    if (value.status === 2 && current.status !== 2) {
      try {
        await this.api.completeTask(value.projectId, entityId);
      } catch (error) {
        const completedAfterError = await this.get(entityId, { projectId: value.projectId });
        if (completedAfterError?.status !== 2) throw error;
      }
      current = await this.get(entityId, { projectId: value.projectId });
      if (current?.status !== 2) throw new Error("任务完成后远端状态未变为已完成");
    }
    return taskSyncProjection(normalizeTask(current));
  }

  async delete(entityId: string, context?: RemoteWriteContext): Promise<void> {
    this.assertTaskCrudVerified();
    if (!context?.projectId) throw new Error("Task deletion requires projectId");
    await this.api.deleteTask(context.projectId, entityId);
  }

  private assertTaskCrudVerified(): void {
    if (this.writeCapabilities().taskCrudVerified !== true) {
      throw new Error("当前滴答账号尚未通过任务基础写入合同测试");
    }
  }
}

export class DidaProjectAdapter implements RemoteEntityAdapter<DidaProject> {
  readonly kind = "project" as const;

  constructor(private readonly api: DidaApi) {}

  async get(entityId: string): Promise<DidaProject | null> {
    try {
      return normalizeProject(await this.api.getProject(entityId));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async create(value: DidaProject): Promise<DidaProject> {
    return normalizeProject(await this.api.createProject(projectWritePayload(value)));
  }

  async update(entityId: string, value: DidaProject): Promise<DidaProject> {
    return normalizeProject(await this.api.updateProject(entityId, projectWritePayload(value)));
  }

  async delete(entityId: string): Promise<void> {
    await this.api.deleteProject(entityId);
  }
}

export class DidaHabitService {
  constructor(private readonly api: DidaApi) {}

  async list(): Promise<DidaHabit[]> {
    return (await this.api.listHabits()).map(normalizeHabit);
  }

  async get(habitId: string): Promise<DidaHabit> {
    return normalizeHabit(await this.api.getHabit(habitId));
  }

  async create(habit: DidaHabit): Promise<DidaHabit> {
    return normalizeHabit(await this.api.createHabit(habit));
  }

  async update(habitId: string, habit: DidaHabit): Promise<DidaHabit> {
    return normalizeHabit(await this.api.updateHabit(habitId, habit));
  }

  async checkin(habitId: string, checkin: DidaHabitCheckin): Promise<DidaHabitCheckin> {
    return normalizeHabitCheckin(await this.api.createHabitCheckin(habitId, checkin));
  }

  async checkins(habitIds: string[], from: number, to: number): Promise<DidaHabitCheckin[]> {
    return (await this.api.getHabitCheckins(habitIds, from, to)).map(normalizeHabitCheckin);
  }
}

export class DidaFocusService {
  constructor(private readonly api: DidaApi) {}

  async list(from: string, to: string, type = 1): Promise<DidaFocusRecord[]> {
    return (await this.api.listFocus(from, to, type)).map(normalizeFocus);
  }

  async get(focusId: string, type = 1): Promise<DidaFocusRecord> {
    return normalizeFocus(await this.api.getFocus(focusId, type));
  }

  async create(record: Omit<DidaFocusRecord, "id">): Promise<DidaFocusRecord> {
    return normalizeFocus(await this.api.createFocus(record));
  }

  delete(focusId: string, type = 1): Promise<void> {
    return this.api.deleteFocus(focusId, type);
  }
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "statusCode" in error && error.statusCode === 404;
}

export interface DidaTaskWriteCapabilities {
  taskCrudVerified?: boolean;
  reminderWriteVerified?: boolean;
  repeatWriteVerified?: boolean;
  parentTaskVerified?: boolean;
  boardPlacementVerified?: boolean;
  taskReopenVerified?: boolean;
}

export function taskCreatePayload(
  value: DidaTask,
  capabilities: DidaTaskWriteCapabilities = {},
): DidaTaskWriteWirePayload & Pick<DidaTask, "title" | "projectId"> {
  return {
    title: value.title,
    projectId: value.projectId,
    content: value.content,
    desc: value.desc,
    isAllDay: value.isAllDay,
    startDate: serializeDidaDate(value.startDate, "任务开始日期"),
    dueDate: serializeDidaDate(value.dueDate, "任务截止日期"),
    timeZone: value.timeZone,
    priority: value.priority,
    sortOrder: value.sortOrderUnsafe ? undefined : value.sortOrder,
    items: serializeDidaChecklistItems(value.items),
    tags: value.tags,
    ...(capabilities.reminderWriteVerified && Object.hasOwn(value, "reminders")
      ? { reminders: value.reminders }
      : {}),
    ...(capabilities.repeatWriteVerified && Object.hasOwn(value, "repeatFlag")
      ? { repeatFlag: value.repeatFlag }
      : {}),
    ...(capabilities.parentTaskVerified && Object.hasOwn(value, "parentId")
      ? { parentId: value.parentId }
      : {}),
    ...(capabilities.boardPlacementVerified && Object.hasOwn(value, "columnId")
      ? { columnId: value.columnId }
      : {}),
  };
}

export function taskUpdatePayload(
  value: DidaTask,
  capabilities: DidaTaskWriteCapabilities = {},
  explicitWriteFields: Iterable<string> = [],
): DidaTaskUpdateWirePayload {
  const writeFields = new Set(explicitWriteFields);
  return {
    id: value.id,
    projectId: value.projectId,
    ...(writeFields.has("title") ? { title: value.title } : {}),
    ...(writeFields.has("content") ? { content: clearedAs(value, "content", "") } : {}),
    ...(writeFields.has("desc") ? { desc: clearedAs(value, "desc", "") } : {}),
    ...(writeFields.has("isAllDay") ? { isAllDay: clearedAs(value, "isAllDay", false) } : {}),
    ...(writeFields.has("startDate")
      ? { startDate: serializeDidaDate(clearedAs(value, "startDate", null), "任务开始日期") }
      : {}),
    ...(writeFields.has("dueDate")
      ? { dueDate: serializeDidaDate(clearedAs(value, "dueDate", null), "任务截止日期") }
      : {}),
    ...(writeFields.has("timeZone") ? { timeZone: value.timeZone } : {}),
    ...(writeFields.has("priority") ? { priority: clearedAs(value, "priority", 0) } : {}),
    // 缺失或不安全的远端排序值绝不是“清零”意图。
    ...(writeFields.has("sortOrder") && !value.sortOrderUnsafe && value.sortOrder !== undefined
      ? { sortOrder: value.sortOrder }
      : {}),
    ...(writeFields.has("items")
      ? { items: serializeDidaChecklistItems(clearedAs(value, "items", [])) }
      : {}),
    ...(writeFields.has("tags") ? { tags: clearedAs(value, "tags", []) } : {}),
    ...(writeFields.has("reminders") && capabilities.reminderWriteVerified && Object.hasOwn(value, "reminders")
      ? {
        reminders: Array.isArray(value.reminders) && value.reminders.length === 0
          ? null
          : value.reminders,
      }
      : {}),
    ...(writeFields.has("repeatFlag") && capabilities.repeatWriteVerified && Object.hasOwn(value, "repeatFlag")
      ? { repeatFlag: clearedAs(value, "repeatFlag", null) }
      : {}),
    ...(writeFields.has("parentId") && capabilities.parentTaskVerified && Object.hasOwn(value, "parentId")
      ? { parentId: clearedAs(value, "parentId", null) }
      : {}),
    ...(writeFields.has("status") && capabilities.taskReopenVerified && value.status === 0
      ? { status: 0 }
      : {}),
  };
}

export function taskBoardPlacementPayload(
  value: DidaTask,
  columnId: string,
): DidaTaskWriteWirePayload {
  if (!columnId.trim()) throw new Error("看板列 ID 不能为空");
  return {
    id: value.id,
    projectId: value.projectId,
    columnId,
  };
}

export function taskBoardPlacementInvariant(
  task: DidaTask,
): Omit<DidaTask, "columnId" | "columnName" | "etag" | "modifiedTime" | "etimestamp"> {
  const withoutMetadata = didaTaskWithoutRemoteMetadata(task);
  const {
    columnId: _columnId,
    columnName: _columnName,
    ...invariant
  } = withoutMetadata;
  return invariant;
}

export function sameTaskBoardPlacementInvariant(left: DidaTask, right: DidaTask): boolean {
  return deepEqual(taskBoardPlacementInvariant(left), taskBoardPlacementInvariant(right));
}

function clearedAs<T extends object, K extends keyof T>(
  value: T,
  key: K,
  clearedValue: unknown,
): T[K] {
  if (Object.prototype.hasOwnProperty.call(value, key) && value[key] === undefined) {
    return clearedValue as T[K];
  }
  return value[key];
}

function projectWritePayload(value: DidaProject): Partial<DidaProject> & Pick<DidaProject, "name"> {
  return {
    name: value.name,
    color: value.color,
    sortOrder: value.sortOrderUnsafe ? undefined : value.sortOrder,
    viewMode: value.viewMode,
    kind: value.kind,
  };
}

export function taskSyncProjection(value: DidaTask): DidaTask {
  const withoutMetadata = didaTaskWithoutRemoteMetadata(value);
  // columnName 是服务端随看板详情派生的展示字段；它不属于任务三方同步
  // 的业务真值，更不能变成可写冲突。
  const { columnId: _columnId, columnName: _columnName, ...syncValue } = withoutMetadata;
  return syncValue;
}
