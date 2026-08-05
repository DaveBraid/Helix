import { describe, expect, it } from "vitest";
import type { DidaColumn, DidaProject, DidaTask } from "../src/domain/entities";
import { stableHash } from "../src/domain/stable";
import {
  adoptPlanAction,
  assertProjectionActivation,
  buildProjectionActivationPreview,
  buildProjectionLedger,
  parseManagedPlanActions,
  patchManagedPlanAction,
  patchProjectParentTaskId,
  planProjectionChanges,
  projectionMarker,
  readProjectProjectionIdentity,
  verifyProjectedTask,
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
  parentTaskVerified: true,
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
  });

  it("preserves the managed action indentation and bullet style", () => {
    const adopted = adoptPlanAction(stage("  * [ ] 缩进行动"), 10, "uuid-layout");
    const patched = patchManagedPlanAction(adopted, { uuid: "uuid-layout", title: "保留结构" });
    expect(patched).toContain("  * [ ] 保留结构 <!-- helix-dida-action:v1");
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
    expect(planProjectionChanges([base], [changed]).map((item) => item.kind)).toEqual(["update-action", "complete-action"]);
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
});

describe("DidaProjectProjectionService with fake remote", () => {
  it("requires explicit activation and a fresh exact preview", async () => {
    const harness = makeHarness();
    await expect(harness.service.synchronizeProject(input())).rejects.toThrow(/尚未显式/);
    expect(harness.pipeline.created).toEqual([]);
    expect(harness.pipeline.updated).toEqual([]);
    expect(harness.pipeline.deleteAttempts).toBe(0);
    expect(harness.pipeline.rereads.size).toBe(0);
    const preview = await harness.service.previewActivation({ targetProjectId: "list-1", targetColumnId: "column-1" }, { projectCount: 1, actionCount: 1 });
    await expect(harness.service.activate(preview, "stale")).rejects.toThrow(/预览已变化/);
    await harness.service.activate(preview, preview.previewHash);
    expect((await harness.state.read()).enabled).toBe(true);
  });

  it("creates parent then child through the injected normal task pipeline and writes verified IDs", async () => {
    const harness = makeHarness(true);
    const summary = await harness.service.synchronizeProject(input());
    expect(summary).toMatchObject({ createdParents: 1, createdActions: 1, frozen: [] });
    expect(harness.pipeline.created).toHaveLength(2);
    expect(harness.markdown.content("Project.md")).toContain("helix-dida-parent-task-id");
    expect((await harness.state.read()).parentCheckpoints).toEqual([]);
    expect(harness.markdown.content("Stage.md")).toMatch(/remoteId=remote-2/);
    const child = harness.pipeline.created[1]!;
    expect(child).toMatchObject({ projectId: "list-1", columnId: "column-1", parentId: "remote-1", content: "helix-projection:uuid-1" });
  });

  it("recovers a missing ledger from a Markdown remote ID by exact reread without creating", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    const creates = harness.pipeline.created.length;
    harness.state.value.ledger = [];
    const recovered = await harness.service.synchronizeProject(input());
    expect(recovered.createdActions).toBe(0);
    expect(harness.pipeline.created).toHaveLength(creates);
    expect(harness.state.value.ledger[0]).toMatchObject({ uuid: "uuid-1", remoteId: "remote-2" });
  });

  it("recovers a durable create receipt after crash before Markdown/state landing without resending", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    const creates = harness.pipeline.created.length;
    harness.markdown.set("Stage.md", patchManagedPlanAction(
      harness.markdown.content("Stage.md"),
      { uuid: "uuid-1", remoteId: null },
    ));
    harness.state.value.ledger = [];
    const recovered = await harness.service.synchronizeProject(input());
    expect(recovered.createdActions).toBe(0);
    expect(harness.pipeline.created).toHaveLength(creates);
    expect(harness.markdown.content("Stage.md")).toContain("remoteId=remote-2");
    expect(harness.state.value.ledger[0]).toMatchObject({ operationId: expect.stringMatching(/^op-/) });
  });

  it("rereads the exact parent immediately before every child create", async () => {
    const harness = makeHarness(true);
    harness.pipeline.onReread = (taskId, count) => {
      if (taskId === "remote-1" && count >= 2) {
        harness.pipeline.tasks.set(taskId, { ...harness.pipeline.tasks.get(taskId)!, columnId: "foreign" });
      }
    };
    const result = await harness.service.synchronizeProject(input());
    expect(result.frozen).toEqual([expect.objectContaining({ uuid: "uuid-1", reason: "identity-mismatch" })]);
    expect(harness.pipeline.created).toHaveLength(1);
  });

  it("updates title and completes, then freezes unsupported action reopen", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", patchManagedPlanAction(harness.markdown.content("Stage.md"), { uuid: "uuid-1", title: "新标题", state: "completed" }));
    const completed = await harness.service.synchronizeProject(input());
    expect(completed).toMatchObject({ updatedActions: 1, completedActions: 1 });
    harness.markdown.set("Stage.md", patchManagedPlanAction(harness.markdown.content("Stage.md"), { uuid: "uuid-1", state: "terminated" }));
    const terminated = await harness.service.synchronizeProject(input());
    expect(terminated.frozen[0]).toMatchObject({ uuid: "uuid-1", reason: "capability" });
    expect(harness.pipeline.tasks.get("remote-2")?.status).toBe(2);
  });

  it("projects parent rename and completion, then freezes unsupported reopen", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());

    const renamed = await harness.service.synchronizeProject(input({ projectTitle: "Beta" }));
    expect(renamed.updatedParents).toBe(1);
    expect(harness.pipeline.tasks.get("remote-1")?.title).toBe("Beta");

    const completed = await harness.service.synchronizeProject(input({ projectTitle: "Beta", projectStatus: "completed" }));
    expect(completed.completedParents).toBe(1);
    expect(harness.pipeline.tasks.get("remote-1")?.status).toBe(2);

    const terminated = await harness.service.synchronizeProject(input({ projectTitle: "Beta", projectStatus: "terminated" }));
    expect(terminated.frozen[0]).toMatchObject({ uuid: "project:project-1", reason: "capability" });
    expect(harness.pipeline.tasks.get("remote-1")?.status).toBe(2);
  });

  it("uses the dedicated reopen receipt only after taskReopenVerified", async () => {
    const harness = makeHarness(true, false, true);
    await harness.service.synchronizeProject(input());
    await harness.service.synchronizeProject(input({ projectStatus: "completed" }));
    const parent = await harness.service.synchronizeProject(input({ projectStatus: "active", projectTitle: "父任务新标题" }));
    expect(parent.frozen).toEqual([]);
    expect(harness.pipeline.reopened).toBe(1);
    expect(harness.pipeline.tasks.get("remote-1")?.status).toBe(0);
    expect(harness.pipeline.tasks.get("remote-1")?.title).toBe("父任务新标题");

    harness.markdown.set("Stage.md", patchManagedPlanAction(harness.markdown.content("Stage.md"), { uuid: "uuid-1", state: "completed" }));
    await harness.service.synchronizeProject(input({ projectTitle: "父任务新标题" }));
    harness.markdown.set("Stage.md", patchManagedPlanAction(harness.markdown.content("Stage.md"), { uuid: "uuid-1", state: "paused", title: "行动新标题" }));
    const action = await harness.service.synchronizeProject(input({ projectTitle: "父任务新标题" }));
    expect(action.frozen).toEqual([]);
    expect(harness.pipeline.reopened).toBe(2);
    expect(harness.pipeline.tasks.get("remote-2")?.status).toBe(0);
    expect(harness.pipeline.tasks.get("remote-2")?.title).toBe("行动新标题");
  });

  it("freezes with the exact title-update receipt after reopen partially succeeds", async () => {
    const harness = makeHarness(true, false, true);
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", patchManagedPlanAction(harness.markdown.content("Stage.md"), { uuid: "uuid-1", state: "completed" }));
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", patchManagedPlanAction(harness.markdown.content("Stage.md"), { uuid: "uuid-1", state: "active", title: "重开后改名" }));
    harness.pipeline.nextResult = {
      operationId: "op-title-after-reopen",
      conflictId: "conflict-title",
      outcome: "unknown",
      message: "title outcome unknown",
    };
    const result = await harness.service.synchronizeProject(input());
    expect(result.frozen[0]).toMatchObject({ uuid: "uuid-1", reason: "unknown-outcome" });
    expect(harness.state.value.ledger[0]).toMatchObject({
      operationId: "op-title-after-reopen",
      conflictId: "conflict-title",
      frozen: "unknown-outcome",
    });
    expect(harness.pipeline.tasks.get("remote-2")).toMatchObject({ status: 0, title: "行动" });
  });

  it("freezes parent remote competition and unknown writes without retrying or title adoption", async () => {
    const competing = makeHarness(true);
    await competing.service.synchronizeProject(input());
    competing.pipeline.tasks.set("remote-1", { ...competing.pipeline.tasks.get("remote-1")!, title: "远端改名" });
    const conflict = await competing.service.synchronizeProject(input({ projectTitle: "Helix 改名" }));
    expect(conflict.frozen[0]).toMatchObject({ uuid: "project:project-1", reason: "conflict" });
    expect(competing.pipeline.updated).toHaveLength(0);

    const unknown = makeHarness(true);
    await unknown.service.synchronizeProject(input());
    unknown.pipeline.nextResult = { operationId: "op-parent-unknown", outcome: "unknown", message: "timeout" };
    const first = await unknown.service.synchronizeProject(input({ projectTitle: "新项目名" }));
    expect(first.frozen[0]).toMatchObject({ uuid: "project:project-1", reason: "unknown-outcome" });
    const writes = unknown.pipeline.updated.length;
    await unknown.service.synchronizeProject(input({ projectTitle: "新项目名" }));
    expect(unknown.pipeline.updated).toHaveLength(writes);
    expect(unknown.state.value.parentCheckpoints[0]).toMatchObject({ operationId: "op-parent-unknown" });
  });

  it("deletes only by strict reread identity and clears a verified tombstone", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", stage("用户保留的普通文字"));
    harness.pipeline.beforeDelete = () => {
      expect(harness.state.value.ledger[0]).toMatchObject({ uuid: "uuid-1", tombstone: true });
    };
    const summary = await harness.service.synchronizeProject(input());
    expect(summary.deletedActions).toBe(1);
    expect(harness.pipeline.deleted).toEqual(["remote-2"]);
    expect((await harness.state.read()).ledger).toEqual([]);
  });

  it("recovers a crash after tombstone persistence without resending delete", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", stage("行动已删"));
    harness.state.value.ledger[0] = { ...harness.state.value.ledger[0]!, tombstone: true };
    const result = await harness.service.synchronizeProject(input());
    expect(result.frozen[0]).toMatchObject({ uuid: "uuid-1", reason: "unknown-outcome" });
    expect(harness.pipeline.deleted).toEqual([]);
    await harness.service.synchronizeProject(input());
    expect(harness.pipeline.deleted).toEqual([]);
  });

  it("freezes an unknown delete after one send and never sends it again", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", stage("行动已删"));
    harness.pipeline.nextDeleteResult = { operationId: "op-delete-unknown", outcome: "unknown", message: "delete timeout" };
    const first = await harness.service.synchronizeProject(input());
    expect(first.frozen[0]).toMatchObject({ uuid: "uuid-1", reason: "unknown-outcome" });
    expect(harness.pipeline.deleteAttempts).toBe(1);
    await harness.service.synchronizeProject(input());
    expect(harness.pipeline.deleteAttempts).toBe(1);
  });

  it("persists and freezes a deletion tombstone when remote identity competes", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.pipeline.tasks.set("remote-2", { ...harness.pipeline.tasks.get("remote-2")!, parentId: "foreign" });
    harness.markdown.set("Stage.md", stage("用户保留"));
    const summary = await harness.service.synchronizeProject(input());
    expect(summary.frozen[0]).toMatchObject({ uuid: "uuid-1", reason: "conflict" });
    expect((await harness.state.read()).ledger[0]).toMatchObject({ uuid: "uuid-1", tombstone: true, frozen: "conflict" });
    expect(harness.pipeline.deleted).toEqual([]);
  });

  it("single-sends unknown create, freezes it, and never retries on the next run", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.markdown.set("Stage.md", `${harness.markdown.content("Stage.md").replace("# 行动结果", "- [ ] 第二条\n# 行动结果")}`);
    const parsed = parseManagedPlanActions(harness.markdown.content("Stage.md"));
    harness.markdown.set("Stage.md", adoptPlanAction(harness.markdown.content("Stage.md"), parsed.unmanagedChecklistLines[0]!, "uuid-2"));
    harness.pipeline.nextResult = { operationId: "op-action-unknown", outcome: "unknown", message: "timeout" };
    const first = await harness.service.synchronizeProject(input());
    expect(first.frozen[0]).toMatchObject({ uuid: "uuid-2", reason: "unknown-outcome" });
    const createCount = harness.pipeline.created.length;
    await harness.service.synchronizeProject(input());
    expect(harness.pipeline.created).toHaveLength(createCount);
    expect((await harness.state.read()).ledger.find((item) => item.uuid === "uuid-2")?.frozen).toBe("unknown-outcome");
    expect((await harness.state.read()).ledger.find((item) => item.uuid === "uuid-2")?.operationId).toBe("op-action-unknown");
    await harness.service.synchronizeProject(input());
    expect(harness.pipeline.created).toHaveLength(createCount);
  });

  it("creates an initially completed action open, then completes it through the normal pipeline", async () => {
    const harness = makeHarness(true);
    harness.markdown.set("Stage.md", patchManagedPlanAction(harness.markdown.content("Stage.md"), { uuid: "uuid-1", state: "completed" }));
    const result = await harness.service.synchronizeProject(input());
    expect(result).toMatchObject({ createdActions: 1, completedActions: 1 });
    expect(harness.pipeline.created[1]?.status).toBe(0);
    expect(harness.pipeline.tasks.get("remote-2")?.status).toBe(2);
  });

  it("freezes a verified parent when Markdown CAS loses and does not create it twice", async () => {
    const harness = makeHarness(true, true);
    const result = await harness.service.synchronizeProject(input());
    expect(result.frozen[0]).toMatchObject({ uuid: "project:project-1", reason: "markdown-race" });
    expect(harness.pipeline.created).toHaveLength(1);
    await harness.service.synchronizeProject(input());
    expect(harness.pipeline.created).toHaveLength(1);
  });

  it("does not touch real APIs or infer a task by title when a remote task disappears", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.pipeline.tasks.delete("remote-2");
    harness.markdown.set("Stage.md", patchManagedPlanAction(harness.markdown.content("Stage.md"), { uuid: "uuid-1", title: "changed" }));
    const result = await harness.service.synchronizeProject(input());
    expect(result.frozen[0]).toMatchObject({ uuid: "uuid-1", reason: "identity-mismatch" });
    expect(result.frozen[0]?.message).toMatch(/不存在.*拒绝按标题/);
  });

  it("merges the latest state by project key when another project changes during a write", async () => {
    const harness = makeHarness(true);
    const other = ledger({ uuid: "other", projectId: "project-2", stageId: "stage-2", remoteId: "other-task" });
    harness.pipeline.onCreate = async (task) => {
      if (task.parentId) harness.state.value.ledger.push(other);
    };
    await harness.service.synchronizeProject(input());
    expect(harness.state.value.ledger.find((entry) => entry.uuid === "other")).toEqual(other);
  });

  it("persists action identity competition instead of throwing or writing remotely", async () => {
    const harness = makeHarness(true);
    await harness.service.synchronizeProject(input());
    harness.state.value.ledger[0] = { ...harness.state.value.ledger[0]!, parentTaskId: "competing-parent" };
    const result = await harness.service.synchronizeProject(input());
    expect(result.frozen[0]).toMatchObject({ uuid: "uuid-1", reason: "identity-mismatch" });
    expect(harness.state.value.ledger[0]?.frozen).toBe("identity-mismatch");
  });

  it("adapts only the existing Helix queue/lease operations and classifies unknown outcomes", async () => {
    const calls: string[] = [];
    const task: DidaTask = { id: "task", projectId: "list-1", title: "T", status: 0 };
    const operations: ExistingHelixTaskQueuePort = {
      enqueueProjectionCreate: async () => { calls.push("queue-create"); return { operationId: "op-create", outcome: "verified", task }; },
      recoverProjectionCreate: async () => { calls.push("queue-recover"); return null; },
      enqueueProjectionUpdate: async () => { calls.push("queue-update"); return { operationId: "op-update", outcome: "unknown", message: "timeout" }; },
      enqueueProjectionComplete: async () => { calls.push("queue-complete"); return { operationId: "op-complete", outcome: "verified", task: { ...task, status: 2 } }; },
      enqueueProjectionReopen: async () => { calls.push("queue-reopen"); return { operationId: "op-reopen", outcome: "verified", task: { ...task, status: 0 } }; },
      enqueueProjectionDelete: async () => { calls.push("queue-delete"); return { operationId: "op-delete", outcome: "verified-absent" }; },
      verifyRemoteTask: async () => { calls.push("lease-reread"); return task; },
    };
    const adapter = new ExistingHelixTaskPipelineAdapter(operations);
    await expect(adapter.createTask(task, "client-1")).resolves.toMatchObject({ outcome: "verified", operationId: "op-create" });
    await expect(adapter.recoverCreate("client-1", "list-1")).resolves.toBeNull();
    await expect(adapter.updateTask(task, ["title"])).resolves.toMatchObject({ outcome: "unknown", operationId: "op-update" });
    await expect(adapter.completeTask(task)).resolves.toMatchObject({ outcome: "verified" });
    await expect(adapter.reopenTask({ ...task, status: 2 })).resolves.toMatchObject({ outcome: "verified", operationId: "op-reopen" });
    await expect(adapter.deleteTask({ taskId: "task", parentTaskId: "parent", targetProjectId: "list-1", targetColumnId: "column-1", marker: "m" }))
      .resolves.toEqual({ operationId: "op-delete", outcome: "verified-absent" });
    await expect(adapter.rereadTask("list-1", "task")).resolves.toEqual(task);
    expect(calls).toEqual(["queue-create", "queue-recover", "queue-update", "queue-complete", "queue-reopen", "queue-delete", "lease-reread"]);
  });

  it("persists non-authoritative projection state with compare-and-swap", async () => {
    let persisted = createDefaultData("device-projection-state");
    const store = new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
    });
    await store.load();
    const port = new PersistedProjectionStatePort(store);
    const initial = await port.read();
    expect(initial).toEqual({ enabled: false, ledger: [], parentCheckpoints: [] });
    const activated: ProjectionPersistentState = {
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64),
      ledger: [],
      parentCheckpoints: [],
    };
    await port.write(initial, activated);
    await expect(port.read()).resolves.toEqual(activated);
    await expect(port.write(initial, { ...initial, enabled: false }))
      .rejects.toThrow(/写入前发生竞争/);
  });

  it("uses only the receipt's exact remote task id when recovering a Base diagnostic", async () => {
    let persisted = createDefaultData("device-projection-diagnostic");
    persisted.projectionOperationReceipts = [{
      clientIdentity: "client-1", projectId: "list-1", operationId: "op-1",
      marker: projectionMarker("uuid-1"), outcome: "unknown", remoteTaskId: "task-expected",
    }];
    const wrong: DidaTask = {
      id: "task-wrong", projectId: "list-1", title: "行动",
      content: projectionMarker("uuid-1"), status: 0,
    };
    persisted.baseSnapshots["task:task-wrong"] = createSnapshot("task", wrong.id, wrong);
    const store = new HelixDataStore({
      async loadData() { return structuredClone(persisted); },
      async saveData(value) { persisted = structuredClone(value) as typeof persisted; },
    });
    await store.load();
    const port = new PersistedProjectionDiagnosticsPort(store);
    await expect(port.inspect("op-1")).resolves.toMatchObject({ resolvedTask: undefined });
    const expected = { ...wrong, id: "task-expected" };
    await store.mutate((data) => {
      data.baseSnapshots["task:task-expected"] = createSnapshot("task", expected.id, expected);
    });
    await expect(port.inspect("op-1")).resolves.toMatchObject({ resolvedTask: { id: "task-expected" } });
    await expect(port.removeReconciled("missing-op")).rejects.toThrow(/找不到投影操作收据/);
    await expect(port.removeResolved("op-1")).rejects.toThrow(/只有已验证收口/);
    await store.mutate((data) => {
      data.projectionOperationReceipts[0]!.outcome = "verified";
    });
    await port.removeResolved("op-1");
    await expect(port.list()).resolves.toEqual([]);
  });

  it("exposes a read model and edits only the expected stable stage revision", async () => {
    const markdown = new MemoryMarkdown({
      "Project.md": projectMarkdown(),
      "Stage.md": stage("- [ ] 未受管行动"),
    });
    const state = new MemoryState({ enabled: false, ledger: [], parentCheckpoints: [] });
    const service = new DidaProjectProjectionService(
      markdown,
      new FakePipeline(),
      state,
      { read: async () => ({ projects: [project], columns: [column], readiness: ready }) },
    );
    const before = await service.readProject(input());
    expect(before.stages[0]).toMatchObject({
      id: "stage-1",
      unmanaged: [{ line: 10, title: "未受管行动", completed: false }],
      managed: [],
    });
    const adopted = await service.adoptAction({
      stagePath: "Stage.md",
      expectedStageId: "stage-1",
      expectedHash: before.stages[0]!.revisionHash,
      line: 10,
    });
    const managed = parseManagedPlanActions(adopted.content).actions[0]!;
    const edited = await service.editAction({
      stagePath: "Stage.md",
      expectedStageId: "stage-1",
      expectedHash: adopted.hash,
      uuid: managed.uuid,
      title: "新标题",
      state: "paused",
    });
    expect(parseManagedPlanActions(edited.content).actions[0]).toMatchObject({
      title: "新标题",
      state: "paused",
    });
    await expect(service.editAction({
      stagePath: "Stage.md",
      expectedStageId: "foreign-stage",
      expectedHash: edited.hash,
      uuid: managed.uuid,
      title: "不得写入",
    })).rejects.toThrow(/身份/);
    expect(markdown.content("Stage.md")).toBe(edited.content);
  });

  it("reconciles unknown create only after the queue clears and exact desired state is verified", async () => {
    const entry = ledger({ remoteId: undefined, frozen: "unknown-outcome", operationId: "op-create" });
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64),
      ledger: [entry],
      parentCheckpoints: [],
    });
    const pipeline = new FakePipeline();
    const remote = {
      id: "remote-created", projectId: "list-1", parentId: "parent-1", columnId: "column-1",
      title: entry.title, content: projectionMarker(entry.uuid), status: 0,
    } satisfies DidaTask;
    pipeline.tasks.set(remote.id, remote);
    const diagnostics = new MemoryDiagnostics({
      operationId: "op-create", blocked: true, resolvedTask: remote,
    });
    const { service, markdown } = projectionHarnessWithDiagnostics(state, pipeline, diagnostics);
    await expect(service.reconcileFrozen(reconcileAction(entry)))
      .rejects.toThrow(/队列或逐字段冲突/);
    diagnostics.blocked = false;
    await service.reconcileFrozen(reconcileAction(entry));
    expect(state.value.ledger[0]).toMatchObject({ remoteId: remote.id });
    expect(state.value.ledger[0]?.frozen).toBeUndefined();
    expect(markdown.content("Stage.md")).toContain(`remoteId=${remote.id}`);
    expect(diagnostics.removed).toEqual(["op-create"]);
    const parent: DidaTask = {
      id: entry.parentTaskId,
      projectId: entry.targetProjectId,
      columnId: entry.targetColumnId,
      title: "Alpha",
      content: "helix-project-projection:project-1",
      status: 0,
    };
    pipeline.tasks.set(parent.id, parent);
    markdown.set("Project.md", patchProjectParentTaskId(markdown.content("Project.md"), parent.id));
    await service.synchronizeProject(input());
    expect(pipeline.created).toEqual([]);
  });

  it("keeps the receipt and frozen state when reconciliation state CAS loses a race", async () => {
    const entry = ledger({ remoteId: undefined, frozen: "unknown-outcome", operationId: "op-race" });
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64), ledger: [entry], parentCheckpoints: [],
    });
    const pipeline = new FakePipeline();
    const remote: DidaTask = {
      id: "remote-race", projectId: entry.targetProjectId, parentId: entry.parentTaskId,
      columnId: entry.targetColumnId, title: entry.title, content: projectionMarker(entry.uuid), status: 0,
    };
    pipeline.tasks.set(remote.id, remote);
    const diagnostics = new MemoryDiagnostics({ operationId: "op-race", blocked: false, resolvedTask: remote });
    const { service, markdown } = projectionHarnessWithDiagnostics(state, pipeline, diagnostics);
    state.failNextCas = true;
    await expect(service.reconcileFrozen(reconcileAction(entry))).rejects.toThrow(/state CAS/);
    expect(state.value.ledger[0]?.frozen).toBe("unknown-outcome");
    expect(diagnostics.removed).toEqual([]);
    expect(markdown.content("Stage.md")).toContain(`remoteId=${remote.id}`);
    await service.reconcileFrozen(reconcileAction(entry));
    expect(state.value.ledger[0]?.frozen).toBeUndefined();
    expect(diagnostics.removed).toEqual(["op-race"]);
  });

  it("refuses to reconcile an operation whose durable receipt is missing", async () => {
    const entry = ledger({ frozen: "unknown-outcome", operationId: "op-missing" });
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64), ledger: [entry], parentCheckpoints: [],
    });
    const pipeline = new FakePipeline();
    pipeline.tasks.set(entry.remoteId!, {
      id: entry.remoteId!, projectId: entry.targetProjectId, parentId: entry.parentTaskId,
      columnId: entry.targetColumnId, title: entry.title, content: projectionMarker(entry.uuid), status: 0,
    });
    const diagnostics = new MemoryDiagnostics({ operationId: "op-missing", blocked: false, receiptPresent: false });
    const service = projectionServiceWithDiagnostics(state, pipeline, diagnostics);
    await expect(service.reconcileFrozen(reconcileAction(entry))).rejects.toThrow(/缺少既有操作收据/);
    expect(state.value.ledger[0]?.frozen).toBe("unknown-outcome");
  });

  it("persists cleanup proof and retries orphan receipt cleanup after restart", async () => {
    const entry = ledger({ remoteId: undefined, frozen: "unknown-outcome", operationId: "op-cleanup" });
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64), ledger: [entry], parentCheckpoints: [],
    });
    const pipeline = new FakePipeline();
    const remote: DidaTask = {
      id: "remote-cleanup", projectId: entry.targetProjectId, parentId: entry.parentTaskId,
      columnId: entry.targetColumnId, title: entry.title, content: projectionMarker(entry.uuid), status: 0,
    };
    pipeline.tasks.set(remote.id, remote);
    const diagnostics = new MemoryDiagnostics({
      operationId: "op-cleanup", blocked: false, resolvedTask: remote, cleanupFailures: 1,
    });
    const { service } = projectionHarnessWithDiagnostics(state, pipeline, diagnostics);
    await service.reconcileFrozen(reconcileAction(entry));
    expect(state.value.ledger[0]?.frozen).toBeUndefined();
    expect(state.value.receiptCleanupPending).toEqual([
      expect.objectContaining({ operationId: "op-cleanup", remoteTaskId: remote.id }),
    ]);
    expect(diagnostics.removed).toEqual([]);
    const model = await service.readProject(input());
    expect(model.receiptCleanupPending).toHaveLength(1);
    expect(diagnostics.removed).toEqual([]);
    await expect(service.removeResolvedReceipt("op-cleanup")).rejects.toThrow(/仍被冻结对象引用/);
    await service.retryReceiptCleanup();
    expect(state.value.receiptCleanupPending).toEqual([]);
    expect(diagnostics.removed).toEqual(["op-cleanup"]);
  });

  it("rejects a receipt bound to another marker before remote reconciliation", async () => {
    const entry = ledger({ frozen: "unknown-outcome", operationId: "op-wrong-receipt" });
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64), ledger: [entry], parentCheckpoints: [],
    });
    const pipeline = new FakePipeline();
    pipeline.tasks.set(entry.remoteId!, {
      id: entry.remoteId!, projectId: entry.targetProjectId, parentId: entry.parentTaskId,
      columnId: entry.targetColumnId, title: entry.title, content: projectionMarker(entry.uuid), status: 0,
    });
    const diagnostics = new MemoryDiagnostics({
      operationId: "op-wrong-receipt", blocked: false,
      receiptOverride: { marker: "helix-projection:foreign" },
    });
    const service = projectionServiceWithDiagnostics(state, pipeline, diagnostics);
    await expect(service.reconcileFrozen(reconcileAction(entry))).rejects.toThrow(/收据与冻结对象身份不一致/);
    expect(pipeline.rereads.size).toBe(0);
  });

  it("writes a recovered unknown parent id to Markdown before clearing its checkpoint", async () => {
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64),
      ledger: [],
      parentCheckpoints: [{
        projectId: "project-1", marker: "helix-project-projection:project-1",
        frozen: "unknown-outcome", operationId: "op-parent",
      }],
    });
    const pipeline = new FakePipeline();
    const remote: DidaTask = {
      id: "remote-parent", projectId: "list-1", columnId: "column-1", title: "Alpha",
      content: "helix-project-projection:project-1", status: 0,
    };
    pipeline.tasks.set(remote.id, remote);
    const diagnostics = new MemoryDiagnostics({ operationId: "op-parent", blocked: false, resolvedTask: remote });
    const { service, markdown } = projectionHarnessWithDiagnostics(state, pipeline, diagnostics);
    await service.reconcileFrozen({
      kind: "parent", projectId: "project-1", projectPath: "Project.md", title: "Alpha", status: "active",
    });
    expect(readProjectProjectionIdentity(markdown.content("Project.md")).parentTaskId).toBe(remote.id);
    expect(state.value.parentCheckpoints).toEqual([]);
    await service.synchronizeProject(input());
    expect(pipeline.created).toEqual([]);
  });

  it("does not leak a copied UUID's persisted freeze across project and stage identity", async () => {
    const foreign = ledger({ projectId: "foreign-project", stageId: "foreign-stage", frozen: "conflict" });
    const state = new MemoryState({
      enabled: false,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      ledger: [foreign],
      parentCheckpoints: [],
    });
    const service = projectionServiceWithDiagnostics(
      state,
      new FakePipeline(),
      new MemoryDiagnostics({ operationId: "unused", blocked: false }),
    );
    const model = await service.readProject(input());
    expect(model.stages[0]?.managed[0]?.uuid).toBe(foreign.uuid);
    expect(model.stages[0]?.managed[0]?.frozen).toBeUndefined();
    await expect(service.reconcileFrozen({
      kind: "action", projectId: "project-1", stageId: "stage-1", stagePath: "Stage.md", uuid: foreign.uuid,
    })).rejects.toThrow(/没有待复核/);
  });

  it("keeps an adopted unknown update frozen until remote title and state match Markdown", async () => {
    const entry = ledger({ frozen: "unknown-outcome", operationId: "op-update" });
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64), ledger: [entry], parentCheckpoints: [],
    });
    const pipeline = new FakePipeline();
    pipeline.tasks.set(entry.remoteId!, {
      id: entry.remoteId!, projectId: entry.targetProjectId, parentId: entry.parentTaskId,
      columnId: entry.targetColumnId, title: "Remote choice", content: projectionMarker(entry.uuid), status: 0,
    });
    const diagnostics = new MemoryDiagnostics({ operationId: "op-update", blocked: false });
    const service = projectionServiceWithDiagnostics(state, pipeline, diagnostics);
    await expect(service.reconcileFrozen(reconcileAction(entry)))
      .rejects.toThrow(/标题/);
    expect(state.value.ledger[0]?.frozen).toBe("unknown-outcome");
    pipeline.tasks.set(entry.remoteId!, {
      ...pipeline.tasks.get(entry.remoteId!)!, title: entry.title,
    });
    await service.reconcileFrozen(reconcileAction(entry));
    expect(state.value.ledger[0]?.frozen).toBeUndefined();
  });

  it("does not clear a blocked conflict until the existing conflict lifecycle is resolved", async () => {
    const entry = ledger({ frozen: "conflict", operationId: "op-blocked", conflictId: "conflict-1" });
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64), ledger: [entry], parentCheckpoints: [],
    });
    const pipeline = new FakePipeline();
    pipeline.tasks.set(entry.remoteId!, {
      id: entry.remoteId!, projectId: entry.targetProjectId, parentId: entry.parentTaskId,
      columnId: entry.targetColumnId, title: entry.title, content: projectionMarker(entry.uuid), status: 0,
    });
    const diagnostics = new MemoryDiagnostics({
      operationId: "op-blocked", blocked: true, receiptOverride: { conflictId: "conflict-1" },
    });
    const service = projectionServiceWithDiagnostics(state, pipeline, diagnostics);
    await expect(service.reconcileFrozen(reconcileAction(entry)))
      .rejects.toThrow(/队列或逐字段冲突/);
    diagnostics.blocked = false;
    await service.reconcileFrozen(reconcileAction(entry));
    expect(state.value.ledger[0]?.frozen).toBeUndefined();
  });

  it("removes a tombstone only after its queue clears and exact reread proves absence", async () => {
    const entry = ledger({ tombstone: true, frozen: "unknown-outcome", operationId: "op-delete" });
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64), ledger: [entry], parentCheckpoints: [],
    });
    const pipeline = new FakePipeline();
    const diagnostics = new MemoryDiagnostics({ operationId: "op-delete", blocked: true });
    const service = projectionServiceWithDiagnostics(state, pipeline, diagnostics);
    await expect(service.reconcileFrozen(reconcileAction(entry)))
      .rejects.toThrow(/队列或逐字段冲突/);
    diagnostics.blocked = false;
    await service.reconcileFrozen(reconcileAction(entry));
    expect(state.value.ledger).toEqual([]);
    expect(diagnostics.removed).toEqual(["op-delete"]);
  });

  it("discovers an orphan tombstone after restart and feeds it to strict reconciliation", async () => {
    const entry = ledger({ tombstone: true, frozen: "unknown-outcome", operationId: "op-orphan" });
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64), ledger: [entry], parentCheckpoints: [],
    });
    const pipeline = new FakePipeline();
    const diagnostics = new MemoryDiagnostics({ operationId: "op-orphan", blocked: false });
    const first = projectionHarnessWithDiagnostics(state, pipeline, diagnostics);
    const restarted = new DidaProjectProjectionService(
      first.markdown,
      pipeline,
      state,
      { read: async () => ({ projects: [project], columns: [column], readiness: ready }) },
      () => "2026-08-05T00:00:00.000Z",
      diagnostics,
    );
    const model = await restarted.readProject(input());
    expect(model.orphanDiagnostics).toEqual([{
      uuid: entry.uuid,
      stageId: entry.stageId,
      state: entry.state,
      frozen: entry.frozen,
      operationId: entry.operationId,
      conflictId: undefined,
      remoteId: entry.remoteId,
      tombstone: true,
    }]);
    expect(model.receipts).toEqual([expect.objectContaining({ operationId: "op-orphan" })]);
    const orphan = model.orphanDiagnostics[0]!;
    await restarted.reconcileFrozen({
      kind: "action",
      projectId: model.project.id,
      stageId: orphan.stageId,
      stagePath: model.stages.find((stageModel) => stageModel.id === orphan.stageId)!.path,
      uuid: orphan.uuid,
    });
    expect(state.value.ledger).toEqual([]);
  });

  it("rejects a UUID copied from another project before any remote write or queue operation", async () => {
    const harness = makeHarness(true);
    harness.state.value.ledger = [ledger({ projectId: "foreign-project", stageId: "foreign-stage" })];
    await expect(harness.service.synchronizeProject(input())).rejects.toThrow(/UUID.*归属不一致/);
    expect(harness.pipeline.created).toEqual([]);
    expect(harness.pipeline.updated).toEqual([]);
    expect(harness.pipeline.deleted).toEqual([]);
    expect(harness.pipeline.reopened).toBe(0);
    expect(harness.pipeline.rereads.size).toBe(0);
  });

  it("binds final Stage revisions to preflight when a UUID changes between reads", async () => {
    const parent: DidaTask = {
      id: "parent-1", projectId: "list-1", columnId: "column-1", title: "Alpha",
      content: "helix-project-projection:project-1", status: 0,
    };
    const markdown = new MemoryMarkdown({
      "Project.md": patchProjectParentTaskId(projectMarkdown(), parent.id),
      "Stage.md": adoptPlanAction(stage("- [ ] 行动"), 10, "uuid-1"),
    });
    markdown.onRead = (path, count) => {
      if (path === "Stage.md" && count === 2) {
        markdown.set("Stage.md", markdown.content("Stage.md").replace("uuid=uuid-1", "uuid=uuid-foreign"));
      }
    };
    const pipeline = new FakePipeline();
    pipeline.tasks.set(parent.id, parent);
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64),
      ledger: [ledger({ uuid: "uuid-foreign", projectId: "foreign-project", stageId: "foreign-stage" })],
      parentCheckpoints: [],
    });
    const service = new DidaProjectProjectionService(
      markdown,
      pipeline,
      state,
      { read: async () => ({ projects: [project], columns: [column], readiness: ready }) },
    );
    await expect(service.synchronizeProject(input())).rejects.toThrow(/UUID.*归属不一致/);
    expect(pipeline.created).toEqual([]);
    expect(pipeline.updated).toEqual([]);
    expect(pipeline.deleted).toEqual([]);
    expect(pipeline.reopened).toBe(0);
    expect(pipeline.rereads.size).toBe(0);
  });

  it("does not misclassify a single frozen tombstone as duplicate UUID ownership", async () => {
    const entry = ledger({ tombstone: true, frozen: "unknown-outcome", operationId: "op-tombstone" });
    const parent: DidaTask = {
      id: entry.parentTaskId,
      projectId: entry.targetProjectId,
      columnId: entry.targetColumnId,
      title: "Alpha",
      content: "helix-project-projection:project-1",
      status: 0,
    };
    const markdown = new MemoryMarkdown({
      "Project.md": patchProjectParentTaskId(projectMarkdown(), parent.id),
      "Stage.md": stage("- [ ] 未受管"),
    });
    const pipeline = new FakePipeline();
    pipeline.tasks.set(parent.id, parent);
    const state = new MemoryState({
      enabled: true,
      target: { targetProjectId: "list-1", targetColumnId: "column-1" },
      confirmedPreviewHash: "a".repeat(64), ledger: [entry], parentCheckpoints: [],
    });
    const service = new DidaProjectProjectionService(
      markdown,
      pipeline,
      state,
      { read: async () => ({ projects: [project], columns: [column], readiness: ready }) },
    );
    await expect(service.synchronizeProject(input())).resolves.toBeDefined();
    expect(state.value.ledger).toEqual([expect.objectContaining({
      uuid: entry.uuid,
      tombstone: true,
      frozen: "unknown-outcome",
    })]);
    expect(pipeline.created).toEqual([]);
    expect(pipeline.updated).toEqual([]);
    expect(pipeline.deleted).toEqual([]);
  });
});

function ledger(overrides: Partial<ProjectionLedgerEntry> = {}): ProjectionLedgerEntry {
  return {
    uuid: "uuid-1", projectId: "project-1", stageId: "stage-1", parentTaskId: "parent-1",
    targetProjectId: "list-1", targetColumnId: "column-1", remoteId: "task-1",
    title: "行动", state: "active", sourceHash: "hash", ...overrides,
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
    return {
      blocked: this.blocked,
      resolvedTask: this.value.resolvedTask,
      receipt: this.value.receiptPresent === false ? undefined : {
        clientIdentity: "test-client",
        projectId: this.value.resolvedTask?.projectId ?? "list-1",
        operationId,
        marker: this.value.resolvedTask?.content ?? projectionMarker("uuid-1"),
        outcome: "unknown" as const,
        remoteTaskId: this.value.resolvedTask?.id,
        ...this.value.receiptOverride,
      },
    };
  }
  async removeResolved(operationId: string) { this.removed.push(operationId); }
  async removeReconciled(operationId: string) {
    if ((this.value.cleanupFailures ?? 0) > 0) {
      this.value.cleanupFailures = (this.value.cleanupFailures ?? 0) - 1;
      throw new Error("cleanup failed");
    }
    this.removed.push(operationId);
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
  nextResult?: ProjectionWriteReceipt;
  nextDeleteResult?: {
    operationId: string;
    outcome: "unknown" | "conflict" | "retryable" | "authorization" | "capability";
    message: string;
    conflictId?: string;
  };
  deleteAttempts = 0;
  beforeDelete?: () => void;
  onCreate?: (task: DidaTask) => Promise<void>;
  onReread?: (taskId: string, count: number) => void;
  rereads = new Map<string, number>();
  receipts = new Map<string, ProjectionWriteReceipt>();
  operationSequence = 0;
  reopened = 0;
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
    const receipt: ProjectionWriteReceipt = {
      operationId: `op-${++this.operationSequence}`,
      outcome: "verified",
      task: structuredClone(remote),
    };
    this.receipts.set(clientIdentity, receipt);
    return receipt;
  }
  async recoverCreate(clientIdentity: string) {
    return structuredClone(this.receipts.get(clientIdentity) ?? null);
  }
  async updateTask(task: DidaTask): Promise<ProjectionWriteReceipt> {
    this.updated.push(structuredClone(task));
    if (this.nextResult) { const result = this.nextResult; this.nextResult = undefined; return result; }
    this.tasks.set(task.id, structuredClone(task));
    return { operationId: `op-${++this.operationSequence}`, outcome: "verified", task: structuredClone(task) };
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
