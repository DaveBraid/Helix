import type { ProjectionSyncSummary } from "./dida-project-projection";

export interface ProjectAutoSyncCandidate {
  projectId: string;
  fingerprint: string;
}

export interface ProjectAutoSyncScan {
  candidates: ProjectAutoSyncCandidate[];
  failures: ProjectAutoSyncCandidate[];
}

export interface ProjectAutoSyncReport {
  blocked: number;
  failed: number;
  frozen: number;
  synchronized: number;
  mutations: number;
}

export interface ProjectAutoSyncSource {
  scan(): Promise<ProjectAutoSyncScan>;
  synchronize(projectId: string): Promise<ProjectionSyncSummary>;
  report(value: ProjectAutoSyncReport): void;
}

export interface ProjectAutoSyncTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: ProjectAutoSyncTimers = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function isBlocked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /尚未|条件不满足|冻结|冲突|结果未知|队列|授权|只读|身份|合同|目标/.test(message);
}

/** 只负责唤醒既有安全同步路径；不持久化任务、不直接写远端。 */
export class ProjectAutoSyncCoordinator {
  private timer: unknown;
  private running = false;
  private rerun = false;
  private disposed = false;
  private forceAll = false;
  private readiness?: boolean;
  private readonly forceProjects = new Set<string>();
  private readonly settled = new Map<string, string>();
  private readonly deferred = new Map<string, string>();
  private readonly reportedIssues = new Map<string, string>();

  constructor(
    private readonly source: ProjectAutoSyncSource,
    private readonly debounceMs = 650,
    private readonly timers: ProjectAutoSyncTimers = DEFAULT_TIMERS,
  ) {}

  request(force = false): void {
    if (this.disposed) return;
    this.forceAll ||= force;
    if (this.running) {
      this.rerun = true;
      return;
    }
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  invalidate(projectId?: string): void {
    if (projectId) {
      this.settled.delete(projectId);
      this.deferred.delete(projectId);
      this.reportedIssues.delete(projectId);
      this.forceProjects.add(projectId);
    } else {
      this.settled.clear();
      this.deferred.clear();
      this.reportedIssues.clear();
      this.forceAll = true;
    }
    this.request();
  }

  updateReadiness(ready: boolean): void {
    if (this.readiness !== true && ready) this.invalidate();
    this.readiness = ready;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.timer !== undefined) {
      this.timers.clear(this.timer);
      this.timer = undefined;
    }
    if (this.running) {
      this.rerun = true;
      return;
    }
    // readiness 未完成或明确不满足时连 scan 都不执行，避免禁用态、合同失效或
    // 恢复锁期间读取项目后意外走到远端同步入口。false→true 会重新唤醒。
    if (this.readiness !== true) return;
    this.running = true;
    const attempted = new Map<string, string>();
    const mutatedProjects = new Set<string>();
    const total = emptyReport();
    let pass = 0;
    try {
      do {
        pass += 1;
        this.rerun = false;
        const forceAll = this.forceAll;
        const forceProjects = new Set(this.forceProjects);
        this.forceAll = false;
        this.forceProjects.clear();
        let scan: ProjectAutoSyncScan;
        try {
          scan = await this.source.scan();
        } catch {
          const report = emptyReport();
          this.reportIssue("__workspace__", "unavailable", "failed", report);
          mergeReport(total, report);
          break;
        }
        const report = emptyReport();
        for (const failure of scan.failures) {
          this.reportIssue(failure.projectId, failure.fingerprint, "failed", report);
        }
        const pending = scan.candidates.filter((candidate) =>
          (forceAll || forceProjects.has(candidate.projectId) ||
            (this.settled.get(candidate.projectId) !== candidate.fingerprint &&
              this.deferred.get(candidate.projectId) !== candidate.fingerprint)) &&
          (forceAll || forceProjects.has(candidate.projectId) ||
            attempted.get(candidate.projectId) !== candidate.fingerprint));
        const successful = new Map<string, string>();
        for (const candidate of pending) {
          attempted.set(candidate.projectId, candidate.fingerprint);
          try {
            const summary = await this.source.synchronize(candidate.projectId);
            if (summary.frozen.length > 0) {
              this.deferred.set(candidate.projectId, candidate.fingerprint);
              this.reportIssue(candidate.projectId, candidate.fingerprint, "blocked", report, summary.frozen.length);
            } else {
              successful.set(candidate.projectId, candidate.fingerprint);
              const mutations = projectionMutationCount(summary);
              report.mutations += mutations;
              if (mutations > 0) mutatedProjects.add(candidate.projectId);
              this.deferred.delete(candidate.projectId);
              this.reportedIssues.delete(candidate.projectId);
            }
          } catch (error) {
            const kind = isBlocked(error) ? "blocked" : "failed";
            if (kind === "blocked") this.deferred.set(candidate.projectId, candidate.fingerprint);
            this.reportIssue(
              candidate.projectId,
              candidate.fingerprint,
              kind,
              report,
            );
          }
        }
        if (successful.size > 0) {
          let fresh: ProjectAutoSyncScan;
          try {
            fresh = await this.source.scan();
          } catch {
            this.reportIssue("__workspace__", "unavailable", "failed", report);
            fresh = { candidates: [], failures: [] };
          }
          for (const failure of fresh.failures) {
            this.reportIssue(failure.projectId, failure.fingerprint, "failed", report);
          }
          for (const [projectId, inputFingerprint] of successful) {
            const candidate = fresh.candidates.find((item) => item.projectId === projectId);
            if (!candidate) continue;
            if (candidate.fingerprint === inputFingerprint) {
              this.settled.set(projectId, inputFingerprint);
            } else {
              this.rerun = true;
            }
          }
        }
        mergeReport(total, report);
      } while (this.rerun && !this.disposed && pass < 4);
      if (this.rerun && !this.disposed) {
        const report = emptyReport();
        this.reportIssue("__convergence__", "limit", "failed", report);
        mergeReport(total, report);
      }
    } finally {
      this.running = false;
    }
    total.synchronized = mutatedProjects.size;
    if (total.blocked > 0 || total.failed > 0 || total.mutations > 0) {
      this.source.report(total);
    }
  }

  private reportIssue(
    projectId: string,
    fingerprint: string,
    kind: "blocked" | "failed",
    report: ProjectAutoSyncReport,
    frozen = 0,
  ): void {
    const state = `${fingerprint}:${kind}`;
    if (this.reportedIssues.get(projectId) === state) return;
    this.reportedIssues.set(projectId, state);
    report[kind] += 1;
    report.frozen += frozen;
  }
}

function emptyReport(): ProjectAutoSyncReport {
  return { blocked: 0, failed: 0, frozen: 0, synchronized: 0, mutations: 0 };
}

function mergeReport(target: ProjectAutoSyncReport, source: ProjectAutoSyncReport): void {
  target.blocked += source.blocked;
  target.failed += source.failed;
  target.frozen += source.frozen;
  target.synchronized += source.synchronized;
  target.mutations += source.mutations;
}

function projectionMutationCount(summary: ProjectionSyncSummary): number {
  return summary.createdParents + summary.updatedParents + summary.completedParents +
    summary.createdActions + summary.updatedActions + summary.completedActions + summary.deletedActions;
}
