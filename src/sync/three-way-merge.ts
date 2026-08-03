import { cloneValue, deepEqual } from "../domain/stable";
import type { ConflictField, ResolutionChoice, SyncConflict } from "./types";

const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  name: "名称",
  content: "正文",
  desc: "说明",
  projectId: "所属项目",
  priority: "优先级",
  status: "状态",
  startDate: "开始时间",
  dueDate: "截止时间",
  timeZone: "时区",
  isAllDay: "全天",
  reminders: "提醒",
  repeatFlag: "重复规则",
  tags: "标签",
  items: "检查事项",
  parentId: "父任务",
  completedTime: "完成时间",
  viewMode: "清单视图",
  sortOrder: "排序",
};

const IGNORED_FIELDS = new Set([
  "etag",
  "modifiedTime",
  "createdTime",
  "sortOrderUnsafe",
  "columnId",
]);
const TEXT_FIELDS = new Set(["content", "desc", "note", "encouragement"]);
const SCHEDULE_FIELDS = new Set([
  "startDate",
  "dueDate",
  "timeZone",
  "isAllDay",
  "reminders",
  "repeatFlag",
]);

function fieldGroup(path: string): ConflictField["group"] {
  const root = path.split(".")[0] ?? path;
  if (TEXT_FIELDS.has(root)) return "text";
  if (root === "tags") return "set";
  if (root === "items" || root === "checkins") return "checklist";
  if (SCHEDULE_FIELDS.has(root)) return "schedule";
  return "scalar";
}

function collectKeys(...values: unknown[]): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!IGNORED_FIELDS.has(key)) keys.add(key);
    }
  }
  return [...keys].sort();
}

function createField(
  path: string,
  baseValue: unknown,
  localValue: unknown,
  remoteValue: unknown,
): ConflictField | null {
  const localChanged = !deepEqual(localValue, baseValue);
  const remoteChanged = !deepEqual(remoteValue, baseValue);
  if (!localChanged && !remoteChanged) return null;
  const sameResult = deepEqual(localValue, remoteValue);
  let suggestedChoice: ResolutionChoice | undefined;
  if (sameResult || (localChanged && !remoteChanged)) suggestedChoice = "local";
  else if (remoteChanged && !localChanged) suggestedChoice = "remote";

  const root = path.split(".")[0] ?? path;
  return {
    path,
    label: FIELD_LABELS[root] ?? root,
    baseValue: cloneValue(baseValue),
    localValue: cloneValue(localValue),
    remoteValue: cloneValue(remoteValue),
    localChanged,
    remoteChanged,
    sameResult,
    group: path === "$" ? "deletion" : fieldGroup(path),
    suggestedChoice,
  };
}

export function buildConflictFields(
  base: unknown,
  local: unknown,
  remote: unknown,
): ConflictField[] {
  if (base === null || local === null || remote === null) {
    const field = createField("$", base, local, remote);
    return field ? [field] : [];
  }
  const keys = collectKeys(base, local, remote);
  if (keys.length === 0) {
    const field = createField("$", base, local, remote);
    return field ? [field] : [];
  }
  return keys
    .flatMap((key) => {
      const baseValue = (base as Record<string, unknown> | null)?.[key];
      const localValue = (local as Record<string, unknown> | null)?.[key];
      const remoteValue = (remote as Record<string, unknown> | null)?.[key];
      if ((key === "items" || key === "checkins") && [baseValue, localValue, remoteValue].some(Array.isArray)) {
        return buildKeyedArrayFields(key, baseValue, localValue, remoteValue);
      }
      return [createField(key, baseValue, localValue, remoteValue)];
    })
    .filter((field): field is ConflictField => field !== null);
}

export function unresolvedFields(conflict: SyncConflict): ConflictField[] {
  return conflict.fields.filter((field) => !field.sameResult && !field.choice);
}

export function setFieldResolution(
  conflict: SyncConflict,
  path: string,
  choice: ResolutionChoice,
  customValue?: unknown,
): SyncConflict {
  const next = cloneValue(conflict);
  const field = next.fields.find((candidate) => candidate.path === path);
  if (!field) throw new Error(`Unknown conflict field: ${path}`);
  field.choice = choice;
  field.customValue = choice === "custom" ? cloneValue(customValue) : undefined;
  next.status = unresolvedFields(next).length === 0 ? "staged" : "open";
  next.updatedAt = new Date().toISOString();
  return next;
}

export function applyResolutions<T>(conflict: SyncConflict<T>): T {
  const missing = unresolvedFields(conflict);
  if (missing.length > 0) {
    throw new Error(`Conflict still has ${missing.length} unresolved field(s)`);
  }
  const output = cloneValue(conflict.base.value) as Record<string, unknown>;
  for (const field of conflict.fields) {
    const choice = field.choice ?? field.suggestedChoice ?? "local";
    const value =
      choice === "custom"
        ? field.customValue
        : choice === "remote"
          ? field.remoteValue
          : field.localValue;
    if (field.path === "$") return cloneValue(value) as T;
    applyFieldValue(output, field.path, value);
  }
  return output as T;
}

function buildKeyedArrayFields(
  key: string,
  baseValue: unknown,
  localValue: unknown,
  remoteValue: unknown,
): ConflictField[] {
  const base = keyedItems(baseValue);
  const local = keyedItems(localValue);
  const remote = keyedItems(remoteValue);
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  return [...ids]
    .sort()
    .map((id) => {
      const field = createField(
        `${key}[${encodeURIComponent(id)}]`,
        base.get(id),
        local.get(id),
        remote.get(id),
      );
      if (field) {
        field.label = `${FIELD_LABELS[key] ?? key} · ${itemTitle(local.get(id) ?? remote.get(id) ?? base.get(id))}`;
        field.group = "checklist";
      }
      return field;
    })
    .filter((field): field is ConflictField => field !== null);
}

function keyedItems(value: unknown): Map<string, unknown> {
  if (!Array.isArray(value)) return new Map();
  return new Map(
    value.map((item, index) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const id = String(record.id ?? `${record.habitId ?? "item"}:${record.checkinTime ?? index}`);
      return [id, item] as const;
    }),
  );
}

function itemTitle(value: unknown): string {
  if (!value || typeof value !== "object") return "已删除";
  const record = value as Record<string, unknown>;
  return String(record.title ?? record.name ?? record.note ?? record.id ?? "未命名项");
}

function applyFieldValue(output: Record<string, unknown>, path: string, value: unknown): void {
  const match = /^(items|checkins)\[(.+)]$/.exec(path);
  if (!match) {
    output[path] = cloneValue(value);
    return;
  }
  const root = match[1]!;
  const itemId = decodeURIComponent(match[2]!);
  const items = Array.isArray(output[root]) ? cloneValue(output[root]) as unknown[] : [];
  const index = items.findIndex((item, position) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const id = String(record.id ?? `${record.habitId ?? "item"}:${record.checkinTime ?? position}`);
    return id === itemId;
  });
  if (value === undefined) {
    if (index >= 0) items.splice(index, 1);
  } else if (index >= 0) {
    items[index] = cloneValue(value);
  } else {
    items.push(cloneValue(value));
  }
  output[root] = items;
}
