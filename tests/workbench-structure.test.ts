import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKBENCH_NAVIGATION } from "../src/domain/workbench-navigation";

describe("workbench layout and navigation structure", () => {
  const view = readFileSync(resolve(process.cwd(), "src/ui/helix-view.ts"), "utf8");
  const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");

  it("uses the intended navigation order without an independent analytics tab", () => {
    expect(WORKBENCH_NAVIGATION.map((item) => item.label))
      .toEqual(["今日", "项目", "任务", "复盘", "挑战", "冲突"]);
    expect(WORKBENCH_NAVIGATION.map((item) => item.id)).not.toContain("analytics");
  });

  it("places analytics below review cards inside the shared review section", () => {
    expect(view).toMatch(/renderReviews[\s\S]*helix-review-recall[\s\S]*renderAnalytics\(recall, false\)/);
    expect(view).toMatch(/renderAnalytics\(content: HTMLElement, includeTitle = true\)/);
  });

  it("keeps shell, sidebar and header fixed while only main content scrolls", () => {
    expect(css).toMatch(/\.helix-root \{[\s\S]*height: 100%;[\s\S]*overflow: hidden !important;/);
    expect(css).toMatch(/\.helix-shell \{[\s\S]*height: 100%;[\s\S]*overflow: hidden !important;/);
    expect(css).toMatch(/\.helix-sidebar \{[\s\S]*height: 100%;[\s\S]*overflow: hidden !important;/);
    expect(css).toMatch(/\.helix-main \{[\s\S]*display: flex;[\s\S]*flex-direction: column;[\s\S]*overflow: hidden;/);
    expect(css).toMatch(/\.helix-content \{[\s\S]*flex: 1 1 auto;[\s\S]*overflow: auto;/);
    expect(css).toMatch(/\.helix-sidebar-lists \{[\s\S]*overflow: hidden !important;/);
  });

  it("routes Canvas repair through the dedicated write-gated action", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(view).toMatch(/this\.actions\.repairProjectCanvas\(\)/);
    expect(view).not.toMatch(/Canvas 需要修复[\s\S]*projectWorkspace\.ensureCanvas\(\)/);
    expect(main).toMatch(/repairProjectCanvas: \(\) => this\.repairProjectCanvas\(\)/);
    expect(main).toMatch(
      /private async repairProjectCanvas\(\): Promise<void> \{[\s\S]*this\.withWritableProjectMutation\(\(\) => this\.projectWorkspace\.ensureCanvas\(\)\)/,
    );
  });

  it("routes all new status saves through a recovery-mode write gate", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(view).toMatch(/this\.actions\.updateProjectStatus\(plan, status\)/);
    expect(view).toMatch(/this\.requestCycleStatusChange\(cycleId, plan\.currentStatus, status\)/);
    expect(view).not.toMatch(/projectWorkspace\.updateProjectStatus\(plan, status\)/);
    expect(view).toMatch(/requestStageBoardStatusChange\(/);
    expect(main).toMatch(/updateProjectStatus: \(plan, status\) => this\.updateProjectStatus\(plan, status\)/);
    expect(main).toMatch(/updateCycleStatus: \(plan, status\) => this\.updateCycleStatus\(plan, status\)/);
    expect(main).toMatch(
      /private async updateProjectStatus\([\s\S]*this\.withWritableProjectMutation\(\(\) => this\.projectWorkspace\.updateProjectStatus\(plan, status\)\)/,
    );
    expect(main).toMatch(
      /private async updateCycleStatus\([\s\S]*this\.withWritableProjectMutation\(\(\) => this\.projectWorkspace\.updateCycleStatus\(plan, status\)\)/,
    );
  });

  it("keeps project reads available while recovery mode rejects all View mutations before writing", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(main).toMatch(/readProjectWorkspace: \(operation\) => this\.withProjectWorkspaceRead\(operation\)/);
    expect(main).toMatch(/mutateProjectWorkspace: \(operation\) => this\.withWritableProjectMutation\(operation\)/);
    expect(main).toMatch(
      /private async withWritableProjectMutation<T>\(operation: \(\) => Promise<T>\): Promise<T> \{[\s\S]*this\.assertWritable\(\);[\s\S]*return this\.withProjectMutation\(operation\);/,
    );
    expect(view).toMatch(/workspace = await this\.actions\.readProjectWorkspace\([\s\S]*loadStableWorkspace\(\)/);
  });

  it("persists focus startup failures into the generic recovery center", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(main).toMatch(
      /initializeFocusBridgeState\(\)[\s\S]*recoveryIssues\.includes\(message\)[\s\S]*recoveryIssues\.push\(message\)/,
    );
    expect(main).toContain("处理冲突中心列出的恢复问题前不能写入");
    expect(view).toContain("Helix 数据或事务状态需要人工修复");
    expect(main).toMatch(
      /recoveryIssueMessage\(\)[\s\S]*enterProjectRecoveryMode\(`Helix 项目工作区需要人工检查/,
    );
    expect(main).toMatch(
      /enterProjectRecoveryMode\(message: string\)[\s\S]*this\.recoveryMode = true[\s\S]*recoveryIssues\.push\(message\)/,
    );
  });

  it("keeps Canvas repair diagnostics beside the lineage workbench", () => {
    expect(view).toMatch(/Canvas 需要修复[\s\S]*const workbenchHost = content\.createDiv\(\{ cls: "helix-project-workbench-host" \}\)/);
    expect(view).toMatch(/this\.projectWorkbench\.render\(workbenchHost\)/);
    expect(view).not.toMatch(/this\.projectWorkbench\.render\(content\)/);
  });

  it("offers structural focus repair without invalid content choices", () => {
    expect(view).toMatch(/conflict\.reason !== "simultaneous-edit"[\s\S]*按来源重建受管块/);
    expect(view).toMatch(/打开 Markdown 手工修复/);
    expect(view).toMatch(/return;[\s\S]*addChoice\("来源"/);
  });

  it("keeps the five-column stage board isolated, horizontally scrollable and write-gated", () => {
    const lineage = readFileSync(resolve(process.cwd(), "src/ui/project-lineage-workbench.ts"), "utf8");
    expect(lineage).toMatch(/STAGE_BOARD_COLUMNS/);
    expect(lineage).toMatch(/boardStageNodes\(\)[\s\S]*snapshot\.projects/);
    expect(lineage).toMatch(/requestCycleStatusChange\(drag\.cycleId, drag\.sourceStatus, targetStatus\)/);
    expect(lineage).toMatch(/pointercancel[\s\S]*lostpointercapture[\s\S]*is-dragging/);
    expect(css).toMatch(/\.helix-lineage-kanban \{[\s\S]*grid-template-columns: repeat\(5, minmax\(244px, 1fr\)\);[\s\S]*overflow-x: auto;/);
    expect(css).toMatch(/\.helix-lineage-kanban \{[\s\S]*overflow-y: hidden;/);
    expect(css).toMatch(/\.helix-lineage-column-list \{[\s\S]*min-height: 0;[\s\S]*overflow-y: auto;/);
    expect(css).toMatch(/\.helix-lineage-card\.is-kanban\.is-dragging \{[\s\S]*pointer-events: none;/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.helix-lineage-card\.is-kanban/);
  });

  it("clears deferred kanban arrival when the view closes", () => {
    expect(view).toMatch(/this\.pendingKanbanArrivalCycleId = null;/);
    expect(view).toMatch(/if \(this\.closed\) return;[\s\S]*this\.pendingKanbanArrivalCycleId = cycleId;/);
  });

  it("replaces the old project mapping bar with explicit projection actions", () => {
    const settings = readFileSync(resolve(process.cwd(), "src/ui/settings-tab.ts"), "utf8");
    expect(view).not.toContain("renderProjectDidaMappingBar");
    expect(view).not.toContain("ProjectDidaMappingConfirmModal");
    expect(view).toMatch(/renderProjectProjectionPanel[\s\S]*未受管[\s\S]*adoptProjectAction/);
    expect(view).toMatch(/editProjectAction[\s\S]*syncProjectProjection/);
    expect(view).toMatch(/再次确认 ·/);
    expect(settings).toMatch(/项目投影[\s\S]*选择清单[\s\S]*选择已有分栏/);
    expect(settings).toMatch(/再次点击确认启用/);
    expect(settings).toContain("请选择清单以查看已有分栏或安全创建目标分栏");
  });

  it("routes projection conflicts only through strict reconciliation and safe cleanup", () => {
    expect(view).toMatch(/renderProjectionConflicts[\s\S]*receiptCleanupPending/);
    expect(view).toMatch(/kind: "action", projectId: model\.project\.id, stageId, uuid/);
    expect(view).toMatch(/removeResolvedProjectProjectionReceipt\(receipt\.operationId\)/);
    expect(view).toMatch(/receipt\.outcome !== "verified"[\s\S]*receipt\.outcome !== "verified-absent"[\s\S]*此处不提供清理[\s\S]*continue;/);
    expect(view).not.toMatch(/项目投影[\s\S]*强制删除收据/);
    expect(css).toMatch(/\.helix-project-projection-panel[\s\S]*var\(--text-normal\)/);
    expect(css).toMatch(/\.helix-project-projection-action[\s\S]*grid-template-columns/);
  });

  it("keeps contract cleanup controls double-confirmed and their failure notice redacted", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(view).toMatch(/严格领养本轮残留[\s\S]*再次确认：执行只读领养/);
    expect(view).toMatch(/冷却后精确清理[\s\S]*再次确认：只清理专用对象/);
    expect(view).toContain("安全操作未完成；对象保持冻结，请查看脱敏诊断");
    const cleanupRegion = view.slice(
      view.indexOf("const cleanupPending"),
      view.indexOf("if (projectionLoad.diagnostic)"),
    );
    expect(cleanupRegion).not.toMatch(/error\.message|String\(error\)/);
    expect(main).toMatch(/strict-adopt-dida-contract-residual[\s\S]*didaContractAdoptConfirmation\.request\(\)[\s\S]*adoptPendingContractRunFromRemote/);
    expect(main).toContain("安全操作未完成；对象保持冻结，请查看脱敏诊断");
  });

  it("serializes projection UI actions and removes Dida mapping from project creation", () => {
    const settings = readFileSync(resolve(process.cwd(), "src/ui/settings-tab.ts"), "utf8");
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const modal = main.slice(main.indexOf("class ProjectPromptModal"), main.indexOf("class CyclePromptModal"));
    expect(view).toMatch(/ProjectionUiActionCoordinator[\s\S]*projectionUiActions\.run/);
    expect(settings).toMatch(/ProjectionUiActionCoordinator[\s\S]*projectionUiActions\.run/);
    expect(settings).toMatch(/setButtonText\("重新预览"\)[\s\S]*removeClass\("mod-cta"\)[\s\S]*确认失败或状态已变化，必须重新预览/);
    expect(modal).not.toMatch(/didaProjectId|滴答清单映射|verifyRemoteProject/);
    expect(modal).toMatch(/submit\(title, this\.color\)/);
  });

  it("exposes column creation only as a double-confirmed preview and unknown reconciliation", () => {
    const settings = readFileSync(resolve(process.cwd(), "src/ui/settings-tab.ts"), "utf8");
    const service = readFileSync(resolve(process.cwd(), "src/services/helix-service.ts"), "utf8");
    const confirm = service.slice(
      service.indexOf("async confirmProjectionColumnCreation"),
      service.indexOf("async reconcileProjectionColumnCreation"),
    );
    expect(settings).toMatch(/创建“\$\{PROJECTION_COLUMN_NAME\}”分栏[\s\S]*预览创建/);
    expect(settings).toMatch(/完整列基线[\s\S]*baselineHash[\s\S]*再次点击确认创建/);
    expect(view).toMatch(/分栏创建结果未知[\s\S]*reconcileProjectProjectionColumn/);
    expect(service).toMatch(/status: "running"[\s\S]*api\.createColumn[\s\S]*readProjectionCatalogWithLeaseHeld/);
    expect(confirm).toMatch(/enterExclusive\("项目投影分栏创建"\)/);
    expect(confirm).not.toContain("withAuthorizationLease");
    expect(service).not.toMatch(/reconcileProjectionColumnCreation[\s\S]*deleteColumn|reconcileProjectionColumnCreation[\s\S]*updateColumn/);
  });

  it("keeps recovery and column-unknown diagnostics visible when the project workspace is unreadable", () => {
    expect(view).toMatch(/loadProjectionConflictModels[\s\S]*persisted\.didaProjectionState\?\.columnCreation/);
    expect(view).toMatch(/项目工作区只读[\s\S]*投影诊断暂不可读[\s\S]*脱敏错误/);
    expect(view).toMatch(/conflictCenterIsEmpty\([\s\S]*workspaceDiagnostic: Boolean\(projectionLoad\.diagnostic\)/);
  });
});
