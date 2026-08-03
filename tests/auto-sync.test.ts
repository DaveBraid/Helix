import { describe, expect, it } from "vitest";
import { autoSyncPlan } from "../src/services/auto-sync";

describe("autoSyncPlan", () => {
  it("runs immediately and schedules an interval on an authorized auto-sync startup", () => {
    expect(autoSyncPlan({
      recoveryMode: false,
      tokenConfigured: true,
      autoSync: true,
      runImmediately: true,
      intervalMinutes: 10,
    })).toEqual({ runImmediately: true, intervalMs: 600_000 });
  });

  it("allows a one-time credential refresh while automatic sync is disabled", () => {
    expect(autoSyncPlan({
      recoveryMode: false,
      tokenConfigured: true,
      autoSync: false,
      runImmediately: true,
      intervalMinutes: 10,
    })).toEqual({ runImmediately: true, intervalMs: null });
  });

  it("does not run immediately for an unrelated settings refresh", () => {
    expect(autoSyncPlan({
      recoveryMode: false,
      tokenConfigured: true,
      autoSync: true,
      runImmediately: false,
      intervalMinutes: 3,
    })).toEqual({ runImmediately: false, intervalMs: 300_000 });
  });

  it.each([
    { recoveryMode: true, tokenConfigured: true },
    { recoveryMode: false, tokenConfigured: false },
  ])("does not contact Dida when recovery or authorization blocks it", (blocked) => {
    expect(autoSyncPlan({
      ...blocked,
      autoSync: true,
      runImmediately: true,
      intervalMinutes: 10,
    })).toEqual({ runImmediately: false, intervalMs: null });
  });
});
