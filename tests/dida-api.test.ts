import { describe, expect, it, vi } from "vitest";
import { DidaApi } from "../src/integrations/dida/api";
import {
  DidaRequestGovernor,
  EMPTY_DIDA_REQUEST_CONTROL,
  type DidaRequestControlState,
} from "../src/integrations/dida/request-governor";
import { DidaHttpError, classifyStatus } from "../src/integrations/dida/http-contract";
import { createSnapshot } from "../src/sync/snapshots";
import { OfflineQueue } from "../src/sync/offline-queue";
import type { DidaTask } from "../src/domain/entities";
import type { SyncQueueOperation } from "../src/sync/types";
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../src/integrations/dida/http-contract";

class ThrowingTransport implements HttpTransport {
  calls: HttpRequest[] = [];

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.calls.push(request);
    throw new Error("socket closed after send");
  }
}

class StatusTransport implements HttpTransport {
  calls = 0;
  constructor(private readonly status: number) {}
  async request<T>(): Promise<HttpResponse<T>> {
    this.calls += 1;
    return {
      status: this.status,
      headers: {},
      data: {} as T,
      text: "failure",
    };
  }
}

class ProbeShapeTransport implements HttpTransport {
  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const data = request.url.endsWith("/task/filter") ? [] : {};
    return { status: 200, headers: {}, data: data as T, text: "" };
  }
}

class CapturingTransport implements HttpTransport {
  calls: HttpRequest[] = [];

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.calls.push(request);
    return { status: 200, headers: {}, data: "OK" as T, text: "OK" };
  }
}

class SequenceTransport implements HttpTransport {
  calls: HttpRequest[] = [];

  constructor(private readonly responses: Array<HttpResponse<unknown>>) {}

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.calls.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("missing test response");
    return response as HttpResponse<T>;
  }
}

class ThrowingRateThenSuccessTransport implements HttpTransport {
  calls: HttpRequest[] = [];

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.calls.push(request);
    if (this.calls.length === 1) {
      throw new DidaHttpError("rate-limit", "查询限流，稍后只读复核", 500, 60_000);
    }
    return {
      status: 200,
      headers: {},
      data: { id: "project-1", name: "Recovered" } as T,
      text: "",
    };
  }
}

describe("DidaApi non-idempotent safety", () => {
  it("classifies Dida's explicit query-limit body with a fixed safe summary", () => {
    const error = classifyStatus(
      500,
      "Dida API 500: errorId=private-id errorCode=exceed_query_limit Maximum 100 requests per minute",
      {},
      '{"errorCode":"exceed_query_limit","errorId":"private-id"}',
    );

    expect(error).toMatchObject({
      category: "rate-limit",
      retryAfterMs: 15 * 60_000,
      limitKind: "query-limit",
    });
    expect(error.message).toBe("查询限流，稍后只读复核");
    expect(error.message).not.toContain("private-id");
  });

  it.each([
    [401, '{"errorCode":"exceed_query_limit"}'],
    [403, '{"errorCode":"exceed_query_limit"}'],
    [400, '{"errorCode":"exceed_query_limit"}'],
    [500, "ordinary text mentions exceed_query_limit but has no errorCode field"],
  ])("does not misclassify status %i or unstructured text as query limit", (status, body) => {
    expect(classifyStatus(status, "sanitized message", {}, body).category).not.toBe("rate-limit");
  });

  it.each([
    ["zero", { "Retry-After": "0" }, 30_000],
    ["negative", { "Retry-After": "-2" }, 30_000],
    ["positive", { "Retry-After": "2" }, 2_000],
  ])("accepts only positive finite Retry-After values (%s)", (_name, headers, expected) => {
    expect(classifyStatus(429, "rate", headers).retryAfterMs).toBe(expected);
  });

  it("supports HTTP-date Retry-After and clamps unsafe durations without releasing early", () => {
    const now = Date.parse("2026-08-07T00:00:00.000Z");
    expect(classifyStatus(
      429,
      "rate",
      { "Retry-After": "Fri, 07 Aug 2026 00:02:00 GMT" },
      undefined,
      now,
    ).retryAfterMs).toBe(120_000);
    expect(classifyStatus(429, "rate", { "Retry-After": "0.001" }, undefined, now).retryAfterMs)
      .toBe(1_000);
    expect(classifyStatus(429, "rate", { "Retry-After": "1e999" }, undefined, now).retryAfterMs)
      .toBe(30_000);
    expect(classifyStatus(429, "rate", { "Retry-After": "9".repeat(400) }, undefined, now).retryAfterMs)
      .toBe(24 * 60 * 60_000);
    expect(classifyStatus(
      429,
      "rate",
      { "Retry-After": "Fri, 07 Aug 2036 00:00:00 GMT" },
      undefined,
      now,
    ).retryAfterMs).toBe(Date.parse("2036-08-07T00:00:00.000Z") - now);
  });

  it("persists a rate-limited read and returns immediately without sleeping or retrying", async () => {
    const transport = new SequenceTransport([
      { status: 500, headers: {}, data: {}, text: "errorId=private-id errorCode=exceed_query_limit" },
      { status: 200, headers: {}, data: { id: "project-1", name: "Recovered" }, text: "" },
    ]);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const api = new DidaApi(transport, () => "test-token-long-enough", {}, sleep);

    await expect(api.getProject("project-1")).rejects.toMatchObject({
      category: "rate-limit",
      retryAfterMs: 15 * 60_000,
    });
    expect(transport.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a rate-limited non-idempotent write", async () => {
    const transport = new SequenceTransport([
      { status: 500, headers: {}, data: {}, text: "errorCode=exceed_query_limit" },
    ]);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const api = new DidaApi(transport, () => "test-token-long-enough", {}, sleep);

    await expect(api.moveTask({
      fromProjectId: "project-1",
      toProjectId: "project-2",
      taskId: "task-1",
    })).rejects.toMatchObject({
      category: "unknown-outcome",
      remoteOutcomeUnknown: true,
      message: "查询限流发生在写入请求之后，无法确认远端结果；已转入待核对状态",
    });
    expect(transport.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns a transport-classified rate limit without holding the caller during Retry-After", async () => {
    const transport = new ThrowingRateThenSuccessTransport();
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const api = new DidaApi(transport, () => "test-token-long-enough", {}, sleep);

    await expect(api.getProject("project-1")).rejects.toMatchObject({
      category: "rate-limit",
      retryAfterMs: 60_000,
    });
    expect(transport.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("turns a transport-thrown rate-limited write into non-runnable reconciliation", async () => {
    const transport = new ThrowingRateThenSuccessTransport();
    const api = new DidaApi(transport, () => "test-token-long-enough");
    const failure = await api.moveTask({
      fromProjectId: "project-1",
      toProjectId: "project-2",
      taskId: "task-1",
    }).catch((error: unknown) => error);
    const task: DidaTask = { id: "task-1", projectId: "project-1", title: "task", status: 0 };
    const queued: SyncQueueOperation<DidaTask> = {
      id: "op-rate-throw",
      kind: "task",
      entityId: task.id,
      operation: "update",
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      attempts: 0,
      status: "pending",
      local: createSnapshot("task", task.id, task),
      projectId: task.projectId,
    };
    const queue = new OfflineQueue([queued]);
    queue.markRunning(queued.id);
    queue.markFailed(queued.id, failure);

    expect(failure).toMatchObject({ category: "unknown-outcome", remoteOutcomeUnknown: true });
    expect(transport.calls).toHaveLength(1);
    expect(queue.list()[0]).toMatchObject({ status: "reconciliation", remoteOutcomeUnknown: true });
    expect(queue.nextRunnable()).toBeNull();
  });

  it("keeps an explicit query-limit write single-shot under maxAttempts=1", async () => {
    const transport = new SequenceTransport([
      { status: 500, headers: {}, data: {}, text: '{"errorCode":"exceed_query_limit"}' },
    ]);
    const api = new DidaApi(transport, () => "test-token-long-enough")
      .withRequestPolicy({ maxAttempts: 1 });

    await expect(api.createTask({ title: "one", projectId: "project-1" }))
      .rejects.toMatchObject({ category: "unknown-outcome", remoteOutcomeUnknown: true });
    expect(transport.calls).toHaveLength(1);
  });
  it("never retries create after an uncertain network failure", async () => {
    const transport = new ThrowingTransport();
    const api = new DidaApi(transport, () => "test-token-long-enough");
    await expect(
      api.createTask({ title: "one", projectId: "project-1" }),
    ).rejects.toMatchObject({
      category: "unknown-outcome",
      remoteOutcomeUnknown: true,
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("never retries create after a 5xx response with uncertain server outcome", async () => {
    const transport = new StatusTransport(503);
    const api = new DidaApi(transport, () => "test-token-long-enough");
    await expect(
      api.createProject({ name: "one" }),
    ).rejects.toMatchObject({
      category: "unknown-outcome",
      remoteOutcomeUnknown: true,
    });
    expect(transport.calls).toBe(1);
  });

  it.each([
    ["update", (api: DidaApi) => api.updateTask("task-1", { title: "updated" })],
    ["project update", (api: DidaApi) => api.updateProject("project-1", { viewMode: "kanban" })],
    ["column create", (api: DidaApi) => api.createColumn("project-1", { name: "Doing" })],
    ["column update", (api: DidaApi) =>
      api.updateColumn("project-1", "column-1", { name: "Done" })],
    ["move", (api: DidaApi) => api.moveTask({
      fromProjectId: "project-1",
      toProjectId: "project-2",
      taskId: "task-1",
    })],
    ["task delete", (api: DidaApi) => api.deleteTask("project-1", "task-1")],
    ["project delete", (api: DidaApi) => api.deleteProject("project-1")],
    ["complete", (api: DidaApi) => api.completeTask("project-1", "task-1")],
    ["habit update", (api: DidaApi) => api.updateHabit("habit-1", { name: "updated" })],
    ["focus delete", (api: DidaApi) => api.deleteFocus("focus-1", 0)],
  ])("never retries %s after an uncertain network failure", async (_name, request) => {
    const transport = new ThrowingTransport();
    const api = new DidaApi(transport, () => "test-token-long-enough");
    await expect(request(api)).rejects.toMatchObject({
      category: "unknown-outcome",
      remoteOutcomeUnknown: true,
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("never retries an update after a 5xx response with uncertain server outcome", async () => {
    const transport = new StatusTransport(503);
    const api = new DidaApi(transport, () => "test-token-long-enough");

    await expect(api.updateTask("task-1", { title: "updated" })).rejects.toMatchObject({
      category: "unknown-outcome",
      remoteOutcomeUnknown: true,
    });
    expect(transport.calls).toBe(1);
  });

  it.each([
    ["habit update", (api: DidaApi) => api.updateHabit("habit-1", { name: "updated" })],
    ["focus delete", (api: DidaApi) => api.deleteFocus("focus-1", 0)],
  ])("never retries %s after a 5xx response with uncertain server outcome", async (_name, request) => {
    const transport = new StatusTransport(503);
    const api = new DidaApi(transport, () => "test-token-long-enough");
    await expect(request(api)).rejects.toMatchObject({
      category: "unknown-outcome",
      remoteOutcomeUnknown: true,
    });
    expect(transport.calls).toBe(1);
  });

  it("serializes a move as one array payload and never falls back to a second write", async () => {
    const transport = new CapturingTransport();
    const api = new DidaApi(transport, () => "test-token-long-enough");

    await expect(api.moveTask({
      fromProjectId: "project-1",
      toProjectId: "project-2",
      taskId: "task-1",
    })).resolves.toBe("OK");

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({ method: "POST", url: expect.stringMatching(/\/task\/move$/) });
    expect(JSON.parse(transport.calls[0]!.body ?? "null")).toEqual([{
      fromProjectId: "project-1",
      toProjectId: "project-2",
      taskId: "task-1",
    }]);
  });

  it("marks 200 responses unavailable when collection endpoints return non-arrays", async () => {
    const api = new DidaApi(new ProbeShapeTransport(), () => "test-token-long-enough");
    const capabilities = await api.probeCapabilities();
    expect(capabilities).toMatchObject({
      projects: "unavailable",
      tasks: "available",
      habits: "unavailable",
      focus: "unavailable",
    });
    expect(capabilities.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/项目接口返回值不是数组/),
      expect.stringMatching(/习惯接口返回值不是数组/),
      expect.stringMatching(/专注接口返回值不是数组/),
    ]));
  });

  it("applies a contract request policy without multiplying read retries", async () => {
    const transport = new ThrowingTransport();
    const api = new DidaApi(transport, () => "test-token-long-enough")
      .withRequestPolicy({ timeoutMs: 5_000, maxAttempts: 1 });

    await expect(api.getProjects()).rejects.toThrow("socket closed after send");
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.timeoutMs).toBe(5_000);
  });

  it("keeps unknown-outcome protection for writes on a derived policy client", async () => {
    const transport = new ThrowingTransport();
    const api = new DidaApi(transport, () => "test-token-long-enough")
      .withRequestPolicy({ timeoutMs: 5_000, maxAttempts: 1 });

    await expect(api.createTask({ title: "one", projectId: "project-1" }))
      .rejects.toMatchObject({ category: "unknown-outcome", remoteOutcomeUnknown: true });
    expect(transport.calls).toHaveLength(1);
  });

  it("falls back to three attempts when maxAttempts is not finite", async () => {
    const transport = new StatusTransport(503);
    const api = new DidaApi(transport, () => "test-token-long-enough")
      .withRequestPolicy({ maxAttempts: Number.NaN });

    await expect(api.getProjects()).rejects.toMatchObject({ category: "transient" });
    expect(transport.calls).toBe(3);
  });

  it("classifies exhausted raw read transport failures as transient", async () => {
    const transport = new ThrowingTransport();
    const api = new DidaApi(transport, () => "test-token-long-enough")
      .withRequestPolicy({ maxAttempts: 1 });

    await expect(api.getProjects()).rejects.toMatchObject({ category: "transient" });
    expect(transport.calls).toHaveLength(1);
  });

  it("stops a derived contract client when its shared call budget is exhausted", async () => {
    const transport = new CapturingTransport();
    const api = new DidaApi(transport, () => "test-token-long-enough")
      .withRequestPolicy({ maxCalls: 2, maxAttempts: 1 });
    await api.getProjects();
    await api.getProjects();
    await expect(api.getProjects()).rejects.toThrow(/预算已耗尽.*安全终止/);
    expect(transport.calls).toHaveLength(2);
  });

  it("keeps the cleanup request reserve independent from an exhausted main contract budget", async () => {
    const transport = new CapturingTransport();
    const base = new DidaApi(transport, () => "test-token-long-enough");
    const main = base.withRequestPolicy({ maxCalls: 1, maxAttempts: 1 });
    const cleanup = base.withRequestPolicy({ maxCalls: 1, maxAttempts: 1, cooldownProbe: true });
    await main.getProjects();
    await expect(main.getProjects()).rejects.toThrow(/预算已耗尽/);
    await expect(cleanup.getProjects()).resolves.toBe("OK");
    expect(transport.calls).toHaveLength(2);
  });

  it("rechecks the remote guard immediately before transport after queueing or retry", async () => {
    const transport = new StatusTransport(503);
    let checks = 0;
    const api = new DidaApi(
      transport,
      () => "test-token-long-enough",
      { maxAttempts: 3 },
      async () => undefined,
      undefined,
      undefined,
      () => {
        checks += 1;
        if (checks >= 3) throw new Error("recovery activated while queued");
      },
    );
    await expect(api.getProjects()).rejects.toThrow(/recovery activated while queued/);
    expect(transport.calls).toBe(1);
    expect(checks).toBe(3);
  });

  it("keeps a sent write unknown while latching a failed rate-limit state save", async () => {
    let state: DidaRequestControlState = {
      ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL),
      authorizationBinding: "a".repeat(64),
    };
    let writes = 0;
    let latchWritten = false;
    const governor = new DidaRequestGovernor({
      read: async () => structuredClone(state),
      write: async (next) => {
        writes += 1;
        if (writes === 2) throw new Error("data save failed");
        state = structuredClone(next);
      },
      readEmergencyLatch: async () => null,
      writeEmergencyLatch: async () => { latchWritten = true; },
    }, 0, () => 0, async () => undefined);
    const transport = new SequenceTransport([{
      status: 500,
      headers: {},
      data: {},
      text: '{"errorCode":"exceed_query_limit"}',
    }]);
    const api = new DidaApi(
      transport,
      () => "test-token-long-enough",
      { maxAttempts: 1 },
      async () => undefined,
      governor,
    );

    await expect(api.createTask({ title: "one", projectId: "project-1" }))
      .rejects.toMatchObject({ category: "unknown-outcome", remoteOutcomeUnknown: true });
    expect(transport.calls).toHaveLength(1);
    expect(latchWritten).toBe(true);
  });

  it("does not mark a write unknown when request control fails before transport", async () => {
    const governor = new DidaRequestGovernor({
      read: async () => ({
        ...structuredClone(EMPTY_DIDA_REQUEST_CONTROL),
        authorizationBinding: "a".repeat(64),
      }),
      write: async () => { throw new Error("preflight save failed"); },
    }, 0, () => 0, async () => undefined);
    const transport = new CapturingTransport();
    const api = new DidaApi(
      transport,
      () => "test-token-long-enough",
      { maxAttempts: 1 },
      async () => undefined,
      governor,
    );

    await expect(api.createTask({ title: "one", projectId: "project-1" }))
      .rejects.toMatchObject({ category: "permanent", requestNotSent: true });
    expect(transport.calls).toHaveLength(0);
  });
});
