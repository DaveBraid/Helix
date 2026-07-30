import { describe, expect, it } from "vitest";
import {
  claimConflictApplication,
  releaseConflictApplication,
} from "../src/services/conflict-claim";
import { createSnapshot } from "../src/sync/snapshots";
import type { SyncConflict } from "../src/sync/types";

function conflict(): SyncConflict {
  const base = createSnapshot("task", "task-1", {
    id: "task-1",
    projectId: "project-1",
    title: "Base",
    status: 0,
  });
  return {
    id: "conflict-1",
    kind: "task",
    entityId: "task-1",
    title: "Task",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    status: "staged",
    base,
    local: base,
    remote: base,
    fields: [],
    remoteRecheckCount: 0,
    sourceDeviceId: "device-a",
  };
}

describe("conflict application claim", () => {
  it("atomically blocks a second application and can release a definite failure", () => {
    const conflicts = [conflict()];
    const previous = claimConflictApplication(conflicts, "conflict-1");
    expect(conflicts[0]?.status).toBe("applying");
    expect(() => claimConflictApplication(conflicts, "conflict-1")).toThrow(
      /不能重复提交/,
    );
    releaseConflictApplication(conflicts, "conflict-1", previous);
    expect(conflicts[0]?.status).toBe("staged");
  });

  it("refuses to persist applying while a field is unresolved", () => {
    const pending = conflict();
    pending.status = "open";
    pending.fields = [{
      path: "title",
      label: "标题",
      baseValue: "Base",
      localValue: "Local",
      remoteValue: "Remote",
      localChanged: true,
      remoteChanged: true,
      sameResult: false,
      group: "text",
    }];
    expect(() => claimConflictApplication([pending], pending.id)).toThrow(
      /仍有字段尚未选择/,
    );
    expect(pending.status).toBe("open");
  });
});
