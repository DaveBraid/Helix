import { describe, expect, it } from "vitest";
import { DidaApi } from "../src/integrations/dida/api";
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

describe("DidaApi non-idempotent safety", () => {
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
    ["move", (api: DidaApi) => api.moveTask({
      fromProjectId: "project-1",
      toProjectId: "project-2",
      taskId: "task-1",
    })],
    ["complete", (api: DidaApi) => api.completeTask("project-1", "task-1")],
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
});
