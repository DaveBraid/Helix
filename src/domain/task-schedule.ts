import type { DidaTask } from "./entities";

export type TaskScheduleMode = "unknown" | "point" | "duration";
export type TaskScheduleEditorMode = "point" | "duration" | "locked-duration";
/** 写入合同的唯一权威版本；版本变化必须使旧能力缓存失效为只读。 */
export const DIDA_CONTRACT_PROBE_VERSION = 8;

export function validateTaskScheduleWrite(
  task: Pick<DidaTask, "startDate" | "dueDate" | "timeZone" | "isAllDay">,
  mode: TaskScheduleMode,
  remoteBeforeWrite?: Pick<
    DidaTask,
    "startDate" | "dueDate" | "timeZone" | "isAllDay"
  > | null,
): void {
  validateScheduleMetadata(task);
  const start = validInstant(task.startDate, "开始时间");
  const due = validInstant(task.dueDate, "截止时间");
  if (start !== null && due !== null && start > due) {
    throw new Error("截止时间不能早于开始时间");
  }
  if (mode === "duration" || isPointSchedule(task)) return;
  if (remoteBeforeWrite && sameSchedule(task, remoteBeforeWrite)) return;
  if (mode === "unknown") {
    throw new Error("尚未检测当前滴答账号的时间段能力；请先在 Helix 设置中运行写入合同测试");
  }
  throw new Error("当前滴答账号仅支持单点任务时间，不能提交不同的开始时间和截止时间");
}

export function taskScheduleEditorMode(
  task: Pick<DidaTask, "startDate" | "dueDate">,
  capability: TaskScheduleMode,
): TaskScheduleEditorMode {
  if (capability !== "point") return "duration";
  return isPointSchedule(task) ? "point" : "locked-duration";
}

export function taskScheduleForSubmission(
  original: Pick<DidaTask, "startDate" | "dueDate" | "timeZone" | "isAllDay">,
  edited: Pick<DidaTask, "startDate" | "dueDate" | "timeZone" | "isAllDay">,
  editorMode: TaskScheduleEditorMode,
): Pick<DidaTask, "startDate" | "dueDate" | "timeZone" | "isAllDay"> {
  if (editorMode !== "locked-duration") return { ...edited };
  return {
    startDate: original.startDate ?? null,
    dueDate: original.dueDate ?? null,
    timeZone: original.timeZone,
    isAllDay: original.isAllDay,
  };
}

export function isPointSchedule(
  task: Pick<DidaTask, "startDate" | "dueDate">,
): boolean {
  const start = task.startDate ?? null;
  const due = task.dueDate ?? null;
  if (start === null && due === null) return true;
  return due !== null && (start === null || sameInstant(start, due));
}

export function sameSchedule(
  left: Pick<DidaTask, "startDate" | "dueDate" | "timeZone" | "isAllDay">,
  right: Pick<DidaTask, "startDate" | "dueDate" | "timeZone" | "isAllDay">,
): boolean {
  return sameOptionalInstant(left.startDate, right.startDate) &&
    sameOptionalInstant(left.dueDate, right.dueDate) &&
    left.timeZone === right.timeZone &&
    (left.isAllDay ?? false) === (right.isAllDay ?? false);
}

function sameOptionalInstant(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return sameInstant(left, right);
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function validInstant(value: string | null | undefined, label: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label}格式无效`);
  return parsed;
}

function validateScheduleMetadata(
  task: Pick<DidaTask, "timeZone" | "isAllDay">,
): void {
  if (task.isAllDay !== undefined && typeof task.isAllDay !== "boolean") {
    throw new Error("全天状态格式无效");
  }
  if (task.timeZone === undefined || task.timeZone === null) return;
  if (typeof task.timeZone !== "string" || !task.timeZone.trim()) {
    throw new Error("任务时区格式无效");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: task.timeZone }).format(new Date(0));
  } catch {
    throw new Error("任务时区无效");
  }
}
