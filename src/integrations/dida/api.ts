import type {
  DidaColumn,
  DidaFocusRecord,
  DidaHabit,
  DidaHabitCheckin,
  DidaProject,
  DidaTask,
} from "../../domain/entities";
import { DidaHttpError, classifyStatus, type HttpTransport } from "./http-contract";
import {
  DidaRequestGovernor,
  EMPTY_DIDA_REQUEST_CONTROL,
  didaInterfaceCategory,
  type DidaRequestControlState,
} from "./request-governor";

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

/**
 * 滴答任务更新的线上载荷。领域模型把“无提醒”规范为 []，但公开更新接口
 * 以 null 表示显式清空；该差异不得渗入领域快照或三方合并。
 */
export type DidaTaskWriteWirePayload = Omit<Partial<DidaTask>, "columnName">;

export type DidaTaskUpdateWirePayload = Omit<DidaTaskWriteWirePayload, "reminders"> & {
  reminders?: DidaTask["reminders"] | null;
};

export interface DidaRequestPolicy {
  timeoutMs?: number;
  maxAttempts?: number;
  maxCalls?: number;
  cooldownProbe?: boolean;
}

export class DidaApi {
  private readonly governor: DidaRequestGovernor;
  private readonly budget?: { remaining: number };

  constructor(
    private readonly transport: HttpTransport,
    private readonly tokenProvider: TokenProvider,
    private readonly requestPolicy: DidaRequestPolicy = {},
    private readonly sleep: (milliseconds: number) => Promise<void> = delay,
    governor?: DidaRequestGovernor,
    budget?: { remaining: number },
    private readonly remoteAccessGuard: () => void | Promise<void> = () => undefined,
  ) {
    this.governor = governor ?? new DidaRequestGovernor(memoryControlPort(), 0, () => Date.now(), sleep);
    this.budget = budget ?? budgetFromPolicy(requestPolicy);
  }

  withRequestPolicy(policy: DidaRequestPolicy): DidaApi {
    const merged = { ...this.requestPolicy, ...policy };
    return new DidaApi(
      this.transport,
      this.tokenProvider,
      merged,
      this.sleep,
      this.governor,
      policy.maxCalls === undefined ? this.budget : budgetFromPolicy(merged),
      this.remoteAccessGuard,
    );
  }

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
    columns?: DidaColumn[];
  }> {
    return this.request(`/project/${encodeURIComponent(projectId)}/data`);
  }

  createProject(project: Partial<DidaProject> & Pick<DidaProject, "name">): Promise<DidaProject> {
    return this.request("/project", "POST", project, { outcomeUnknownOnNetworkFailure: true });
  }

  updateProject(projectId: string, project: Partial<DidaProject>): Promise<DidaProject> {
    return this.request(`/project/${encodeURIComponent(projectId)}`, "POST", project, {
      outcomeUnknownOnNetworkFailure: true,
    });
  }

  getColumns(projectId: string): Promise<DidaColumn[]> {
    return this.request(`/project/${encodeURIComponent(projectId)}/column`);
  }

  createColumn(projectId: string, column: Pick<DidaColumn, "name">): Promise<DidaColumn> {
    return this.request(
      `/project/${encodeURIComponent(projectId)}/column`,
      "POST",
      column,
      { outcomeUnknownOnNetworkFailure: true },
    );
  }

  updateColumn(
    projectId: string,
    columnId: string,
    column: Pick<DidaColumn, "name">,
  ): Promise<DidaColumn> {
    return this.request(
      `/project/${encodeURIComponent(projectId)}/column/${encodeURIComponent(columnId)}`,
      "POST",
      column,
      { outcomeUnknownOnNetworkFailure: true },
    );
  }

  deleteProject(projectId: string): Promise<void> {
    return this.request(`/project/${encodeURIComponent(projectId)}`, "DELETE", undefined, {
      outcomeUnknownOnNetworkFailure: true,
    });
  }

  getTask(projectId: string, taskId: string): Promise<DidaTask> {
    return this.request(
      `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`,
    );
  }

  createTask(task: DidaTaskWriteWirePayload & Pick<DidaTask, "title" | "projectId">): Promise<DidaTask> {
    return this.request("/task", "POST", task, { outcomeUnknownOnNetworkFailure: true });
  }

  updateTask(taskId: string, task: DidaTaskUpdateWirePayload): Promise<DidaTask> {
    return this.request(`/task/${encodeURIComponent(taskId)}`, "POST", task, {
      outcomeUnknownOnNetworkFailure: true,
    });
  }

  moveTask(input: {
    fromProjectId: string;
    toProjectId: string;
    taskId: string;
  }): Promise<unknown> {
    // DidaSync 的 MIT 实现及本地 CLI 核对均使用单元素数组。移动响应本身
    // 不作为成功依据；调用方必须通过只读复读确认位置，绝不以对象载荷重发。
    return this.request("/task/move", "POST", [input], {
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
      undefined,
      { outcomeUnknownOnNetworkFailure: true },
    );
  }

  filterTasks(filter: Record<string, unknown>): Promise<DidaTask[]> {
    return this.request("/task/filter", "POST", filter, { readOnly: true });
  }

  getCompletedTasks(filter: Record<string, unknown>): Promise<DidaTask[]> {
    return this.request("/task/completed", "POST", filter, { readOnly: true });
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
    return this.request(
      `/habit/${encodeURIComponent(habitId)}`,
      "POST",
      habit,
      { outcomeUnknownOnNetworkFailure: true },
    );
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
      undefined,
      { outcomeUnknownOnNetworkFailure: true },
    );
  }

  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    options: { outcomeUnknownOnNetworkFailure?: boolean; readOnly?: boolean } = {},
  ): Promise<T> {
    await this.remoteAccessGuard();
    const token = this.tokenProvider();
    if (!token) throw new DidaHttpError("authentication", "尚未配置滴答 API 口令", 401);
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    let lastError: unknown;
    const configuredAttempts = this.requestPolicy.maxAttempts ?? 3;
    const maxAttempts = options.outcomeUnknownOnNetworkFailure
      ? 1
      : Number.isFinite(configuredAttempts)
        ? Math.max(1, Math.floor(configuredAttempts))
        : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        this.consumeBudget();
        const response = await this.governor.schedule(
          didaInterfaceCategory(path),
          method === "GET" || options.readOnly === true,
          this.requestPolicy.cooldownProbe === true,
          async () => {
            // 排队、节流等待和 transient 重试后再次检查，封住恢复状态竞态。
            try {
              await this.remoteAccessGuard();
            } catch (error) {
              throw new DidaHttpError(
                "permanent",
                messageOf(error),
                undefined,
                undefined,
                false,
                undefined,
                true,
              );
            }
            const response = await this.transport.request<T>({
              url: `${BASE_URL}${path}`,
              method,
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: requestBody,
              timeoutMs: this.requestPolicy.timeoutMs,
            });
            if (response.status < 200 || response.status >= 300) {
              throw classifyStatus(
                response.status,
                `Dida API ${response.status}: ${sanitize(response.text)}`,
                response.headers,
                response.text,
              );
            }
            return response;
          },
        );
        return response.data;
      } catch (error) {
        if (error instanceof DidaHttpError && error.category === "unknown-outcome") {
          throw error;
        }
        if (
          options.outcomeUnknownOnNetworkFailure &&
          error instanceof DidaHttpError &&
          error.category === "rate-limit" &&
          !error.requestNotSent
        ) {
          throw new DidaHttpError(
            "unknown-outcome",
            "查询限流发生在写入请求之后，无法确认远端结果；已转入待核对状态",
            error.statusCode,
            undefined,
            true,
          );
        }
        if (error instanceof DidaHttpError) {
          // 全局 governor 已持久化冷却窗口。限流必须立即释放上层写门，
          // 只能由显式只读探针恢复，禁止在本次调用内等待或自动重发。
          if (error.category === "rate-limit") throw error;
          if (error.category !== "transient") throw error;
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
        if (attempt < maxAttempts - 1) {
          await this.sleep(1_000 * 2 ** attempt);
        }
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
    if (lastError instanceof Error) {
      throw new DidaHttpError("transient", lastError.message);
    }
    throw new DidaHttpError("transient", String(lastError));
  }

  private consumeBudget(): void {
    if (!this.budget) return;
    if (this.budget.remaining <= 0) {
      throw new DidaHttpError("permanent", "滴答合同请求预算已耗尽，已主动安全终止");
    }
    this.budget.remaining -= 1;
  }
}

function budgetFromPolicy(policy: DidaRequestPolicy): { remaining: number } | undefined {
  return policy.maxCalls === undefined
    ? undefined
    : {
        remaining: Number.isSafeInteger(policy.maxCalls) && policy.maxCalls >= 0
          ? policy.maxCalls
          : 0,
      };
}

function memoryControlPort() {
  let state: DidaRequestControlState = structuredClone(EMPTY_DIDA_REQUEST_CONTROL);
  return {
    read: async () => structuredClone(state),
    write: async (next: DidaRequestControlState) => { state = structuredClone(next); },
  };
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
