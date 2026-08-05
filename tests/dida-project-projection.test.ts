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
  actionCreateClientIdentity,
  parentCreateClientIdentity,
  type ProjectionCatalogPort,
  type ProjectionMarkdownPort,
  type ProjectionMarkdownRevision,
  type ProjectionPersistentState,
  type ProjectionStatePort,
  type ProjectionTaskPipeline,
  type ProjectionWriteReceipt,
  type ExistingHelixTaskQueuePort,
} from "../src/services/dida-project-projection";

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
});

function ledger(overrides: Partial<ProjectionLedgerEntry> = {}): ProjectionLedgerEntry {
  return {
    uuid: "uuid-1", projectId: "project-1", stageId: "stage-1", parentTaskId: "parent-1",
    targetProjectId: "list-1", targetColumnId: "column-1", remoteId: "task-1",
    title: "行动", state: "active", sourceHash: "hash", ...overrides,
  };
}

function input(overrides: Partial<{ projectTitle: string; projectStatus: "planned" | "active" | "paused" | "completed" | "terminated" }> = {}) {
  return {
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
    projects: async () => [project],
    columns: async () => [column],
    readiness: async () => ({ ...ready, taskReopenVerified }),
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
  constructor(private readonly files: Record<string, string>) {}
  async read(path: string): Promise<ProjectionMarkdownRevision | null> {
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
  constructor(public value: ProjectionPersistentState) {}
  async read() { return structuredClone(this.value); }
  async write(expected: ProjectionPersistentState, next: ProjectionPersistentState) {
    if (stableHash(expected) !== stableHash(this.value)) throw new Error("state CAS conflict");
    this.value = structuredClone(next);
  }
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
