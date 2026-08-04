export type EntityKind =
  | "task"
  | "project"
  | "habit"
  | "habit-checkin"
  | "focus";

export interface VersionStamp {
  etag?: string;
  modifiedAt?: string;
  hash: string;
}

export interface EntitySnapshot<T> {
  kind: EntityKind;
  entityId: string;
  capturedAt: string;
  value: T;
  stamp: VersionStamp;
}

export interface DidaChecklistItem {
  id: string;
  title: string;
  status: number;
  sortOrder?: number;
  sortOrderUnsafe?: boolean;
  startDate?: string;
  isAllDay?: boolean;
  timeZone?: string;
  completedTime?: string | number;
}

export interface DidaColumn {
  id: string;
  projectId: string;
  name: string;
  sortOrder?: number;
  sortOrderUnsafe?: boolean;
}

export interface DidaBoardSnapshot {
  projectId: string;
  columns: DidaColumn[];
  /** 只读详情投影；不进入任务 Base/Local/Remote，也不参与任务写载荷。 */
  taskColumnIds: Record<string, string | null>;
  capturedAt: string;
  stale: boolean;
}

export interface DidaTask {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  desc?: string;
  startDate?: string | null;
  dueDate?: string | null;
  timeZone?: string;
  isAllDay?: boolean;
  priority?: number;
  reminders?: string[];
  repeatFlag?: string | null;
  completedTime?: string | null;
  status: number;
  sortOrder?: number;
  columnId?: string | null;
  /** 看板归栏后由服务端派生的列名；仅用于读取与归栏后验证，禁止写回。 */
  columnName?: string | null;
  sortOrderUnsafe?: boolean;
  items?: DidaChecklistItem[];
  tags?: string[];
  parentId?: string | null;
  childIds?: string[];
  kind?: "TASK" | "NOTE" | "CHECKLIST" | string;
  etag?: string;
  modifiedTime?: string;
  /** 滴答服务端生成的写入时间戳；不进入业务字段比较或写载荷。 */
  etimestamp?: string | number;
  createdTime?: string;
}

export interface DidaProject {
  id: string;
  name: string;
  color?: string;
  sortOrder?: number;
  sortOrderUnsafe?: boolean;
  closed?: boolean;
  groupId?: string;
  viewMode?: "list" | "kanban" | "timeline" | string;
  permission?: "read" | "comment" | "write" | string;
  kind?: "TASK" | "NOTE" | string;
  etag?: string;
  /** 由只读远端看板快照临时附加，不进入项目同步写载荷。 */
  columns?: DidaColumn[];
  boardCapturedAt?: string;
  boardStale?: boolean;
}

export interface DidaHabit {
  id: string;
  name: string;
  color?: string;
  iconRes?: string;
  status?: number;
  encouragement?: string;
  goal?: number;
  step?: number;
  unit?: string;
  repeatRule?: string;
  reminders?: string[];
  recordEnable?: boolean;
  sectionId?: string;
  targetDays?: number;
  etag?: string;
  modifiedTime?: string;
}

export interface DidaHabitCheckin {
  id?: string;
  habitId: string;
  checkinTime: string | number;
  value?: number;
  status?: number;
  note?: string;
  etag?: string;
  modifiedTime?: string;
}

export interface DidaFocusRecord {
  id: string;
  type: number;
  taskId?: string;
  habitId?: string;
  note?: string;
  status?: number;
  startTime?: string;
  endTime?: string;
  pauseDuration?: number;
  adjustTime?: number;
  duration?: number;
  etag?: string;
  modifiedTime?: string;
}

export type RemoteEntity =
  | DidaTask
  | DidaProject
  | DidaHabit
  | DidaHabitCheckin
  | DidaFocusRecord;

export interface HelixProject {
  id: string;
  title: string;
  status: "planned" | "active" | "paused" | "completed" | "terminated";
  area?: string;
  didaProjectId?: string;
  parentProjectIds: string[];
  activeCycleId?: string;
  createdAt: string;
  updatedAt: string;
  notePath: string;
}

export interface HelixCycle {
  id: string;
  projectId: string;
  sequence: number;
  stageCode?: string;
  status: "idea" | "active" | "completed" | "paused" | "terminated";
  predecessorCycleId?: string;
  startedAt?: string;
  closedAt?: string;
  notePath: string;
}

export type JournalPeriod = "daily" | "weekly" | "monthly" | "yearly";

export interface JournalRecord {
  id: string;
  period: JournalPeriod;
  periodStart: string;
  periodEnd: string;
  notePath: string;
  closedAt?: string;
  projectIds: string[];
}

export interface InProgressEntry {
  taskId: string;
  projectId: string;
  cycleId?: string;
  markedAt: string;
  lastTouchedAt: string;
  activeFocus: boolean;
}
