import type {
  DidaFocusRecord,
  DidaHabit,
  DidaHabitCheckin,
  DidaProject,
  DidaTask,
} from "../../domain/entities";
import type { RemoteEntityAdapter } from "../../sync/types";
import { DidaApi } from "./api";
import {
  normalizeFocus,
  normalizeHabit,
  normalizeHabitCheckin,
  normalizeProject,
  normalizeTask,
} from "./normalization";

export class DidaTaskAdapter implements RemoteEntityAdapter<DidaTask> {
  readonly kind = "task" as const;

  constructor(private readonly api: DidaApi) {}

  async get(entityId: string, context?: { projectId?: string }): Promise<DidaTask | null> {
    if (!context?.projectId) throw new Error("Task lookup requires projectId");
    try {
      return normalizeTask(await this.api.getTask(context.projectId, entityId));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async create(value: DidaTask): Promise<DidaTask> {
    return normalizeTask(await this.api.createTask(taskCreatePayload(value)));
  }

  async update(
    entityId: string,
    value: DidaTask,
    context?: { projectId?: string },
  ): Promise<DidaTask> {
    if (context?.projectId && context.projectId !== value.projectId) {
      const alreadyMoved = await this.get(entityId, { projectId: value.projectId });
      if (!alreadyMoved) {
        const stillAtSource = await this.get(entityId, { projectId: context.projectId });
        if (!stillAtSource) {
          throw new Error("任务既不在原清单也不在目标清单，必须人工核对远端位置");
        }
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
      }
    }
    await this.api.updateTask(entityId, taskUpdatePayload(value));
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
    return normalizeTask(current);
  }

  async delete(entityId: string, context?: { projectId?: string }): Promise<void> {
    if (!context?.projectId) throw new Error("Task deletion requires projectId");
    await this.api.deleteTask(context.projectId, entityId);
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

function taskCreatePayload(value: DidaTask): Partial<DidaTask> & Pick<DidaTask, "title" | "projectId"> {
  return {
    title: value.title,
    projectId: value.projectId,
    content: value.content,
    desc: value.desc,
    isAllDay: value.isAllDay,
    startDate: value.startDate,
    dueDate: value.dueDate,
    timeZone: value.timeZone,
    reminders: value.reminders,
    repeatFlag: value.repeatFlag,
    priority: value.priority,
    sortOrder: value.sortOrder,
    items: value.items,
    tags: value.tags,
  };
}

function taskUpdatePayload(value: DidaTask): Partial<DidaTask> {
  return {
    id: value.id,
    projectId: value.projectId,
    parentId: clearedAs(value, "parentId", null),
    title: value.title,
    content: clearedAs(value, "content", ""),
    desc: clearedAs(value, "desc", ""),
    isAllDay: clearedAs(value, "isAllDay", false),
    startDate: clearedAs(value, "startDate", null),
    dueDate: clearedAs(value, "dueDate", null),
    timeZone: clearedAs(value, "timeZone", null),
    reminders: clearedAs(value, "reminders", []),
    repeatFlag: clearedAs(value, "repeatFlag", null),
    priority: clearedAs(value, "priority", 0),
    sortOrder: clearedAs(value, "sortOrder", 0),
    items: clearedAs(value, "items", []),
    tags: clearedAs(value, "tags", []),
  };
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
    sortOrder: value.sortOrder,
    viewMode: value.viewMode,
    kind: value.kind,
  };
}
