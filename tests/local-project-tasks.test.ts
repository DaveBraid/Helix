import { describe, expect, it } from "vitest";
import {
  adoptAllPlanActions,
  parseManagedPlanActions,
} from "../src/domain/dida-project-projection";
import { stableHash } from "../src/domain/stable";
import {
  derivedLocalProjectStageStatus,
  inheritedLocalProjectActionState,
  LocalProjectTaskService,
  isLocalProjectTaskId,
  localProjectTaskPresentationTasks,
  localProjectStageTaskId,
  reconcileLocalPlanParentCompletion,
  type LocalProjectTaskSnapshot,
} from "../src/services/local-project-tasks";
import type {
  ProjectionMarkdownPort,
  ProjectionMarkdownRevision,
} from "../src/services/dida-project-projection";
import type { ProjectWorkspaceSnapshot } from "../src/services/project-workspace";

const stage = `---
helix-kind: helix-stage
helix-id: stage-1
---

# 阶段 1 · 验收

# 本阶段问题聚焦

# 计划行动

- [ ] 根任务
  - [ ] 子任务
- [ ]

# 行动结果

用户正文
`;

class MemoryMarkdown implements ProjectionMarkdownPort {
  writes = 0;
  constructor(private content = stage) {}
  async read(path: string): Promise<ProjectionMarkdownRevision | null> {
    return path === "Stage.md" ? { path, content: this.content, hash: stableHash(this.content) } : null;
  }
  async compareAndWrite(
    revision: ProjectionMarkdownRevision,
    content: string,
  ): Promise<ProjectionMarkdownRevision> {
    if (revision.hash !== stableHash(this.content)) throw new Error("CAS 竞争");
    this.content = content;
    this.writes += 1;
    return { path: revision.path, content, hash: stableHash(content) };
  }
  value(): string { return this.content; }
}

function workspace(): ProjectWorkspaceSnapshot {
  return {
    canvasPath: "Helix/Project Lineage.canvas",
    canvasRevisionHash: "canvas",
    managedMarkdownRevisionHashes: {},
    projects: [{
      id: "project-1",
      title: "项目 A",
      status: "active",
      notePath: "Project.md",
      color: "#123456",
      cycles: [{
        id: "stage-1",
        title: "验收",
        notePath: "Stage.md",
        sequence: 1,
        stageCode: "1",
        status: "active",
      }],
    }],
    nextStageSequenceByProject: { "project-1": 2 },
    relations: [],
    migrationWarnings: [],
    migrationItems: [],
    migrationRequired: false,
    canvasNodes: [],
    collapsedCompletedProjectIds: [],
    nativeRelationCandidates: [],
  };
}

function expectClean(snapshot: LocalProjectTaskSnapshot): void {
  expect(snapshot.issues).toEqual([]);
  expect(snapshot.tasks.every((task) => isLocalProjectTaskId(task.id))).toBe(true);
}

describe("LocalProjectTaskService", () => {
  it("adopts native Stage actions once and exposes only roots in the task collection", async () => {
    const markdown = new MemoryMarkdown();
    const service = new LocalProjectTaskService(markdown);
    const first = await service.snapshot(workspace(), { adoptUnmanaged: true });
    expectClean(first);
    expect(first.tasks).toHaveLength(2);
    expect(first.roots).toHaveLength(1);
    expect(first.roots[0]).toMatchObject({
      title: "根任务",
      projectTitle: "项目 A",
      stageTitle: "验收",
      childCount: 1,
    });
    expect(first.stageParents).toEqual([expect.objectContaining({
      taskId: localProjectStageTaskId("stage-1"),
      stageStatus: "active",
    })]);
    expect(first.tasks[1]?.parentUuid).toBe(first.tasks[0]?.uuid);
    expect(first.tasks.every((task) => task.state === "active")).toBe(true);
    expect(markdown.writes).toBe(1);
    await service.snapshot(workspace(), { adoptUnmanaged: true });
    expect(markdown.writes).toBe(1);
    expect(markdown.value()).toContain("- [ ]\n\n# 行动结果");
  });

  it("inherits the active Stage status for open actions without changing terminal states", () => {
    expect(inheritedLocalProjectActionState("active", "idea")).toBe("active");
    expect(inheritedLocalProjectActionState("active", "paused")).toBe("paused");
    expect(inheritedLocalProjectActionState("active", "completed")).toBe("completed");
    expect(inheritedLocalProjectActionState("idea", "idea")).toBe("idea");
  });

  it("uses the stable remote task identity after an action is synchronized", async () => {
    const content = stage.replace(
      "- [ ] 根任务\n  - [ ] 子任务",
      "- [ ] 已同步任务 <!-- helix-dida-action:v1 uuid=uuid-remote remoteId=remote-task-1 state=idea -->",
    );
    const snapshot = await new LocalProjectTaskService(new MemoryMarkdown(content)).snapshot(workspace());
    expect(snapshot.roots[0]).toMatchObject({
      id: "remote-task-1",
      remoteId: "remote-task-1",
      uuid: "uuid-remote",
      title: "已同步任务",
    });
    expect(snapshot.byId.get("remote-task-1")?.uuid).toBe("uuid-remote");
  });

  it("repairs orphaned legacy parent markers without hiding the Stage task tree", async () => {
    const content = stage.replace(
      "- [ ] 根任务\n  - [ ] 子任务",
      [
        "- [ ] 独立任务 <!-- helix-dida-action:v1 uuid=uuid-root remoteId=- state=idea -->",
        "- [x] 旧子任务 <!-- helix-dida-action:v2 uuid=uuid-orphan parent=missing-parent remoteId=- state=idea -->",
      ].join("\n"),
    );
    const markdown = new MemoryMarkdown(content);
    const snapshot = await new LocalProjectTaskService(markdown).snapshot(
      workspace(),
      { adoptUnmanaged: true },
    );
    expectClean(snapshot);
    expect(snapshot.roots.map((task) => task.title)).toEqual(["独立任务", "旧子任务"]);
    expect(snapshot.stageParents).toEqual([expect.objectContaining({
      taskId: localProjectStageTaskId("stage-1"),
      stageStatus: "active",
    })]);
    expect(markdown.value()).toContain(
      "helix-dida-action:v1 uuid=uuid-orphan remoteId=- state=completed",
    );
    expect(markdown.value()).not.toContain("parent=missing-parent");
    expect(markdown.writes).toBe(1);
  });

  it("maps the synchronized Stage parent without guessing from its title", async () => {
    const content = stage.replace(
      "helix-id: stage-1",
      "helix-id: stage-1\nhelix-dida-parent-task-id: remote-stage-1",
    );
    const snapshot = await new LocalProjectTaskService(new MemoryMarkdown(content)).snapshot(workspace());
    expect(snapshot.stageParents).toEqual([expect.objectContaining({
      taskId: "remote-stage-1",
      remoteTaskId: "remote-stage-1",
      projectId: "project-1",
      stageId: "stage-1",
      stageCode: "1",
      stageStatus: "active",
    })]);
    expect(snapshot.byRemoteParentTaskId.get("remote-stage-1")?.stageTitle).toBe("验收");
    expect(snapshot.byStageParentTaskId.get("remote-stage-1")?.stageTitle).toBe("验收");
  });

  it("shows an active local Stage parent before any remote projection exists", async () => {
    const snapshot = await new LocalProjectTaskService(new MemoryMarkdown(stage))
      .snapshot(workspace(), { adoptUnmanaged: true });
    const displayed = localProjectTaskPresentationTasks(snapshot, []);
    const parentId = localProjectStageTaskId("stage-1");
    expect(displayed.find((task) => task.id === parentId)).toMatchObject({
      title: "验收",
      status: 0,
      projectId: "helix-project:project-1",
    });
    expect(displayed.find((task) => task.title === "根任务")).toMatchObject({
      parentId,
      status: 0,
    });
    expect(snapshot.byStageParentTaskId.get(parentId)?.stageStatus).toBe("active");
    expect(snapshot.byRemoteParentTaskId.size).toBe(0);
  });

  it("keeps newly edited Stage actions visible inside the remote Helix Projects filter", async () => {
    const content = stage.replace(
      "helix-id: stage-1",
      "helix-id: stage-1\nhelix-dida-parent-task-id: remote-stage-1",
    );
    const snapshot = await new LocalProjectTaskService(new MemoryMarkdown(content))
      .snapshot(workspace(), { adoptUnmanaged: true });
    const displayed = localProjectTaskPresentationTasks(snapshot, [{
      id: "remote-stage-1",
      projectId: "helix-projects",
      title: "阶段父任务",
      status: 0,
      priority: 0,
    }]);
    expect(displayed).toHaveLength(3);
    expect(displayed.every((task) => task.projectId === "helix-projects")).toBe(true);
    const root = displayed.find((task) => task.title === "根任务")!;
    const child = displayed.find((task) => task.title === "子任务")!;
    expect(root).toMatchObject({ parentId: "remote-stage-1" });
    expect(child).toMatchObject({ parentId: root.id });
  });

  it("uses the Stage Markdown status as completion truth for its remote parent row", async () => {
    const content = stage
      .replace("helix-id: stage-1", "helix-id: stage-1\nhelix-dida-parent-task-id: remote-stage-1")
      .replace("helix-status: active", "helix-status: completed");
    const completedWorkspace = workspace();
    completedWorkspace.projects[0]!.cycles[0]!.status = "completed";
    const snapshot = await new LocalProjectTaskService(new MemoryMarkdown(content))
      .snapshot(completedWorkspace, { adoptUnmanaged: true });
    const displayed = localProjectTaskPresentationTasks(snapshot, [{
      id: "remote-stage-1",
      projectId: "helix-projects",
      title: "阶段父任务",
      status: 0,
      priority: 0,
    }]);
    expect(displayed.find((task) => task.id === "remote-stage-1")?.status).toBe(2);
  });

  it("creates a root and child, updates the child, then deletes the subtree with CAS", async () => {
    const markdown = new MemoryMarkdown(stage.replace("- [ ] 根任务\n  - [ ] 子任务\n", ""));
    const service = new LocalProjectTaskService(markdown);
    const rootId = await service.createTask(workspace(), {
      projectId: "project-1",
      stageId: "stage-1",
      title: "新根任务",
    });
    let current = await service.snapshot(workspace());
    const root = current.byId.get(rootId)!;
    const childId = await service.createTask(workspace(), {
      projectId: root.projectId,
      stageId: root.stageId,
      parentUuid: root.uuid,
      title: "新子任务",
      state: "active",
    });
    current = await service.snapshot(workspace());
    const child = current.byId.get(childId)!;
    await service.updateTask(workspace(), {
      projectId: child.projectId,
      stageId: child.stageId,
      uuid: child.uuid,
      expectedHash: child.revisionHash,
      title: "子任务已修改",
      state: "completed",
    });
    current = await service.snapshot(workspace());
    expect(current.byId.get(childId)).toMatchObject({ title: "子任务已修改", state: "completed" });
    const refreshedRoot = current.byId.get(rootId)!;
    await service.deleteTask(workspace(), {
      projectId: refreshedRoot.projectId,
      stageId: refreshedRoot.stageId,
      uuid: refreshedRoot.uuid,
      expectedHash: refreshedRoot.revisionHash,
    });
    expect((await service.snapshot(workspace())).tasks).toEqual([]);
    expect(markdown.value()).toContain("用户正文");
  });

  it("derives parent completion from children and reopens it when a child reopens", async () => {
    const markdown = new MemoryMarkdown();
    const service = new LocalProjectTaskService(markdown);
    let snapshot = await service.snapshot(workspace(), { adoptUnmanaged: true });
    const child = snapshot.tasks.find((task) => task.parentUuid)!;
    await service.updateTask(workspace(), {
      projectId: child.projectId,
      stageId: child.stageId,
      uuid: child.uuid,
      expectedHash: child.revisionHash,
      state: "completed",
    });
    snapshot = await service.snapshot(workspace());
    expect(snapshot.roots[0]?.state).toBe("completed");
    expect(markdown.value()).toContain("- [x] 根任务");

    const reopened = snapshot.byUuid.get(child.uuid)!;
    await service.updateTask(workspace(), {
      projectId: reopened.projectId,
      stageId: reopened.stageId,
      uuid: reopened.uuid,
      expectedHash: reopened.revisionHash,
      state: "idea",
    });
    snapshot = await service.snapshot(workspace());
    expect(snapshot.roots[0]?.state).toBe("active");
    expect(markdown.value()).toContain("- [ ] 根任务");
  });

  it("reconciles nested parents to a fixed point and derives the Stage parent status", () => {
    const nested = adoptAllPlanActions(`---\nhelix-kind: helix-stage\nhelix-id: stage-1\n---\n\n# 计划行动\n\n- [ ] 根\n  - [ ] 中\n    - [x] 叶\n`);
    const reconciled = reconcileLocalPlanParentCompletion(nested);
    const actions = parseManagedPlanActions(reconciled).actions;
    expect(actions.find((action) => action.title === "中")?.state).toBe("completed");
    expect(actions.find((action) => action.title === "根")?.state).toBe("completed");
    expect(derivedLocalProjectStageStatus("active", actions.filter((action) => !action.parentUuid))).toBe("recording");
    expect(derivedLocalProjectStageStatus("recording", [{ state: "completed" }])).toBeUndefined();
    expect(derivedLocalProjectStageStatus("recording", [{ state: "idea" }])).toBe("idea");
    expect(derivedLocalProjectStageStatus("completed", [{ state: "completed" }])).toBeUndefined();
    expect(derivedLocalProjectStageStatus("completed", [{ state: "idea" }])).toBe("idea");
    expect(derivedLocalProjectStageStatus("active", [{ state: "terminated" }])).toBeUndefined();
    expect(derivedLocalProjectStageStatus("paused", [{ state: "completed" }])).toBeUndefined();
  });

  it("refuses stale writes without changing Markdown", async () => {
    const markdown = new MemoryMarkdown();
    const service = new LocalProjectTaskService(markdown);
    const current = await service.snapshot(workspace(), { adoptUnmanaged: true });
    const root = current.roots[0]!;
    const before = markdown.value();
    await expect(service.updateTask(workspace(), {
      projectId: root.projectId,
      stageId: root.stageId,
      uuid: root.uuid,
      expectedHash: "stale",
      title: "覆盖",
    })).rejects.toThrow(/已变化/);
    expect(markdown.value()).toBe(before);
  });

  it("saves the root and direct child collection in one Markdown CAS", async () => {
    const markdown = new MemoryMarkdown();
    const service = new LocalProjectTaskService(markdown);
    const current = await service.snapshot(workspace(), { adoptUnmanaged: true });
    const root = current.roots[0]!;
    const child = current.tasks.find((task) => task.parentUuid === root.uuid)!;
    const writesBefore = markdown.writes;
    await service.saveTask(workspace(), {
      projectId: root.projectId,
      stageId: root.stageId,
      uuid: root.uuid,
      expectedHash: root.revisionHash,
      draft: {
        title: "根任务已改",
        state: "active",
        content: "实验备注",
        startDate: "2026-08-10T01:00:00.000Z",
        dueDate: "2026-08-10T02:00:00.000Z",
        timeZone: "Asia/Shanghai",
        isAllDay: false,
        priority: 5,
        tags: ["科研", "验收"],
        children: [
          {
            title: "新增子任务",
            state: "idea",
            startDate: "2026-08-11T01:00:00.000Z",
            dueDate: "2026-08-11T02:00:00.000Z",
            timeZone: "Asia/Shanghai",
            priority: 3,
          },
          { uuid: child.uuid, title: "子任务已完成", state: "completed", priority: 0 },
        ],
      },
    });
    expect(markdown.writes).toBe(writesBefore + 1);
    const saved = await service.snapshot(workspace());
    expect(saved.roots[0]?.title).toBe("根任务已改");
    expect(saved.roots[0]).toMatchObject({
      content: "实验备注",
      startDate: "2026-08-10T01:00:00.000Z",
      dueDate: "2026-08-10T02:00:00.000Z",
      timeZone: "Asia/Shanghai",
      priority: 5,
      tags: ["科研", "验收"],
    });
    expect(saved.tasks.filter((task) => task.parentUuid === root.uuid)).toEqual([
      expect.objectContaining({
        title: "新增子任务",
        state: "active",
        startDate: "2026-08-11T01:00:00.000Z",
        dueDate: "2026-08-11T02:00:00.000Z",
        priority: 3,
      }),
      expect.objectContaining({ uuid: child.uuid, title: "子任务已完成", state: "completed" }),
    ]);
  });
});
