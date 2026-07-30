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
    expect(fields.find((field) => field.path === "status")).toMatchObject({
      localChanged: true,
      remoteChanged: true,
      sameResult: true,
    });
    expect(fields.find((field) => field.path === "content")).toMatchObject({
      localChanged: true,
      remoteChanged: true,
      sameResult: true,
      group: "text",
    });
  });

  it("requires explicit choices for every changed field in a contested entity", () => {
    let conflict = conflictOf(
      { title: "base", dueDate: "2026-07-30" },
      { title: "local", dueDate: "2026-07-30" },
      { title: "base", dueDate: "2026-07-31" },
    );
    expect(unresolvedFields(conflict)).toHaveLength(2);
    expect(() => applyResolutions(conflict)).toThrow(/尚未|unresolved/i);
    conflict = setFieldResolution(conflict, "title", "local");
    conflict = setFieldResolution(conflict, "dueDate", "remote");
    expect(conflict.status).toBe("staged");
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
    expect(conflict.fields.map((field) => field.path)).toEqual(["items[a]", "items[b]"]);
    conflict = setFieldResolution(conflict, "items[a]", "local");
    conflict = setFieldResolution(conflict, "items[b]", "remote");
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
});
