import type { DidaProject, DidaTask } from "../../domain/entities";
import type { TaskScheduleMode } from "../../domain/task-schedule";
import type { DidaApi } from "./api";
import { DidaHttpError } from "./http-contract";
import { normalizeProject, normalizeTask } from "./normalization";
import { serializeDidaDate } from "./serialization";

type ContractApi = Pick<
  DidaApi,
  | "createProject"
  | "getProjects"
  | "getProject"
  | "getProjectData"
  | "deleteProject"
  | "createTask"
  | "getTask"
  | "getCompletedTasks"
  | "updateTask"
  | "moveTask"
  | "completeTask"
  | "deleteTask"
>;

const ABSENCE_CHECK_ATTEMPTS = 20;
const ABSENCE_CHECK_DELAY_MS = 750;
const CONSISTENCY_RETRY_BUDGET_MS = 15_000;

export interface DidaWriteContractProgress {
  stage: string;
  attempt?: number;
  maxAttempts?: number;
}

export interface DidaWriteContractReport {
  status: "passed" | "failed";
  steps: string[];
  failure?: string;
  failureStage?: string;
  cleanupErrors: string[];
  remoteArtifactsRemaining: boolean;
  taskScheduleMode: TaskScheduleMode;
}

interface CreatedProject {
  id: string;
  name: string;
}

interface CreatedTask {
  id: string;
  projectId: string;
  candidateProjectIds: string[];
  state: "open" | "completed" | "unknown";
}

export class DidaWriteContractRunner {
  private untrackedCreateOutcome = false;
  private taskScheduleMode: TaskScheduleMode = "unknown";
  private currentStage = "准备合同测试";
  private readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  constructor(
    private readonly api: ContractApi,
    private readonly createRunId: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (milliseconds: number) => Promise<void> = delay,
    private readonly onProgress: (progress: DidaWriteContractProgress) => void = () => undefined,
    private readonly monotonicNow: () => number = () => Date.now(),
  ) {}

  async run(): Promise<DidaWriteContractReport> {
    this.untrackedCreateOutcome = false;
    this.taskScheduleMode = "unknown";
    this.currentStage = "准备合同测试";
    const runId = this.createRunId();
    const marker = `[Helix 合同测试 ${runId}]`;
    const projectAName = `${marker} 清单 A`;
    const projectBName = `${marker} 清单 B`;
    const steps: string[] = [];
    const cleanupErrors: string[] = [];
    const projects: CreatedProject[] = [];
    const forbiddenProjectIds = new Set<string>();
    let task: CreatedTask | null = null;
    let failure: string | undefined;
    let failureStage: string | undefined;

    try {
      this.beginStage("冻结测试前清单范围");
      const existingProjects = await this.api.getProjects();
      if (!Array.isArray(existingProjects)) throw new Error("写入测试前清单列表不是数组");
      for (const project of existingProjects.map(normalizeProject)) {
        forbiddenProjectIds.add(project.id);
      }
      steps.push("冻结测试前既有清单 ID 集合");

      this.beginStage("创建并复读专用清单 A");
      const projectA = await this.createAndVerifyProject(
        projectAName,
        projects,
        forbiddenProjectIds,
      );
      steps.push("创建并复读专用清单 A");

      this.beginStage("创建并复读专用清单 B");
      const projectB = await this.createAndVerifyProject(
        projectBName,
        projects,
        forbiddenProjectIds,
      );
      steps.push("创建并复读专用清单 B");

      const firstStart = this.futureInstant(86_400_000);
      const firstDue = this.futureInstant(90_000_000);
      this.beginStage("创建并核对测试任务字段");
      let created: DidaTask;
      try {
        created = normalizeTask(await this.api.createTask({
          projectId: projectA.id,
          title: `${marker} 新建任务`,
          content: `${marker} create`,
          priority: 1,
          isAllDay: false,
          timeZone: this.timeZone,
          startDate: serializeDidaDate(firstStart, "任务开始日期"),
          dueDate: serializeDidaDate(firstDue, "任务截止日期"),
        }));
      } catch (error) {
        this.untrackedCreateOutcome = true;
        throw error;
      }
      task = {
        id: created.id,
        projectId: created.projectId,
        candidateProjectIds: [projectA.id, projectB.id],
        state: "open",
      };
      this.assertTaskIdentity(created, created.id, projectA.id, marker);
      const rereadCreated = normalizeTask(await this.api.getTask(projectA.id, created.id));
      this.assertTaskIdentity(rereadCreated, created.id, projectA.id, marker);
      this.assertTaskFields(rereadCreated, {
        title: `${marker} 新建任务`,
        content: `${marker} create`,
        priority: 1,
        timeZone: this.timeZone,
        isAllDay: false,
        startDate: firstStart,
        dueDate: firstDue,
      });
      this.taskScheduleMode = this.classifyInitialSchedule(
        rereadCreated,
        firstStart,
        firstDue,
      );
      steps.push(
        this.taskScheduleMode === "duration"
          ? "创建任务并验证标题、内容、优先级和独立起止时间"
          : "创建任务并验证标题、内容、优先级；账号使用单点任务时间",
      );

      const secondStart = this.futureInstant(172_800_000);
      const secondDue = this.futureInstant(178_200_000);
      this.beginStage("编辑并复读测试任务");
      const updateStart = this.taskScheduleMode === "duration" ? secondStart : secondDue;
      const updatePayload = {
        id: created.id,
        projectId: projectA.id,
        title: `${marker} 已编辑任务`,
        content: `${marker} update`,
        priority: 5,
        isAllDay: false,
        timeZone: this.timeZone,
        startDate: serializeDidaDate(updateStart, "任务开始日期"),
        dueDate: serializeDidaDate(secondDue, "任务截止日期"),
      };
      const reconciledUnknownUpdate = await this.updateAndVerifyTask(
        created.id,
        projectA.id,
        marker,
        updatePayload,
        updateStart,
        secondDue,
      );
      steps.push(
        reconciledUnknownUpdate
          ? "编辑响应未知；未重发，精确复读已证明字段生效"
          : "编辑任务并复读验证字段",
      );

      this.beginStage("移动测试任务并核对来源清单");
      await this.api.moveTask({
        fromProjectId: projectA.id,
        toProjectId: projectB.id,
        taskId: created.id,
      });
      task.projectId = projectB.id;
      const rereadMoved = normalizeTask(await this.api.getTask(projectB.id, created.id));
      this.assertTaskIdentity(rereadMoved, created.id, projectB.id, marker);
      await this.waitForTaskAbsentFromProjectData(projectA.id, created.id);
      steps.push("移动任务并验证原清单已无该任务");

      this.beginStage("完成并复读测试任务");
      task.state = "unknown";
      await this.api.completeTask(projectB.id, created.id);
      const rereadCompleted = normalizeTask(await this.api.getTask(projectB.id, created.id));
      this.assertTaskIdentity(rereadCompleted, created.id, projectB.id, marker);
      if (rereadCompleted.status !== 2) throw new Error("任务完成后 status 未变为 2");
      task.state = "completed";
      steps.push("完成任务并复读状态");

      this.beginStage("删除并核对测试任务");
      await this.deleteVerifiedTask(task, marker);
      task = null;
      steps.push("删除测试任务并验证不存在");

      this.beginStage("核对并删除空测试清单");
      for (const project of [...projects].reverse()) {
        await this.deleteVerifiedProject(project, marker);
        projects.splice(projects.indexOf(project), 1);
      }
      steps.push("删除两个空测试清单并验证身份");
    } catch (error) {
      failureStage = this.currentStage;
      failure = `${failureStage}：${messageOf(error)}`;
    } finally {
      let taskCleanupFailed = false;
      if (task) {
        this.reportProgress("安全清理测试任务");
        await this.cleanupTask(task, marker).catch((error) => {
          taskCleanupFailed = true;
          cleanupErrors.push(`测试任务：${messageOf(error)}`);
        });
      }
      if (!taskCleanupFailed) {
        this.reportProgress("安全清理测试清单");
        for (const project of [...projects].reverse()) {
          await this.cleanupProject(project, marker).catch((error) => {
            cleanupErrors.push(`测试清单：${messageOf(error)}`);
          });
        }
      }
    }

    return {
      status: failure ? "failed" : "passed",
      steps,
      failure,
      failureStage,
      cleanupErrors,
      remoteArtifactsRemaining: cleanupErrors.length > 0 || this.untrackedCreateOutcome,
      taskScheduleMode: this.taskScheduleMode,
    };
  }

  private async updateAndVerifyTask(
    taskId: string,
    projectId: string,
    marker: string,
    payload: Partial<DidaTask>,
    expectedStart: string,
    expectedDue: string,
  ): Promise<boolean> {
    let unknownOutcome: unknown;
    try {
      await this.api.updateTask(taskId, payload);
    } catch (error) {
      if (!isUnknownRemoteOutcome(error)) throw error;
      unknownOutcome = error;
    }

    let reread: DidaTask;
    try {
      reread = normalizeTask(await this.api.getTask(projectId, taskId));
    } catch (error) {
      if (!unknownOutcome) throw error;
      throw new Error(
        `编辑响应未知且精确复读失败；未重发。原始错误：${messageOf(unknownOutcome)}；` +
        `复读错误：${messageOf(error)}`,
      );
    }

    try {
      this.assertTaskIdentity(reread, taskId, projectId, marker);
      this.assertTaskFields(reread, {
        title: payload.title ?? "",
        content: payload.content,
        priority: payload.priority,
        timeZone: payload.timeZone,
        isAllDay: payload.isAllDay,
        startDate: expectedStart,
        dueDate: expectedDue,
      });
      this.assertScheduleForMode(reread, expectedStart, expectedDue);
    } catch (error) {
      if (!unknownOutcome) throw error;
      throw new Error(
        `编辑响应未知，精确复读未证明写入生效；未重发。原始错误：` +
        `${messageOf(unknownOutcome)}；核对错误：${messageOf(error)}`,
      );
    }
    return unknownOutcome !== undefined;
  }

  private async createAndVerifyProject(
    name: string,
    tracked: CreatedProject[],
    forbiddenIds: Set<string>,
  ): Promise<CreatedProject> {
    let created: DidaProject;
    try {
      created = normalizeProject(await this.api.createProject({ name }));
    } catch (error) {
      this.untrackedCreateOutcome = true;
      throw error;
    }
    if (created.name !== name) {
      this.untrackedCreateOutcome = true;
      throw new Error("新建清单返回的名称与本轮唯一标记不一致");
    }
    if (forbiddenIds.has(created.id)) {
      this.untrackedCreateOutcome = true;
      throw new Error("新建清单返回了测试前已存在或本轮已使用的 ID，拒绝继续");
    }
    const project = { id: created.id, name };
    tracked.push(project);
    forbiddenIds.add(created.id);
    const reread = normalizeProject(await this.api.getProject(created.id));
    if (reread.id !== created.id || reread.name !== name) {
      throw new Error("新建清单复读身份与本轮唯一标记不一致");
    }
    return project;
  }

  private assertTaskIdentity(
    task: DidaTask,
    taskId: string,
    projectId: string,
    marker: string,
  ): void {
    if (task.id !== taskId || task.projectId !== projectId || !task.title.includes(marker)) {
      throw new Error("任务身份、清单或本轮唯一标记不一致");
    }
  }

  private assertTaskFields(
    task: DidaTask,
    expected: Pick<
      DidaTask,
      | "title"
      | "content"
      | "priority"
      | "timeZone"
      | "isAllDay"
      | "startDate"
      | "dueDate"
    >,
  ): void {
    const mismatches = [
      task.title !== expected.title ? "标题" : null,
      task.content !== expected.content ? "内容" : null,
      task.priority !== expected.priority ? "优先级" : null,
      task.timeZone !== expected.timeZone
        ? `时区（预期 ${expected.timeZone ?? "空"}，实际 ${task.timeZone ?? "空"}）`
        : null,
      task.isAllDay !== expected.isAllDay ? "全天状态" : null,
    ].filter((label): label is string => label !== null);
    if (mismatches.length > 0) {
      throw new Error(`任务写后复读字段与提交值不一致：${mismatches.join("、")}`);
    }
  }

  private classifyInitialSchedule(
    task: DidaTask,
    expectedStart: string,
    expectedDue: string,
  ): Exclude<TaskScheduleMode, "unknown"> {
    if (sameInstant(task.startDate, expectedStart) && sameInstant(task.dueDate, expectedDue)) {
      return "duration";
    }
    if (
      sameInstant(task.dueDate, expectedDue) &&
      (sameInstant(task.startDate, expectedDue) || task.startDate === null)
    ) {
      return "point";
    }
    throw scheduleMismatch(task, expectedStart, expectedDue);
  }

  private assertScheduleForMode(
    task: DidaTask,
    expectedStart: string,
    expectedDue: string,
  ): void {
    if (this.taskScheduleMode === "duration") {
      if (sameInstant(task.startDate, expectedStart) && sameInstant(task.dueDate, expectedDue)) return;
      throw scheduleMismatch(task, expectedStart, expectedDue);
    }
    if (
      this.taskScheduleMode === "point" &&
      sameInstant(task.dueDate, expectedDue) &&
      (sameInstant(task.startDate, expectedDue) || task.startDate === null)
    ) {
      return;
    }
    throw scheduleMismatch(task, expectedDue, expectedDue);
  }

  private futureInstant(offsetMs: number): string {
    const milliseconds = this.now().getTime() + offsetMs;
    return new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString();
  }

  private async deleteVerifiedTask(task: CreatedTask, marker: string): Promise<void> {
    const current = normalizeTask(await this.api.getTask(task.projectId, task.id));
    if (current.id !== task.id) throw new Error("删除前任务 ID 复读不一致");
    this.assertTaskIdentity(current, task.id, task.projectId, marker);
    await this.assertTaskPresentInObservableCollection(task);
    try {
      await this.api.deleteTask(task.projectId, task.id);
    } catch (error) {
      try {
        await this.waitForTaskAbsentFromObservableCollection(task);
        return;
      } catch {
        throw error;
      }
    }
    await this.waitForTaskAbsentFromObservableCollection(task);
  }

  private async deleteVerifiedProject(project: CreatedProject, marker: string): Promise<void> {
    const current = normalizeProject(await this.api.getProject(project.id));
    if (current.id !== project.id || current.name !== project.name || !current.name.includes(marker)) {
      throw new Error("删除前清单身份或本轮唯一标记不一致");
    }
    const data = await this.api.getProjectData(project.id);
    const tasks = Array.isArray(data.tasks) ? data.tasks.map(normalizeTask) : null;
    if (!tasks) throw new Error("删除前清单任务列表不是数组");
    if (tasks.some((candidate) => !candidate.title.includes(marker))) {
      throw new Error("测试清单出现非本轮任务，拒绝删除清单");
    }
    if (tasks.length > 0) throw new Error("测试清单仍有任务，拒绝删除清单");
    const completedTasks = await this.readCompletedTasks(project.id, "full-history");
    if (completedTasks.some((candidate) => !candidate.title.includes(marker))) {
      throw new Error("测试清单出现非本轮已完成任务，拒绝删除清单");
    }
    if (completedTasks.length > 0) {
      throw new Error("测试清单仍有已完成任务，拒绝删除清单");
    }
    try {
      await this.api.deleteProject(project.id);
    } catch (error) {
      try {
        await this.waitForProjectAbsentFromCollection(project.id);
        return;
      } catch {
        throw error;
      }
    }
    await this.waitForProjectAbsentFromCollection(project.id);
  }

  private async assertProjectAbsentFromCollection(projectId: string): Promise<void> {
    const projects = await this.api.getProjects();
    if (!Array.isArray(projects)) throw new Error("清单删除复核返回值不是数组");
    if (projects.map(normalizeProject).some((project) => project.id === projectId)) {
      throw new ConsistencyPendingError("清单删除后仍存在于活动清单集合");
    }
  }

  private async waitForProjectAbsentFromCollection(projectId: string): Promise<void> {
    await this.waitForConsistency(
      () => this.assertProjectAbsentFromCollection(projectId),
      "等待活动清单集合确认删除",
    );
  }

  private async assertTaskPresentInObservableCollection(task: CreatedTask): Promise<void> {
    await this.waitForConsistency(async () => {
      const tasks = await this.readObservableTasks(task);
      if (!tasks.some((candidate) => candidate.id === task.id)) {
        throw new ConsistencyPendingError("删除前任务不在预期可观察集合，拒绝执行删除");
      }
    }, "等待任务进入可观察集合");
  }

  private async assertTaskAbsentFromObservableCollection(task: CreatedTask): Promise<void> {
    const tasks = await this.readObservableTasks(task);
    if (tasks.some((candidate) => candidate.id === task.id)) {
      throw new ConsistencyPendingError("任务删除后仍存在于可观察任务集合");
    }
  }

  private async waitForTaskAbsentFromObservableCollection(task: CreatedTask): Promise<void> {
    await this.waitForConsistency(
      () => this.assertTaskAbsentFromObservableCollection(task),
      "等待任务集合确认删除",
    );
  }

  private async waitForTaskAbsentFromProjectData(projectId: string, taskId: string): Promise<void> {
    await this.waitForConsistency(async () => {
      const data = await this.api.getProjectData(projectId);
      if (!Array.isArray(data.tasks)) throw new Error("任务移动复核返回值不是数组");
      if (data.tasks.map(normalizeTask).some((candidate) => candidate.id === taskId)) {
        throw new ConsistencyPendingError("任务移动后仍存在于原清单任务集合");
      }
    }, "等待来源清单确认任务移出");
  }

  private async readObservableTasks(task: CreatedTask): Promise<DidaTask[]> {
    if (task.state === "open") {
      const data = await this.api.getProjectData(task.projectId);
      if (!Array.isArray(data.tasks)) throw new Error("任务删除复核返回值不是数组");
      return data.tasks.map(normalizeTask);
    }
    const completed = await this.readCompletedTasks(task.projectId);
    if (task.state === "completed") return completed;
    const data = await this.api.getProjectData(task.projectId);
    if (!Array.isArray(data.tasks)) throw new Error("任务删除复核返回值不是数组");
    const byId = new Map<string, DidaTask>();
    for (const candidate of [...data.tasks.map(normalizeTask), ...completed]) {
      byId.set(candidate.id, candidate);
    }
    return [...byId.values()];
  }

  private async readCompletedTasks(
    projectId: string,
    range: "recent" | "full-history" = "recent",
  ): Promise<DidaTask[]> {
    const center = this.now().getTime();
    const tasks = await this.api.getCompletedTasks({
      projectIds: [projectId],
      startDate: new Date(range === "full-history" ? 0 : center - 86_400_000).toISOString(),
      endDate: new Date(center + 86_400_000).toISOString(),
    });
    if (!Array.isArray(tasks)) throw new Error("已完成任务删除复核返回值不是数组");
    return tasks.map(normalizeTask).filter((candidate) => candidate.projectId === projectId);
  }

  private async waitForConsistency(check: () => Promise<void>, stage: string): Promise<void> {
    let lastError: unknown;
    const deadline = this.monotonicNow() + CONSISTENCY_RETRY_BUDGET_MS;
    for (let attempt = 0; attempt < ABSENCE_CHECK_ATTEMPTS; attempt += 1) {
      this.reportProgress(stage, attempt + 1, ABSENCE_CHECK_ATTEMPTS);
      try {
        await check();
        return;
      } catch (error) {
        if (!(error instanceof ConsistencyPendingError)) throw error;
        lastError = error;
        if (attempt < ABSENCE_CHECK_ATTEMPTS - 1) {
          const remaining = deadline - this.monotonicNow();
          if (remaining <= 0) break;
          await this.sleep(Math.min(ABSENCE_CHECK_DELAY_MS, remaining));
        }
      }
    }
    throw lastError;
  }

  private async cleanupTask(task: CreatedTask, marker: string): Promise<void> {
    const located = await this.locateTaskInCandidateCollections(task);
    if (!located) return;
    await this.deleteVerifiedTask(located, marker);
  }

  private async locateTaskInCandidateCollections(
    task: CreatedTask,
  ): Promise<CreatedTask | null> {
    let ambiguous = false;
    const deadline = this.monotonicNow() + CONSISTENCY_RETRY_BUDGET_MS;
    for (let attempt = 0; attempt < ABSENCE_CHECK_ATTEMPTS; attempt += 1) {
      this.reportProgress("定位待清理测试任务", attempt + 1, ABSENCE_CHECK_ATTEMPTS);
      const matches: CreatedTask[] = [];
      for (const projectId of task.candidateProjectIds) {
        const candidate = { ...task, projectId };
        const tasks = await this.readObservableTasks(candidate);
        if (tasks.some((current) => current.id === task.id)) matches.push(candidate);
      }
      if (matches.length === 1) return matches[0]!;
      ambiguous = matches.length > 1;
      if (attempt < ABSENCE_CHECK_ATTEMPTS - 1) {
        const remaining = deadline - this.monotonicNow();
        if (remaining <= 0) break;
        await this.sleep(Math.min(ABSENCE_CHECK_DELAY_MS, remaining));
      }
    }
    if (ambiguous) throw new Error("测试任务同时存在于多个候选清单集合，拒绝猜测归属");
    return null;
  }

  private async cleanupProject(project: CreatedProject, marker: string): Promise<void> {
    try {
      await this.deleteVerifiedProject(project, marker);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  private reportProgress(stage: string, attempt?: number, maxAttempts?: number): void {
    try {
      this.onProgress({ stage, attempt, maxAttempts });
    } catch {
      // 进度展示不能中断远端清理或改变合同测试结论。
    }
  }

  private beginStage(stage: string): void {
    this.currentStage = stage;
    this.reportProgress(stage);
  }
}

class ConsistencyPendingError extends Error {}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "statusCode" in error && error.statusCode === 404;
}

function isUnknownRemoteOutcome(error: unknown): boolean {
  if (error instanceof DidaHttpError) {
    return error.category === "unknown-outcome" || error.remoteOutcomeUnknown === true;
  }
  return !!error && typeof error === "object" &&
    "remoteOutcomeUnknown" in error && error.remoteOutcomeUnknown === true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scheduleMismatch(task: DidaTask, expectedStart: string, expectedDue: string): Error {
  return new Error(
    "任务写后复读时间与提交值不一致：" +
    `开始时间（预期 ${expectedStart}，实际 ${task.startDate ?? "空"}）、` +
    `截止时间（预期 ${expectedDue}，实际 ${task.dueDate ?? "空"}）`,
  );
}

function sameInstant(actual: string | null | undefined, expected: string): boolean {
  return !!actual && Date.parse(actual) === Date.parse(expected);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
