import type {
  DidaFocusRecord,
  DidaHabit,
  DidaHabitCheckin,
  DidaProject,
  DidaTask,
} from "../../domain/entities";
import { DidaHttpError, classifyStatus, type HttpTransport } from "./http-contract";

const BASE_URL = "https://api.dida365.com/open/v1";

export interface DidaCapabilities {
  projects: "available" | "unavailable";
  tasks: "available" | "unavailable";
  habits: "available" | "unavailable";
  focus: "available" | "unavailable";
  checkedAt: string;
  errors: string[];
}

export type TokenProvider = () => string | null;

export class DidaApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly tokenProvider: TokenProvider,
  ) {}

  async probeCapabilities(): Promise<DidaCapabilities> {
    const result: DidaCapabilities = {
      projects: "unavailable",
      tasks: "unavailable",
      habits: "unavailable",
      focus: "unavailable",
      checkedAt: new Date().toISOString(),
      errors: [],
    };
    await Promise.all([
      this.getProjects()
        .then((projects) => {
          if (!Array.isArray(projects)) throw new Error("项目接口返回值不是数组");
          result.projects = "available";
        })
        .catch((error) => result.errors.push(`projects: ${messageOf(error)}`)),
      this.filterTasks({ status: [0, -1] })
        .then((tasks) => {
          if (!Array.isArray(tasks)) throw new Error("任务过滤接口返回值不是数组");
          result.tasks = "available";
        })
        .catch((error) => result.errors.push(`tasks: ${messageOf(error)}`)),
      this.listHabits()
        .then((habits) => {
          if (!Array.isArray(habits)) throw new Error("习惯接口返回值不是数组");
          result.habits = "available";
        })
        .catch((error) => result.errors.push(`habits: ${messageOf(error)}`)),
      this.listFocus(new Date(Date.now() - 86_400_000).toISOString(), new Date().toISOString(), 1)
        .then((focus) => {
          if (!Array.isArray(focus)) throw new Error("专注接口返回值不是数组");
          result.focus = "available";
        })
        .catch((error) => result.errors.push(`focus: ${messageOf(error)}`)),
    ]);
    return result;
  }

  getProjects(): Promise<DidaProject[]> {
    return this.request("/project");
  }

  getProject(projectId: string): Promise<DidaProject> {
    return this.request(`/project/${encodeURIComponent(projectId)}`);
  }

  getProjectData(projectId: string): Promise<{
    project: DidaProject;
    tasks: DidaTask[];
    columns?: unknown[];
  }> {
    return this.request(`/project/${encodeURIComponent(projectId)}/data`);
  }

  createProject(project: Partial<DidaProject> & Pick<DidaProject, "name">): Promise<DidaProject> {
    return this.request("/project", "POST", project, { outcomeUnknownOnNetworkFailure: true });
  }

  updateProject(projectId: string, project: Partial<DidaProject>): Promise<DidaProject> {
    return this.request(`/project/${encodeURIComponent(projectId)}`, "POST", project);
  }

  deleteProject(projectId: string): Promise<void> {
    return this.request(`/project/${encodeURIComponent(projectId)}`, "DELETE");
  }

  getTask(projectId: string, taskId: string): Promise<DidaTask> {
    return this.request(
      `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`,
    );
  }

  createTask(task: Partial<DidaTask> & Pick<DidaTask, "title" | "projectId">): Promise<DidaTask> {
    return this.request("/task", "POST", task, { outcomeUnknownOnNetworkFailure: true });
  }

  updateTask(taskId: string, task: Partial<DidaTask>): Promise<DidaTask> {
    return this.request(`/task/${encodeURIComponent(taskId)}`, "POST", task);
  }

  moveTask(input: {
    fromProjectId: string;
    toProjectId: string;
    taskId: string;
  }): Promise<{ id: string; etag?: string }> {
    return this.request("/task/move", "POST", input, {
      outcomeUnknownOnNetworkFailure: true,
    });
  }

  completeTask(projectId: string, taskId: string): Promise<void> {
    return this.request(
      `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`,
      "POST",
      undefined,
      { outcomeUnknownOnNetworkFailure: true },
    );
  }

  deleteTask(projectId: string, taskId: string): Promise<void> {
    return this.request(
      `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`,
      "DELETE",
    );
  }

  filterTasks(filter: Record<string, unknown>): Promise<DidaTask[]> {
    return this.request("/task/filter", "POST", filter);
  }

  getCompletedTasks(filter: Record<string, unknown>): Promise<DidaTask[]> {
    return this.request("/task/completed", "POST", filter);
  }

  listHabits(): Promise<DidaHabit[]> {
    return this.request("/habit");
  }

  getHabit(habitId: string): Promise<DidaHabit> {
    return this.request(`/habit/${encodeURIComponent(habitId)}`);
  }

  createHabit(habit: Partial<DidaHabit> & Pick<DidaHabit, "name">): Promise<DidaHabit> {
    return this.request("/habit", "POST", habit, { outcomeUnknownOnNetworkFailure: true });
  }

  updateHabit(habitId: string, habit: Partial<DidaHabit>): Promise<DidaHabit> {
    return this.request(`/habit/${encodeURIComponent(habitId)}`, "POST", habit);
  }

  createHabitCheckin(habitId: string, checkin: DidaHabitCheckin): Promise<DidaHabitCheckin> {
    return this.request(
      `/habit/${encodeURIComponent(habitId)}/checkin`,
      "POST",
      checkin,
      { outcomeUnknownOnNetworkFailure: true },
    );
  }

  getHabitCheckins(habitIds: string[], from: number, to: number): Promise<DidaHabitCheckin[]> {
    const params = new URLSearchParams({
      habitIds: habitIds.join(","),
      from: String(from),
      to: String(to),
    });
    return this.request(`/habit/checkins?${params.toString()}`);
  }

  listFocus(from: string, to: string, type: number): Promise<DidaFocusRecord[]> {
    const params = new URLSearchParams({ from, to, type: String(type) });
    return this.request(`/focus?${params.toString()}`);
  }

  getFocus(focusId: string, type: number): Promise<DidaFocusRecord> {
    const params = new URLSearchParams({ type: String(type) });
    return this.request(`/focus/${encodeURIComponent(focusId)}?${params.toString()}`);
  }

  createFocus(record: Omit<DidaFocusRecord, "id">): Promise<DidaFocusRecord> {
    return this.request("/focus", "POST", record, { outcomeUnknownOnNetworkFailure: true });
  }

  deleteFocus(focusId: string, type: number): Promise<void> {
    const params = new URLSearchParams({ type: String(type) });
    return this.request(
      `/focus/${encodeURIComponent(focusId)}?${params.toString()}`,
      "DELETE",
    );
  }

  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    options: { outcomeUnknownOnNetworkFailure?: boolean } = {},
  ): Promise<T> {
    const token = this.tokenProvider();
    if (!token) throw new DidaHttpError("authentication", "尚未配置滴答 API 口令", 401);
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    let lastError: unknown;
    const maxAttempts = options.outcomeUnknownOnNetworkFailure ? 1 : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await this.transport.request<T>({
          url: `${BASE_URL}${path}`,
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: requestBody,
        });
        if (response.status >= 200 && response.status < 300) return response.data;
        const error = classifyStatus(
          response.status,
          `Dida API ${response.status}: ${sanitize(response.text)}`,
          response.headers,
        );
        if (error.category !== "transient" && error.category !== "rate-limit") throw error;
        if (options.outcomeUnknownOnNetworkFailure && error.category === "transient") {
          throw new DidaHttpError(
            "unknown-outcome",
            "服务器错误发生在写入请求之后，无法确认远端结果；已转入待核对状态",
            response.status,
            undefined,
            true,
          );
        }
        lastError = error;
        if (attempt < maxAttempts - 1) {
          await delay(error.retryAfterMs ?? 1_000 * 2 ** attempt);
        }
        continue;
      } catch (error) {
        if (error instanceof DidaHttpError && error.category === "unknown-outcome") {
          throw error;
        }
        if (error instanceof DidaHttpError) {
          if (error.category !== "transient" && error.category !== "rate-limit") throw error;
          lastError = error;
        } else {
          if (options.outcomeUnknownOnNetworkFailure) {
            throw new DidaHttpError(
              "unknown-outcome",
              "网络在写入请求后中断，无法确认远端结果；已转入待核对状态",
              undefined,
              undefined,
              true,
            );
          }
          lastError = error;
        }
        if (attempt < maxAttempts - 1) await delay(1_000 * 2 ** attempt);
      }
    }
    if (lastError instanceof DidaHttpError && lastError.category === "rate-limit") {
      throw lastError;
    }
    if (options.outcomeUnknownOnNetworkFailure && method !== "GET") {
      throw new DidaHttpError(
        "unknown-outcome",
        "写入请求超时，无法确认远端结果；已转入待核对状态",
        undefined,
        undefined,
        true,
      );
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function sanitize(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
