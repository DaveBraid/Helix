import type { DidaColumn, DidaProject, DidaTask } from "../domain/entities";
import type {
  DidaContractCleanupPlan,
  PendingDidaContractCleanup,
} from "../domain/dida-contract-cleanup";
import {
  isDidaContractTaskTitle,
  parseDidaContractProjectName,
} from "../domain/dida-contract-cleanup";
import type { DidaApi } from "../integrations/dida/api";
import {
  normalizeColumns,
  normalizeProject,
  normalizeTask,
} from "../integrations/dida/normalization";

type CleanupApi = Pick<
  DidaApi,
  "getProjects" | "getProjectData" | "getColumns" | "getCompletedTasks" |
  "deleteTask" | "deleteProject"
>;

export interface ContractCleanupStore {
  snapshot(): Promise<{ pendingDidaContractCleanup?: PendingDidaContractCleanup }>;
  mutate(mutator: (data: { pendingDidaContractCleanup?: PendingDidaContractCleanup }) => void): Promise<void>;
}

export class DidaContractCleanupService {
  constructor(
    private readonly api: CleanupApi,
    private readonly store: ContractCleanupStore,
    _sleep: (milliseconds: number) => Promise<void> = delay,
    _monotonicNow: () => number = () => Date.now(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async adoptStrictRemoteRun(authorizationBinding: string): Promise<void> {
    const current = await this.store.snapshot();
    const placeholder = current.pendingDidaContractCleanup;
    if (placeholder && (placeholder.authorizationBinding !== authorizationBinding ||
      placeholder.plan.projects.length > 0 || placeholder.plan.tasks.length > 0)) {
      throw new Error("已有待清理合同计划，拒绝再次领养");
    }
    const projects = (await this.readWithRateLimit(() => this.api.getProjects()))
      .map(normalizeProject);
    const allContractProjects = projects.flatMap((project) => {
      const parsed = parseDidaContractProjectName(project.name);
      return parsed ? [{ project, ...parsed }] : [];
    });
    if (placeholder) {
      const sameRun = allContractProjects.filter((entry) =>
        entry.runId === placeholder.plan.runId);
      if (sameRun.length === 0) {
        const secondProjects = (await this.readWithRateLimit(() => this.api.getProjects()))
          .map(normalizeProject);
        if (!sameProjectIdentityList(projects, secondProjects) || secondProjects.some((project) =>
          parseDidaContractProjectName(project.name)?.runId === placeholder.plan.runId)) {
          throw new Error("远端清单双读不稳定或本轮对象重新出现，保留占位");
        }
        await this.store.mutate((data) => {
          const existing = data.pendingDidaContractCleanup;
          if (!sameEmptyPlaceholder(existing, placeholder)) {
            throw new Error("合同清理占位发生竞争，拒绝清除");
          }
          delete data.pendingDidaContractCleanup;
        });
        return;
      }
      if (sameRun.length !== 2) {
        throw new Error("本轮合同残留不是精确 A/B 组，保留占位");
      }
    }
    const contractProjects = placeholder
      ? allContractProjects.filter((entry) => entry.runId === placeholder.plan.runId)
      : allContractProjects;
    const runIds = [...new Set(contractProjects.map((entry) => entry.runId))];
    if (runIds.length !== 1 || contractProjects.length !== 2) {
      throw new Error("远端合同残留不是唯一 A/B 运行组，拒绝领养");
    }
    const runId = runIds[0]!;
    const marker = `[Helix 合同测试 ${runId}]`;
    if (placeholder && (placeholder.plan.runId !== runId || placeholder.plan.marker !== marker)) {
      throw new Error("远端合同运行组与待领养占位不一致，拒绝覆盖");
    }
    const a = contractProjects.filter((entry) => entry.runId === runId && entry.side === "A");
    const b = contractProjects.filter((entry) => entry.runId === runId && entry.side === "B");
    if (a.length !== 1 || b.length !== 1) {
      throw new Error("远端合同残留未精确包含 A/B 各一个清单，拒绝领养");
    }
    const adoptedProjects: DidaContractCleanupPlan["projects"] = [];
    const adoptedTasks = new Map<string, DidaContractCleanupPlan["tasks"][number]>();
    for (const entry of [a[0]!, b[0]!]) {
      const [data, endpointColumns, completed] = await Promise.all([
        this.readWithRateLimit(() => this.api.getProjectData(entry.project.id)),
        this.readWithRateLimit(() => this.api.getColumns(entry.project.id)),
        this.readCompleted(entry.project.id),
      ]);
      const detailProject = normalizeProject(data.project);
      if (detailProject.id !== entry.project.id || detailProject.name !== entry.project.name) {
        throw new Error("合同清单列表与详情身份不一致，拒绝领养");
      }
      const detailColumns = normalizeColumns(data.columns);
      const columns = normalizeColumns(endpointColumns);
      assertExactColumns(detailColumns, columns, "合同清单双源列基线不一致，拒绝领养");
      adoptedProjects.push({
        id: entry.project.id,
        name: entry.project.name,
        expectedColumns: columns,
        baselineSource: "adopted",
      });
      const visible = [
        ...requireTaskArray(data.tasks, "合同清单开放任务列表"),
        ...completed,
      ];
      for (const task of visible) {
        if (task.projectId !== entry.project.id || !isDidaContractTaskTitle(task.title, marker)) {
          throw new Error("合同清单含非本轮任务或任务归属不一致，拒绝领养");
        }
        if (adoptedTasks.has(task.id)) {
          throw new Error("同一任务出现在多个候选集合，拒绝领养");
        }
        adoptedTasks.set(task.id, {
          id: task.id,
          candidateProjectIds: [a[0]!.project.id, b[0]!.project.id],
          state: "unknown",
        });
      }
    }
    const pending: PendingDidaContractCleanup = {
      authorizationBinding,
      plan: {
        runId,
        marker,
        projects: adoptedProjects,
        tasks: [...adoptedTasks.values()],
      },
    };
    await this.store.mutate((data) => {
      const existing = data.pendingDidaContractCleanup;
      if (placeholder ? !sameEmptyPlaceholder(existing, placeholder) : existing !== undefined) {
        throw new Error("合同清理计划发生竞争，拒绝覆盖");
      }
      data.pendingDidaContractCleanup = pending;
    });
  }

  /**
   * 合同已持久化精确项目基线、但内部探针未及登记任务时的窄恢复入口。
   * 只扫描计划中的本轮清单；任一非 marker 任务都会拒绝领养。
   */
  async adoptTasksIntoExistingPlan(authorizationBinding: string): Promise<void> {
    const initial = (await this.store.snapshot()).pendingDidaContractCleanup;
    if (!initial) throw new Error("没有待恢复的合同清理计划");
    if (initial.authorizationBinding !== authorizationBinding) {
      throw new Error("滴答授权已变化，拒绝领养旧授权下的测试任务");
    }
    if (initial.plan.projects.length === 0 || initial.plan.tasks.length > 0) {
      throw new Error("当前清理计划不符合任务补登记条件");
    }
    const adopted = new Map<string, DidaContractCleanupPlan["tasks"][number]>();
    for (const project of initial.plan.projects) {
      const [data, completed] = await Promise.all([
        this.readWithRateLimit(() => this.api.getProjectData(project.id)),
        this.readCompleted(project.id),
      ]);
      const detail = normalizeProject(data.project);
      if (detail.id !== project.id || detail.name !== project.name) {
        throw new Error("合同清单详情身份发生竞争，拒绝补登记任务");
      }
      const visible = [...requireTaskArray(data.tasks, "合同清单开放任务列表"), ...completed];
      const parentIds = new Set(visible.filter((task) =>
        task.projectId === project.id && !task.parentId &&
        typeof task.content === "string" && task.content.startsWith("helix-project-projection:") &&
        task.columnId && project.expectedColumns.some((column) => column.id === task.columnId))
        .map((task) => task.id));
      for (const task of visible) {
        const markerOwned = isDidaContractTaskTitle(task.title, initial.plan.marker) ||
          (!task.parentId && parentIds.has(task.id)) ||
          (Boolean(task.parentId) && parentIds.has(task.parentId!) &&
            typeof task.content === "string" && task.content.startsWith("helix-projection:"));
        if (task.projectId !== project.id || !markerOwned) {
          throw new Error("合同清单含非本轮任务，拒绝补登记");
        }
        if (adopted.has(task.id)) throw new Error("同一合同任务出现在多个清单，拒绝补登记");
        adopted.set(task.id, {
          id: task.id,
          candidateProjectIds: initial.plan.projects.map((candidate) => candidate.id),
          state: task.status === 2 ? "completed" : "open",
        });
      }
    }
    await this.store.mutate((data) => {
      const current = data.pendingDidaContractCleanup;
      if (!current || current.authorizationBinding !== authorizationBinding ||
        current.plan.runId !== initial.plan.runId || current.plan.tasks.length > 0) {
        throw new Error("合同清理计划发生竞争，拒绝补登记");
      }
      data.pendingDidaContractCleanup = {
        ...current,
        plan: { ...current.plan, tasks: [...adopted.values()] },
      };
    });
  }

  async recover(authorizationBinding: string): Promise<void> {
    const initial = (await this.store.snapshot()).pendingDidaContractCleanup;
    if (!initial) throw new Error("没有待恢复的合同清理计划");
    if (initial.authorizationBinding !== authorizationBinding) {
      throw new Error("滴答授权已变化，拒绝使用旧授权下的清理计划");
    }
    if (initial.plan.projects.length === 0 && initial.plan.tasks.length === 0) {
      throw new Error("合同结果存在未跟踪残留，必须先严格领养，禁止直接清理");
    }
    const runId = initial.plan.runId;
    for (const task of initial.plan.tasks) {
      await this.recoverTask(runId, task.id);
    }
    const afterTasks = (await this.store.snapshot()).pendingDidaContractCleanup;
    if (!afterTasks) return;
    if (afterTasks.plan.tasks.length > 0) {
      throw new Error("仍有任务未证明清理，拒绝删除合同清单");
    }
    for (const project of afterTasks.plan.projects) {
      await this.recoverProject(runId, project.id);
    }
  }

  private async recoverTask(runId: string, taskId: string): Promise<void> {
    const pending = await this.requireCurrent(runId);
    const task = pending.plan.tasks.find((entry) => entry.id === taskId);
    if (!task) return;
    const matches = await this.locateTask(task.id, task.candidateProjectIds, pending.plan);
    if (matches.length === 0) {
      await this.removeTask(runId, taskId);
      return;
    }
    if (matches.length !== 1) throw new Error("合同任务位置存在歧义，已保留清理计划");
    const match = matches[0]!;
    if (!isOwnedCleanupTask(match.task, pending.plan)) {
      throw new Error("合同任务唯一标记不一致，拒绝删除");
    }
    if (task.deleteState === "sent-unknown") {
      throw new Error("合同任务删除结果未知且对象仍存在；只允许以后复读，不会重发删除");
    }
    await this.markTaskSent(runId, taskId);
    try {
      await this.api.deleteTask(match.projectId, task.id);
    } catch (error) {
      const reread = await this.locateTask(task.id, task.candidateProjectIds, pending.plan);
      if (reread.length === 0) await this.removeTask(runId, taskId);
      else throw new Error(`合同任务删除结果未知，已冻结重发：${messageOf(error)}`);
      return;
    }
    const reread = await this.locateTask(task.id, task.candidateProjectIds, pending.plan);
    if (reread.length === 0) await this.removeTask(runId, taskId);
    else {
      throw new Error("合同任务删除后仍可见，已冻结重发并保留清理计划");
    }
  }

  private async recoverProject(runId: string, projectId: string): Promise<void> {
    const pending = await this.requireCurrent(runId);
    const project = pending.plan.projects.find((entry) => entry.id === projectId);
    if (!project) return;
    const projects = (await this.readWithRateLimit(() => this.api.getProjects())).map(normalizeProject);
    const current = projects.filter((entry) => entry.id === project.id);
    if (current.length === 0) {
      await this.removeProject(runId, projectId);
      return;
    }
    if (current.length !== 1 || current[0]!.name !== project.name ||
      current[0]!.name !== `${pending.plan.marker} 清单 ${project.name.endsWith(" A") ? "A" : "B"}`) {
      throw new Error("合同清单身份或精确名称发生竞争，拒绝删除");
    }
    const [data, endpointColumns, completed] = await Promise.all([
      this.readWithRateLimit(() => this.api.getProjectData(project.id)),
      this.readWithRateLimit(() => this.api.getColumns(project.id)),
      this.readCompleted(project.id),
    ]);
    const detailProject = normalizeProject(data.project);
    if (detailProject.id !== project.id || detailProject.name !== project.name) {
      throw new Error("合同清单详情身份发生竞争，拒绝删除");
    }
    const open = requireTaskArray(data.tasks, "合同清单开放任务列表");
    if (open.length > 0 || completed.length > 0) {
      throw new Error("合同清单仍有任务，拒绝删除");
    }
    const endpoint = normalizeColumns(endpointColumns);
    assertExactColumns(normalizeColumns(data.columns), endpoint, "合同清单双源列不一致，拒绝删除");
    assertExactColumns(endpoint, project.expectedColumns, "合同清单列基线发生竞争，拒绝删除");
    if (project.deleteState === "sent-unknown") {
      throw new Error("合同清单删除结果未知且对象仍存在；只允许以后复读，不会重发删除");
    }
    await this.markProjectSent(runId, projectId);
    try {
      await this.api.deleteProject(project.id);
    } catch (error) {
      const absent = await this.projectAbsent(project.id);
      if (absent) await this.removeProject(runId, projectId);
      else throw new Error(`合同清单删除结果未知，已冻结重发：${messageOf(error)}`);
      return;
    }
    if (await this.projectAbsent(project.id)) await this.removeProject(runId, projectId);
    else {
      throw new Error("合同清单删除后仍可见，已冻结重发并保留清理计划");
    }
  }

  private async locateTask(
    taskId: string,
    candidateProjectIds: string[],
    plan: DidaContractCleanupPlan,
  ): Promise<Array<{ projectId: string; task: DidaTask }>> {
    const matches: Array<{ projectId: string; task: DidaTask }> = [];
    const listed = (await this.readWithRateLimit(() => this.api.getProjects())).map(normalizeProject);
    for (const projectId of candidateProjectIds) {
      const expected = plan.projects.find((project) => project.id === projectId);
      if (!expected) throw new Error("候选清单不在合同清理计划内");
      const visibleProject = listed.filter((project) => project.id === projectId);
      if (visibleProject.length === 0) continue;
      if (visibleProject.length !== 1 || visibleProject[0]!.name !== expected.name) {
        throw new Error("候选清单身份或精确名称发生竞争，拒绝定位任务");
      }
      const [data, completed] = await Promise.all([
        this.readWithRateLimit(() => this.api.getProjectData(projectId)),
        this.readCompleted(projectId),
      ]);
      const project = normalizeProject(data.project);
      if (project.id !== projectId || project.name !== expected.name) {
        throw new Error("候选清单详情身份或精确名称不一致");
      }
      const visible = [...requireTaskArray(data.tasks, "候选清单开放任务列表"), ...completed];
      for (const task of visible.filter((entry) => entry.id === taskId)) {
        matches.push({ projectId, task });
      }
    }
    return matches;
  }

  private async readCompleted(projectId: string): Promise<DidaTask[]> {
    const tasks = await this.readWithRateLimit(() => this.api.getCompletedTasks({
      projectIds: [projectId],
      startDate: new Date(0).toISOString(),
      endDate: new Date(this.now().getTime() + 86_400_000).toISOString(),
    }));
    if (!Array.isArray(tasks)) throw new Error("候选清单已完成任务列表不是数组");
    return tasks.map(normalizeTask).filter((task) => task.projectId === projectId);
  }

  private async projectAbsent(projectId: string): Promise<boolean> {
    const projects = await this.readWithRateLimit(() => this.api.getProjects());
    if (!Array.isArray(projects)) throw new Error("清单集合不是数组");
    return !projects.map(normalizeProject).some((project) => project.id === projectId);
  }

  private async readWithRateLimit<T>(read: () => Promise<T>): Promise<T> {
    // 全局请求治理器负责冷却；持有 RemoteWriteGate 的清理流程不得等待或自动重试。
    return read();
  }

  private async requireCurrent(runId: string): Promise<PendingDidaContractCleanup> {
    const pending = (await this.store.snapshot()).pendingDidaContractCleanup;
    if (!pending || pending.plan.runId !== runId) throw new Error("合同清理计划发生竞争，已停止");
    return pending;
  }

  private async removeTask(runId: string, taskId: string): Promise<void> {
    await this.updatePlan(runId, (plan) => ({
      ...plan,
      tasks: plan.tasks.filter((entry) => entry.id !== taskId),
    }));
  }

  private async markTaskSent(runId: string, taskId: string): Promise<void> {
    await this.updatePlan(runId, (plan) => ({
      ...plan,
      tasks: plan.tasks.map((entry) => entry.id === taskId
        ? { ...entry, deleteState: "sent-unknown" }
        : entry),
    }));
  }

  private async removeProject(runId: string, projectId: string): Promise<void> {
    await this.updatePlan(runId, (plan) => ({
      ...plan,
      projects: plan.projects.filter((entry) => entry.id !== projectId),
    }));
  }

  private async markProjectSent(runId: string, projectId: string): Promise<void> {
    await this.updatePlan(runId, (plan) => ({
      ...plan,
      projects: plan.projects.map((entry) => entry.id === projectId
        ? { ...entry, deleteState: "sent-unknown" }
        : entry),
    }));
  }

  private async updatePlan(
    runId: string,
    update: (plan: DidaContractCleanupPlan) => DidaContractCleanupPlan,
  ): Promise<void> {
    await this.store.mutate((data) => {
      const pending = data.pendingDidaContractCleanup;
      if (!pending || pending.plan.runId !== runId) throw new Error("合同清理计划发生竞争，拒绝覆盖");
      const plan = update(pending.plan);
      if (plan.projects.length === 0 && plan.tasks.length === 0) {
        delete data.pendingDidaContractCleanup;
      } else {
        data.pendingDidaContractCleanup = { ...pending, plan };
      }
    });
  }
}

function isOwnedCleanupTask(task: DidaTask, plan: DidaContractCleanupPlan): boolean {
  if (isDidaContractTaskTitle(task.title, plan.marker)) return true;
  const project = plan.projects.find((candidate) => candidate.id === task.projectId);
  if (!project || !task.columnId || !project.expectedColumns.some((column) => column.id === task.columnId)) {
    return false;
  }
  if (!task.parentId) {
    return typeof task.content === "string" && task.content.startsWith("helix-project-projection:");
  }
  return plan.tasks.some((candidate) => candidate.id === task.parentId) &&
    typeof task.content === "string" && task.content.startsWith("helix-projection:");
}

function requireTaskArray(value: unknown, label: string): DidaTask[] {
  if (!Array.isArray(value)) throw new Error(`${label}不是数组`);
  return value.map(normalizeTask);
}

function assertExactColumns(actual: DidaColumn[], expected: DidaColumn[], message: string): void {
  if (actual.length !== expected.length || actual.some((column, index) => {
    const baseline = expected[index];
    return !baseline || column.id !== baseline.id || column.projectId !== baseline.projectId ||
      column.name !== baseline.name || column.sortOrder !== baseline.sortOrder ||
      column.sortOrderUnsafe !== baseline.sortOrderUnsafe;
  })) throw new Error(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameEmptyPlaceholder(
  current: PendingDidaContractCleanup | undefined,
  expected: PendingDidaContractCleanup,
): boolean {
  return !!current && current.authorizationBinding === expected.authorizationBinding &&
    current.plan.runId === expected.plan.runId && current.plan.marker === expected.plan.marker &&
    current.plan.projects.length === 0 && current.plan.tasks.length === 0;
}

function sameProjectIdentityList(left: DidaProject[], right: DidaProject[]): boolean {
  const identity = (projects: DidaProject[]) => projects
    .map((project) => `${project.id}\u0000${project.name}`)
    .sort();
  const a = identity(left);
  const b = identity(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
