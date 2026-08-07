import { describe, expect, it, vi } from "vitest";
import {
  ProjectAutoSyncCoordinator,
  type ProjectAutoSyncReport,
} from "../src/services/project-auto-sync";
import { RemoteWriteGate } from "../src/services/remote-write-gate";

const summary = (frozen = 0) => ({
  createdParents: 0, updatedParents: 0, completedParents: 0,
  createdActions: 0, updatedActions: 0, completedActions: 0, deletedActions: 0,
  frozen: Array.from({ length: frozen }, (_, index) => ({
    uuid: `u${index}`, reason: "conflict" as const, message: "blocked",
  })),
});

describe("ProjectAutoSyncCoordinator", () => {
  it("debounces events, reruns a changed post-write fingerprint, then stays silent once settled", async () => {
    vi.useFakeTimers();
    let fingerprint = "before";
    const report = vi.fn();
    const synchronize = vi.fn(async () => {
      if (fingerprint === "before") {
        fingerprint = "after";
        coordinator.request();
      }
      return summary();
    });
    const coordinator = new ProjectAutoSyncCoordinator({
      scan: async () => ({ candidates: [{ projectId: "p1", fingerprint }], failures: [] }),
      synchronize,
      report,
    }, 100);
    coordinator.request();
    coordinator.request();
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(report).not.toHaveBeenCalled();
    await coordinator.flush();
    expect(synchronize).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("never settles frozen work and deduplicates the same project/fingerprint issue", async () => {
    const reports: ProjectAutoSyncReport[] = [];
    const synchronize = vi.fn(async () => summary(1));
    const coordinator = new ProjectAutoSyncCoordinator({
      scan: async () => ({ candidates: [{ projectId: "p1", fingerprint: "same" }], failures: [] }),
      synchronize,
      report: (value) => reports.push(value),
    });
    await coordinator.flush();
    await coordinator.flush();
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([{ blocked: 1, failed: 0, frozen: 1 }]);
    coordinator.invalidate("p1");
    await coordinator.flush();
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(reports).toEqual([
      { blocked: 1, failed: 0, frozen: 1 },
      { blocked: 1, failed: 0, frozen: 1 },
    ]);
  });

  it("lets an explicit reconciliation invalidation retry the same fingerprint in flight", async () => {
    const reports: ProjectAutoSyncReport[] = [];
    const synchronize = vi.fn(async () => {
      if (synchronize.mock.calls.length === 1) coordinator.invalidate("p1");
      return summary(1);
    });
    const coordinator = new ProjectAutoSyncCoordinator({
      scan: async () => ({ candidates: [{ projectId: "p1", fingerprint: "same" }], failures: [] }),
      synchronize,
      report: (value) => reports.push(value),
    });
    await coordinator.flush();
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(reports).toEqual([{ blocked: 1, failed: 0, frozen: 1 }]);
  });

  it("isolates scan failures so healthy projects still synchronize", async () => {
    const reports: ProjectAutoSyncReport[] = [];
    const synchronize = vi.fn(async () => summary());
    const coordinator = new ProjectAutoSyncCoordinator({
      scan: async () => ({
        candidates: [{ projectId: "healthy", fingerprint: "ok" }],
        failures: [{ projectId: "broken", fingerprint: "bad" }],
      }),
      synchronize,
      report: (value) => reports.push(value),
    });
    await coordinator.flush();
    expect(synchronize).toHaveBeenCalledWith("healthy");
    expect(reports).toEqual([{ blocked: 0, failed: 1, frozen: 0 }]);
    await coordinator.flush();
    expect(reports).toHaveLength(1);
  });

  it("reports a blocked/failed transition once per changed fingerprint", async () => {
    let fingerprint = "one";
    let failure: "blocked" | "failed" = "blocked";
    const reports: ProjectAutoSyncReport[] = [];
    const coordinator = new ProjectAutoSyncCoordinator({
      scan: async () => ({ candidates: [{ projectId: "p1", fingerprint }], failures: [] }),
      synchronize: async () => {
        if (failure === "blocked") throw new Error("授权合同失效");
        throw new Error("unexpected");
      },
      report: (value) => reports.push(value),
    });
    await coordinator.flush();
    await coordinator.flush();
    fingerprint = "two";
    await coordinator.flush();
    failure = "failed";
    coordinator.invalidate("p1");
    await coordinator.flush();
    expect(reports).toEqual([
      { blocked: 1, failed: 0, frozen: 0 },
      { blocked: 1, failed: 0, frozen: 0 },
      { blocked: 0, failed: 1, frozen: 0 },
    ]);
  });

  it("invalidates only the reconciled project without replaying another settled project", async () => {
    const synchronize = vi.fn(async (_projectId: string) => summary());
    const coordinator = new ProjectAutoSyncCoordinator({
      scan: async () => ({
        candidates: [
          { projectId: "p1", fingerprint: "one" },
          { projectId: "p2", fingerprint: "two" },
        ],
        failures: [],
      }),
      synchronize,
      report: vi.fn(),
    });
    await coordinator.flush();
    coordinator.invalidate("p1");
    await coordinator.flush();
    expect(synchronize.mock.calls.map(([projectId]) => projectId)).toEqual(["p1", "p2", "p1"]);
  });

  it("globally retries when a real queue clears and the final lease makes readiness ready", async () => {
    const queue = ["op-1"];
    const synchronize = vi.fn(async () => summary());
    let coordinator!: ProjectAutoSyncCoordinator;
    const gate = new RemoteWriteGate(() => {
      coordinator.updateReadiness(queue.length === 0 && gate.isIdle());
    });
    coordinator = new ProjectAutoSyncCoordinator({
      scan: async () => ({ candidates: [{ projectId: "p1", fingerprint: "same" }], failures: [] }),
      synchronize,
      report: vi.fn(),
    });
    await coordinator.flush();
    coordinator.updateReadiness(false);
    const release = gate.enterShared();
    queue.pop();
    coordinator.updateReadiness(queue.length === 0 && gate.isIdle());
    await coordinator.flush();
    expect(synchronize).toHaveBeenCalledTimes(1);
    release();
    await coordinator.flush();
    expect(synchronize).toHaveBeenCalledTimes(2);
    coordinator.updateReadiness(true);
    await coordinator.flush();
    expect(synchronize).toHaveBeenCalledTimes(2);
  });

  it("stays silent while projection is disabled and cancels pending work on dispose", async () => {
    vi.useFakeTimers();
    const synchronize = vi.fn();
    const report = vi.fn();
    const coordinator = new ProjectAutoSyncCoordinator({
      scan: async () => ({ candidates: [], failures: [] }), synchronize, report,
    }, 100);
    coordinator.request();
    coordinator.dispose();
    await vi.runAllTimersAsync();
    expect(synchronize).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
