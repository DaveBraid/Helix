import type {
  DidaColumn,
  DidaChecklistItem,
  DidaFocusRecord,
  DidaHabit,
  DidaHabitCheckin,
  DidaProject,
  DidaTask,
} from "../../domain/entities";

function normalizedDate(
  value: string | null | undefined,
  label = "日期",
): string | null {
  if (!value) return null;
  const parsed = new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(parsed.getTime())) throw new Error(`Dida ${label}格式无效`);
  return parsed.toISOString();
}

function normalizedStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function preservedStrings(values: string[] | undefined, label: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
    throw new Error(`Dida ${label}不是有效字符串数组`);
  }
  return [...values];
}

function preservedOptionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Dida ${label}不是字符串`);
  return value;
}

function normalizeChecklist(items: DidaChecklistItem[] | undefined): DidaChecklistItem[] {
  return (items ?? [])
    .map((item) => {
      if (
        typeof item.completedTime === "number" &&
        !Number.isFinite(new Date(item.completedTime).getTime())
      ) {
        throw new Error("Dida 检查项完成日期格式无效");
      }
      const sortOrderUnsafe = item.sortOrder !== undefined && !Number.isSafeInteger(item.sortOrder);
      return {
        ...item,
        title: item.title.trim(),
        startDate: normalizedDate(item.startDate, "检查项开始日期") ?? undefined,
        completedTime:
          typeof item.completedTime === "string"
            ? normalizedDate(item.completedTime, "检查项完成日期") ?? undefined
            : item.completedTime,
        sortOrder: sortOrderUnsafe ? undefined : item.sortOrder,
        sortOrderUnsafe: sortOrderUnsafe || undefined,
      };
    })
    .sort((left, right) => {
      const leftKey = left.id || `${left.sortOrder ?? 0}:${left.title}`;
      const rightKey = right.id || `${right.sortOrder ?? 0}:${right.title}`;
      return leftKey.localeCompare(rightKey);
    });
}

export function normalizeTask(task: DidaTask): DidaTask {
  assertRecord(task, "任务");
  requireString(task.id, "任务 id");
  requireString(task.projectId, "任务 projectId");
  requireString(task.title, "任务 title");
  if (typeof task.status !== "number") throw new Error("Dida 任务 status 不是数字");
  if (
    task.columnId !== undefined &&
    task.columnId !== null &&
    (typeof task.columnId !== "string" || !task.columnId.trim())
  ) {
    throw new Error("Dida 任务 columnId 缺失或类型错误");
  }
  const sortOrderUnsafe = task.sortOrder !== undefined && !Number.isSafeInteger(task.sortOrder);
  return {
    ...task,
    title: task.title.trim(),
    content: task.content ?? "",
    desc: task.desc ?? "",
    startDate: normalizedDate(task.startDate, "任务开始日期"),
    dueDate: normalizedDate(task.dueDate, "任务截止日期"),
    completedTime: normalizedDate(task.completedTime, "任务完成日期"),
    modifiedTime: normalizedDate(task.modifiedTime, "任务修改日期") ?? undefined,
    createdTime: normalizedDate(task.createdTime, "任务创建日期") ?? undefined,
    isAllDay: task.isAllDay ?? false,
    priority: task.priority ?? 0,
    reminders: preservedStrings(task.reminders, "任务 reminders"),
    repeatFlag: preservedOptionalString(task.repeatFlag, "任务 repeatFlag"),
    tags: normalizedStrings(task.tags),
    items: normalizeChecklist(task.items),
    parentId: task.parentId || null,
    columnId: task.columnId === undefined ? undefined : task.columnId?.trim() || null,
    sortOrder: sortOrderUnsafe ? undefined : task.sortOrder,
    sortOrderUnsafe: sortOrderUnsafe || undefined,
  };
}

export function normalizeColumn(column: DidaColumn): DidaColumn {
  assertRecord(column, "看板列");
  requireString(column.id, "看板列 id");
  requireString(column.projectId, "看板列 projectId");
  requireString(column.name, "看板列 name");
  const sortOrderUnsafe = column.sortOrder !== undefined && !Number.isSafeInteger(column.sortOrder);
  return {
    ...column,
    name: column.name.trim(),
    sortOrder: sortOrderUnsafe ? undefined : column.sortOrder,
    sortOrderUnsafe: sortOrderUnsafe || undefined,
  };
}

export function normalizeColumns(columns: DidaColumn[] | undefined): DidaColumn[] {
  if (columns === undefined) throw new Error("Dida 看板列字段缺失");
  if (!Array.isArray(columns)) throw new Error("Dida 看板列返回值不是数组");
  const normalized = columns.map(normalizeColumn);
  if (new Set(normalized.map((column) => column.id)).size !== normalized.length) {
    throw new Error("Dida 看板列 id 重复");
  }
  return normalized.sort((left, right) =>
    (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.id.localeCompare(right.id));
}

export function normalizeProject(project: DidaProject): DidaProject {
  assertRecord(project, "项目");
  requireString(project.id, "项目 id");
  requireString(project.name, "项目 name");
  const sortOrderUnsafe = project.sortOrder !== undefined && !Number.isSafeInteger(project.sortOrder);
  return {
    ...project,
    name: project.name.trim(),
    closed: project.closed ?? false,
    sortOrder: sortOrderUnsafe ? undefined : project.sortOrder,
    sortOrderUnsafe: sortOrderUnsafe || undefined,
    columns: project.columns === undefined ? undefined : normalizeColumns(project.columns),
  };
}

export function normalizeHabit(habit: DidaHabit): DidaHabit {
  assertRecord(habit, "习惯");
  requireString(habit.id, "习惯 id");
  requireString(habit.name, "习惯 name");
  return {
    ...habit,
    name: habit.name.trim(),
    reminders: normalizedStrings(habit.reminders),
    modifiedTime: normalizedDate(habit.modifiedTime, "习惯修改日期") ?? undefined,
  };
}

export function normalizeHabitCheckin(checkin: DidaHabitCheckin): DidaHabitCheckin {
  assertRecord(checkin, "习惯打卡");
  requireString(checkin.habitId, "习惯打卡 habitId");
  if (typeof checkin.checkinTime !== "string" && typeof checkin.checkinTime !== "number") {
    throw new Error("Dida 习惯打卡 checkinTime 无效");
  }
  const checkinTime =
    typeof checkin.checkinTime === "number"
      ? new Date(checkin.checkinTime)
      : new Date(checkin.checkinTime.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!Number.isFinite(checkinTime.getTime())) {
    throw new Error("Dida 习惯打卡 checkinTime 格式无效");
  }
  return {
    ...checkin,
    checkinTime:
      typeof checkin.checkinTime === "number"
        ? checkin.checkinTime
        : checkinTime.toISOString(),
    note: checkin.note?.trim() || undefined,
    modifiedTime: normalizedDate(checkin.modifiedTime, "习惯打卡修改日期") ?? undefined,
  };
}

export function normalizeFocus(record: DidaFocusRecord): DidaFocusRecord {
  assertRecord(record, "专注记录");
  requireString(record.id, "专注记录 id");
  return {
    ...record,
    note: record.note?.trim() || undefined,
    startTime: normalizedDate(record.startTime, "专注开始日期") ?? undefined,
    endTime: normalizedDate(record.endTime, "专注结束日期") ?? undefined,
    modifiedTime: normalizedDate(record.modifiedTime, "专注修改日期") ?? undefined,
  };
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Dida ${label}返回值不是对象`);
  }
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Dida ${label} 缺失或类型错误`);
  }
}
