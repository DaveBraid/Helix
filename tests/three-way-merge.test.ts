import { describe, expect, it } from "vitest";
import { createSnapshot } from "../src/sync/snapshots";
import {
  applyResolutions,
  buildConflictFields,
  setFieldResolution,
  unresolvedFields,
} from "../src/sync/three-way-merge";
import type { SyncConflict } from "../src/sync/types";

function conflictOf(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): SyncConflict {
  const now = "2026-07-30T00:00:00.000Z";
  return {
    id: "conflict-1",
    kind: "task",
    entityId: "task-1",
    title: "测试任务",
    createdAt: now,
    updatedAt: now,
    status: "open",
    base: createSnapshot("task", "task-1", base, { capturedAt: now }),
    local: createSnapshot("task", "task-1", local, { capturedAt: now }),
    remote: createSnapshot("task", "task-1", remote, { capturedAt: now }),
    fields: buildConflictFields(base, local, remote),
    remoteRecheckCount: 0,
    sourceDeviceId: "device-a",
  };
}

describe("three-way conflict fields", () => {
  it("labels project view-mode conflicts for manual field resolution", () => {
    expect(buildConflictFields(
      { viewMode: "list" },
      { viewMode: "kanban" },
      { viewMode: "timeline" },
    )).toMatchObject([{ path: "viewMode", label: "清单视图" }]);
  });

  it("keeps read-only board placement out of writable task conflicts", () => {
    const fields = buildConflictFields(
      { title: "Base", columnId: "todo" },
      { title: "Local", columnId: "todo" },
      { title: "Base", columnId: "done" },
    );
    expect(fields.map((field) => field.path)).toEqual(["title"]);
  });

  it("excludes server-derived columnName from ordinary three-way comparison", () => {
    const fields = buildConflictFields(
      { title: "Base", columnName: "待办" },
      { title: "Base", columnName: "待办" },
      { title: "Base", columnName: "进行中" },
    );
    expect(fields).toEqual([]);
  });

  it("excludes App-owned completion fields from writable conflict choices", () => {
    const fields = buildConflictFields(
      { title: "Base", status: 0, completedTime: null },
      { title: "Base", status: 2, completedTime: "2026-08-04T00:00:00Z" },
      { title: "Base", status: 0, completedTime: null },
    );
    expect(fields).toEqual([]);
  });

  it("does not create a field conflict for server-managed etimestamp", () => {
    const fields = buildConflictFields(
      { title: "Base", etimestamp: 10 },
      { title: "Local", etimestamp: 10 },
      { title: "Base", etimestamp: 11 },
    );
    expect(fields.map((field) => field.path)).toEqual(["title"]);
  });

  it("distinguishes local-only, remote-only, same, and divergent changes", () => {
    const fields = buildConflictFields(
      { title: "base", priority: 1, status: 0, content: "old" },
      { title: "local", priority: 1, status: 2, content: "same" },
      { title: "base", priority: 5, status: 2, content: "same" },
    );
    expect(fields.find((field) => field.path === "title")).toMatchObject({
      localChanged: true,
      remoteChanged: false,
      suggestedChoice: "local",
    });
    expect(fields.find((field) => field.path === "priority")).toMatchObject({
      localChanged: false,
      remoteChanged: true,
      suggestedChoice: "remote",
    });
    expect(fields.find((field) => field.path === "status")).toBeUndefined();
    expect(fields.find((field) => field.path === "content")).toMatchObject({
      localChanged: true,
      remoteChanged: true,
      sameResult: true,
      group: "text",
    });
  });

  it("requires explicit choices for ordinary changed fields in a contested entity", () => {
    let conflict = conflictOf(
      { title: "base", dueDate: "2026-07-30" },
      { title: "local", dueDate: "2026-07-30" },
      { title: "base", dueDate: "2026-07-31" },
    );
    expect(unresolvedFields(conflict)).toHaveLength(2);
    conflict = setFieldResolution(conflict, "title", "local");
    conflict = setFieldResolution(conflict, "dueDate", "remote");
    expect(applyResolutions(conflict)).toEqual({
      title: "local",
      dueDate: "2026-07-31",
    });
  });

  it("supports a custom merged value", () => {
    let conflict = conflictOf(
      { content: "base" },
      { content: "local" },
      { content: "remote" },
    );
    conflict = setFieldResolution(conflict, "content", "custom", "merged");
    expect(applyResolutions(conflict)).toEqual({ content: "merged" });
  });

  it("resolves checklist items independently and represents deletion as a whole-record choice", () => {
    let conflict = conflictOf(
      { items: [{ id: "a", title: "base-a" }, { id: "b", title: "base-b" }] },
      { items: [{ id: "a", title: "local-a" }, { id: "b", title: "base-b" }] },
      { items: [{ id: "a", title: "base-a" }, { id: "b", title: "remote-b" }] },
    );
    expect(conflict.fields.map((field) => field.path)).toEqual(["items[a].title", "items[b].title"]);
    expect(applyResolutions(conflict)).toEqual({
      items: [{ id: "a", title: "local-a" }, { id: "b", title: "remote-b" }],
    });

    const deletion = buildConflictFields(
      { title: "base" },
      null,
      { title: "remote" },
    );
    expect(deletion).toHaveLength(1);
    expect(deletion[0]).toMatchObject({ path: "$", group: "deletion" });
  });

  it("exposes only competing owned title/status while preserving remote item order and unknown fields", () => {
    let conflict = conflictOf(
      { items: [{ id: "owned", title: "base", status: 0, vendor: "base" }, { id: "ordinary", title: "O", status: 0 }] },
      { items: [{ id: "owned", title: "local", status: 2, vendor: "base" }, { id: "ordinary", title: "O", status: 0 }] },
      { items: [{ id: "ordinary", title: "O", status: 0, remoteOnly: 1 }, { id: "owned", title: "remote", status: 0, vendor: "remote" }] },
    );
    expect(conflict.fields.map((field) => field.path)).toEqual([
      "items[owned].title", "items[owned].status",
    ]);
    expect(unresolvedFields(conflict).map((field) => field.path)).toEqual(["items[owned].title"]);
    conflict = setFieldResolution(conflict, "items[owned].title", "local");
    expect(applyResolutions(conflict)).toEqual({
      items: [
        { id: "ordinary", title: "O", status: 0, remoteOnly: 1 },
        { id: "owned", title: "local", status: 2, vendor: "remote" },
      ],
    });
  });

  it("validates custom owned fields and removes completedTime when reopening", () => {
    let conflict = conflictOf(
      { items: [{ id: "owned", title: "base", status: 2, completedTime: "2026-08-01T00:00:00Z" }] },
      { items: [{ id: "owned", title: "local", status: 0 }] },
      { items: [{ id: "owned", title: "remote", status: 2, completedTime: "2026-08-02T00:00:00Z" }] },
    );
    expect(() => setFieldResolution(conflict, "items[owned].title", "custom", " ")).toThrow(/非空/);
    expect(() => setFieldResolution(conflict, "items[owned].title", "custom", " 人工标题 ")).toThrow(/首尾空格/);
    expect(() => setFieldResolution(conflict, "items[owned].title", "custom", "注入\n下一行")).toThrow(/单行/);
    expect(() => setFieldResolution(conflict, "items[owned].title", "custom", "<!-- helix-dida-action:伪造 -->")).toThrow(/同步标记/);
    expect(() => setFieldResolution(conflict, "items[owned].status", "custom", 1)).toThrow(/只能/);
    conflict = setFieldResolution(conflict, "items[owned].title", "custom", "人工标题");
    expect(applyResolutions(conflict)).toEqual({
      items: [{ id: "owned", title: "人工标题", status: 0 }],
    });
  });
});
