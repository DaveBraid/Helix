import { describe, expect, it } from "vitest";
import type { DidaChecklistItem, DidaColumn, DidaProject, DidaTask } from "../src/domain/entities";
import { stableHash } from "../src/domain/stable";
import {
  adoptPlanAction,
  adoptAllPlanActions,
  appendManagedPlanAction,
  assertProjectionActivation,
  buildProjectionActivationPreview,
  buildProjectionLedger,
  parseManagedPlanActions,
  patchManagedPlanAction,
  removeManagedPlanAction,
  reconcileLocalPlanActionCheckboxes,
  patchProjectParentTaskId,
  planProjectionChanges,
  projectionMarker,
  readProjectProjectionIdentity,
  verifyProjectedTask,
  verifyClientChecklistAppendResult,
  PROJECTION_ACTION_EDITABLE_STATES,
  type ProjectionLedgerEntry,
  type ProjectionReadiness,
} from "../src/domain/dida-project-projection";
import {
  DidaProjectProjectionService,
  ExistingHelixTaskPipelineAdapter,
  PersistedProjectionDiagnosticsPort,
  PersistedProjectionStatePort,
  actionCreateClientIdentity,
  parentCreateClientIdentity,
  type ProjectionCatalogPort,
  type ProjectionDiagnosticsPort,
  type ProjectionOperationDiagnostic,
  type ProjectionMarkdownPort,
  type ProjectionMarkdownRevision,
  type ProjectionPersistentState,
  type ProjectionStatePort,
  type ProjectionTaskPipeline,
  type ProjectionWriteReceipt,
  type ExistingHelixTaskQueuePort,
} from "../src/services/dida-project-projection";
import { HelixDataStore } from "../src/storage/data-store";
import { createDefaultData } from "../src/storage/model";
import { createSnapshot } from "../src/sync/snapshots";

const project: DidaProject = { id: "list-1", name: "科研", viewMode: "kanban", permission: "write" };
const column: DidaColumn = { id: "column-1", projectId: "list-1", name: "Helix项目" };
const ready: ProjectionReadiness = {
  writable: true,
  queueEmpty: true,
  authorizationCurrent: true,
  taskParentingVerified: true,
  itemsRoundTripVerified: true, itemIdStableVerified: true,
  boardPlacementVerified: true,
  boardFresh: true,
  taskReopenVerified: false,
  unknownOutcomes: 0,
};

function stage(body = "- [ ] 未受管"): string {
  return `---\nhelix-kind: helix-stage\nhelix-id: stage-1\n---\n\n# 本阶段问题聚焦\n\n# 计划行动\n\n${body}\n\n# 行动结果\n用户正文\n`;
}

function projectMarkdown(eol = "\n"): string {
  return [
    "---",
    "helix-kind: helix-project",
    "helix-id: project-1",
    "helix-dida-project-id: legacy-list",
    "unknown: keep",
    "---",
    "# 项目",
    "用户正文",
    "",
  ].join(eol);
}

describe("Dida project projection domain", () => {
  it("builds an exact target preview without selecting by name", () => {
    expect(actionCreateClientIdentity({ projectId: "p:1", stageId: "s/1", uuid: "u 1" }))
      .toBe("helix-action:p%3A1:s%2F1:u%201");
    expect(parentCreateClientIdentity("p:1")).toBe("helix-parent:p%3A1");
    const preview = buildProjectionActivationPreview({
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      projects: [project, { ...project, id: "list-2" }],
      columns: [column],
      readiness: ready,
      projectCount: 2,
      actionCount: 5,
    });
    expect(preview).toMatchObject({ projectName: "科研", columnName: "Helix项目", blockers: [], createsColumn: false });
    expect(() => assertProjectionActivation(preview, preview.previewHash)).not.toThrow();
    const serverAssignedIds = buildProjectionActivationPreview({
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      projects: [project],
      columns: [column],
      readiness: { ...ready, itemIdStableVerified: false },
      projectCount: 2,
      actionCount: 5,
    });
    expect(serverAssignedIds.blockers).toEqual([]);
    expect(() => assertProjectionActivation(serverAssignedIds, serverAssignedIds.previewHash)).not.toThrow();
    expect(() => assertProjectionActivation(preview, "stale")).toThrow(/预览已变化/);
  });

  it("reports every activation blocker and rejects a foreign column", () => {
    const preview = buildProjectionActivationPreview({
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      projects: [{ ...project, permission: "read", viewMode: "list" }],
      columns: [column],
      readiness: { ...ready, queueEmpty: false, authorizationCurrent: false, unknownOutcomes: 1 },
      projectCount: 1,
      actionCount: 0,
    });
    expect(preview.blockers.join(" ")).toMatch(/队列非空.*授权合同.*结果未知.*没有写权限.*不是看板/);
    expect(() => buildProjectionActivationPreview({
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      projects: [project], columns: [{ ...column, projectId: "other" }], readiness: ready, projectCount: 1, actionCount: 0,
    })).toThrow(/归属不一致/);
  });

  it("leaves unknown checklist items byte-equivalent until explicit adoption", () => {
    expect(PROJECTION_ACTION_EDITABLE_STATES).toEqual(["idea", "active", "completed", "paused", "terminated"]);
    const source = stage("- 普通列表\n- [ ] 用户未知项\n- [x] 已做但未受管");
    const parsed = parseManagedPlanActions(source);
    expect(parsed.actions).toEqual([]);
    expect(parsed.unmanagedChecklistLines).toHaveLength(2);
    expect(source).not.toContain("helix-dida-action");
    const adopted = adoptPlanAction(source, parsed.unmanagedChecklistLines[0]!, "uuid-1");
    expect(adopted).toContain("- 普通列表\n- [ ] 用户未知项 <!-- helix-dida-action:v1 uuid=uuid-1 remoteId=- state=active -->");
  });

  it("parses, edits and roundtrips a managed action", () => {
    const adopted = adoptPlanAction(stage("- [ ] 写论文"), 10, "uuid-1");
    const patched = patchManagedPlanAction(adopted, { uuid: "uuid-1", title: "修改论文", remoteId: "task-1", state: "completed" });
    expect(parseManagedPlanActions(patched).actions).toEqual([{
      uuid: "uuid-1", title: "修改论文", remoteId: "task-1", state: "completed", line: 10,
    }]);
    expect(patched).toContain("- [x] 修改论文");
    expect(() => patchManagedPlanAction(adopted, { uuid: "uuid-1", title: " 修改论文 " }))
      .toThrow(/首尾空格/);
  });

  it("preserves the managed action indentation and bullet style", () => {
    const adopted = adoptPlanAction(stage("  * [ ] 缩进行动"), 10, "uuid-layout");
    const patched = patchManagedPlanAction(adopted, { uuid: "uuid-layout", title: "保留结构" });
    expect(patched).toContain("  * [ ] 保留结构 <!-- helix-dida-action:v1");
  });

  it("silently adopts valid native actions, preserves the empty template row and records hierarchy", () => {
    let sequence = 0;
    const source = stage("- [ ] 根任务\n  - [ ] 子任务\n- [ ]\n- 普通列表");
    const adopted = adoptAllPlanActions(source, () => `uuid-${++sequence}`);
    expect(parseManagedPlanActions(adopted).actions).toEqual([
      { uuid: "uuid-1", title: "根任务", state: "idea", line: 10 },
      { uuid: "uuid-2", parentUuid: "uuid-1", title: "子任务", state: "idea", line: 11 },
    ]);
    expect(adopted).toContain("- [ ]\n- 普通列表");
    expect(adoptAllPlanActions(adopted, () => "unexpected")).toBe(adopted);
  });

  it("appends and removes a parent task subtree without touching unrelated Markdown", () => {
    const root = appendManagedPlanAction(stage("用户正文"), {
      uuid: "root-task",
      title: "根任务",
      state: "idea",
    });
    const child = appendManagedPlanAction(root, {
      uuid: "child-task",
      title: "子任务",
      state: "active",
      parentUuid: "root-task",
    });
    const sibling = appendManagedPlanAction(child, {
      uuid: "sibling-task",
      title: "同级任务",
      state: "active",
    });
    expect(parseManagedPlanActions(sibling).actions).toEqual([
      { uuid: "root-task", title: "根任务", state: "idea", line: 12 },
      { uuid: "child-task", parentUuid: "root-task", title: "子任务", state: "active", line: 13 },
      { uuid: "sibling-task", title: "同级任务", state: "active", line: 14 },
    ]);
    const removed = removeManagedPlanAction(sibling, "root-task");
    expect(removed).toContain("用户正文");
    expect(parseManagedPlanActions(removed).actions).toEqual([
      { uuid: "sibling-task", title: "同级任务", state: "active", line: 12 },
    ]);
  });

  it("rejects a child marker whose parent is missing or ordered after it", () => {
    expect(() => parseManagedPlanActions(stage(
      "  - [ ] 子任务 <!-- helix-dida-action:v2 uuid=child parent=missing remoteId=- state=active -->",
    ))).toThrow(/父任务必须位于子任务之前/);
  });

  it("accepts native checkbox completion for local tasks but never rewrites a remote-bound item", () => {
    const local = adoptPlanAction(stage("- [ ] 本地任务"), 10, "local-task");
    const checked = local.replace("- [ ] 本地任务", "- [x] 本地任务");
    const reconciled = reconcileLocalPlanActionCheckboxes(checked);
    expect(parseManagedPlanActions(reconciled).actions[0]?.state).toBe("completed");
    const reopened = reconcileLocalPlanActionCheckboxes(reconciled.replace("- [x]", "- [ ]"));
    expect(parseManagedPlanActions(reopened).actions[0]?.state).toBe("idea");

    const remote = patchManagedPlanAction(local, { uuid: "local-task", remoteId: "remote-task" });
    const remoteChecked = remote.replace("- [ ] 本地任务", "- [x] 本地任务");
    expect(reconcileLocalPlanActionCheckboxes(remoteChecked)).toBe(remoteChecked);
    expect(() => parseManagedPlanActions(remoteChecked)).toThrow(/勾选状态/);
  });

  it("roundtrips local editor metadata in the hidden action marker", () => {
    const adopted = adoptPlanAction(stage("- [ ] 元数据任务"), 10, "meta-task");
    const updated = patchManagedPlanAction(adopted, {
      uuid: "meta-task",
      content: "两行备注\n第二行",
      startDate: "2026-08-10T01:00:00.000Z",
      dueDate: "2026-08-10T02:00:00.000Z",
      timeZone: "Asia/Shanghai",
      isAllDay: false,
      priority: 5,
      tags: ["科研", "阶段 验收"],
    });
    expect(updated).toContain("helix-dida-action:v3");
    expect(parseManagedPlanActions(updated).actions[0]).toMatchObject({
      uuid: "meta-task",
      content: "两行备注\n第二行",
      startDate: "2026-08-10T01:00:00.000Z",
      dueDate: "2026-08-10T02:00:00.000Z",
      timeZone: "Asia/Shanghai",
      priority: 5,
      tags: ["科研", "阶段 验收"],
    });
    const checked = reconcileLocalPlanActionCheckboxes(updated.replace("- [ ]", "- [x]"));
    expect(parseManagedPlanActions(checked).actions[0]).toMatchObject({
      state: "completed",
      content: "两行备注\n第二行",
      priority: 5,
    });
  });

  it("ignores headings in both fence styles and stops at the next H1", () => {
    const source = stage("```md\n# 行动结果\n- [ ] 围栏内\n```\n~~~\n- [ ] 仍在围栏\n~~~\n- [ ] 真实");
    const parsed = parseManagedPlanActions(source);
    expect(parsed.unmanagedChecklistLines).toHaveLength(1);
  });

  it("rejects missing, duplicate and wrong-level plan headings", () => {
    expect(() => parseManagedPlanActions(stage().replace("# 计划行动", "## 计划行动"))).toThrow(/缺少/);
    expect(() => parseManagedPlanActions(`${stage()}\n# 计划行动\n`)).toThrow(/重复/);
  });

  it("rejects corrupted, duplicate UUID and duplicate remote markers", () => {
    const one = "- [ ] A <!-- helix-dida-action:v1 uuid=u1 remoteId=t1 state=active -->";
    expect(() => parseManagedPlanActions(stage(one.replace("state=active", "state=bogus")))).toThrow(/标记损坏/);
    expect(() => parseManagedPlanActions(stage(`${one}\n${one.replace("A", "B").replace("t1", "t2")}`))).toThrow(/UUID 重复/);
    expect(() => parseManagedPlanActions(stage(`${one}\n${one.replace("A", "B").replace("u1", "u2")}`))).toThrow(/远端 ID 重复/);
  });

  it("rejects checkbox-state disagreement and empty managed titles", () => {
    expect(() => parseManagedPlanActions(stage("- [x] A <!-- helix-dida-action:v1 uuid=u1 remoteId=- state=active -->"))).toThrow(/勾选状态/);
    expect(() => parseManagedPlanActions(stage("- [ ]  <!-- helix-dida-action:v1 uuid=u1 remoteId=- state=active -->"))).toThrow();
  });

  it("stores the parent task in an independent field while preserving the legacy mapping and CRLF", () => {
    const source = projectMarkdown("\r\n");
    const patched = patchProjectParentTaskId(source, "parent-1");
    expect(readProjectProjectionIdentity(patched)).toEqual({ projectId: "project-1", legacyListId: "legacy-list", parentTaskId: "parent-1" });
    expect(patched).toContain("unknown: keep\r\n");
    expect(patched.replace(/\r\n/g, "")).not.toContain("\n");
    expect(() => patchProjectParentTaskId(patched, "other-parent")).toThrow(/禁止静默改写/);
  });

  it("plans create, title update, completion and persistent deletion tombstone", () => {
    const base = ledger({ remoteId: "task-1", title: "旧", state: "active" });
    const changed = ledger({ remoteId: "task-1", title: "新", state: "completed" });
    expect(planProjectionChanges([base], [changed]).map((item) => item.kind))
      .toEqual(["update-action", "complete-action"]);
    expect(planProjectionChanges([base], [changed])[0]).toMatchObject({
      writeFields: ["title"],
      entry: { state: "active" },
    });
    expect(planProjectionChanges([], [ledger({ remoteId: undefined })])[0]?.kind).toBe("create-action");
    const deletion = planProjectionChanges([base], [])[0];
    expect(deletion).toMatchObject({ kind: "delete-action", entry: { tombstone: true } });
  });

  it("freezes identity competition and skips already frozen actions", () => {
    expect(planProjectionChanges([ledger({ parentTaskId: "parent-a" })], [ledger({ parentTaskId: "parent-b" })]))
      .toEqual([expect.objectContaining({ kind: "freeze-action", reason: "identity-mismatch" })]);
    expect(planProjectionChanges([ledger({ frozen: "unknown-outcome" })], [ledger({ title: "new" })])).toEqual([]);
  });

  it("verifies every remote identity field and unique marker", () => {
    const entry = ledger({ remoteId: "task-1" });
    const task: DidaTask = { id: "task-1", projectId: "list-1", parentId: "parent-1", columnId: "column-1", title: "行动", content: projectionMarker("uuid-1"), status: 0 };
    expect(() => verifyProjectedTask(task, entry, projectionMarker("uuid-1"))).not.toThrow();
    expect(() => verifyProjectedTask({ ...task, parentId: "foreign" }, entry, projectionMarker("uuid-1"))).toThrow(/复读不一致/);
  });

  it("accepts a uniquely identified server-reordered checklist append without relaxing existing items", () => {
    const ordinaryA: DidaChecklistItem = { id: "ordinary-a", title: "用户 A", status: 0, sortOrder: 20 };
    const ordinaryB: DidaChecklistItem = { id: "ordinary-b", title: "用户 B", status: 2, sortOrder: 10 };
    const base: DidaTask = { id: "task-1", projectId: "list-1", title: "项目", status: 0, kind: "CHECKLIST", items: [ordinaryA, ordinaryB] };
    const desired: DidaTask = { ...base, items: [...base.items!, { id: "1785772800000", title: "Helix 行动", status: 0, sortOrder: 21 }] };
    const created: DidaChecklistItem = { id: "1785772800000", title: "Helix 行动", status: 0, sortOrder: 21, timeZone: "Asia/Shanghai" };
    const reordered: DidaTask = { ...desired, items: [created, ordinaryA, ordinaryB] };
    const serverAssigned: DidaTask = {
      ...desired,
      items: [{ ...created, id: "server-formal-id" }, ordinaryA, ordinaryB],
    };

    expect(verifyClientChecklistAppendResult(base, desired, reordered)).toBe(true);
    expect(verifyClientChecklistAppendResult(base, desired, serverAssigned)).toBe(true);
    const duplicateA: DidaChecklistItem = { id: "dup-a", title: "重复", status: 0, sortOrder: 1 };
    const duplicateB: DidaChecklistItem = { id: "dup-b", title: "重复", status: 0, sortOrder: 1 };
    const duplicateBase: DidaTask = { ...base, items: [duplicateA, duplicateB] };
    const duplicateDesired: DidaTask = {
      ...duplicateBase,
      items: [...duplicateBase.items!, { id: "1785772800001", title: "新项", status: 0, sortOrder: 2 }],
    };
    expect(verifyClientChecklistAppendResult(duplicateBase, duplicateDesired, {
      ...duplicateDesired,
      items: [
        { ...duplicateA, id: "dup-new-a" },
        { ...duplicateB, id: "dup-new-b" },
        { id: "owned-new", title: "新项", status: 0, sortOrder: 2 },
      ],
    })).toBe(false);
    expect(verifyClientChecklistAppendResult(base, desired, {
      ...reordered,
      items: [created, ordinaryB, ordinaryA],
    })).toBe(false);
    expect(verifyClientChecklistAppendResult(base, desired, {
      ...reordered,
      items: [created, ordinaryA, { ...ordinaryB, title: "被改动" }],
    })).toBe(false);
  });
});

function ledger(overrides: Partial<ProjectionLedgerEntry> = {}): ProjectionLedgerEntry {
  return {
    uuid: "uuid-1", projectId: "project-1", stageId: "stage-1", parentTaskId: "parent-1",
    targetProjectId: "list-1", targetColumnId: "column-1", remoteId: "task-1",
    title: "行动", state: "active", sourceHash: "hash", ...overrides,
  };
}

function parentTaskWithItem(
  entry: ProjectionLedgerEntry,
  itemTitle = entry.title,
  items: DidaTask["items"] = [{ id: entry.remoteId!, title: itemTitle, status: entry.state === "completed" ? 2 : 0 }],
): DidaTask {
  return {
    id: entry.parentTaskId,
    projectId: entry.targetProjectId,
    columnId: entry.targetColumnId,
    title: "Alpha",
    content: `helix-project-projection:${entry.projectId}`,
    status: 0,
    items,
  };
}

function reconcileAction(entry: ProjectionLedgerEntry) {
  return {
    kind: "action" as const,
    projectId: entry.projectId,
    stageId: entry.stageId,
    stagePath: "Stage.md",
    uuid: entry.uuid,
  };
}

function input(overrides: Partial<{ projectTitle: string; projectStatus: "planned" | "active" | "paused" | "completed" | "terminated" }> = {}) {
  return {
    projectId: "project-1",
    projectPath: "Project.md",
    projectTitle: overrides.projectTitle ?? "Alpha",
    projectStatus: overrides.projectStatus ?? "active" as const,
    stages: [{ path: "Stage.md", stageId: "stage-1" }],
  };
}

function makeHarness(activate = false, failFirstCas = false, taskReopenVerified = false) {
  const markdown = new MemoryMarkdown({ "Project.md": projectMarkdown(), "Stage.md": adoptPlanAction(stage("- [ ] 行动"), 10, "uuid-1") });
  markdown.failNextCas = failFirstCas;
  const pipeline = new FakePipeline();
  const state = new MemoryState({ enabled: false, ledger: [], parentCheckpoints: [] });
  const catalog: ProjectionCatalogPort = {
    read: async () => ({
      projects: [project],
      columns: [column],
      readiness: { ...ready, taskReopenVerified },
    }),
  };
  const service = new DidaProjectProjectionService(markdown, pipeline, state, catalog, () => "2026-08-05T00:00:00.000Z");
  if (activate) {
    const preview = buildProjectionActivationPreview({ target: { targetProjectId: "list-1", targetColumnId: "column-1" }, projects: [project], columns: [column], readiness: ready, projectCount: 1, actionCount: 1 });
    state.value = { enabled: true, target: preview.target, confirmedPreviewHash: preview.previewHash, ledger: [], parentCheckpoints: [] };
  }
  return { markdown, pipeline, state, service };
}

class MemoryMarkdown implements ProjectionMarkdownPort {
  failNextCas = false;
  onRead?: (path: string, count: number) => void;
  private readonly readCounts = new Map<string, number>();
  constructor(private readonly files: Record<string, string>) {}
  async read(path: string): Promise<ProjectionMarkdownRevision | null> {
    const count = (this.readCounts.get(path) ?? 0) + 1;
    this.readCounts.set(path, count);
    this.onRead?.(path, count);
    const content = this.files[path];
    return content === undefined ? null : { path, content, hash: stableHash(content) };
  }
  async compareAndWrite(revision: ProjectionMarkdownRevision, content: string): Promise<ProjectionMarkdownRevision> {
    if (this.failNextCas) { this.failNextCas = false; throw new Error("CAS conflict"); }
    if (stableHash(this.files[revision.path]) !== revision.hash) throw new Error("CAS conflict");
    this.files[revision.path] = content;
    return { path: revision.path, content, hash: stableHash(content) };
  }
  content(path: string) { return this.files[path]!; }
  set(path: string, content: string) { this.files[path] = content; }
}

class MemoryState implements ProjectionStatePort {
  failNextCas = false;
  constructor(public value: ProjectionPersistentState) {}
  async read() { return structuredClone(this.value); }
  async write(expected: ProjectionPersistentState, next: ProjectionPersistentState) {
    if (this.failNextCas) { this.failNextCas = false; throw new Error("state CAS conflict"); }
    if (stableHash(expected) !== stableHash(this.value)) throw new Error("state CAS conflict");
    this.value = structuredClone(next);
  }
}

class MemoryDiagnostics implements ProjectionDiagnosticsPort {
  blocked: boolean;
  removed: string[] = [];
  constructor(private readonly value: {
    operationId: string;
    blocked: boolean;
    resolvedTask?: DidaTask;
    receiptPresent?: boolean;
    cleanupFailures?: number;
    receiptOverride?: Partial<ProjectionOperationDiagnostic>;
  }) {
    this.blocked = value.blocked;
  }
  async list(): Promise<ProjectionOperationDiagnostic[]> {
    const inspection = await this.inspect(this.value.operationId);
    return inspection.receipt ? [inspection.receipt] : [];
  }
  async inspect(operationId: string) {
    expect(operationId).toBe(this.value.operationId);
    const resolvedIsParent = this.value.resolvedTask?.content?.startsWith("helix-project-projection:") === true;
    const conflictId = this.value.receiptOverride?.conflictId;
    return {
      blocked: this.blocked,
      resolvedTask: this.value.resolvedTask,
      receipt: this.value.receiptPresent === false ? undefined : {
        clientIdentity: "test-client",
        projectId: this.value.resolvedTask?.projectId ?? "list-1",
        operationId,
        marker: this.value.resolvedTask?.content ?? "helix-project-projection:project-1",
        outcome: "unknown" as const,
        remoteTaskId: this.value.resolvedTask?.id ?? (resolvedIsParent ? undefined : "parent-1"),
        ...this.value.receiptOverride,
      },
      resolutionAudit: conflictId && this.value.resolvedTask ? {
        id: `audit-${conflictId}`,
        conflictId,
        entityId: this.value.resolvedTask.id,
        kind: "task" as const,
        resolvedAt: "2026-08-05T00:00:00.000Z",
        sourceDeviceId: "test-device",
        choices: {},
        remoteBeforeHash: stableHash(this.value.resolvedTask),
        remoteAfterHash: stableHash(this.value.resolvedTask),
      } : undefined,
    };
  }
  async removeResolved(operationId: string) { this.removed.push(operationId); }
  async removeReconciled(operationId: string) {
    if ((this.value.cleanupFailures ?? 0) > 0) {
      this.value.cleanupFailures = (this.value.cleanupFailures ?? 0) - 1;
      throw new Error("cleanup failed");
    }
    this.removed.push(operationId);
    this.value.receiptPresent = false;
  }
}

function projectionServiceWithDiagnostics(
  state: MemoryState,
  pipeline: FakePipeline,
  diagnostics: ProjectionDiagnosticsPort,
): DidaProjectProjectionService {
  return projectionHarnessWithDiagnostics(state, pipeline, diagnostics).service;
}

function projectionHarnessWithDiagnostics(
  state: MemoryState,
  pipeline: FakePipeline,
  diagnostics: ProjectionDiagnosticsPort,
): { service: DidaProjectProjectionService; markdown: MemoryMarkdown } {
  const entry = state.value.ledger[0];
  const stageBody = entry && !entry.tombstone
    ? `- [${entry.state === "completed" ? "x" : " "}] ${entry.title} <!-- helix-dida-action:v1 uuid=${entry.uuid} remoteId=${entry.remoteId ?? "-"} state=${entry.state} -->`
    : "- [ ] 未受管";
  const markdown = new MemoryMarkdown({ "Project.md": projectMarkdown(), "Stage.md": stage(stageBody) });
  return { service: new DidaProjectProjectionService(
    markdown,
    pipeline,
    state,
    { read: async () => ({ projects: [project], columns: [column], readiness: ready }) },
    () => "2026-08-05T00:00:00.000Z",
    diagnostics,
  ), markdown };
}

class FakePipeline implements ProjectionTaskPipeline {
  tasks = new Map<string, DidaTask>();
  created: DidaTask[] = [];
  deleted: string[] = [];
  updated: DidaTask[] = [];
  updateAttempts: DidaTask[] = [];
  updateOperationIds: Array<string | undefined> = [];
  updateBases: Array<DidaTask | undefined> = [];
  nextResult?: ProjectionWriteReceipt;
  nextResults: ProjectionWriteReceipt[] = [];
  nextUpdateError?: Error;
  nextDeleteResult?: {
    operationId: string;
    outcome: "unknown" | "conflict" | "retryable" | "authorization" | "capability";
    message: string;
    conflictId?: string;
  };
  deleteAttempts = 0;
  beforeDelete?: () => void;
  onCreate?: (task: DidaTask) => Promise<void>;
  afterCreate?: (task: DidaTask) => void;
  onReread?: (taskId: string, count: number) => void;
  rereads = new Map<string, number>();
  receipts = new Map<string, ProjectionWriteReceipt>();
  operationSequence = 0;
  reopened = 0;
  stagedConflicts = 0;
  stagedBases: DidaTask[] = [];
  regenerateChecklistIdsEveryUpdate = false;
  stripBoardFromReceipts = false;
  async createTask(task: DidaTask, clientIdentity: string): Promise<ProjectionWriteReceipt> {
    this.created.push(structuredClone(task));
    await this.onCreate?.(task);
    if (this.nextResult) {
      const result = this.nextResult;
      this.nextResult = undefined;
      this.receipts.set(clientIdentity, result);
      return result;
    }
    const remote = { ...task, id: `remote-${this.created.length}` };
    this.tasks.set(remote.id, remote);
    const receiptTask = structuredClone(remote);
    if (this.stripBoardFromReceipts) delete receiptTask.columnId;
    const receipt: ProjectionWriteReceipt = {
      operationId: `op-${++this.operationSequence}`,
      outcome: "verified",
      task: receiptTask,
    };
    this.receipts.set(clientIdentity, receipt);
    this.afterCreate?.(structuredClone(remote));
    return receipt;
  }
  async recoverCreate(clientIdentity: string) {
    return structuredClone(this.receipts.get(clientIdentity) ?? null);
  }
  async updateTask(task: DidaTask, _writeFields?: string[], operationId?: string, freshBase?: DidaTask): Promise<ProjectionWriteReceipt> {
    this.updateOperationIds.push(operationId);
    this.updateAttempts.push(structuredClone(task));
    this.updateBases.push(structuredClone(freshBase));
    if (this.nextUpdateError) {
      const error = this.nextUpdateError;
      this.nextUpdateError = undefined;
      throw error;
    }
    const queuedResult = this.nextResults.shift() ?? this.nextResult;
    if (queuedResult?.outcome === "preflight-changed") {
      const result = queuedResult;
      if (queuedResult === this.nextResult) this.nextResult = undefined;
      this.tasks.set(result.task.id, structuredClone(result.task));
      return operationId ? { ...result, operationId } : result;
    }
    const previous = this.tasks.get(task.id);
    task = {
      ...task,
      items: task.items?.map((candidate) => {
        const item = candidate.id ? { ...candidate } : { ...candidate, id: `item-${++this.operationSequence}` };
        const before = previous?.items?.find((old) => old.id === item.id);
        if (before?.status !== 2 && item.status === 2) item.completedTime = "2026-08-05T00:00:00.000Z";
        if (before?.status === 2 && item.status !== 2) delete item.completedTime;
        return item;
      }),
    };
    if (this.regenerateChecklistIdsEveryUpdate && task.items) {
      task.items = task.items.map((item) => ({ ...item, id: `server-remap-${++this.operationSequence}` }));
    }
    this.updated.push(structuredClone(task));
    if (this.nextResult) {
      const result = this.nextResult;
      this.nextResult = undefined;
      return operationId ? { ...result, operationId } : result;
    }
    this.tasks.set(task.id, structuredClone(task));
    const receiptTask = structuredClone(task);
    if (this.stripBoardFromReceipts) delete receiptTask.columnId;
    return { operationId: operationId ?? `op-${++this.operationSequence}`, outcome: "verified", task: receiptTask };
  }
  async stageItemsConflict(_local: DidaTask, _remote: DidaTask, base: DidaTask, _operationId: string): Promise<ProjectionWriteReceipt> {
    this.stagedConflicts += 1;
    this.stagedBases.push(structuredClone(base));
    return {
      operationId: `op-items-conflict-${this.stagedConflicts}`,
      outcome: "conflict",
      message: "owned item 进入逐子字段冲突",
      conflictId: `conflict-items-${this.stagedConflicts}`,
    };
  }
  async stageTaskConflict(_local: DidaTask, _remote: DidaTask, base: DidaTask, operationId: string): Promise<ProjectionWriteReceipt> {
    this.stagedConflicts += 1;
    this.stagedBases.push(structuredClone(base));
    return {
      operationId,
      outcome: "conflict",
      message: "项目行动任务进入逐字段冲突",
      conflictId: `conflict-task-${this.stagedConflicts}`,
    };
  }
  async completeTask(task: DidaTask): Promise<ProjectionWriteReceipt> { return this.updateTask(task); }
  async reopenTask(task: DidaTask): Promise<ProjectionWriteReceipt> {
    this.reopened += 1;
    this.tasks.set(task.id, structuredClone(task));
    return { operationId: `op-${++this.operationSequence}`, outcome: "verified", task: structuredClone(task) };
  }
  async deleteTask(expected: { taskId: string; parentTaskId: string; targetProjectId: string; targetColumnId: string; marker: string }) {
    this.deleteAttempts += 1;
    this.beforeDelete?.();
    if (this.nextDeleteResult) {
      const result = this.nextDeleteResult;
      this.nextDeleteResult = undefined;
      return result;
    }
    const task = this.tasks.get(expected.taskId);
    if (!task || task.parentId !== expected.parentTaskId || task.projectId !== expected.targetProjectId || task.columnId !== expected.targetColumnId || task.content !== expected.marker) {
      return { operationId: `op-${++this.operationSequence}`, outcome: "conflict" as const, message: "identity mismatch" };
    }
    this.tasks.delete(expected.taskId);
    this.deleted.push(expected.taskId);
    return { operationId: `op-${++this.operationSequence}`, outcome: "verified-absent" as const };
  }
  async rereadTask(projectId: string, taskId: string) {
    const count = (this.rereads.get(taskId) ?? 0) + 1;
    this.rereads.set(taskId, count);
    this.onReread?.(taskId, count);
    const task = this.tasks.get(taskId);
    return task?.projectId === projectId ? structuredClone(task) : null;
  }
}

describe("DidaProjectProjectionService with real child tasks", () => {
  it("creates a project parent and one ordinary child task with stable identity", async () => {
    const harness = makeHarness(true);

    const summary = await harness.service.synchronizeProject(input());

    expect(summary).toMatchObject({ createdParents: 1, createdActions: 1, frozen: [] });
    expect(harness.pipeline.created).toHaveLength(2);
    const parent = harness.pipeline.created[0]!;
    const child = harness.pipeline.created[1]!;
    expect(parent).toMatchObject({ columnId: "column-1" });
    expect(parent).not.toHaveProperty("parentId");
    expect(child).toMatchObject({
      parentId: "remote-1",
      projectId: "list-1",
      columnId: "column-1",
      title: "行动",
      content: projectionMarker("uuid-1"),
      status: 0,
    });
    expect(child.items).toBeUndefined();
    expect(harness.markdown.content("Stage.md")).toContain("remoteId=remote-2");
    expect(harness.state.value.ledger[0]).toMatchObject({
      uuid: "uuid-1",
      remoteId: "remote-2",
      parentTaskId: "remote-1",
    });
  });

  it("uses an exact post-write reread when ordinary task receipts omit board placement", async () => {
    const harness = makeHarness(true);
    harness.pipeline.stripBoardFromReceipts = true;

    const summary = await harness.service.synchronizeProject(input());

    expect(summary).toMatchObject({ createdParents: 1, createdActions: 1, frozen: [] });
    expect(harness.state.value.ledger[0]).toMatchObject({ remoteId: "remote-2", remoteEntity: "task" });
    expect(harness.pipeline.rereads.get("remote-1")).toBeGreaterThan(0);
    expect(harness.pipeline.rereads.get("remote-2")).toBeGreaterThan(0);
  });

  it("updates title and completion through the shared task pipeline", async () => {
    const harness = makeHarness(true, false, true);
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", patchManagedPlanAction(
      harness.markdown.content("Stage.md"), { uuid: "uuid-1", title: "新行动", state: "completed" },
    ));

    const summary = await harness.service.synchronizeProject(input());

    expect(summary).toMatchObject({ updatedActions: 1, completedActions: 1, frozen: [] });
    expect(harness.pipeline.tasks.get("remote-2")).toMatchObject({
      title: "新行动",
      status: 2,
      parentId: "remote-1",
      content: projectionMarker("uuid-1"),
    });
  });

  it("projects note, schedule, priority and tags through ordinary task fields", async () => {
    const harness = makeHarness(true);
    harness.markdown.set("Stage.md", patchManagedPlanAction(harness.markdown.content("Stage.md"), {
      uuid: "uuid-1",
      content: "验证数据处理流程",
      startDate: "2026-08-15T09:30:00.000+08:00",
      dueDate: "2026-08-15T16:00:00.000+08:00",
      timeZone: "Asia/Shanghai",
      priority: 5,
      tags: ["科研", "论文"],
    }));

    await harness.service.synchronizeProject(input());

    expect(harness.pipeline.tasks.get("remote-2")).toMatchObject({
      content: projectionMarker("uuid-1"),
      desc: "验证数据处理流程",
      startDate: "2026-08-15T09:30:00.000+08:00",
      dueDate: "2026-08-15T16:00:00.000+08:00",
      timeZone: "Asia/Shanghai",
      priority: 5,
      tags: ["科研", "论文"],
    });
    expect(harness.state.value.ledger[0]).toMatchObject({
      content: "验证数据处理流程", priority: 5, tags: ["科研", "论文"], remoteEntity: "task",
    });
  });

  it("clears optional task attributes explicitly without changing the identity marker", async () => {
    const harness = makeHarness(true);
    harness.markdown.set("Stage.md", patchManagedPlanAction(harness.markdown.content("Stage.md"), {
      uuid: "uuid-1", content: "旧备注", priority: 3, tags: ["旧标签"],
    }));
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", patchManagedPlanAction(harness.markdown.content("Stage.md"), {
      uuid: "uuid-1", content: null, priority: 0, tags: [],
    }));

    const summary = await harness.service.synchronizeProject(input());

    expect(summary).toMatchObject({ updatedActions: 1, frozen: [] });
    expect(harness.pipeline.tasks.get("remote-2")).toMatchObject({
      content: projectionMarker("uuid-1"),
    });
    expect(harness.pipeline.tasks.get("remote-2")?.priority ?? 0).toBe(0);
    expect(harness.pipeline.tasks.get("remote-2")?.tags ?? []).toEqual([]);
    expect(harness.pipeline.tasks.get("remote-2")?.desc).toBeUndefined();
  });

  it("stages metadata competition against the projection ledger Base", async () => {
    const harness = makeHarness(true);
    harness.markdown.set("Stage.md", patchManagedPlanAction(
      harness.markdown.content("Stage.md"), { uuid: "uuid-1", content: "原备注" },
    ));
    await harness.service.synchronizeProject(input());
    harness.pipeline.tasks.set("remote-2", { ...harness.pipeline.tasks.get("remote-2")!, desc: "远端备注" });
    harness.markdown.set("Stage.md", patchManagedPlanAction(
      harness.markdown.content("Stage.md"), { uuid: "uuid-1", content: "本地备注" },
    ));

    const summary = await harness.service.synchronizeProject(input());

    expect(summary.frozen).toContainEqual(expect.objectContaining({ uuid: "uuid-1", reason: "conflict" }));
    expect(harness.pipeline.stagedBases[0]).toMatchObject({ desc: "原备注" });
    expect(harness.pipeline.tasks.get("remote-2")?.desc).toBe("远端备注");
  });

  it("reopens a completed child only when the reopen contract is verified", async () => {
    const harness = makeHarness(true, false, true);
    harness.markdown.set("Stage.md", patchManagedPlanAction(
      harness.markdown.content("Stage.md"), { uuid: "uuid-1", state: "completed" },
    ));
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", patchManagedPlanAction(
      harness.markdown.content("Stage.md"), { uuid: "uuid-1", state: "active" },
    ));

    const summary = await harness.service.synchronizeProject(input());

    expect(summary.frozen).toEqual([]);
    expect(harness.pipeline.tasks.get("remote-2")?.status).toBe(0);
  });

  it("deletes only the exact bound child and keeps the parent", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", harness.markdown.content("Stage.md")
      .split(/\r?\n/u).filter((line) => !line.includes("uuid=uuid-1 ")).join("\n"));

    const summary = await harness.service.synchronizeProject(input());

    expect(summary).toMatchObject({ deletedActions: 1, frozen: [] });
    expect(harness.pipeline.deleted).toEqual(["remote-2"]);
    expect(harness.pipeline.tasks.has("remote-1")).toBe(true);
    expect(harness.state.value.ledger).toEqual([]);
  });

  it("freezes instead of deleting when the child identity changed", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.pipeline.tasks.set("remote-2", { ...harness.pipeline.tasks.get("remote-2")!, parentId: "foreign-parent" });
    harness.markdown.set("Stage.md", harness.markdown.content("Stage.md")
      .split(/\r?\n/u).filter((line) => !line.includes("uuid=uuid-1 ")).join("\n"));

    const summary = await harness.service.synchronizeProject(input());

    expect(summary.frozen).toContainEqual(expect.objectContaining({ uuid: "uuid-1" }));
    expect(harness.pipeline.tasks.has("remote-2")).toBe(true);
  });

  it("stages Base/Local/Remote competition as a normal task conflict", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.pipeline.tasks.set("remote-2", { ...harness.pipeline.tasks.get("remote-2")!, title: "远端改名" });
    harness.markdown.set("Stage.md", patchManagedPlanAction(
      harness.markdown.content("Stage.md"), { uuid: "uuid-1", title: "本地改名" },
    ));

    const summary = await harness.service.synchronizeProject(input());

    expect(summary.frozen).toContainEqual(expect.objectContaining({ uuid: "uuid-1", reason: "conflict" }));
    expect(harness.pipeline.stagedConflicts).toBe(1);
    expect(harness.pipeline.stagedBases[0]).toMatchObject({ title: "行动", parentId: "remote-1" });
    expect(harness.pipeline.tasks.get("remote-2")?.title).toBe("远端改名");
  });

  it("single-sends an unknown child create and never retries automatically", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    const withSecond = harness.markdown.content("Stage.md")
      .replace("# 行动结果", "- [ ] 第二行动\n# 行动结果");
    const line = parseManagedPlanActions(withSecond).unmanagedChecklistLines[0]!;
    harness.markdown.set("Stage.md", adoptPlanAction(withSecond, line, "uuid-2"));
    harness.pipeline.nextResult = { operationId: "op-child-unknown", outcome: "unknown", message: "timeout" };

    const first = await harness.service.synchronizeProject(input());
    const createCount = harness.pipeline.created.length;
    const second = await harness.service.synchronizeProject(input());

    expect(first.frozen).toContainEqual(expect.objectContaining({ uuid: "uuid-2", reason: "unknown-outcome" }));
    expect(second.frozen).toEqual([]);
    expect(harness.pipeline.created).toHaveLength(createCount);
    expect(harness.state.value.ledger.find((entry) => entry.uuid === "uuid-2"))
      .toMatchObject({ frozen: "unknown-outcome", operationId: "op-child-unknown" });
  });

  it("freezes a missing bound child without adopting by title", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.pipeline.tasks.delete("remote-2");
    harness.markdown.set("Stage.md", patchManagedPlanAction(
      harness.markdown.content("Stage.md"), { uuid: "uuid-1", title: "触发精确复读" },
    ));

    const summary = await harness.service.synchronizeProject(input());

    expect(summary.frozen).toContainEqual(expect.objectContaining({ uuid: "uuid-1", reason: "identity-mismatch" }));
    expect(harness.pipeline.created).toHaveLength(2);
  });

  it("retains another project's ledger while synchronizing the selected project", async () => {
    const harness = makeHarness(true);
    const other = ledger({ uuid: "other", projectId: "project-2", stageId: "stage-2", remoteId: "other-task" });
    harness.state.value.ledger.push(other);

    await harness.service.synchronizeProject(input());

    expect(harness.state.value.ledger.find((entry) => entry.uuid === "other")).toEqual(other);
  });

  it("freezes a legacy items mapping instead of treating its remote id as a task", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    delete harness.state.value.ledger[0]!.remoteEntity;
    harness.markdown.set("Stage.md", patchManagedPlanAction(
      harness.markdown.content("Stage.md"), { uuid: "uuid-1", title: "不得写入" },
    ));
    const writes = harness.pipeline.updated.length;

    const summary = await harness.service.synchronizeProject(input());

    expect(summary.frozen).toContainEqual(expect.objectContaining({ uuid: "uuid-1", reason: "identity-mismatch" }));
    expect(harness.pipeline.updated).toHaveLength(writes);
  });

  it("read-only reconciles an applied unknown child update without resending", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", patchManagedPlanAction(
      harness.markdown.content("Stage.md"), { uuid: "uuid-1", title: "已在远端生效" },
    ));
    harness.pipeline.nextResult = { operationId: "op-child-update-unknown", outcome: "unknown", message: "timeout" };
    await harness.service.synchronizeProject(input());
    const frozen = harness.state.value.ledger[0]!;
    harness.pipeline.tasks.set(frozen.remoteId!, {
      ...harness.pipeline.tasks.get(frozen.remoteId!)!,
      title: frozen.title,
    });
    const diagnostics = new MemoryDiagnostics({
      operationId: frozen.operationId!,
      blocked: false,
      resolvedTask: harness.pipeline.tasks.get(frozen.remoteId!),
    });
    const writes = harness.pipeline.updated.length;
    const recovered = projectionHarnessWithDiagnostics(harness.state, harness.pipeline, diagnostics);

    await recovered.service.reconcileFrozen(reconcileAction(frozen));

    expect(harness.pipeline.updated).toHaveLength(writes);
    expect(harness.state.value.ledger[0]).toMatchObject({ title: "已在远端生效", remoteEntity: "task" });
    expect(harness.state.value.ledger[0]).not.toHaveProperty("frozen");
    expect(diagnostics.removed).toEqual([frozen.operationId]);
  });

  it("clears an unknown child deletion only after exact absence is proven", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", harness.markdown.content("Stage.md")
      .split(/\r?\n/u).filter((line) => !line.includes("uuid=uuid-1 ")).join("\n"));
    harness.pipeline.nextDeleteResult = {
      operationId: "op-child-delete-unknown", outcome: "unknown", message: "timeout",
    };
    await harness.service.synchronizeProject(input());
    const frozen = harness.state.value.ledger[0]!;
    harness.pipeline.tasks.delete(frozen.remoteId!);
    const diagnostics = new MemoryDiagnostics({
      operationId: frozen.operationId!, blocked: false, receiptPresent: true,
      receiptOverride: {
        marker: projectionMarker(frozen.uuid),
        remoteTaskId: frozen.remoteId,
      },
    });
    const recovered = projectionHarnessWithDiagnostics(harness.state, harness.pipeline, diagnostics);

    await recovered.service.reconcileFrozen(reconcileAction(frozen));

    expect(harness.state.value.ledger).toEqual([]);
    expect(diagnostics.removed).toEqual(["op-child-delete-unknown"]);
  });

  it("keeps a child freeze while its queue or field conflict is still open", async () => {
    const entry = ledger({ remoteEntity: "task", frozen: "conflict", operationId: "op-blocked" });
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "confirmed",
      ledger: [entry],
      parentCheckpoints: [],
    });
    const pipeline = new FakePipeline();
    pipeline.tasks.set(entry.remoteId!, {
      id: entry.remoteId!, projectId: entry.targetProjectId, parentId: entry.parentTaskId,
      columnId: entry.targetColumnId, title: entry.title, status: 0, content: projectionMarker(entry.uuid),
    });
    const diagnostics = new MemoryDiagnostics({
      operationId: "op-blocked", blocked: true, resolvedTask: pipeline.tasks.get(entry.remoteId!),
    });
    const recovered = projectionHarnessWithDiagnostics(state, pipeline, diagnostics);

    await expect(recovered.service.reconcileFrozen(reconcileAction(entry)))
      .rejects.toThrow(/仍由队列或逐字段冲突持有/);
    expect(state.value.ledger[0]).toMatchObject({ frozen: "conflict", operationId: "op-blocked" });
  });
});
