export interface AutoSyncPlanInput {
  recoveryMode: boolean;
  tokenConfigured: boolean;
  autoSync: boolean;
  runImmediately: boolean;
  intervalMinutes: number;
}

export interface AutoSyncPlan {
  runImmediately: boolean;
  intervalMs: number | null;
}

export function autoSyncPlan(input: AutoSyncPlanInput): AutoSyncPlan {
  if (input.recoveryMode || !input.tokenConfigured) {
    return { runImmediately: false, intervalMs: null };
  }
  return {
    runImmediately: input.runImmediately,
    intervalMs: input.autoSync
      ? Math.max(5, input.intervalMinutes) * 60_000
      : null,
  };
}
