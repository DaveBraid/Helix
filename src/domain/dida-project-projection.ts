import type { DidaChecklistItem, DidaColumn, DidaProject, DidaTask } from "./entities";
import { stableHash } from "./stable";
import { isDidaChecklistClientId } from "./dida-checklist-id";

export const PROJECT_PARENT_TASK_FIELD = "helix-dida-parent-task-id";
export const LEGACY_PROJECT_LIST_FIELD = "helix-dida-project-id";
export const PLAN_ACTION_HEADING = "计划行动";

export type ProjectionActionState = "idea" | "active" | "completed" | "paused" | "terminated";
/** 共享 UI 必须提供这五种用户可编辑状态；非 completed 状态均投影为滴答开放。 */
export const PROJECTION_ACTION_EDITABLE_STATES: readonly ProjectionActionState[] = [
  "idea", "active", "completed", "paused", "terminated",
];
export type ProjectionFreezeReason =
  | "conflict"
  | "unknown-outcome"
  | "retryable"
  | "authorization"
  | "capability"
  | "markdown-race"
  | "identity-mismatch";

export interface DidaProjectionTarget {
  targetProjectId: string;
  targetColumnId: string;
}

export interface ProjectionReadiness {
  writable: boolean;
  queueEmpty: boolean;
  authorizationCurrent: boolean;
  taskParentingVerified: boolean;
  itemsRoundTripVerified: boolean;
  itemIdStableVerified: boolean;
  boardPlacementVerified: boolean;
  boardFresh: boolean;
  taskReopenVerified: boolean;
  unknownOutcomes: number;
}

export interface ProjectionActivationPreview {
  target: DidaProjectionTarget;
  projectName: string;
  columnName: string;
  projectCount: number;
  actionCount: number;
  createsColumn: false;
  previewHash: string;
  blockers: string[];
}

export const PROJECTION_COLUMN_NAME = "Helix项目";
export const PROJECTION_PROJECT_NAME = "Helix Projects";
/** 项目阶段任务直接归入清单，不指定看板分栏。 */
export const PROJECTION_NO_COLUMN_ID = "helix-no-column";
/** 旧调试状态没有此凭证；门禁开放后必须由当前设置页重新预览确认。 */
export const PROJECT_PROJECTION_ACTIVATION_VERSION = 3;

export interface ProjectionColumnBaseline {
  id: string;
  projectId: string;
  name: string;
}

export interface ProjectionColumnCreationCheckpoint {
  operationId: string;
  targetProjectId: string;
  desiredName: typeof PROJECTION_COLUMN_NAME;
  baselineColumns: ProjectionColumnBaseline[];
  baselineHash: string;
  previewHash: string;
  status: "prepared" | "running" | "unknown";
  remoteColumnId?: string;
  errorSummary?: string;
}

export interface ProjectionColumnCreationPreview {
  targetProjectId: string;
  projectName: string;
  desiredName: typeof PROJECTION_COLUMN_NAME;
  baselineColumns: ProjectionColumnBaseline[];
  baselineHash: string;
  previewHash: string;
  blockers: string[];
}

export interface ManagedPlanAction {
  uuid: string;
  title: string;
  state: ProjectionActionState;
  parentUuid?: string;
  content?: string;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  isAllDay?: boolean;
  priority?: 0 | 1 | 3 | 5;
  tags?: string[];
  remoteId?: string;
  line: number;
}

export interface ParsedPlanActions {
  actions: ManagedPlanAction[];
  unmanagedChecklistLines: number[];
  section: { start: number; end: number; eol: "\n" | "\r\n" };
}

export interface ProjectionLedgerEntry {
  uuid: string;
  projectId: string;
  stageId: string;
  /** Stage Markdown 的稳定 Vault 路径；整组 items ID 重映时不可缺失。 */
  stagePath?: string;
  parentTaskId: string;
  targetProjectId: string;
  targetColumnId: string;
  remoteId?: string;
  /** 缺失表示 1.0.1 及以前的历史 items 映射，只允许诊断，不得按 Task 写入。 */
  remoteEntity?: "task" | "item";
  title: string;
  state: ProjectionActionState;
  content?: string;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  isAllDay?: boolean;
  priority?: 0 | 1 | 3 | 5;
  tags?: string[];
  sourceHash: string;
  tombstone?: boolean;
  frozen?: ProjectionFreezeReason;
  operationId?: string;
  conflictId?: string;
  /** 新建检查项写前持久化的完整稳定 ID 集合；仅用于崩溃后唯一差集领养。 */
  createBaselineItemIds?: string[];
  createBaselineItemsHash?: string;
  createBaselineItemHashes?: Record<string, string>;
  /** 既有项按原顺序保存的除 ID 外完整语义哈希；用于明确成功响应后的正式 ID 重映。 */
  createBaselineSemanticHashes?: string[];
  /** 写前持久化的客户端检查项身份；缺失表示旧版无 ID checkpoint，只允许只读复读。 */
  createItemId?: string;
  createItemSortOrder?: number;
  /** owned item 更新发送前检查点；用于崩溃/结果未知后的只读收口，禁止重发。 */
  updateExpectedTitle?: string;
  updateExpectedStatus?: number;
  updateStageRevisionHash?: string;
  mutationKind?: "update" | "delete";
  mutationBaselineItemIds?: string[];
  mutationBaselineItemsHash?: string;
  mutationBaselineItemHashes?: Record<string, string>;
  /** 排除 owned 项后，普通 items 按原顺序保存的除 ID 外完整语义哈希。 */
  mutationOrdinarySemanticHashes?: string[];
  mutationOwnedInvariantHash?: string;
  mutationBaselineOwnedStatus?: number;
  mutationBaselineOwnedCompletedTimeHash?: string;
  /** 整组 items 写入前冻结的行动 UUID→Stage 路径，用于全组 ID 重映的崩溃恢复。 */
  remapStagePaths?: Record<string, string>;
}

export type ProjectionReceiptCleanupProof = {
  operationId: string;
  conflictId?: string;
  targetProjectId: string;
  marker: string;
  remoteTaskId: string;
} & (
  | { kind: "action"; projectId: string; stageId: string; uuid: string }
  | { kind: "parent"; projectId: string }
);

export type ProjectionIntent =
  | { kind: "create-action"; entry: ProjectionLedgerEntry }
  | { kind: "recover-action"; entry: ProjectionLedgerEntry }
  | { kind: "reconcile-delete"; entry: ProjectionLedgerEntry }
  | { kind: "freeze-action"; entry: ProjectionLedgerEntry; reason: ProjectionFreezeReason }
  | { kind: "update-action"; entry: ProjectionLedgerEntry; writeFields: ProjectionTaskWriteField[] }
  | { kind: "complete-action"; entry: ProjectionLedgerEntry }
  | { kind: "reopen-action"; entry: ProjectionLedgerEntry }
  | { kind: "delete-action"; entry: ProjectionLedgerEntry };

export type ProjectionTaskWriteField =
  | "title" | "content" | "status" | "desc" | "startDate" | "dueDate" | "timeZone" | "isAllDay" | "priority" | "tags";

const ACTION_MARKER_V1 = /^<!-- helix-dida-action:v1 uuid=([^ ]+) remoteId=([^ ]+) state=(idea|active|completed|paused|terminated) -->$/;
const ACTION_MARKER_V2 = /^<!-- helix-dida-action:v2 uuid=([^ ]+) parent=([^ ]+) remoteId=([^ ]+) state=(idea|active|completed|paused|terminated) -->$/;
const ACTION_MARKER_V3 = /^<!-- helix-dida-action:v3 uuid=([^ ]+) parent=([^ ]+) remoteId=([^ ]+) state=(idea|active|completed|paused|terminated) priority=(0|1|3|5) start=([^ ]+) due=([^ ]+) zone=([^ ]+) allDay=(0|1) tags=([^ ]+) note=([^ ]+) -->$/;
const CHECKBOX = /^(\s*)[-*+] \[([ xX])\] (.*?)(?:\s+<!-- helix-dida-action:v1 [\s\S]+ -->)?\s*$/;

export function buildProjectionActivationPreview(input: {
  target: DidaProjectionTarget;
  projects: DidaProject[];
  columns: DidaColumn[];
  readiness: ProjectionReadiness;
  projectCount: number;
  actionCount: number;
}): ProjectionActivationPreview {
  assertStableId(input.target.targetProjectId, "目标清单 ID");
  assertStableId(input.target.targetColumnId, "目标分栏 ID");
  const matchingProjects = input.projects.filter((item) => item.id === input.target.targetProjectId);
  if (matchingProjects.length !== 1) throw new Error("目标滴答清单身份缺失或重复");
  const project = matchingProjects[0]!;
  const withoutColumn = input.target.targetColumnId === PROJECTION_NO_COLUMN_ID;
  const matchingColumns = input.columns.filter((item) => item.id === input.target.targetColumnId);
  if (!withoutColumn && (matchingColumns.length !== 1 || matchingColumns[0]!.projectId !== input.target.targetProjectId)) {
    throw new Error("目标看板分栏身份或归属不一致");
  }
  const blockers = readinessBlockers(input.readiness, project);
  const stable = {
    target: input.target,
    projectName: project.name,
    columnName: withoutColumn ? "不指定分栏" : matchingColumns[0]!.name,
    projectCount: input.projectCount,
    actionCount: input.actionCount,
    blockers,
  };
  return { ...stable, createsColumn: false, previewHash: stableHash(stable) };
}

export function assertProjectionActivation(preview: ProjectionActivationPreview, confirmedHash: string): void {
  if (preview.previewHash !== confirmedHash) throw new Error("同步预览已变化，请重新确认精确清单与分栏");
  if (preview.blockers.length > 0) throw new Error(`滴答项目同步尚不可启用：${preview.blockers.join("；")}`);
}

export function parseManagedPlanActions(markdown: string): ParsedPlanActions {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const section = exactHeadingSection(lines, PLAN_ACTION_HEADING, 1);
  const actions: ManagedPlanAction[] = [];
  const unmanagedChecklistLines: number[] = [];
  const uuids = new Set<string>();
  const remoteIds = new Set<string>();
  let fence: { char: "`" | "~"; length: number } | undefined;
  for (let index = section.start + 1; index < section.end; index += 1) {
    const line = lines[index] ?? "";
    const fenceMarker = /^( {0,3})(`{3,}|~{3,})/.exec(line)?.[2];
    if (fenceMarker) {
      const char = fenceMarker[0] as "`" | "~";
      if (!fence) fence = { char, length: fenceMarker.length };
      else if (char === fence.char && fenceMarker.length >= fence.length &&
        new RegExp(`^ {0,3}${char === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;
    const checkbox = CHECKBOX.exec(line);
    if (!checkbox) continue;
    const markerStart = line.indexOf("<!-- helix-dida-action:");
    if (markerStart < 0) {
      // 模板用空复选框提示可填写位置；它不是任务，也不得进入纳管或预览计数。
      if (!checkbox[3]!.trim()) continue;
      unmanagedChecklistLines.push(index + 1);
      continue;
    }
    const markerText = line.slice(markerStart).trim();
    const marker = parseActionMarker(markerText);
    if (!marker) throw new Error(`计划行动同步标记损坏：第 ${index + 1} 行`);
    const { uuid, parentUuid, remoteId: remote, state } = marker;
    assertStableId(uuid, "行动 UUID");
    if (uuids.has(uuid)) throw new Error(`计划行动 UUID 重复：${uuid}`);
    if (parentUuid && !uuids.has(parentUuid)) {
      throw new Error(`计划行动父任务必须位于子任务之前：第 ${index + 1} 行`);
    }
    if (remote && remoteIds.has(remote)) throw new Error(`计划行动远端 ID 重复：${remote}`);
    uuids.add(uuid);
    if (remote) remoteIds.add(remote);
    const rawTitle = line.slice(0, markerStart).replace(/^\s*[-*+] \[[ xX]\]\s*/, "").trim();
    if (!rawTitle) throw new Error(`已加入同步的计划行动标题为空：第 ${index + 1} 行`);
    const checked = checkbox[2]!.toLowerCase() === "x";
    if (checked !== (state === "completed")) {
      throw new Error(`计划行动勾选状态与同步状态不一致：第 ${index + 1} 行`);
    }
    actions.push({
      uuid,
      title: rawTitle,
      state,
      ...(parentUuid ? { parentUuid } : {}),
      ...(marker.content ? { content: marker.content } : {}),
      ...(marker.startDate ? { startDate: marker.startDate } : {}),
      ...(marker.dueDate ? { dueDate: marker.dueDate } : {}),
      ...(marker.timeZone ? { timeZone: marker.timeZone } : {}),
      ...(marker.isAllDay ? { isAllDay: true } : {}),
      ...(marker.priority ? { priority: marker.priority } : {}),
      ...(marker.tags?.length ? { tags: marker.tags } : {}),
      ...(remote ? { remoteId: remote } : {}),
      line: index + 1,
    });
  }
  return { actions, unmanagedChecklistLines, section: { ...section, eol } };
}

/** Live Preview 复用完整领域校验；任一损坏、编码或状态不一致均由调用方保持可见。 */
export function managedActionMarkerSpans(markdown: string): Array<{ from: number; to: number }> {
  const parsed = parseManagedPlanActions(markdown);
  const lineStarts = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") lineStarts.push(index + 1);
  }
  const lines = markdown.split(/\r?\n/);
  return parsed.actions.map((action) => {
    const line = lines[action.line - 1] ?? "";
    const markerFrom = line.indexOf("<!-- helix-dida-action:");
    const markerText = markerFrom >= 0 ? line.slice(markerFrom).trim() : "";
    if (markerFrom < 0 || !parseActionMarker(markerText)) {
      throw new Error(`计划行动同步标记损坏：第 ${action.line} 行`);
    }
    const from = lineStarts[action.line - 1]! + markerFrom;
    return { from, to: from + markerText.length };
  });
}

export function adoptPlanAction(
  markdown: string,
  lineNumber: number,
  uuid: string,
  parentUuid?: string,
): string {
  assertStableId(uuid, "行动 UUID");
  const parsed = parseManagedPlanActions(markdown);
  if (!parsed.unmanagedChecklistLines.includes(lineNumber)) throw new Error("只能将计划行动中尚未加入同步的清单项加入同步");
  if (parsed.actions.some((action) => action.uuid === uuid)) throw new Error("行动 UUID 已存在");
  const lines = markdown.split(/\r?\n/);
  const index = lineNumber - 1;
  const checkbox = CHECKBOX.exec(lines[index] ?? "");
  if (!checkbox) throw new Error("目标行已变化，请重新预览");
  const state: ProjectionActionState = checkbox[2]!.toLowerCase() === "x" ? "completed" : "active";
  if (parentUuid && !parsed.actions.some((action) => action.uuid === parentUuid)) {
    throw new Error("计划行动父任务不存在");
  }
  lines[index] = `${lines[index]!.trimEnd()} ${renderActionMarker(uuid, undefined, state, parentUuid)}`;
  return lines.join(parsed.section.eol);
}

/** 为“计划行动”中的有效原生复选项一次性补齐稳定身份；空模板占位保持原样。 */
export function adoptAllPlanActions(
  markdown: string,
  uuidFactory: () => string = () => crypto.randomUUID(),
): string {
  const parsed = parseManagedPlanActions(markdown);
  if (parsed.unmanagedChecklistLines.length === 0) return markdown;
  const unmanaged = new Set(parsed.unmanagedChecklistLines);
  const managedByLine = new Map(parsed.actions.map((action) => [action.line, action]));
  const lines = markdown.split(/\r?\n/);
  const stack: Array<{ indent: number; uuid: string }> = [];
  let changed = false;
  for (let lineNumber = parsed.section.start + 2; lineNumber <= parsed.section.end; lineNumber += 1) {
    if (!unmanaged.has(lineNumber) && !managedByLine.has(lineNumber)) continue;
    const line = lines[lineNumber - 1] ?? "";
    const checkbox = CHECKBOX.exec(line);
    if (!checkbox) continue;
    const indent = indentationWidth(checkbox[1]!);
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const existing = managedByLine.get(lineNumber);
    if (existing) {
      stack.push({ indent, uuid: existing.uuid });
      continue;
    }
    const title = checkbox[3]!.trim();
    if (!title) continue;
    assertManagedActionTitle(title);
    const uuid = uuidFactory();
    assertStableId(uuid, "行动 UUID");
    const state: ProjectionActionState = checkbox[2]!.toLowerCase() === "x" ? "completed" : "idea";
    const parentUuid = stack[stack.length - 1]?.uuid;
    lines[lineNumber - 1] = `${line.trimEnd()} ${renderActionMarker(uuid, undefined, state, parentUuid)}`;
    stack.push({ indent, uuid });
    changed = true;
  }
  const next = changed ? lines.join(parsed.section.eol) : markdown;
  if (changed) parseManagedPlanActions(next);
  return next;
}

/** 原生勾选只驱动尚未绑定远端的本地任务；远端身份存在时仍保持严格冲突检查。 */
export function reconcileLocalPlanActionCheckboxes(markdown: string): string {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const section = exactHeadingSection(lines, PLAN_ACTION_HEADING, 1);
  let changed = false;
  let fence: { char: "`" | "~"; length: number } | undefined;
  for (let index = section.start + 1; index < section.end; index += 1) {
    const line = lines[index] ?? "";
    const fenceMarker = /^( {0,3})(`{3,}|~{3,})/.exec(line)?.[2];
    if (fenceMarker) {
      const char = fenceMarker[0] as "`" | "~";
      if (!fence) fence = { char, length: fenceMarker.length };
      else if (char === fence.char && fenceMarker.length >= fence.length &&
        new RegExp(`^ {0,3}${char === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;
    const checkbox = CHECKBOX.exec(line);
    const markerStart = line.indexOf("<!-- helix-dida-action:");
    if (!checkbox || markerStart < 0) continue;
    const marker = parseActionMarker(line.slice(markerStart).trim());
    if (!marker || marker.remoteId) continue;
    const checked = checkbox[2]!.toLowerCase() === "x";
    const nextState = checked
      ? "completed"
      : marker.state === "completed"
        ? "idea"
        : marker.state;
    if (nextState === marker.state) continue;
    lines[index] = `${line.slice(0, markerStart).trimEnd()} ${
      renderActionMarker(marker.uuid, undefined, nextState, marker.parentUuid, marker)
    }`;
    changed = true;
  }
  const next = changed ? lines.join(eol) : markdown;
  if (changed) parseManagedPlanActions(next);
  return next;
}

export function appendManagedPlanAction(markdown: string, input: {
  uuid: string;
  title: string;
  state?: ProjectionActionState;
  parentUuid?: string;
  content?: string;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  isAllDay?: boolean;
  priority?: 0 | 1 | 3 | 5;
  tags?: string[];
}): string {
  assertStableId(input.uuid, "行动 UUID");
  assertManagedActionTitle(input.title);
  const parsed = parseManagedPlanActions(markdown);
  if (parsed.actions.some((action) => action.uuid === input.uuid)) throw new Error("行动 UUID 已存在");
  const lines = markdown.split(/\r?\n/);
  let insertAt = parsed.section.end;
  let indent = "";
  if (input.parentUuid) {
    const parent = parsed.actions.find((action) => action.uuid === input.parentUuid);
    if (!parent) throw new Error("计划行动父任务不存在");
    const parentLayout = /^(\s*)[-*+] \[[ xX]\]/.exec(lines[parent.line - 1] ?? "");
    if (!parentLayout) throw new Error("父任务行结构已变化");
    indent = `${parentLayout[1]}  `;
    const parentWidth = indentationWidth(parentLayout[1]!);
    insertAt = parsed.section.end;
    for (let index = parent.line; index < parsed.section.end; index += 1) {
      const candidate = /^(\s*)[-*+] \[[ xX]\]/.exec(lines[index] ?? "");
      if (candidate && indentationWidth(candidate[1]!) <= parentWidth) {
        insertAt = index;
        break;
      }
    }
  }
  const state = input.state ?? "idea";
  const line = `${indent}- [${state === "completed" ? "x" : " "}] ${input.title} ${
    renderActionMarker(input.uuid, undefined, state, input.parentUuid, input)
  }`;
  lines.splice(insertAt, 0, line);
  return lines.join(parsed.section.eol);
}

export function removeManagedPlanAction(markdown: string, uuid: string): string {
  const parsed = parseManagedPlanActions(markdown);
  const target = parsed.actions.find((action) => action.uuid === uuid);
  if (!target) throw new Error("找不到需要删除的计划行动");
  const removed = new Set([uuid]);
  for (const action of parsed.actions) {
    if (action.parentUuid && removed.has(action.parentUuid)) removed.add(action.uuid);
  }
  const targets = parsed.actions.filter((action) => removed.has(action.uuid));
  if (targets.some((action) => action.remoteId)) {
    throw new Error("计划行动仍绑定滴答身份，当前本地模式禁止删除");
  }
  const targetLines = new Set(targets.map((action) => action.line));
  return markdown.split(/\r?\n/)
    .filter((_line, index) => !targetLines.has(index + 1))
    .join(parsed.section.eol);
}

export function patchManagedPlanAction(markdown: string, input: {
  uuid: string;
  title?: string;
  state?: ProjectionActionState;
  remoteId?: string | null;
  content?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  timeZone?: string | null;
  isAllDay?: boolean;
  priority?: 0 | 1 | 3 | 5;
  tags?: string[];
}): string {
  const parsed = parseManagedPlanActions(markdown);
  const current = parsed.actions.find((action) => action.uuid === input.uuid);
  if (!current) throw new Error("找不到需要修改的已加入同步计划行动");
  const title = input.title === undefined ? current.title : input.title;
  assertManagedActionTitle(title);
  const state = input.state ?? current.state;
  const remoteId = input.remoteId === undefined ? current.remoteId : input.remoteId || undefined;
  if (remoteId) assertStableId(remoteId, "远端任务 ID");
  const lines = markdown.split(/\r?\n/);
  const original = lines[current.line - 1] ?? "";
  const layout = /^(\s*)([-*+]) \[[ xX]\]/.exec(original);
  if (!layout) throw new Error("已加入同步的计划行动行结构已变化");
  const metadata = {
    content: input.content === undefined ? current.content : input.content || undefined,
    startDate: input.startDate === undefined ? current.startDate : input.startDate || undefined,
    dueDate: input.dueDate === undefined ? current.dueDate : input.dueDate || undefined,
    timeZone: input.timeZone === undefined ? current.timeZone : input.timeZone || undefined,
    isAllDay: input.isAllDay ?? current.isAllDay,
    priority: input.priority ?? current.priority,
    tags: input.tags ?? current.tags,
  };
  lines[current.line - 1] = `${layout[1]}${layout[2]} [${state === "completed" ? "x" : " "}] ${title} ${renderActionMarker(current.uuid, remoteId, state, current.parentUuid, metadata)}`;
  return lines.join(parsed.section.eol);
}

/** 只重排同一父任务的直接子任务行；标记与未知元数据逐字保留。 */
export function reorderManagedPlanChildren(
  markdown: string,
  parentUuid: string,
  orderedUuids: string[],
): string {
  const parsed = parseManagedPlanActions(markdown);
  const children = parsed.actions.filter((action) => action.parentUuid === parentUuid);
  const existing = new Set(children.map((child) => child.uuid));
  if (
    orderedUuids.length !== children.length ||
    new Set(orderedUuids).size !== orderedUuids.length ||
    orderedUuids.some((uuid) => !existing.has(uuid))
  ) throw new Error("子任务排序身份与当前 Markdown 不一致");
  if (children.length < 2) return markdown;
  const lines = markdown.split(/\r?\n/);
  const rawByUuid = new Map(children.map((child) => [child.uuid, lines[child.line - 1]!]));
  const childLineIndices = new Set(children.map((child) => child.line - 1));
  const insertAt = Math.min(...childLineIndices);
  const remaining = lines.filter((_line, index) => !childLineIndices.has(index));
  remaining.splice(insertAt, 0, ...orderedUuids.map((uuid) => rawByUuid.get(uuid)!));
  const next = remaining.join(parsed.section.eol);
  parseManagedPlanActions(next);
  return next;
}

export function restoreManagedPlanAction(
  markdown: string,
  action: Pick<ManagedPlanAction,
    "uuid" | "title" | "state" | "remoteId" | "parentUuid" | "content" |
    "startDate" | "dueDate" | "timeZone" | "isAllDay" | "priority" | "tags">,
): string {
  assertManagedActionTitle(action.title);
  const parsed = parseManagedPlanActions(markdown);
  if (parsed.actions.some((candidate) => candidate.uuid === action.uuid ||
    (action.remoteId && candidate.remoteId === action.remoteId))) {
    throw new Error("待恢复行动与现有同步行动身份冲突");
  }
  const lines = markdown.split(/\r?\n/);
  lines.splice(parsed.section.end, 0,
    `- [${action.state === "completed" ? "x" : " "}] ${action.title} ${renderActionMarker(action.uuid, action.remoteId, action.state, action.parentUuid, action)}`);
  return lines.join(parsed.section.eol);
}

function assertManagedActionTitle(title: string): void {
  if (!title.trim()) throw new Error("计划行动标题不能为空");
  if (title !== title.trim() || /[\r\n]/u.test(title) || title.includes("<!-- helix-dida-action:")) {
    throw new Error("计划行动标题不能有首尾空格，必须是单行文本且不能包含同步标记");
  }
}

export function readProjectProjectionIdentity(markdown: string): {
  projectId: string;
  legacyListId?: string;
  parentTaskId?: string;
} {
  const projectId = readUniqueFrontmatterScalar(markdown, "helix-id");
  if (!projectId) throw new Error("Project Markdown 缺少稳定 helix-id");
  return {
    projectId,
    legacyListId: readUniqueFrontmatterScalar(markdown, LEGACY_PROJECT_LIST_FIELD),
    parentTaskId: readUniqueFrontmatterScalar(markdown, PROJECT_PARENT_TASK_FIELD),
  };
}

export function assertProjectionStageIdentity(markdown: string, expectedStageId: string): void {
  const kind = readUniqueFrontmatterScalar(markdown, "helix-kind");
  const stageId = readUniqueFrontmatterScalar(markdown, "helix-id");
  if (kind !== "helix-stage" || stageId !== expectedStageId) {
    throw new Error("计划行动所属阶段 Markdown 身份与稳定工作区不一致");
  }
}

export function patchProjectParentTaskId(markdown: string, remoteId: string): string {
  assertStableId(remoteId, "父任务 ID");
  const identity = readProjectProjectionIdentity(markdown);
  if (identity.parentTaskId && identity.parentTaskId !== remoteId) {
    throw new Error("Project Markdown 已绑定其他父任务，禁止静默改写");
  }
  return patchFrontmatterScalar(markdown, PROJECT_PARENT_TASK_FIELD, remoteId);
}

export function buildProjectionLedger(input: {
  projectId: string;
  stageId: string;
  stagePath: string;
  parentTaskId: string;
  target: DidaProjectionTarget;
  actions: ManagedPlanAction[];
}): ProjectionLedgerEntry[] {
  const seen = new Set<string>();
  return input.actions.map((action) => {
    if (seen.has(action.uuid)) throw new Error(`同步行动 UUID 重复：${action.uuid}`);
    seen.add(action.uuid);
    return {
      uuid: action.uuid,
      projectId: input.projectId,
      stageId: input.stageId,
      stagePath: input.stagePath,
      parentTaskId: input.parentTaskId,
      targetProjectId: input.target.targetProjectId,
      targetColumnId: input.target.targetColumnId,
      remoteId: action.remoteId,
      remoteEntity: "task",
      title: action.title,
      state: action.state,
      content: action.content,
      startDate: action.startDate,
      dueDate: action.dueDate,
      timeZone: action.timeZone,
      isAllDay: action.isAllDay,
      priority: action.priority,
      tags: action.tags ? [...action.tags] : undefined,
      sourceHash: actionSourceHash(action),
    };
  });
}

export function planProjectionChanges(
  previous: ProjectionLedgerEntry[],
  current: ProjectionLedgerEntry[],
  options: { taskReopenVerified?: boolean } = {},
): ProjectionIntent[] {
  const before = uniqueLedger(previous);
  const after = uniqueLedger(current);
  const intents: ProjectionIntent[] = [];
  for (const [uuid, entry] of after) {
    if (entry.frozen) continue;
    const old = before.get(uuid);
    if (!old) {
      intents.push({ kind: entry.remoteId ? "recover-action" : "create-action", entry });
      continue;
    }
    if (!sameProjectionIdentity(old, entry)) {
      intents.push({ kind: "freeze-action", entry: { ...entry, frozen: "identity-mismatch" }, reason: "identity-mismatch" });
      continue;
    }
    if (old.frozen) continue;
    if (old.tombstone) {
      intents.push({ kind: "reconcile-delete", entry: old });
      continue;
    }
    if (!entry.remoteId && old.remoteId) entry.remoteId = old.remoteId;
    const writeFields: ProjectionTaskWriteField[] = [];
    if (old.title !== entry.title) writeFields.push("title");
    let statusIntent: "complete-action" | "reopen-action" | undefined;
    if (old.state === "completed" && entry.state !== "completed") {
      if (!options.taskReopenVerified) {
        intents.push({ kind: "freeze-action", entry: { ...entry, frozen: "capability" }, reason: "capability" });
        continue;
      }
      statusIntent = "reopen-action";
    }
    if (old.state !== "completed" && entry.state === "completed") statusIntent = "complete-action";
    if (old.content !== entry.content) writeFields.push("desc");
    if (old.startDate !== entry.startDate) writeFields.push("startDate");
    if (old.dueDate !== entry.dueDate) writeFields.push("dueDate");
    if (old.timeZone !== entry.timeZone) writeFields.push("timeZone");
    if (old.isAllDay !== entry.isAllDay) writeFields.push("isAllDay");
    if (old.priority !== entry.priority) writeFields.push("priority");
    if (stableHash(old.tags) !== stableHash(entry.tags)) writeFields.push("tags");
    if (writeFields.length > 0) {
      // 滴答完成／重开不是普通字段更新。先以旧状态写其他属性，再用专用端点
      // 改状态，避免把 status=2 混入 update payload 后得到“成功但未完成”。
      intents.push({
        kind: "update-action",
        entry: statusIntent ? { ...entry, state: old.state } : entry,
        writeFields,
      });
    }
    if (statusIntent) intents.push({ kind: statusIntent, entry });
  }
  for (const [uuid, old] of before) {
    if (after.has(uuid) || old.frozen) continue;
    intents.push(old.tombstone
      ? { kind: "reconcile-delete", entry: old }
      : { kind: "delete-action", entry: { ...old, tombstone: true } });
  }
  return intents;
}

export function verifyProjectedTask(
  task: DidaTask,
  entry: ProjectionLedgerEntry,
  _marker: string,
  options: { title?: boolean; state?: boolean; attributes?: boolean; column?: boolean } = {},
): void {
  const verifyTitle = options.title ?? true;
  const verifyState = options.state ?? true;
  const verifyAttributes = options.attributes ?? true;
  const attributeFailures = verifyAttributes ? projectionTaskAttributeMismatches(task, entry) : [];
  const checks = {
    remoteId: Boolean(entry.remoteId) && task.id === entry.remoteId,
    projectId: task.projectId === entry.targetProjectId,
    parentId: task.parentId === entry.parentTaskId,
    columnId: options.column === false || entry.targetColumnId === PROJECTION_NO_COLUMN_ID ||
      task.columnId === entry.targetColumnId,
    marker: task.content === undefined || task.content === "",
    title: !verifyTitle || task.title === entry.title,
    state: !verifyState || (entry.state === "completed" ? task.status === 2 : task.status !== 2),
    attributes: attributeFailures.length === 0,
  };
  const failed = Object.entries(checks).filter(([, valid]) => !valid).map(([field]) => field)
    .flatMap((field) => field === "attributes" ? attributeFailures.map((item) => `attributes.${item}`) : [field]);
  if (failed.length > 0) {
    throw new Error(`滴答项目同步任务复读不一致：${failed.join("、")}`);
  }
}

function projectionTaskAttributeMismatches(task: DidaTask, entry: ProjectionLedgerEntry): string[] {
  const optional = (value: string | null | undefined) => value?.trim() || undefined;
  // 滴答会把标签规范化为小写；标签身份不区分大小写，但仍严格比较集合内容。
  const tags = (value: string[] | undefined) => [...new Set((value ?? [])
    .map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  // 滴答会给无日期任务补上账户默认时区；没有开始/截止时间时该字段没有业务语义，
  // 不能把服务端默认值误判为项目行动写入失败。
  const scheduleExists = Boolean(task.startDate || task.dueDate || entry.startDate || entry.dueDate);
  return [
    optional(task.desc) === optional(entry.content) ? undefined : "desc",
    sameOptionalInstant(task.startDate, entry.startDate) ? undefined : "startDate",
    sameOptionalInstant(task.dueDate, entry.dueDate) ? undefined : "dueDate",
    !scheduleExists || optional(task.timeZone) === optional(entry.timeZone) ? undefined : "timeZone",
    Boolean(task.isAllDay) === Boolean(entry.isAllDay) ? undefined : "isAllDay",
    (task.priority ?? 0) === (entry.priority ?? 0) ? undefined : "priority",
    stableHash(tags(task.tags)) === stableHash(tags(entry.tags)) ? undefined : "tags",
  ].filter((item): item is string => Boolean(item));
}

function sameOptionalInstant(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const leftTime = Date.parse(left.replace(/([+-]\d{2})(\d{2})$/u, "$1:$2"));
  const rightTime = Date.parse(right.replace(/([+-]\d{2})(\d{2})$/u, "$1:$2"));
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) &&
    Math.trunc(leftTime / 1_000) === Math.trunc(rightTime / 1_000);
}

/**
 * 核验“在末尾提交一个已持久化客户端 ID 的检查项”后的服务端结果。
 * 明确成功响应允许服务端把临时客户端 ID 替换为唯一正式 ID；既有项逐项及相对顺序不变。
 */
export function verifyClientChecklistAppendResult(
  base: DidaTask,
  desired: DidaTask,
  actual: DidaTask,
): boolean {
  const baselineItems = base.items ?? [];
  const desiredItems = desired.items ?? [];
  const actualItems = actual.items ?? [];
  const desiredNew = desiredItems.at(-1);
  if (desired.kind !== "CHECKLIST" || actual.kind !== "CHECKLIST" ||
    desiredItems.length !== baselineItems.length + 1 || !desiredNew || !isDidaChecklistClientId(desiredNew.id) ||
    baselineItems.some((item) => item.id === desiredNew.id) ||
    actualItems.length !== baselineItems.length + 1) return false;

  const { items: _desiredItems, ...desiredParent } = desired;
  const { items: _actualItems, ...actualParent } = actual;
  if (stableHash(desiredParent) !== stableHash(actualParent)) return false;

  try {
    const baselineById = new Map<string, DidaChecklistItem>();
    for (const item of baselineItems) {
      assertStableId(item.id, "既有检查项 ID");
      if (baselineById.has(item.id)) return false;
      baselineById.set(item.id, item);
    }
    const actualById = new Map<string, NonNullable<DidaTask["items"]>[number]>();
    for (const item of actualItems) {
      assertStableId(item.id, "服务端检查项 ID");
      if (actualById.has(item.id)) return false;
      actualById.set(item.id, item);
    }
    const matched = baselineItems.map((item) => {
      const expected = checklistItemSemanticHash(item);
      const candidates = actualItems.filter((candidate) => checklistItemSemanticHash(candidate) === expected);
      return candidates.length === 1 ? candidates[0] : undefined;
    });
    if (matched.some((item) => !item) || new Set(matched.map((item) => item!.id)).size !== matched.length) return false;
    const matchedIds = new Set(matched.map((item) => item!.id));
    const preservedIds = actualItems.filter((item) => matchedIds.has(item.id)).map((item) => item.id);
    if (stableHash(preservedIds) !== stableHash(matched.map((item) => item!.id))) return false;
    const added = actualItems.filter((item) => !matchedIds.has(item.id));
    if (added.length !== 1) return false;
    return Object.entries(desiredNew)
      .filter(([key, value]) => key !== "id" && value !== undefined)
      .every(([key, value]) => stableHash(value) === stableHash((added[0] as unknown as Record<string, unknown>)[key]));
  } catch {
    return false;
  }
}

function checklistItemSemanticHash(item: DidaChecklistItem): string {
  const { id: _id, ...semantic } = item;
  return stableHash(semantic);
}

export function projectionMarker(uuid: string): string {
  assertStableId(uuid, "行动 UUID");
  return `helix-projection:${uuid}`;
}

function readinessBlockers(value: ProjectionReadiness, project: DidaProject): string[] {
  return [
    !value.writable ? "当前处于只读或恢复模式" : undefined,
    !value.queueEmpty ? "现有任务队列非空" : undefined,
    !value.authorizationCurrent ? "滴答授权合同缺失或过期" : undefined,
    !value.taskParentingVerified ? "真实子任务父子关系尚未验证" : undefined,
    value.unknownOutcomes > 0 ? "仍有远端结果未知对象" : undefined,
    project.permission && project.permission !== "write" ? "目标清单没有写权限" : undefined,
  ].filter((item): item is string => Boolean(item));
}

function exactHeadingSection(lines: string[], title: string, level: number): { start: number; end: number } {
  const matches: number[] = [];
  let fence: { char: "`" | "~"; length: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = /^( {0,3})(`{3,}|~{3,})/.exec(line)?.[2];
    if (marker) {
      const char = marker[0] as "`" | "~";
      if (!fence) fence = { char, length: marker.length };
      else if (char === fence.char && marker.length >= fence.length && new RegExp(`^ {0,3}${char === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^( {0,3})(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && heading[2]!.length === level && heading[3] === title) matches.push(index);
  }
  if (matches.length !== 1) throw new Error(matches.length === 0 ? `缺少 # ${title}` : `# ${title} 重复`);
  const start = matches[0]!;
  fence = undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = /^( {0,3})(`{3,}|~{3,})/.exec(line)?.[2];
    if (marker) {
      const char = marker[0] as "`" | "~";
      if (!fence) fence = { char, length: marker.length };
      else if (char === fence.char && marker.length >= fence.length && new RegExp(`^ {0,3}${char === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) fence = undefined;
      continue;
    }
    if (!fence && /^( {0,3})#\s+/.test(line)) return { start, end: index };
  }
  return { start, end: lines.length };
}

function readUniqueFrontmatterScalar(markdown: string, key: string): string | undefined {
  const block = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1];
  if (block === undefined) throw new Error("文件没有可识别的 YAML frontmatter");
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const values = [...block.matchAll(new RegExp(`^${escaped}\\s*:\\s*(.*?)\\s*$`, "gm"))];
  if (values.length > 1) throw new Error(`Helix 同步属性重复：${key}`);
  if (values.length === 0) return undefined;
  const raw = values[0]![1]!.trim();
  if (!raw || raw === "null") return undefined;
  if (raw.startsWith('"')) {
    try { return String(JSON.parse(raw)); } catch { throw new Error(`Helix 同步属性无效：${key}`); }
  }
  return raw;
}

function patchFrontmatterScalar(markdown: string, key: string, value: string): string {
  const match = /^((?:\uFEFF)?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(markdown);
  if (!match) throw new Error("文件没有可识别的 YAML frontmatter");
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = match[2]!.split(/\r?\n/);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const indices = lines.flatMap((line, index) => new RegExp(`^${escaped}\\s*:`).test(line) ? [index] : []);
  if (indices.length > 1) throw new Error(`Helix 同步属性重复：${key}`);
  const rendered = `${key}: ${JSON.stringify(value)}`;
  if (indices.length === 1) lines[indices[0]!] = rendered;
  else lines.push(rendered);
  return `${match[1]}${lines.join(eol)}${match[3]}${markdown.slice(match[0].length)}`;
}

function renderActionMarker(
  uuid: string,
  remoteId: string | undefined,
  state: ProjectionActionState,
  parentUuid?: string,
  metadata: Pick<ManagedPlanAction,
    "content" | "startDate" | "dueDate" | "timeZone" | "isAllDay" | "priority" | "tags"> = {},
): string {
  const hasMetadata = Boolean(
    metadata.content || metadata.startDate || metadata.dueDate || metadata.timeZone ||
    metadata.isAllDay || metadata.priority || metadata.tags?.length,
  );
  if (hasMetadata) {
    return `<!-- helix-dida-action:v3 uuid=${encodeURIComponent(uuid)} parent=${parentUuid ? encodeURIComponent(parentUuid) : "-"} remoteId=${remoteId ? encodeURIComponent(remoteId) : "-"} state=${state} priority=${metadata.priority ?? 0} start=${encodeMarkerOptional(metadata.startDate)} due=${encodeMarkerOptional(metadata.dueDate)} zone=${encodeMarkerOptional(metadata.timeZone)} allDay=${metadata.isAllDay ? 1 : 0} tags=${encodeMarkerOptional(metadata.tags?.length ? JSON.stringify(metadata.tags) : undefined)} note=${encodeMarkerOptional(metadata.content)} -->`;
  }
  if (parentUuid) {
    return `<!-- helix-dida-action:v2 uuid=${encodeURIComponent(uuid)} parent=${encodeURIComponent(parentUuid)} remoteId=${remoteId ? encodeURIComponent(remoteId) : "-"} state=${state} -->`;
  }
  return `<!-- helix-dida-action:v1 uuid=${encodeURIComponent(uuid)} remoteId=${remoteId ? encodeURIComponent(remoteId) : "-"} state=${state} -->`;
}

function parseActionMarker(marker: string): {
  uuid: string;
  parentUuid?: string;
  remoteId?: string;
  state: ProjectionActionState;
  content?: string;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  isAllDay?: boolean;
  priority?: 0 | 1 | 3 | 5;
  tags?: string[];
} | null {
  const v3 = ACTION_MARKER_V3.exec(marker);
  if (v3) {
    const parentUuid = decodeMarkerOptional(v3[2]!, "父任务 UUID");
    const remoteId = decodeMarkerOptional(v3[3]!, "远端任务 ID");
    const startDate = decodeMarkerOptional(v3[6]!, "开始时间");
    const dueDate = decodeMarkerOptional(v3[7]!, "截止时间");
    const timeZone = decodeMarkerOptional(v3[8]!, "时区");
    const tagsText = decodeMarkerOptional(v3[10]!, "标签");
    const content = decodeMarkerOptional(v3[11]!, "备注");
    if (startDate && !Number.isFinite(Date.parse(startDate))) throw new Error("开始时间无效");
    if (dueDate && !Number.isFinite(Date.parse(dueDate))) throw new Error("截止时间无效");
    let tags: string[] | undefined;
    if (tagsText) {
      try {
        const parsed = JSON.parse(tagsText);
        if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string" || !tag.trim())) throw new Error();
        tags = [...new Set(parsed.map((tag) => tag.trim()))];
      } catch {
        throw new Error("标签编码无效");
      }
    }
    return {
      uuid: decodeMarkerValue(v3[1]!, "行动 UUID"),
      ...(parentUuid ? { parentUuid } : {}),
      ...(remoteId ? { remoteId } : {}),
      state: v3[4] as ProjectionActionState,
      ...(Number(v3[5]) === 0 ? {} : { priority: Number(v3[5]) as 1 | 3 | 5 }),
      ...(startDate ? { startDate } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(timeZone ? { timeZone } : {}),
      ...(v3[9] === "1" ? { isAllDay: true } : {}),
      ...(tags?.length ? { tags } : {}),
      ...(content ? { content } : {}),
    };
  }
  const v2 = ACTION_MARKER_V2.exec(marker);
  if (v2) {
    const parentUuid = v2[2] === "-" ? undefined : decodeMarkerValue(v2[2]!, "父任务 UUID");
    return {
      uuid: decodeMarkerValue(v2[1]!, "行动 UUID"),
      ...(parentUuid ? { parentUuid } : {}),
      ...(v2[3] === "-" ? {} : { remoteId: decodeMarkerValue(v2[3]!, "远端任务 ID") }),
      state: v2[4] as ProjectionActionState,
    };
  }
  const v1 = ACTION_MARKER_V1.exec(marker);
  if (!v1) return null;
  return {
    uuid: decodeMarkerValue(v1[1]!, "行动 UUID"),
    ...(v1[2] === "-" ? {} : { remoteId: decodeMarkerValue(v1[2]!, "远端任务 ID") }),
    state: v1[3] as ProjectionActionState,
  };
}

function encodeMarkerOptional(value: string | undefined): string {
  return value ? encodeURIComponent(value) : "-";
}

function decodeMarkerOptional(value: string, label: string): string | undefined {
  return value === "-" ? undefined : decodeMarkerValue(value, label);
}

function indentationWidth(value: string): number {
  return [...value].reduce((width, char) => width + (char === "\t" ? 4 : 1), 0);
}

function decodeMarkerValue(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (encodeURIComponent(decoded) !== value) throw new Error();
    return decoded;
  } catch { throw new Error(`${label}编码无效`); }
}

function actionSourceHash(action: ManagedPlanAction): string {
  const { line: _line, ...source } = action;
  return stableHash(source);
}

function uniqueLedger(entries: ProjectionLedgerEntry[]): Map<string, ProjectionLedgerEntry> {
  const map = new Map<string, ProjectionLedgerEntry>();
  for (const entry of entries) {
    if (map.has(entry.uuid)) throw new Error(`同步账本 UUID 重复：${entry.uuid}`);
    map.set(entry.uuid, { ...entry });
  }
  return map;
}

function sameProjectionIdentity(left: ProjectionLedgerEntry, right: ProjectionLedgerEntry): boolean {
  return left.projectId === right.projectId && left.stageId === right.stageId &&
    left.parentTaskId === right.parentTaskId && left.targetProjectId === right.targetProjectId &&
    left.targetColumnId === right.targetColumnId && left.remoteEntity === right.remoteEntity &&
    (!left.remoteId || !right.remoteId || left.remoteId === right.remoteId);
}

export function assertStableId(value: string, label: string): void {
  if (!value || value !== value.trim() || /[\r\n]/.test(value) || value.length > 512) throw new Error(`${label}无效`);
}
