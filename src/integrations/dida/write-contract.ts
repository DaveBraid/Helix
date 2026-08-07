import type { DidaColumn, DidaProject, DidaTask } from "../../domain/entities";
import { assertStableId } from "../../domain/dida-project-projection";
import {
  didaTaskDifferenceFields,
  didaTaskWithoutRemoteMetadata,
  sameDidaTaskExcept,
} from "../../domain/dida-task-metadata";
import type { TaskScheduleMode } from "../../domain/task-schedule";
import {
  isDidaContractTaskTitle,
  type DidaContractCleanupPlan,
} from "../../domain/dida-contract-cleanup";
import { deepEqual } from "../../domain/stable";
import type { DidaApi, DidaTaskUpdateWirePayload } from "./api";
import {
  sameTaskBoardPlacementInvariant,
  taskBoardPlacementPayload,
  taskCreatePayload,
  taskUpdatePayload,
  type DidaTaskWriteCapabilities,
} from "./adapters";
import { DidaHttpError } from "./http-contract";
import { normalizeColumns, normalizeProject, normalizeTask } from "./normalization";
import { serializeDidaDate } from "./serialization";

type ContractApi = Pick<
  DidaApi,
  | "createProject"
  | "getProjects"
  | "getProject"
  | "getProjectData"
  | "updateProject"
  | "getColumns"
  | "createColumn"
  | "updateColumn"
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
  boardPlacementVerified: boolean;
  columnCreateVerified: boolean;
  taskCrudVerified: boolean;
  reminderWriteVerified: boolean;
  repeatWriteVerified: boolean;
  itemsRoundTripVerified: boolean;
  itemIdStableVerified: boolean;
  taskReopenVerified: boolean;
  manualCleanupRequired?: {
    taskId: string;
    marker: string;
    candidateProjectIds: string[];
    reason: string;
  };
  capabilityFailures: string[];
  /** 固定、脱敏的能力探针失败阶段码；不得包含远端正文或 ID。 */
  capabilityFailureCodes: string[];
  /** 仅供持久恢复使用；不得进入 Notice 或普通诊断。 */
  cleanupPlan?: DidaContractCleanupPlan;
}

export function verifiedBoardPlacementCapability(
  report: Pick<DidaWriteContractReport, "boardPlacementVerified" | "remoteArtifactsRemaining">,
): boolean {
  return report.boardPlacementVerified && !report.remoteArtifactsRemaining;
}

interface CreatedProject {
  id: string;
  name: string;
  viewMode?: DidaProject["viewMode"];
  expectedColumns: DidaColumn[];
  columnsCaptured: boolean;
  deleteState?: "sent-unknown";
}

interface CreatedTask {
  id: string;
  projectId: string;
  candidateProjectIds: string[];
  state: "open" | "completed" | "unknown";
  deleteState?: "sent-unknown";
}

export class DidaWriteContractRunner {
  private untrackedCreateOutcome = false;
  private taskScheduleMode: TaskScheduleMode = "unknown";
  private boardPlacementVerified = false;
  private columnCreateVerified = false;
  private taskCrudVerified = false;
  private reminderWriteVerified = false;
  private repeatWriteVerified = false;
  private itemsRoundTripVerified = false;
  private itemIdStableVerified = false;
  private taskReopenVerified = false;
  private manualCleanupRequired: DidaWriteContractReport["manualCleanupRequired"];
  private currentStage = "准备合同测试";
  private cleanupCheckpoint: (() => Promise<void>) | undefined;
  private cleanupCheckpointFailed = false;
  private readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  private api: ContractApi;

  constructor(
    api: ContractApi,
    private readonly createRunId: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (milliseconds: number) => Promise<void> = delay,
    private readonly onProgress: (progress: DidaWriteContractProgress) => void = () => undefined,
    private readonly monotonicNow: () => number = () => Date.now(),
    private readonly onCleanupPlanChange: (
      plan: DidaContractCleanupPlan | undefined,
    ) => Promise<void> = async () => undefined,
    private readonly cleanupApi: ContractApi = api,
  ) {
    this.api = api;
  }

  async run(): Promise<DidaWriteContractReport> {
    this.untrackedCreateOutcome = false;
    this.taskScheduleMode = "unknown";
    this.boardPlacementVerified = false;
    this.columnCreateVerified = false;
    this.taskCrudVerified = false;
    this.reminderWriteVerified = false;
    this.repeatWriteVerified = false;
    this.itemsRoundTripVerified = false;
    this.itemIdStableVerified = false;
    this.taskReopenVerified = false;
    this.manualCleanupRequired = undefined;
    this.currentStage = "准备合同测试";
    this.cleanupCheckpointFailed = false;
    const runId = this.createRunId();
    const marker = `[Helix 合同测试 ${runId}]`;
    const projectAName = `${marker} 清单 A`;
    const projectBName = `${marker} 清单 B`;
    const steps: string[] = [];
    const cleanupErrors: string[] = [];
    const capabilityFailures: string[] = [];
    const capabilityFailureCodes: string[] = [];
    const projects: CreatedProject[] = [];
    const forbiddenProjectIds = new Set<string>();
    let task: CreatedTask | null = null;
    let childTask: CreatedTask | null = null;
    const optionalTasks: CreatedTask[] = [];
    let failure: string | undefined;
    let failureStage: string | undefined;
    this.cleanupCheckpoint = async () => {
      try {
        await this.onCleanupPlanChange(buildCleanupPlan(
          runId,
          marker,
          projects,
          [task, childTask, ...optionalTasks].filter((entry): entry is CreatedTask => entry !== null),
          this.manualCleanupRequired,
          projects.length > 0 || task !== null || childTask !== null || optionalTasks.length > 0 ||
            this.untrackedCreateOutcome,
          this.untrackedCreateOutcome,
        ));
      } catch {
        this.cleanupCheckpointFailed = true;
        throw new Error("合同清理计划持久化发生竞争，已停止后续远端操作");
      }
    };

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

      this.beginStage("验证专用清单列表与看板默认视图");
      await this.updateAndVerifyProjectViewMode(projectA, "list");
      await this.updateAndVerifyProjectViewMode(projectA, "kanban");
      const kanbanData = await this.api.getProjectData(projectA.id);
      const kanbanProject = normalizeProject(kanbanData.project);
      if (
        kanbanProject.id !== projectA.id ||
        kanbanProject.name !== projectA.name ||
        kanbanProject.viewMode !== "kanban"
      ) {
        throw new Error("看板详情复读的清单身份、名称或视图状态不一致");
      }
      let columns = normalizeColumns(kanbanData.columns);
      const directlyReadColumns = normalizeColumns(await this.api.getColumns(projectA.id));
      this.assertExactColumns(
        columns,
        directlyReadColumns,
        "切换看板后的详情列与列端点复读不一致",
      );
      this.assertExactColumns(
        columns,
        projectA.expectedColumns,
        "切换看板后列基线出现未知变化",
      );
      const existingPlacementColumnId = columns[0]?.id;
      const baselineWasEmpty = columns.length === 0;
      projectA.expectedColumns = columns;
      const createCapabilityColumn = await this.createAndVerifyColumn(
        projectA,
        `${marker} 分栏创建能力`,
      );
      this.columnCreateVerified = true;
      columns = projectA.expectedColumns;
      steps.push("创建唯一标记分栏并经详情与列端点双源精确复读");
      if (baselineWasEmpty) {
        const firstColumnName = `${marker} 待处理`;
        const secondColumnName = `${marker} 进行中`;
        const firstColumn = await this.createAndVerifyColumn(
          projectA,
          firstColumnName,
        );
        const renameTarget = await this.createAndVerifyColumn(
          projectA,
          secondColumnName,
        );
        const renamed = `${marker} 验证中`;
        await this.updateAndVerifyColumn(projectA, renameTarget, renamed);
        columns = projectA.expectedColumns;
        if (!columns.some((column) => column.id === firstColumn.id)) {
          throw new Error("首个测试分栏在后续列操作中消失");
        }
      }
      if (!columns.some((column) => column.id === createCapabilityColumn.id)) {
        throw new Error("分栏创建能力测试对象在后续列操作中消失");
      }
      const columnIds = new Set<string>();
      for (const column of columns) {
        if (
          !column ||
          typeof column.id !== "string" ||
          !column.id ||
          column.projectId !== projectA.id ||
          typeof column.name !== "string" ||
          !column.name.trim() ||
          columnIds.has(column.id)
        ) {
          throw new Error("专用清单默认列的身份、名称或归属无效");
        }
        columnIds.add(column.id);
      }
      projectA.expectedColumns = columns;
      await this.updateAndVerifyProjectViewMode(projectA, "list");
      steps.push(`验证列表→看板→列表，并复读 ${columnIds.size} 个看板列`);

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
        await this.cleanupCheckpoint();
        throw error;
      }
      task = {
        id: created.id,
        projectId: created.projectId,
        candidateProjectIds: [projectA.id, projectB.id],
        state: "open",
      };
      await this.cleanupCheckpoint();
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

      this.beginStage("独立验证测试任务提醒写入与清空");
      const reminder = "TRIGGER:-PT10M";
      const reminderTask = await this.createCapabilityTask(
        projectA.id,
        marker,
        "提醒能力任务",
        optionalTasks,
      );
      this.reminderWriteVerified = await this.probeTaskField(
        reminderTask.id,
        projectA.id,
        marker,
        "reminders",
        [reminder],
        [],
        { reminderWriteVerified: true },
        capabilityFailures,
      );
      await this.deleteVerifiedTask(reminderTask, marker);
      optionalTasks.splice(optionalTasks.indexOf(reminderTask), 1);
      await this.cleanupCheckpoint();
      steps.push(this.reminderWriteVerified
        ? "独立写入并清空 10 分钟前提醒"
        : "当前账号未通过提醒写入合同，保持生产只读");

      this.beginStage("独立验证测试任务重复规则写入与清空");
      const repeatFlag = "RRULE:FREQ=DAILY;INTERVAL=1";
      const repeatTask = await this.createCapabilityTask(
        projectA.id,
        marker,
        "重复能力任务",
        optionalTasks,
      );
      this.repeatWriteVerified = await this.probeTaskField(
        repeatTask.id,
        projectA.id,
        marker,
        "repeatFlag",
        repeatFlag,
        null,
        { repeatWriteVerified: true },
        capabilityFailures,
      );
      await this.deleteVerifiedTask(repeatTask, marker);
      optionalTasks.splice(optionalTasks.indexOf(repeatTask), 1);
      await this.cleanupCheckpoint();
      steps.push(this.repeatWriteVerified
        ? "独立写入并清空每日重复规则"
        : "当前账号未通过重复规则写入合同，保持生产只读");

      this.beginStage("验证父任务检查项往返与 ID 稳定性");
      const parentTask = await this.createCapabilityTask(
        projectA.id,
        marker,
        "检查项能力父任务",
        optionalTasks,
      );
      let itemsFailureCode = "ITEMS_PARENT_CREATE";
      try {
        const emptyParent = normalizeTask(await this.api.getTask(projectA.id, parentTask.id));
        const sentinelTitle = `${marker} sentinel`;
        const sentinelDraft = { id: "", title: sentinelTitle, status: 0, sortOrder: 321 };
        itemsFailureCode = "ITEMS_SENTINEL_CREATE";
        const withSentinel = await this.updateAndVerifyTaskProperties(
          parentTask.id,
          projectA.id,
          marker,
          taskUpdatePayload({
            ...emptyParent,
            items: [sentinelDraft],
          }, { itemsRoundTripVerified: true }, ["items"]),
          (reread) => {
            if (!sameDidaTaskExcept(emptyParent, reread, ["items"])) throw new Error("新增 sentinel 时父任务其他字段发生变化");
            if (reread.items?.length !== 1 || !reread.items[0]?.id || reread.items[0].title !== sentinelTitle) {
              throw new Error("sentinel 检查项未获得唯一服务端 ID");
            }
            if (!sameInitialChecklistSemantics(sentinelDraft, reread.items[0])) {
              throw new Error("sentinel 检查项受管字段未按语义往返");
            }
          },
        );
        const sentinel = withSentinel.items![0]!;
        const ownedTitle = `${marker} owned item`;
        itemsFailureCode = "ITEMS_OWNED_APPEND";
        const withOwned = await this.updateAndVerifyTaskProperties(
          parentTask.id,
          projectA.id,
          marker,
          taskUpdatePayload({
            ...withSentinel,
            items: [...withSentinel.items!, { id: "", title: ownedTitle, status: 0 }],
          }, { itemsRoundTripVerified: true }, ["items"]),
          (reread) => {
            if (!sameDidaTaskExcept(withSentinel, reread, ["items"])) throw new Error("新增 owned item 时父任务其他字段发生变化");
            const added = (reread.items ?? []).filter((item) => item.id !== sentinel.id);
            if (added.length !== 1 || !added[0]?.id || added[0].title !== ownedTitle || added[0].status !== 0) {
              throw new Error("owned item 写后无法唯一领养服务端 ID");
            }
            if (!deepEqual(reread.items?.[0], sentinel) || reread.items?.[1]?.id !== added[0].id) {
              throw new Error("新增 owned item 时 sentinel 未完整保留");
            }
          },
        );
        const owned = withOwned.items!.find((item) => item.id !== sentinel.id)!;
        const renamed = { ...owned, title: `${ownedTitle} renamed`, status: 2 };
        itemsFailureCode = "ITEMS_OWNED_COMPLETE";
        const afterRename = await this.updateAndVerifyTaskProperties(
          parentTask.id,
          projectA.id,
          marker,
          taskUpdatePayload({ ...withOwned, items: [sentinel, renamed] }, { itemsRoundTripVerified: true }, ["items"]),
          (reread) => assertChecklistContractState(withOwned, reread, sentinel, renamed),
        );
        const reopened = { ...renamed, status: 0 };
        itemsFailureCode = "ITEMS_OWNED_REOPEN";
        const afterReopen = await this.updateAndVerifyTaskProperties(
          parentTask.id,
          projectA.id,
          marker,
          taskUpdatePayload({ ...afterRename, items: [sentinel, reopened] }, { itemsRoundTripVerified: true }, ["items"]),
          (reread) => assertChecklistContractState(afterRename, reread, sentinel, reopened),
        );
        itemsFailureCode = "ITEMS_OWNED_DELETE";
        await this.updateAndVerifyTaskProperties(
          parentTask.id,
          projectA.id,
          marker,
          taskUpdatePayload({ ...afterReopen, items: [sentinel] }, { itemsRoundTripVerified: true }, ["items"]),
          (reread) => {
            if (!sameDidaTaskExcept(afterReopen, reread, ["items"]) || reread.items?.length !== 1 ||
              !deepEqual(reread.items[0], sentinel)) throw new Error("删除 owned item 时 sentinel 或父任务其他字段发生变化");
          },
        );
        this.itemsRoundTripVerified = true;
        this.itemIdStableVerified = true;
        steps.push("验证 sentinel 保留、单项 ID 领养、ID 稳定、改名、完成/重开与 owned 删除");
        await this.cleanupCheckpoint();
        await this.deleteVerifiedTask(parentTask, marker);
        optionalTasks.splice(optionalTasks.indexOf(parentTask), 1);
        await this.cleanupCheckpoint();
      } catch (error) {
        if (this.untrackedCreateOutcome) throw error;
        if (isUnprovenRemoteOutcome(error)) throw error;
        await this.cleanupTask(parentTask, marker);
        optionalTasks.splice(optionalTasks.indexOf(parentTask), 1);
        await this.cleanupCheckpoint();
        this.itemsRoundTripVerified = false;
        this.itemIdStableVerified = false;
        capabilityFailures.push(capabilityFailureSummary("items"));
        capabilityFailureCodes.push(itemsFailureCode);
        steps.push("当前账号未通过检查项往返与 ID 稳定合同，保持项目投影只读");
      }

      this.beginStage("以最小载荷验证测试任务看板归栏");
      this.assertExactColumns(
        normalizeColumns(await this.api.getColumns(projectA.id)),
        projectA.expectedColumns,
        "写入任务归栏前的完整列基线已变化",
      );
      const boardTask = await this.createCapabilityTask(
        projectA.id,
        marker,
        "看板归栏能力任务",
        optionalTasks,
      );
      const beforePlacement = normalizeTask(await this.api.getTask(projectA.id, boardTask.id));
      this.assertTaskIdentity(beforePlacement, boardTask.id, projectA.id, marker);
      try {
        const reconciledUnknownPlacement = await this.placeAndVerifyTask(
          beforePlacement,
          existingPlacementColumnId ?? createCapabilityColumn.id,
          marker,
        );
        this.boardPlacementVerified = true;
        steps.push(
          reconciledUnknownPlacement
            ? "归栏响应未知；未重发，精确复读证明目标分栏且其他字段未变化"
            : "以最小白名单归栏并证明其他任务字段未变化",
        );
      } catch (error) {
        const current = normalizeTask(await this.api.getTask(projectA.id, boardTask.id));
        this.assertTaskIdentity(current, boardTask.id, projectA.id, marker);
        if (!sameTaskBoardPlacementInvariant(beforePlacement, current)) {
          const differences = didaTaskDifferenceFields(beforePlacement, current, ["columnId", "columnName"]);
          throw new Error(
            "看板归栏合同失败：归栏修改出现非目标字段；" +
            `差异字段 ${differenceFieldsLabel(differences)}`,
          );
        }
        if (isUnprovenRemoteOutcome(error)) throw error;
        this.boardPlacementVerified = false;
        capabilityFailures.push(capabilityFailureSummary("boardPlacement"));
        steps.push("当前账号未通过看板归栏合同，保持生产只读");
      }
      await this.deleteVerifiedTask(boardTask, marker);
      optionalTasks.splice(optionalTasks.indexOf(boardTask), 1);
      await this.cleanupCheckpoint();

      this.beginStage("移动测试任务并核对来源清单");
      const beforeMove = normalizeTask(await this.api.getTask(projectA.id, created.id));
      this.assertTaskIdentity(beforeMove, created.id, projectA.id, marker);
      const move = await this.moveAndVerifyTask(
        beforeMove,
        projectA.id,
        projectB.id,
        marker,
      );
      if (!move.applied) {
        task.projectId = projectA.id;
        throw new Error("移动复读确认任务仍在来源清单；已停止继续流程且未重发");
      }
      task.projectId = projectB.id;
      await this.cleanupCheckpoint();
      steps.push(
        move.responseUnknown
          ? "移动响应未知；未重发，目标清单精确复读且来源清单确认移出"
          : "移动任务并验证目标身份及原清单已无该任务",
      );

      this.beginStage("完成并复读测试任务");
      task.state = "unknown";
      await this.cleanupCheckpoint();
      await this.api.completeTask(projectB.id, created.id);
      const rereadCompleted = normalizeTask(await this.api.getTask(projectB.id, created.id));
      this.assertTaskIdentity(rereadCompleted, created.id, projectB.id, marker);
      if (rereadCompleted.status !== 2 ||
        !sameDidaTaskExcept(beforeMove, rereadCompleted, ["projectId", "status", "completedTime"])) {
        throw new Error("任务完成后状态未完成或除 completedTime 外其他字段发生变化");
      }
      task.state = "completed";
      await this.cleanupCheckpoint();
      steps.push("完成任务并复读状态");

      this.beginStage("删除并核对测试任务");
      await this.deleteVerifiedTask(task, marker);
      task = null;
      await this.cleanupCheckpoint();
      this.taskCrudVerified = true;
      steps.push("删除测试任务并验证不存在");

      this.beginStage("创建专用任务验证完成后重开");
      const reopenTask = await this.createCapabilityTask(
        projectA.id,
        marker,
        "重开能力任务",
        optionalTasks,
      );
      try {
        reopenTask.state = "unknown";
        await this.cleanupCheckpoint();
        await this.api.completeTask(projectA.id, reopenTask.id);
        const completed = normalizeTask(await this.api.getTask(projectA.id, reopenTask.id));
        this.assertTaskIdentity(completed, reopenTask.id, projectA.id, marker);
        if (completed.status !== 2) throw new Error("重开探针任务未先完成");
        reopenTask.state = "completed";
        await this.cleanupCheckpoint();
        await this.updateAndVerifyTaskProperties(
          reopenTask.id,
          projectA.id,
          marker,
          { id: reopenTask.id, projectId: projectA.id, status: 0 },
          (reread) => {
            if (reread.status === 2 ||
              !sameDidaTaskExcept(completed, reread, ["status", "completedTime"])) {
              throw new Error("最小 status=0 重开后状态未开放或其他字段发生变化");
            }
          },
        );
        reopenTask.state = "open";
        await this.cleanupCheckpoint();
        this.taskReopenVerified = true;
        steps.push("专用临时任务完成→最小 status=0→精确复读");
      } catch (error) {
        if (isUnprovenRemoteOutcome(error)) throw error;
        this.taskReopenVerified = false;
        capabilityFailures.push(capabilityFailureSummary("taskReopen"));
        steps.push("当前账号未通过任务重开合同，重开保持冻结");
      } finally {
        await this.cleanupTask(reopenTask, marker);
        optionalTasks.splice(optionalTasks.indexOf(reopenTask), 1);
        await this.cleanupCheckpoint();
      }

      this.beginStage("核对并删除空测试清单");
      for (const project of [...projects].reverse()) {
        await this.deleteVerifiedProject(project, marker);
        projects.splice(projects.indexOf(project), 1);
        await this.cleanupCheckpoint();
      }
      steps.push("删除两个空测试清单并验证身份");
    } catch (error) {
      failureStage = this.currentStage;
      failure = `${failureStage}：${messageOf(error)}`;
    } finally {
      // 主合同预算耗尽后也必须保留独立的安全清理额度。
      this.api = this.cleanupApi;
      let taskCleanupFailed = false;
      if (this.cleanupCheckpointFailed) {
        taskCleanupFailed = true;
        cleanupErrors.push("合同清理计划未能安全持久化；已停止后续远端操作");
      } else if (this.manualCleanupRequired) {
        cleanupErrors.push(
          "移动结果未决：已停止自动清理，请按报告中的任务 ID、唯一标记与候选清单人工核对",
        );
      } else if (childTask) {
        this.reportProgress("安全清理测试子任务");
        await this.cleanupTask(childTask, marker).then(() => {
          childTask = null;
          return this.cleanupCheckpoint?.();
        }).catch((error) => {
          taskCleanupFailed = true;
          cleanupErrors.push(`测试子任务：${messageOf(error)}`);
        });
      }
      if (!this.cleanupCheckpointFailed && !this.manualCleanupRequired) {
        for (const optionalTask of [...optionalTasks].reverse()) {
          this.reportProgress("安全清理可选能力测试任务");
          await this.cleanupTask(optionalTask, marker).then(() => {
            optionalTasks.splice(optionalTasks.indexOf(optionalTask), 1);
            return this.cleanupCheckpoint?.();
          }).catch((error) => {
            taskCleanupFailed = true;
            cleanupErrors.push(`可选能力测试任务：${messageOf(error)}`);
          });
        }
      }
      if (!this.cleanupCheckpointFailed && !this.manualCleanupRequired && task) {
        this.reportProgress("安全清理测试任务");
        await this.cleanupTask(task, marker).then(() => {
          task = null;
          return this.cleanupCheckpoint?.();
        }).catch((error) => {
          taskCleanupFailed = true;
          cleanupErrors.push(`测试任务：${messageOf(error)}`);
        });
      }
      if (!this.cleanupCheckpointFailed && !this.manualCleanupRequired && !taskCleanupFailed) {
        this.reportProgress("安全清理测试清单");
        for (const project of [...projects].reverse()) {
          await this.cleanupProject(project, marker).then(() => {
            projects.splice(projects.indexOf(project), 1);
            return this.cleanupCheckpoint?.();
          }).catch((error) => {
            cleanupErrors.push(`测试清单：${messageOf(error)}`);
          });
        }
      }
    }

    const cleanupPlan = buildCleanupPlan(
      runId,
      marker,
      projects,
      [task, childTask, ...optionalTasks].filter((entry): entry is CreatedTask => entry !== null),
      this.manualCleanupRequired,
      cleanupErrors.length > 0 || this.untrackedCreateOutcome,
      this.untrackedCreateOutcome,
    );
    this.cleanupCheckpoint = undefined;
    return {
      status: failure ? "failed" : "passed",
      steps,
      failure,
      failureStage,
      cleanupErrors,
      remoteArtifactsRemaining: cleanupErrors.length > 0 || this.untrackedCreateOutcome,
      taskScheduleMode: this.taskScheduleMode,
      boardPlacementVerified: this.boardPlacementVerified,
      columnCreateVerified: this.columnCreateVerified &&
        cleanupErrors.length === 0 && !this.untrackedCreateOutcome,
      taskCrudVerified: this.taskCrudVerified,
      reminderWriteVerified: this.reminderWriteVerified,
      repeatWriteVerified: this.repeatWriteVerified,
      itemsRoundTripVerified: this.itemsRoundTripVerified,
      itemIdStableVerified: this.itemIdStableVerified,
      taskReopenVerified: this.taskReopenVerified,
      manualCleanupRequired: this.manualCleanupRequired,
      capabilityFailures,
      capabilityFailureCodes,
      cleanupPlan,
    };
  }

  private async updateAndVerifyTaskProperties(
    taskId: string,
    projectId: string,
    marker: string,
    payload: DidaTaskUpdateWirePayload,
    verify: (reread: DidaTask) => void,
  ): Promise<DidaTask> {
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
      this.assertTaskIdentity(reread, taskId, projectId, marker);
      verify(reread);
    } catch (error) {
      if (!unknownOutcome) throw error;
      throw new UnprovenRemoteOutcomeError("属性写入", unknownOutcome, error);
    }
    return reread;
  }

  private async probeTaskField<K extends "reminders" | "repeatFlag">(
    taskId: string,
    projectId: string,
    marker: string,
    field: K,
    writtenValue: DidaTask[K],
    clearedValue: DidaTask[K],
    capabilities: DidaTaskWriteCapabilities,
    failures: string[],
  ): Promise<boolean> {
    const before = normalizeTask(await this.api.getTask(projectId, taskId));
    this.assertTaskIdentity(before, taskId, projectId, marker);
    try {
      await this.updateAndVerifyTaskProperties(
        taskId,
        projectId,
        marker,
        taskUpdatePayload({ ...before, [field]: writtenValue }, capabilities, [field]),
        (reread) => {
          if (!deepEqual(reread[field], writtenValue) ||
            !sameDidaTaskExcept(before, reread, [field])) {
            throw new Error(
              `${field} 写后复读不一致或其他字段发生变化：` +
              didaTaskDifferenceFields(before, reread, [field]).join("、"),
            );
          }
        },
      );
      const written = normalizeTask(await this.api.getTask(projectId, taskId));
      await this.updateAndVerifyTaskProperties(
        taskId,
        projectId,
        marker,
        taskUpdatePayload({ ...written, [field]: clearedValue }, capabilities, [field]),
        (reread) => {
          if (!deepEqual(reread[field], clearedValue) ||
            !sameDidaTaskExcept(written, reread, [field])) {
            throw new Error(
              `${field} 清空后复读不一致或其他字段发生变化：` +
              `差异字段 ${differenceFieldsLabel(didaTaskDifferenceFields(written, reread, [field]))}`,
            );
          }
        },
      );
      return true;
    } catch (error) {
      if (isUnprovenRemoteOutcome(error)) throw error;
      const current = normalizeTask(await this.api.getTask(projectId, taskId));
      this.assertTaskIdentity(current, taskId, projectId, marker);
      const differences = didaTaskDifferenceFields(before, current);
      if (differences.some((difference) => difference !== field)) {
        throw new Error(
          `${field} 合同失败且未恢复到安全基线：${messageOf(error)}；` +
          `当前差异字段 ${differenceFieldsLabel(differences)}`,
        );
      }
      failures.push(capabilityFailureSummary(field));
      return false;
    }
  }

  private async createCapabilityTask(
    projectId: string,
    marker: string,
    label: string,
    tracking: CreatedTask[],
  ): Promise<CreatedTask> {
    let created: DidaTask;
    try {
      created = normalizeTask(await this.api.createTask({
        projectId,
        title: `${marker} ${label}`,
        content: `${marker} capability-probe`,
        priority: 0,
      }));
    } catch (error) {
      if (isUnknownRemoteOutcome(error)) {
        this.untrackedCreateOutcome = true;
        await this.cleanupCheckpoint?.();
      }
      throw error;
    }
    this.assertTaskIdentity(created, created.id, projectId, marker);
    const reread = normalizeTask(await this.api.getTask(projectId, created.id));
    this.assertTaskIdentity(reread, created.id, projectId, marker);
    const task: CreatedTask = {
      id: created.id,
      projectId,
      candidateProjectIds: [projectId],
      state: "open",
    };
    tracking.push(task);
    await this.cleanupCheckpoint?.();
    return task;
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
      throw new UnprovenRemoteOutcomeError("编辑", unknownOutcome, error, true);
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
      throw new UnprovenRemoteOutcomeError("编辑", unknownOutcome, error);
    }
    return unknownOutcome !== undefined;
  }

  private async placeAndVerifyTask(
    before: DidaTask,
    targetColumnId: string,
    marker: string,
  ): Promise<boolean> {
    let unknownOutcome: unknown;
    try {
      await this.api.updateTask(
        before.id,
        taskBoardPlacementPayload(before, targetColumnId),
      );
    } catch (error) {
      if (!isUnknownRemoteOutcome(error)) throw error;
      unknownOutcome = error;
    }

    let reread: DidaTask;
    try {
      reread = normalizeTask(await this.api.getTask(before.projectId, before.id));
    } catch (error) {
      if (!unknownOutcome) throw error;
      throw new UnprovenRemoteOutcomeError("看板归栏", unknownOutcome, error, true, true);
    }

    try {
      this.assertTaskIdentity(reread, before.id, before.projectId, marker);
      if (reread.columnId !== targetColumnId) {
        throw new Error("任务 columnId 写后复读与目标分栏不一致");
      }
      if (!sameTaskBoardPlacementInvariant(before, reread)) {
        throw new Error(
          "最小归栏写入改变了分栏以外的任务字段：差异字段 " +
          differenceFieldsLabel(didaTaskDifferenceFields(before, reread, ["columnId", "columnName"])),
        );
      }
    } catch (error) {
      if (!unknownOutcome) throw error;
      throw new UnprovenRemoteOutcomeError("看板归栏", unknownOutcome, error, false, true);
    }
    return unknownOutcome !== undefined;
  }

  private async moveAndVerifyTask(
    before: DidaTask,
    fromProjectId: string,
    toProjectId: string,
    marker: string,
  ): Promise<{ applied: boolean; responseUnknown: boolean }> {
    let unknownOutcome: unknown;
    try {
      await this.api.moveTask({ fromProjectId, toProjectId, taskId: before.id });
    } catch (error) {
      if (!isUnknownRemoteOutcome(error)) throw error;
      unknownOutcome = error;
    }

    try {
      return await this.reconcileMovedTaskLocation(
        before,
        fromProjectId,
        toProjectId,
        marker,
        unknownOutcome !== undefined,
      );
    } catch (error) {
      this.manualCleanupRequired = {
        taskId: before.id,
        marker,
        candidateProjectIds: [fromProjectId, toProjectId],
        reason: messageOf(error),
      };
      await this.cleanupCheckpoint?.();
      if (!unknownOutcome) throw error;
      throw new Error(
        "移动响应未知，复读未能同时证明目标清单身份与来源清单移出；未重发。" +
        `原始错误：${messageOf(unknownOutcome)}；核对错误：${messageOf(error)}`,
      );
    }
  }

  /**
   * 移动端点的 2xx 正文并不稳定，唯一可信结果是两个候选清单的只读任务集合。
   * 只发出一次移动写入；项目身份、数组或字段歧义都停止自动清理并交由人工。
   */
  private async reconcileMovedTaskLocation(
    before: DidaTask,
    fromProjectId: string,
    toProjectId: string,
    marker: string,
    responseUnknown: boolean,
  ): Promise<{ applied: boolean; responseUnknown: boolean }> {
    const deadline = this.monotonicNow() + CONSISTENCY_RETRY_BUDGET_MS;
    let pending: "both" | "none" | undefined;
    for (let attempt = 0; attempt < ABSENCE_CHECK_ATTEMPTS; attempt += 1) {
      this.reportProgress("复读移动任务位置", attempt + 1, ABSENCE_CHECK_ATTEMPTS);
      const sourceData = await this.api.getProjectData(fromProjectId);
      const targetData = await this.api.getProjectData(toProjectId);
      const sourceProject = normalizeProject(sourceData.project);
      const targetProject = normalizeProject(targetData.project);
      if (sourceProject.id !== fromProjectId || targetProject.id !== toProjectId) {
        throw new Error("移动复读的候选清单项目身份不匹配");
      }
      if (!Array.isArray(sourceData.tasks) || !Array.isArray(targetData.tasks)) {
        throw new Error("移动复读的候选清单任务列表不是数组");
      }
      const source = sourceData.tasks.map(normalizeTask).filter((task) => task.id === before.id);
      const target = targetData.tasks.map(normalizeTask).filter((task) => task.id === before.id);
      if (source.length === 0 && target.length === 1) {
        this.assertMovedTask(before, target[0]!, toProjectId, marker);
        return { applied: true, responseUnknown };
      }
      if (source.length === 1 && target.length === 0) {
        this.assertMovedTask(before, source[0]!, fromProjectId, marker);
        const remaining = deadline - this.monotonicNow();
        if (attempt === ABSENCE_CHECK_ATTEMPTS - 1 || remaining <= 0) {
          return { applied: false, responseUnknown };
        }
        await this.sleep(Math.min(ABSENCE_CHECK_DELAY_MS, remaining));
        continue;
      }
      if (source.length > 1 || target.length > 1) {
        throw new Error("候选清单内出现重复任务 ID，拒绝猜测移动位置");
      }
      if (source.length === 1 && target.length === 1) {
        pending = "both";
      } else if (source.length === 0 && target.length === 0) {
        pending = "none";
      } else {
        throw new Error("移动复读出现无法分类的位置状态");
      }
      const remaining = deadline - this.monotonicNow();
      if (attempt === ABSENCE_CHECK_ATTEMPTS - 1 || remaining <= 0) {
        throw new Error(
          pending === "both"
            ? "任务持续同时存在于两个候选清单集合，超过一致性预算"
            : "任务持续不在任一候选清单集合，超过一致性预算",
        );
      }
      await this.sleep(Math.min(ABSENCE_CHECK_DELAY_MS, remaining));
    }
    throw new Error("移动位置复读超出一致性预算");
  }

  private assertMovedTask(
    before: DidaTask,
    actual: DidaTask,
    projectId: string,
    marker: string,
  ): void {
    this.assertTaskIdentity(actual, before.id, projectId, marker);
    if (!deepEqual(taskMoveInvariant(before), taskMoveInvariant(actual))) {
      throw new Error("跨清单移动改变了清单归属以外的任务字段");
    }
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
      await this.cleanupCheckpoint?.();
      throw error;
    }
    if (created.name !== name) {
      this.untrackedCreateOutcome = true;
      await this.cleanupCheckpoint?.();
      throw new Error("新建清单返回的名称与本轮唯一标记不一致");
    }
    if (forbiddenIds.has(created.id)) {
      this.untrackedCreateOutcome = true;
      await this.cleanupCheckpoint?.();
      throw new Error("新建清单返回了测试前已存在或本轮已使用的 ID，拒绝继续");
    }
    const project: CreatedProject = {
      id: created.id,
      name,
      expectedColumns: [],
      columnsCaptured: false,
    };
    tracked.push(project);
    forbiddenIds.add(created.id);
    await this.cleanupCheckpoint?.();
    const reread = normalizeProject(await this.api.getProject(created.id));
    if (reread.id !== created.id || reread.name !== name) {
      throw new Error("新建清单复读身份与本轮唯一标记不一致");
    }
    project.viewMode = reread.viewMode;
    const initialColumns = normalizeColumns(await this.api.getColumns(project.id));
    if (initialColumns.some((column) => column.projectId !== project.id)) {
      throw new Error("新建清单的初始分栏归属与清单 ID 不一致");
    }
    project.expectedColumns = initialColumns;
    project.columnsCaptured = true;
    await this.cleanupCheckpoint?.();
    return project;
  }

  private async createAndVerifyColumn(
    project: CreatedProject,
    name: string,
  ): Promise<DidaColumn> {
    const beforeDetail = await this.api.getProjectData(project.id);
    const beforeEndpoint = normalizeColumns(await this.api.getColumns(project.id));
    if (normalizeProject(beforeDetail.project).id !== project.id) {
      throw new Error("创建分栏前详情清单身份不一致");
    }
    const beforeDetailColumns = normalizeColumns(beforeDetail.columns);
    this.assertExactColumns(beforeDetailColumns, beforeEndpoint, "创建分栏前双源列基线不一致");
    this.assertExactColumns(beforeEndpoint, project.expectedColumns, "创建分栏前的完整列基线已变化");
    const created = normalizeColumns([await this.api.createColumn(project.id, { name })])[0]!;
    if (
      created.projectId !== project.id ||
      created.name !== name ||
      project.expectedColumns.some((column) => column.id === created.id)
    ) {
      throw new Error("创建分栏响应的 ID、归属、名称或唯一性无效");
    }
    const expected = normalizeColumns([...project.expectedColumns, created]);
    const afterDetail = await this.api.getProjectData(project.id);
    const reread = normalizeColumns(await this.api.getColumns(project.id));
    if (normalizeProject(afterDetail.project).id !== project.id) {
      throw new Error("创建分栏后详情清单身份不一致");
    }
    this.assertExactColumns(normalizeColumns(afterDetail.columns), reread, "创建分栏后双源列复读不一致");
    this.assertExactColumns(reread, expected, "创建分栏后的同 ID 复读不一致");
    project.expectedColumns = reread;
    await this.cleanupCheckpoint?.();
    return created;
  }

  private async updateAndVerifyColumn(
    project: CreatedProject,
    column: DidaColumn,
    name: string,
  ): Promise<void> {
    const before = normalizeColumns(await this.api.getColumns(project.id));
    this.assertExactColumns(before, project.expectedColumns, "改名分栏前的完整列基线已变化");
    const current = before.find((candidate) => candidate.id === column.id);
    if (!current || current.name !== column.name || current.projectId !== project.id) {
      throw new Error("改名目标分栏的 ID、旧名称或归属已变化");
    }
    const updated = normalizeColumns([
      await this.api.updateColumn(project.id, column.id, { name }),
    ])[0]!;
    if (updated.id !== column.id || updated.projectId !== project.id || updated.name !== name) {
      throw new Error("改名分栏响应的 ID、归属或名称无效");
    }
    const expected = normalizeColumns(before.map((candidate) =>
      candidate.id === column.id ? updated : candidate));
    const reread = normalizeColumns(await this.api.getColumns(project.id));
    this.assertExactColumns(reread, expected, "改名分栏后的同 ID 复读不一致");
    project.expectedColumns = reread;
    await this.cleanupCheckpoint?.();
  }

  private async updateAndVerifyProjectViewMode(
    project: CreatedProject,
    viewMode: "list" | "kanban",
  ): Promise<void> {
    const before = normalizeProject(await this.api.getProject(project.id));
    if (
      before.id !== project.id ||
      before.name !== project.name ||
      !before.name.includes("[Helix 合同测试 ") ||
      before.viewMode !== project.viewMode
    ) {
      throw new Error("修改清单视图前的身份、标记或视图基线已变化，拒绝覆盖");
    }
    await this.api.updateProject(project.id, {
      id: project.id,
      name: project.name,
      viewMode,
    });
    const reread = normalizeProject(await this.api.getProject(project.id));
    if (
      reread.id !== project.id ||
      reread.name !== project.name ||
      reread.viewMode !== viewMode
    ) {
      throw new Error(`清单默认视图写后复读不一致：预期 ${viewMode}`);
    }
    project.viewMode = viewMode;
  }

  private assertTaskIdentity(
    task: DidaTask,
    taskId: string,
    projectId: string,
    marker: string,
  ): void {
    if (task.id !== taskId || task.projectId !== projectId ||
      !isDidaContractTaskTitle(task.title, marker)) {
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
    if (task.deleteState === "sent-unknown") {
      await this.waitForTaskAbsentFromObservableCollection(task);
      return;
    }
    task.deleteState = "sent-unknown";
    await this.cleanupCheckpoint?.();
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
    if (tasks.some((candidate) => !isDidaContractTaskTitle(candidate.title, marker))) {
      throw new Error("测试清单出现非本轮任务，拒绝删除清单");
    }
    if (tasks.length > 0) throw new Error("测试清单仍有任务，拒绝删除清单");
    const completedTasks = await this.readCompletedTasks(project.id, "full-history");
    if (completedTasks.some((candidate) => !isDidaContractTaskTitle(candidate.title, marker))) {
      throw new Error("测试清单出现非本轮已完成任务，拒绝删除清单");
    }
    if (completedTasks.length > 0) {
      throw new Error("测试清单仍有已完成任务，拒绝删除清单");
    }
    this.assertExactColumns(
      normalizeColumns(await this.api.getColumns(project.id)),
      project.expectedColumns,
      "测试清单分栏集合在运行期间出现未知变化，拒绝删除清单",
    );
    if (project.deleteState === "sent-unknown") {
      await this.waitForProjectAbsentFromCollection(project.id);
      return;
    }
    project.deleteState = "sent-unknown";
    await this.cleanupCheckpoint?.();
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
      if (matches.length === 1) {
        task.projectId = matches[0]!.projectId;
        await this.cleanupCheckpoint?.();
        return task;
      }
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

  private assertExactColumns(
    actual: DidaColumn[],
    expected: DidaColumn[],
    message: string,
  ): void {
    if (
      actual.length !== expected.length ||
      actual.some((column, index) => {
        const baseline = expected[index];
        return !baseline || column.id !== baseline.id ||
          column.projectId !== baseline.projectId || column.name !== baseline.name ||
          column.sortOrder !== baseline.sortOrder ||
          column.sortOrderUnsafe !== baseline.sortOrderUnsafe;
      })
    ) {
      throw new Error(message);
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

class UnprovenRemoteOutcomeError extends Error {
  readonly remoteOutcomeUnknown = true;

  constructor(
    operation: string,
    original: unknown,
    proof: unknown,
    rereadFailed = false,
    safeWrite = false,
  ) {
    super(
      rereadFailed
        ? `${operation}响应未知且精确复读失败；未重发。` +
          `原始错误：${messageOf(original)}；复读错误：${messageOf(proof)}`
        : `${operation}响应未知，精确复读未证明${safeWrite ? "安全写入" : "写入生效"}；未重发。` +
          `原始错误：${messageOf(original)}；核对错误：${messageOf(proof)}`,
    );
    this.name = "UnprovenRemoteOutcomeError";
  }
}

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

function isUnprovenRemoteOutcome(error: unknown): boolean {
  return error instanceof UnprovenRemoteOutcomeError ||
    (!!error && typeof error === "object" &&
      "remoteOutcomeUnknown" in error && error.remoteOutcomeUnknown === true);
}

function capabilityFailureSummary(
  capability: "reminders" | "repeatFlag" | "items" | "boardPlacement" | "taskReopen",
): string {
  const name = {
    reminders: "提醒",
    repeatFlag: "重复规则",
    items: "检查项",
    boardPlacement: "看板归栏",
    taskReopen: "任务重开",
  }[capability];
  return `${name}：未通过写入合同，保持只读`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 诊断只披露字段名，避免把临时合同任务内容写入日志或界面。 */
function differenceFieldsLabel(fields: string[]): string {
  return fields.length > 0 ? fields.join("、") : "无可枚举字段";
}

function assertChecklistContractState(
  before: DidaTask,
  reread: DidaTask,
  sentinel: NonNullable<DidaTask["items"]>[number],
  expectedOwned: NonNullable<DidaTask["items"]>[number],
): void {
  if (!sameDidaTaskExcept(before, reread, ["items"])) throw new Error("检查项写入改变了父任务其他字段");
  const actualOwned = reread.items?.[1];
  const beforeOwned = before.items?.find((item) => item.id === expectedOwned.id);
  if (reread.items?.length !== 2 || !deepEqual(reread.items[0], sentinel) ||
    !actualOwned || !beforeOwned || !sameChecklistOwnedExceptDerivedTime(beforeOwned, expectedOwned, actualOwned)) {
    throw new Error("检查项 ID、字段、未知属性或顺序未稳定往返");
  }
}

function sameInitialChecklistSemantics(
  expected: NonNullable<DidaTask["items"]>[number],
  actual: NonNullable<DidaTask["items"]>[number],
): boolean {
  // 新检查项的 ID 及未提交字段由服务端生成；合同只要求显式受管字段
  // 精确往返。后续步骤以该完整复读值为基线，继续证明默认/未知字段不丢失。
  assertStableId(actual.id, "服务端检查项 ID");
  return actual.title === expected.title &&
    actual.status === expected.status && actual.sortOrder === expected.sortOrder;
}

function sameChecklistOwnedExceptDerivedTime(
  before: NonNullable<DidaTask["items"]>[number],
  expected: NonNullable<DidaTask["items"]>[number],
  actual: NonNullable<DidaTask["items"]>[number],
): boolean {
  const expectedCopy = { ...expected };
  const actualCopy = { ...actual };
  const statusChanged = before.status !== expected.status;
  if (!statusChanged) return deepEqual(actualCopy, expectedCopy);
  if (before.status === 0 && expected.status === 2) {
    if (actual.completedTime === undefined ||
      !Number.isFinite(new Date(actual.completedTime).getTime())) return false;
    delete expectedCopy.completedTime;
    delete actualCopy.completedTime;
    return deepEqual(actualCopy, expectedCopy);
  }
  if (before.status === 2 && expected.status !== 2) {
    if (actual.completedTime !== undefined && actual.completedTime !== null) return false;
    delete expectedCopy.completedTime;
    delete actualCopy.completedTime;
    return deepEqual(actualCopy, expectedCopy);
  }
  return false;
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

function taskMoveInvariant(task: DidaTask): Omit<
  DidaTask,
  "projectId" | "columnId" | "etag" | "modifiedTime" | "etimestamp"
> {
  const withoutMetadata = didaTaskWithoutRemoteMetadata(task);
  const {
    projectId: _projectId,
    columnId: _columnId,
    ...invariant
  } = withoutMetadata;
  return invariant;
}

function buildCleanupPlan(
  runId: string,
  marker: string,
  projects: CreatedProject[],
  tasks: CreatedTask[],
  manual: DidaWriteContractReport["manualCleanupRequired"],
  force: boolean,
  requiresAdoption: boolean,
): DidaContractCleanupPlan | undefined {
  const byTaskId = new Map<string, CreatedTask>();
  for (const task of tasks) {
    const previous = byTaskId.get(task.id);
    byTaskId.set(task.id, previous
      ? {
          ...task,
          candidateProjectIds: [...new Set([
            ...previous.candidateProjectIds,
            ...task.candidateProjectIds,
          ])],
          state: previous.state === task.state ? task.state : "unknown",
        }
      : task);
  }
  if (manual) {
    const previous = byTaskId.get(manual.taskId);
    byTaskId.set(manual.taskId, {
      id: manual.taskId,
      projectId: previous?.projectId ?? manual.candidateProjectIds[0] ?? "",
      candidateProjectIds: [...new Set([
        ...(previous?.candidateProjectIds ?? []),
        ...manual.candidateProjectIds,
      ])],
      state: "unknown",
    });
  }
  if (!force && projects.length === 0 && byTaskId.size === 0) return undefined;
  if (requiresAdoption || projects.some((project) => !project.columnsCaptured)) {
    return { runId, marker, projects: [], tasks: [] };
  }
  return {
    runId,
    marker,
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      expectedColumns: project.expectedColumns,
      baselineSource: "contract",
      ...(project.deleteState ? { deleteState: project.deleteState } : {}),
    })),
    tasks: [...byTaskId.values()].map(({ id, candidateProjectIds, state, deleteState }) => ({
      id,
      candidateProjectIds,
      state,
      ...(deleteState ? { deleteState } : {}),
    })),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
