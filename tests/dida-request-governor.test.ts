import { describe, expect, it, vi } from "vitest";
import { DidaHttpError } from "../src/integrations/dida/http-contract";
import {
  DidaRequestGovernor,
  EMPTY_DIDA_REQUEST_CONTROL,
  didaInterfaceCategory,
  type DidaRequestControlState,
} from "../src/integrations/dida/request-governor";

function memoryPort(initial: DidaRequestControlState = structuredClone(EMPTY_DIDA_REQUEST_CONTROL)) {
  let state = structuredClone(initial);
  return {
    read: async () => structuredClone(state),
    write: async (next: DidaRequestControlState) => { state = structuredClone(next); },
    snapshot: () => structuredClone(state),
  };
}

describe("DidaRequestGovernor", () => {
  it("serializes all interfaces at one request per second without burst", async () => {
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const port = memoryPort();
    const governor = new DidaRequestGovernor(port, 1_000, () => now, sleep);
    const sent: number[] = [];
    await Promise.all([
      governor.schedule("project", true, false, async () => { sent.push(now); }),
      governor.schedule("task", true, false, async () => { sent.push(now); }),
      governor.schedule("focus", true, false, async () => { sent.push(now); }),
    ]);
    expect(sent).toEqual([0, 1_000, 2_000]);
    expect(port.snapshot().requestCounts).toMatchObject({ project: 1, task: 1, focus: 1 });
  });

  it("persists 15/30/60 minute query-limit backoff and permits only one read probe", async () => {
    let now = Date.parse("2026-08-07T00:00:00.000Z");
    const port = memoryPort();
    const first = new DidaRequestGovernor(port, 0, () => now, async () => undefined);
    const limited = () => Promise.reject(new DidaHttpError(
      "rate-limit", "limited", 500, 15 * 60_000, false, "query-limit",
    ));
    await expect(first.schedule("project", true, false, limited)).rejects.toBeInstanceOf(DidaHttpError);
    expect(Date.parse(port.snapshot().cooldownUntil!) - now).toBe(15 * 60_000);
    await expect(first.schedule("task", true, true, limited)).rejects.toBeInstanceOf(DidaHttpError);
    expect(Date.parse(port.snapshot().cooldownUntil!) - now).toBe(30 * 60_000);
    const calls = vi.fn(async () => undefined);
    await expect(first.schedule("focus", true, true, calls)).rejects.toMatchObject({ requestNotSent: true });
    expect(calls).not.toHaveBeenCalled();
    now = Date.parse(port.snapshot().cooldownUntil!) + 1;
    await expect(first.schedule("habit", true, false, limited)).rejects.toBeInstanceOf(DidaHttpError);
    expect(Date.parse(port.snapshot().cooldownUntil!) - now).toBe(60 * 60_000);
    const restored = new DidaRequestGovernor(port, 0, () => now, async () => undefined);
    await expect(restored.assertContractAllowed()).rejects.toMatchObject({ requestNotSent: true });
  });

  it("honors 429 Retry-After and blocks writes before sending during cooldown", async () => {
    const now = Date.parse("2026-08-07T00:00:00.000Z");
    const port = memoryPort();
    const governor = new DidaRequestGovernor(port, 0, () => now, async () => undefined);
    await expect(governor.schedule("task", true, false, async () => {
      throw new DidaHttpError("rate-limit", "retry", 429, 12_000, false, "retry-after");
    })).rejects.toBeInstanceOf(DidaHttpError);
    expect(Date.parse(port.snapshot().cooldownUntil!) - now).toBe(12_000);
    const write = vi.fn(async () => undefined);
    await expect(governor.schedule("task", false, false, write)).rejects.toMatchObject({ requestNotSent: true });
    expect(write).not.toHaveBeenCalled();
  });

  it("blocks ordinary reads without consuming the single explicit cooldown probe", async () => {
    const now = Date.parse("2026-08-07T00:00:00.000Z");
    const port = memoryPort({
      ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL),
      cooldownUntil: new Date(now + 60_000).toISOString(),
      queryLimitLevel: 2,
    });
    const governor = new DidaRequestGovernor(port, 0, () => now, async () => undefined);
    const ordinary = vi.fn(async () => undefined);
    await expect(governor.schedule("task", true, false, ordinary))
      .rejects.toMatchObject({ requestNotSent: true });
    expect(ordinary).not.toHaveBeenCalled();
    expect(port.snapshot().cooldownProbeUsed).toBe(false);

    const probe = vi.fn(async () => undefined);
    await expect(governor.schedule("task", true, true, probe)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(port.snapshot()).toMatchObject({ cooldownProbeUsed: false, queryLimitLevel: 0 });
    expect(port.snapshot().cooldownUntil).toBeUndefined();
  });

  it("persists the next allowed send time across governor restarts", async () => {
    let now = 0;
    const port = memoryPort();
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    await new DidaRequestGovernor(port, 1_000, () => now, sleep)
      .schedule("project", true, false, async () => undefined);
    const sent = vi.fn(async () => undefined);
    await new DidaRequestGovernor(port, 1_000, () => now, sleep)
      .schedule("focus", true, false, sent);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(now).toBe(1_000);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("keeps recovery pending across a transient failure and clears the level on read success", async () => {
    const now = Date.parse("2026-08-07T00:00:00.000Z");
    const port = memoryPort({
      ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL),
      cooldownUntil: new Date(now - 1).toISOString(),
      queryLimitLevel: 2,
    });
    const governor = new DidaRequestGovernor(port, 0, () => now, async () => undefined);
    await expect(governor.schedule("project", true, false, async () => {
      throw new DidaHttpError("transient", "temporary", 503);
    })).rejects.toMatchObject({ category: "transient" });
    expect(port.snapshot()).toMatchObject({ recoveryReadPending: true, queryLimitLevel: 2 });
    await governor.schedule("project", true, false, async () => undefined);
    expect(port.snapshot()).toMatchObject({ recoveryReadPending: false, queryLimitLevel: 0 });
  });

  it("rejects an abnormal persisted spacing deadline without sleeping or sending", async () => {
    const now = Date.parse("2026-08-07T00:00:00.000Z");
    const port = memoryPort({
      ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL),
      nextAllowedAt: new Date(now + 60_000).toISOString(),
    });
    const sleep = vi.fn(async () => undefined);
    const send = vi.fn(async () => undefined);
    const governor = new DidaRequestGovernor(port, 1_000, () => now, sleep);
    await expect(governor.schedule("task", true, false, send))
      .rejects.toMatchObject({ category: "permanent", requestNotSent: true });
    expect(sleep).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("remains fail-closed when persisting a newly observed rate limit fails", async () => {
    let state: DidaRequestControlState = {
      ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL),
      authorizationBinding: "a".repeat(64),
    };
    let writes = 0;
    let latch: {
      version: 1;
      authorizationBinding: string;
      reason: "rate-limit-persistence-failed";
      createdAt: string;
    } | null = null;
    const persistenceFailure = vi.fn();
    const port = {
      read: async () => structuredClone(state),
      write: async (next: DidaRequestControlState) => {
        writes += 1;
        if (writes === 2) throw new Error("save failed");
        state = structuredClone(next);
      },
      onPersistenceFailure: persistenceFailure,
      readEmergencyLatch: async () => structuredClone(latch),
      writeEmergencyLatch: async (next: NonNullable<typeof latch>) => { latch = structuredClone(next); },
    };
    const governor = new DidaRequestGovernor(port, 0, () => 0, async () => undefined);
    await expect(governor.schedule("task", true, false, async () => {
      throw new DidaHttpError("rate-limit", "limited", 429, 30_000, false, "retry-after");
    })).rejects.toMatchObject({ category: "rate-limit" });
    expect(persistenceFailure).toHaveBeenCalledWith(expect.stringMatching(/只读恢复模式/));
    expect(latch).toMatchObject({
      version: 1,
      authorizationBinding: "a".repeat(64),
      reason: "rate-limit-persistence-failed",
    });

    const send = vi.fn(async () => undefined);
    await expect(governor.schedule("task", true, false, send))
      .rejects.toMatchObject({ category: "permanent", requestNotSent: true });
    expect(send).not.toHaveBeenCalled();

    const restarted = new DidaRequestGovernor(port, 0, () => 0, async () => undefined);
    await expect(restarted.schedule("task", true, false, send))
      .rejects.toMatchObject({ category: "permanent", requestNotSent: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps recovery pending when a write is first after expiry until a read succeeds", async () => {
    const now = Date.parse("2026-08-07T00:00:00.000Z");
    const port = memoryPort({
      ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL),
      cooldownUntil: new Date(now - 1).toISOString(),
      queryLimitLevel: 2,
    });
    const governor = new DidaRequestGovernor(port, 0, () => now, async () => undefined);
    await governor.schedule("task", false, false, async () => undefined);
    expect(port.snapshot()).toMatchObject({ recoveryReadPending: true, queryLimitLevel: 2 });
    await governor.schedule("task", true, false, async () => undefined);
    expect(port.snapshot()).toMatchObject({ recoveryReadPending: false, queryLimitLevel: 0 });
  });

  it("treats an emergency latch from another authorization as explicit recovery damage", async () => {
    const state: DidaRequestControlState = {
      ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL),
      authorizationBinding: "b".repeat(64),
    };
    const send = vi.fn(async () => undefined);
    const governor = new DidaRequestGovernor({
      read: async () => structuredClone(state),
      write: async () => undefined,
      readEmergencyLatch: async () => ({
        version: 1,
        authorizationBinding: "a".repeat(64),
        reason: "rate-limit-persistence-failed",
        createdAt: "2026-08-07T00:00:00.000Z",
      }),
    }, 0, () => 0, async () => undefined);

    await expect(governor.schedule("task", true, false, send))
      .rejects.toMatchObject({
        category: "permanent",
        requestNotSent: true,
        message: expect.stringMatching(/授权不匹配.*重新初始化/),
      });
    expect(send).not.toHaveBeenCalled();
  });

  it("rechecks an externally created latch after spacing and before sending", async () => {
    let now = 0;
    const binding = "a".repeat(64);
    const port = memoryPort({ ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL), authorizationBinding: binding });
    let latch: {
      version: 1;
      authorizationBinding: string;
      reason: "authorization-transition";
      createdAt: string;
      targetAuthorizationBinding: string;
      stage: "prepared";
    } | null = null;
    const governedPort = {
      read: port.read,
      write: port.write,
      readEmergencyLatch: async () => structuredClone(latch),
    };
    const governor = new DidaRequestGovernor(governedPort, 1_000, () => now, async (ms) => {
      now += ms;
      latch = {
        version: 1,
        authorizationBinding: binding,
        targetAuthorizationBinding: "b".repeat(64),
        reason: "authorization-transition",
        stage: "prepared",
        createdAt: new Date(now).toISOString(),
      };
    });
    await governor.schedule("task", true, false, async () => undefined);
    const send = vi.fn(async () => undefined);
    await expect(governor.schedule("task", true, false, send))
      .rejects.toMatchObject({ category: "permanent", requestNotSent: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("resets a terminal latch only for an initialized replacement binding", async () => {
    let state: DidaRequestControlState = {
      ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL),
      authorizationBinding: "a".repeat(64),
    };
    let latch: {
      version: 1;
      authorizationBinding: string;
      reason: "rate-limit-persistence-failed";
      createdAt: string;
    } | null = {
      version: 1,
      authorizationBinding: "a".repeat(64),
      reason: "rate-limit-persistence-failed",
      createdAt: "2026-08-07T00:00:00.000Z",
    };
    const port = {
      read: async () => structuredClone(state),
      write: async (next: DidaRequestControlState) => { state = structuredClone(next); },
      readEmergencyLatch: async () => structuredClone(latch),
    };
    const governor = new DidaRequestGovernor(port, 0, () => 0, async () => undefined);
    await expect(governor.schedule("task", true, false, async () => undefined))
      .rejects.toMatchObject({ category: "permanent" });

    state = { ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL), authorizationBinding: "b".repeat(64) };
    latch = null;
    governor.resetForAuthorization("b".repeat(64));
    await expect(governor.schedule("task", true, false, async () => "sent")).resolves.toBe("sent");
  });

  it("classifies every pre-transport state write failure as request-not-sent", async () => {
    const recovery = vi.fn();
    const send = vi.fn(async () => undefined);
    const governor = new DidaRequestGovernor({
      read: async () => ({
        ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL),
        authorizationBinding: "a".repeat(64),
      }),
      write: async () => { throw new Error("save failed before transport"); },
      onPersistenceFailure: recovery,
    }, 0, () => 0, async () => undefined);

    await expect(governor.schedule("task", false, false, send))
      .rejects.toMatchObject({ category: "permanent", requestNotSent: true });
    expect(send).not.toHaveBeenCalled();
    expect(recovery).toHaveBeenCalledWith(expect.stringMatching(/无法持久化/));
  });

  it("classifies observations without retaining paths or identifiers", () => {
    expect(didaInterfaceCategory("/project/private-id/data")).toBe("project");
    expect(didaInterfaceCategory("/task/filter")).toBe("task");
    expect(didaInterfaceCategory("/habit/private-id")).toBe("habit");
    expect(didaInterfaceCategory("/focus/private-id")).toBe("focus");
  });
});
