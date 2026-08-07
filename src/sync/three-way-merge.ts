import { DIDA_TASK_REMOTE_METADATA_FIELDS } from "../domain/dida-task-metadata";
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
  ...DIDA_TASK_REMOTE_METADATA_FIELDS,
  "createdTime",
  "sortOrderUnsafe",
  "columnId",
  // 只读的服务端派生展示字段，不参加 Base/Local/Remote 冲突或回写。
  "columnName",
  // 本阶段任务状态由滴答 App 管理。完成仍通过独立 complete 队列，
  // 绝不在普通逐字段冲突中 local/custom 写回。
  "status",
  "completedTime",
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

export function applyConflictScopeDefaults(
  fields: ConflictField[],
  scope: SyncConflict["scope"],
): ConflictField[] {
  if (scope !== "helix-projection-owned-items") return fields;
  return fields.map((field) => field.path === "kind"
    ? { ...field, choice: "local" as const, customValue: undefined }
    : field);
}

export function enforceConflictScopeDefaults<T>(conflict: SyncConflict<T>): SyncConflict<T> {
  if (conflict.scope !== "helix-projection-owned-items") return conflict;
  const kind = conflict.fields.find((field) => field.path === "kind");
  if (kind && kind.localValue !== "CHECKLIST") {
    throw new Error("投影 owned 冲突的 Local kind 必须是 CHECKLIST");
  }
  return { ...conflict, fields: applyConflictScopeDefaults(conflict.fields, conflict.scope) };
}

/** 校验最终实际选择值，而不只校验 custom 输入。 */
export function validateChecklistTitleResolutions(conflict: SyncConflict, ownedItemIds: readonly string[]): void {
  const owned = new Set(ownedItemIds);
  for (const field of conflict.fields) {
    const match = /^items\[([^\]]+)\](?:\.title)?$/u.exec(field.path);
    if (!match || !owned.has(decodeURIComponent(match[1]!))) continue;
    const choice = field.choice ?? field.suggestedChoice ?? "local";
    const selected = choice === "custom"
      ? field.customValue
      : choice === "remote" ? field.remoteValue : field.localValue;
    const title = field.path.endsWith(".title")
      ? selected
      : selected && typeof selected === "object" ? (selected as Record<string, unknown>).title : undefined;
    if (selected === undefined || selected === null || (title === undefined && !field.path.endsWith(".title"))) continue;
    if (typeof title !== "string" || !title.trim() || title !== title.trim() || /[\r\n]/u.test(title) ||
      title.includes("<!-- helix-dida-action:")) {
      throw new Error("所选检查项标题必须非空、不能有首尾空格、必须是单行文本且不能包含同步标记");
    }
  }
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
  if (next.scope === "helix-projection-owned-items" && path === "kind" && choice !== "local") {
    throw new Error("投影 owned 冲突的 kind 由系统固定为 Local CHECKLIST");
  }
  if (choice === "custom" && /^items\[[^\]]+\]\.title$/u.test(path) &&
    (typeof customValue !== "string" || !customValue.trim() || customValue !== customValue.trim() ||
      /[\r\n]/u.test(customValue) ||
      customValue.includes("<!-- helix-dida-action:"))) {
    throw new Error("检查项自定义标题必须非空、不能有首尾空格、必须是单行文本且不能包含同步标记");
  }
  if (choice === "custom" && /^items\[[^\]]+\]\.status$/u.test(path) &&
    customValue !== 0 && customValue !== 2) {
    throw new Error("检查项自定义状态只能是未完成或已完成");
  }
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
  // 远端是未知字段与集合顺序的权威底板；只把明确选择的本地业务字段覆盖上去。
  const output = cloneValue(conflict.remote.value) as Record<string, unknown>;
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
    .flatMap((id) => {
      if (key === "items" && base.has(id) && local.has(id) && remote.has(id)) {
        const baseItem = base.get(id) as Record<string, unknown>;
        const localItem = local.get(id) as Record<string, unknown>;
        const remoteItem = remote.get(id) as Record<string, unknown>;
        return ["title", "status"]
          .map((property) => {
            const field = createField(
              `${key}[${encodeURIComponent(id)}].${property}`,
              baseItem[property],
              localItem[property],
              remoteItem[property],
            );
            if (field) {
              field.label = `${FIELD_LABELS[property] ?? property} · ${itemTitle(localItem)}`;
              field.group = "checklist";
              // owned item 的正交单边变化可直接合并；只有同一子字段双改竞争需要人工选择。
              if (!field.sameResult && field.suggestedChoice) field.choice = field.suggestedChoice;
            }
            return field;
          })
          .filter((field): field is ConflictField => field !== null);
      }
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
      return field ? [field] : [];
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
  const match = /^(items|checkins)\[(.+?)](?:\.(title|status))?$/.exec(path);
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
    if (match[3]) {
      const current = items[index] && typeof items[index] === "object"
        ? cloneValue(items[index]) as Record<string, unknown>
        : {};
      current[match[3]] = cloneValue(value);
      if (match[3] === "status") {
        if (value === 0) delete current.completedTime;
        else if (value === 2 && current.completedTime !== undefined &&
          !Number.isFinite(new Date(current.completedTime as string | number).getTime())) {
          delete current.completedTime;
        }
      }
      items[index] = current;
    } else {
      items[index] = cloneValue(value);
    }
  } else {
    items.push(cloneValue(value));
  }
  output[root] = items;
}
