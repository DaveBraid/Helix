import { describe, expect, it } from "vitest";
import type { DidaProject, DidaTask } from "../src/domain/entities";
import { createDefaultData } from "../src/storage/model";
import { ingestRemoteRecords } from "../src/sync/remote-ingest";
import { createSnapshot } from "../src/sync/snapshots";

function task(title: string): DidaTask {
  return { id: "task-1", projectId: "project-1", title, status: 0 };
}

describe("remote snapshot ingestion", () => {
  it("initializes Base and Local only for first import", () => {
    const data = createDefaultData("device-a");
    ingestRemoteRecords(data, "task", [task("remote")], {
      capturedAt: "2026-07-30T00:00:00Z",
    });
    expect(data.baseSnapshots["task:task-1"]?.value).toMatchObject({ title: "remote" });
    expect(data.localSnapshots["task:task-1"]?.value).toMatchObject({ title: "remote" });
  });

  it("never overwrites local edits and opens a reachable three-way conflict", () => {
    const data = createDefaultData("device-a");
    data.baseSnapshots["task:task-1"] = createSnapshot("task", "task-1", task("base"));
    data.localSnapshots["task:task-1"] = createSnapshot("task", "task-1", task("local"));
    ingestRemoteRecords(data, "task", [task("remote")], {
      capturedAt: "2026-07-30T00:00:00Z",
    });
    expect(data.localSnapshots["task:task-1"]?.value).toMatchObject({ title: "local" });
    expect(data.baseSnapshots["task:task-1"]?.value).toMatchObject({ title: "base" });
    expect(data.conflicts).toHaveLength(1);
    expect(data.conflicts[0]?.fields.find((field) => field.path === "title")).toMatchObject({
      localValue: "local",
      remoteValue: "remote",
    });
  });

  it("advances Base when an independent remote edit converges to the local value", () => {
    const data = createDefaultData("device-a");
    data.baseSnapshots["task:task-1"] = createSnapshot("task", "task-1", task("base"));
    data.localSnapshots["task:task-1"] = createSnapshot("task", "task-1", task("same result"));

    ingestRemoteRecords(data, "task", [task("same result")], {
      capturedAt: "2026-07-30T00:00:00Z",
    });

    expect(data.baseSnapshots["task:task-1"]?.value).toMatchObject({ title: "same result" });
    expect(data.localSnapshots["task:task-1"]?.value).toMatchObject({ title: "same result" });
    expect(data.conflicts).toEqual([]);
  });

  it("adopts the server completion time when a queued completion already converged remotely", () => {
    const data = createDefaultData("device-completion");
    const base = task("same task");
    const local = { ...base, status: 2, completedTime: null };
    const remote = { ...base, status: 2, completedTime: "2026-08-19T08:00:00.000Z" };
    data.baseSnapshots["task:task-1"] = createSnapshot("task", "task-1", base);
    data.localSnapshots["task:task-1"] = createSnapshot("task", "task-1", local);
    data.queue.push({
      id: "op-complete",
      kind: "task",
      entityId: "task-1",
      projectId: "project-1",
      operation: "complete",
      createdAt: "2026-08-19T07:59:59.000Z",
      updatedAt: "2026-08-19T07:59:59.000Z",
      attempts: 0,
      status: "pending",
      base: data.baseSnapshots["task:task-1"],
      local: data.localSnapshots["task:task-1"],
    });

    ingestRemoteRecords(data, "task", [remote], {
      capturedAt: "2026-08-19T08:00:01.000Z",
    });

    expect(data.localSnapshots["task:task-1"]?.value).toMatchObject(remote);
    expect(data.baseSnapshots["task:task-1"]?.value).toMatchObject(remote);
    expect(data.conflicts).toEqual([]);
  });

  it("accepts remote-only changes but requires a conflict for remote deletion versus local edit", () => {
    const data = createDefaultData("device-a");
    data.baseSnapshots["task:task-1"] = createSnapshot("task", "task-1", task("base"));
    data.localSnapshots["task:task-1"] = createSnapshot("task", "task-1", task("base"));
    ingestRemoteRecords(data, "task", [task("remote")], {
      capturedAt: "2026-07-30T00:00:00Z",
    });
    expect(data.localSnapshots["task:task-1"]?.value).toMatchObject({ title: "remote" });

    data.localSnapshots["task:task-1"] = createSnapshot("task", "task-1", task("local"));
    ingestRemoteRecords(data, "task", [], {
      capturedAt: "2026-07-30T01:00:00Z",
      coveredEntityIds: new Set(["task-1"]),
    });
    expect(data.localSnapshots["task:task-1"]?.value).toMatchObject({ title: "local" });
    expect(data.conflicts[0]?.fields).toMatchObject([{ path: "$", group: "deletion" }]);
  });

  it("removes a remotely deleted project only when the project list has complete coverage", () => {
    const data = createDefaultData("device-a");
    const project: DidaProject = { id: "project-1", name: "Project" };
    data.baseSnapshots["project:project-1"] = createSnapshot("project", "project-1", project);
    data.localSnapshots["project:project-1"] = createSnapshot("project", "project-1", project);
    ingestRemoteRecords(data, "project", [], {
      capturedAt: "2026-07-30T00:00:00Z",
      coveredEntityIds: new Set(["project-1"]),
    });
    expect(data.baseSnapshots["project:project-1"]).toBeUndefined();
    expect(data.localSnapshots["project:project-1"]).toBeUndefined();
  });
});
