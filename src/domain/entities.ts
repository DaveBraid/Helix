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
  startDate?: string;
  isAllDay?: boolean;
  timeZone?: string;
  completedTime?: string | number;
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
  items?: DidaChecklistItem[];
  tags?: string[];
  parentId?: string | null;
  childIds?: string[];
  kind?: "TASK" | "NOTE" | "CHECKLIST" | string;
  etag?: string;
  modifiedTime?: string;
  createdTime?: string;
}

export interface DidaProject {
  id: string;
  name: string;
  color?: string;
  sortOrder?: number;
  closed?: boolean;
  groupId?: string;
  viewMode?: "list" | "kanban" | "timeline" | string;
  permission?: "read" | "comment" | "write" | string;
  kind?: "TASK" | "NOTE" | string;
  etag?: string;
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
  status: "planned" | "active" | "paused" | "completed" | "archived";
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
  status: "planned" | "active" | "closed";
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
