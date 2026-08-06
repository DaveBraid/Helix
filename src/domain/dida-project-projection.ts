import type { DidaColumn, DidaProject, DidaTask } from "./entities";
import { stableHash } from "./stable";

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
  parentTaskVerified: boolean;
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
  parentTaskId: string;
  targetProjectId: string;
  targetColumnId: string;
  remoteId?: string;
  title: string;
  state: ProjectionActionState;
  sourceHash: string;
  tombstone?: boolean;
  frozen?: ProjectionFreezeReason;
  operationId?: string;
  conflictId?: string;
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
  | { kind: "update-action"; entry: ProjectionLedgerEntry; writeFields: Array<"title" | "status"> }
  | { kind: "complete-action"; entry: ProjectionLedgerEntry }
  | { kind: "reopen-action"; entry: ProjectionLedgerEntry }
  | { kind: "delete-action"; entry: ProjectionLedgerEntry };

const ACTION_MARKER = /^<!-- helix-dida-action:v1 uuid=([^ ]+) remoteId=([^ ]+) state=(idea|active|completed|paused|terminated) -->$/;
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
  const matchingColumns = input.columns.filter((item) => item.id === input.target.targetColumnId);
  if (matchingProjects.length !== 1) throw new Error("目标滴答清单身份缺失或重复");
  if (matchingColumns.length !== 1 || matchingColumns[0]!.projectId !== input.target.targetProjectId) {
    throw new Error("目标看板分栏身份或归属不一致");
  }
  const project = matchingProjects[0]!;
  const column = matchingColumns[0]!;
  const blockers = readinessBlockers(input.readiness, project);
  const stable = {
    target: input.target,
    projectName: project.name,
    columnName: column.name,
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
      unmanagedChecklistLines.push(index + 1);
      continue;
    }
    const markerText = line.slice(markerStart).trim();
    const marker = ACTION_MARKER.exec(markerText);
    if (!marker) throw new Error(`计划行动同步标记损坏：第 ${index + 1} 行`);
    const uuid = decodeMarkerValue(marker[1]!, "行动 UUID");
    const remote = marker[2] === "-" ? undefined : decodeMarkerValue(marker[2]!, "远端任务 ID");
    const state = marker[3] as ProjectionActionState;
    assertStableId(uuid, "行动 UUID");
    if (uuids.has(uuid)) throw new Error(`计划行动 UUID 重复：${uuid}`);
    if (remote && remoteIds.has(remote)) throw new Error(`计划行动远端 ID 重复：${remote}`);
    uuids.add(uuid);
    if (remote) remoteIds.add(remote);
    const rawTitle = line.slice(0, markerStart).replace(/^\s*[-*+] \[[ xX]\]\s*/, "").trim();
    if (!rawTitle) throw new Error(`已加入同步的计划行动标题为空：第 ${index + 1} 行`);
    const checked = checkbox[2]!.toLowerCase() === "x";
    if (checked !== (state === "completed")) {
      throw new Error(`计划行动勾选状态与同步状态不一致：第 ${index + 1} 行`);
    }
    actions.push({ uuid, title: rawTitle, state, remoteId: remote, line: index + 1 });
  }
  return { actions, unmanagedChecklistLines, section: { ...section, eol } };
}

export function adoptPlanAction(markdown: string, lineNumber: number, uuid: string): string {
  assertStableId(uuid, "行动 UUID");
  const parsed = parseManagedPlanActions(markdown);
  if (!parsed.unmanagedChecklistLines.includes(lineNumber)) throw new Error("只能将计划行动中尚未加入同步的清单项加入同步");
  if (parsed.actions.some((action) => action.uuid === uuid)) throw new Error("行动 UUID 已存在");
  const lines = markdown.split(/\r?\n/);
  const index = lineNumber - 1;
  const checkbox = CHECKBOX.exec(lines[index] ?? "");
  if (!checkbox) throw new Error("目标行已变化，请重新预览");
  const state: ProjectionActionState = checkbox[2]!.toLowerCase() === "x" ? "completed" : "active";
  lines[index] = `${lines[index]!.trimEnd()} ${renderActionMarker(uuid, undefined, state)}`;
  return lines.join(parsed.section.eol);
}

export function patchManagedPlanAction(markdown: string, input: {
  uuid: string;
  title?: string;
  state?: ProjectionActionState;
  remoteId?: string | null;
}): string {
  const parsed = parseManagedPlanActions(markdown);
  const current = parsed.actions.find((action) => action.uuid === input.uuid);
  if (!current) throw new Error("找不到需要修改的已加入同步计划行动");
  const title = input.title === undefined ? current.title : input.title.trim();
  if (!title) throw new Error("计划行动标题不能为空");
  const state = input.state ?? current.state;
  const remoteId = input.remoteId === undefined ? current.remoteId : input.remoteId || undefined;
  if (remoteId) assertStableId(remoteId, "远端任务 ID");
  const lines = markdown.split(/\r?\n/);
  const original = lines[current.line - 1] ?? "";
  const layout = /^(\s*)([-*+]) \[[ xX]\]/.exec(original);
  if (!layout) throw new Error("已加入同步的计划行动行结构已变化");
  lines[current.line - 1] = `${layout[1]}${layout[2]} [${state === "completed" ? "x" : " "}] ${title} ${renderActionMarker(current.uuid, remoteId, state)}`;
  return lines.join(parsed.section.eol);
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
      parentTaskId: input.parentTaskId,
      targetProjectId: input.target.targetProjectId,
      targetColumnId: input.target.targetColumnId,
      remoteId: action.remoteId,
      title: action.title,
      state: action.state,
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
    const writeFields: Array<"title" | "status"> = [];
    if (old.title !== entry.title) writeFields.push("title");
    if (old.state === "completed" && entry.state !== "completed") {
      intents.push(options.taskReopenVerified
        ? { kind: "reopen-action", entry }
        : { kind: "freeze-action", entry: { ...entry, frozen: "capability" }, reason: "capability" });
      continue;
    }
    if (writeFields.length > 0) intents.push({ kind: "update-action", entry, writeFields });
    if (old.state !== "completed" && entry.state === "completed") intents.push({ kind: "complete-action", entry });
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
  marker: string,
  options: { title?: boolean; state?: boolean } = {},
): void {
  const verifyTitle = options.title ?? true;
  const verifyState = options.state ?? true;
  if (!entry.remoteId || task.id !== entry.remoteId || task.projectId !== entry.targetProjectId ||
    task.parentId !== entry.parentTaskId || task.columnId !== entry.targetColumnId ||
    task.content !== marker || (verifyTitle && task.title !== entry.title) ||
    (verifyState && (entry.state === "completed" ? task.status !== 2 : task.status === 2))) {
    throw new Error("远端任务身份、父级、清单、分栏、标题、状态或唯一标记复读不一致");
  }
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
    !value.parentTaskVerified ? "父子任务能力尚未验证" : undefined,
    !value.boardPlacementVerified ? "看板归栏能力尚未验证" : undefined,
    !value.boardFresh ? "目标看板快照已过期" : undefined,
    value.unknownOutcomes > 0 ? "仍有远端结果未知对象" : undefined,
    project.permission && project.permission !== "write" ? "目标清单没有写权限" : undefined,
    project.viewMode !== "kanban" ? "目标清单当前不是看板视图" : undefined,
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

function renderActionMarker(uuid: string, remoteId: string | undefined, state: ProjectionActionState): string {
  return `<!-- helix-dida-action:v1 uuid=${encodeURIComponent(uuid)} remoteId=${remoteId ? encodeURIComponent(remoteId) : "-"} state=${state} -->`;
}

function decodeMarkerValue(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (encodeURIComponent(decoded) !== value) throw new Error();
    return decoded;
  } catch { throw new Error(`${label}编码无效`); }
}

function actionSourceHash(action: Pick<ManagedPlanAction, "uuid" | "title" | "state" | "remoteId">): string {
  return stableHash({ uuid: action.uuid, title: action.title, state: action.state, remoteId: action.remoteId });
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
    left.targetColumnId === right.targetColumnId &&
    (!left.remoteId || !right.remoteId || left.remoteId === right.remoteId);
}

function assertStableId(value: string, label: string): void {
  if (!value || value !== value.trim() || /[\r\n]/.test(value) || value.length > 512) throw new Error(`${label}无效`);
}
