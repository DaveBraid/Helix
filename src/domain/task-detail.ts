export type TaskDetailSource = "dida" | "stage-action" | "stage-projection" | "preview";

export type TaskDetailStatus = "idea" | "active" | "recording" | "completed" | "paused" | "terminated";

export type TaskDetailPriority = 0 | 1 | 3 | 5;

export interface TaskDetailSubtaskDraft {
  id: string;
  title: string;
  status: TaskDetailStatus;
  date: string;
  startTime: string;
  endTime: string;
  priority: TaskDetailPriority;
}

export interface TaskDetailDraft {
  id: string;
  source: TaskDetailSource;
  breadcrumb: string[];
  syncLabel: string;
  title: string;
  status: TaskDetailStatus;
  priority: TaskDetailPriority;
  date: string;
  startTime: string;
  endTime: string;
  timeMode: "none" | "point" | "range";
  timeZone: string;
  tags: string[];
  listId?: string;
  reminders: string[];
  repeatFlag: string | null;
  subtasks: TaskDetailSubtaskDraft[];
}

export interface TaskDetailCapabilities {
  delete: boolean;
  editTitle: boolean;
  editStatus: boolean;
  statusOptions: TaskDetailStatus[];
  /** 已完成只能由全部直属子任务完成后派生，不能由状态控件主动选择。 */
  completionDerivedFromSubtasks?: boolean;
  editPriority: boolean;
  editSchedule: boolean;
  editTags: boolean;
  editSubtasks: boolean;
  addSubtasks: boolean;
  deleteSubtasks: boolean;
  editSubtaskSchedule: boolean;
  reorderSubtasks: boolean;
  list: boolean;
  listChoices: Array<{ id: string; name: string }>;
  reminder: boolean;
  repeat: boolean;
}

export interface TaskDetailAdapter {
  read(): Promise<{ draft: TaskDetailDraft; capabilities: TaskDetailCapabilities }>;
  save(draft: TaskDetailDraft): Promise<void>;
  delete?(): Promise<void>;
  toggleCompletion?(subtaskId: string, completed: boolean): Promise<void>;
}

export function cloneTaskDetailDraft(draft: TaskDetailDraft): TaskDetailDraft {
  return {
    ...draft,
    breadcrumb: [...draft.breadcrumb],
    tags: [...draft.tags],
    reminders: [...draft.reminders],
    subtasks: draft.subtasks.map((subtask) => ({ ...subtask })),
  };
}

export function validateTaskDetailDraft(draft: TaskDetailDraft): void {
  if (!draft.title.trim()) throw new Error("任务标题不能为空");
  if (draft.startTime && draft.endTime && draft.startTime > draft.endTime) {
    throw new Error("结束时间不能早于开始时间");
  }
  for (const subtask of draft.subtasks) {
    if (!subtask.title.trim()) throw new Error("子任务标题不能为空");
    if (subtask.startTime && subtask.endTime && subtask.startTime > subtask.endTime) {
      throw new Error(`子任务“${subtask.title}”的结束时间不能早于开始时间`);
    }
  }
}
