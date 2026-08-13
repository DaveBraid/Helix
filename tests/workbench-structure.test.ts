import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKBENCH_NAVIGATION } from "../src/domain/workbench-navigation";

describe("workbench layout and navigation structure", () => {
  const view = readFileSync(resolve(process.cwd(), "src/ui/helix-view.ts"), "utf8");
  const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
  const projectWorkspace = readFileSync(
    resolve(process.cwd(), "src/services/project-workspace.ts"),
    "utf8",
  );
  const didaRequestGovernor = readFileSync(
    resolve(process.cwd(), "src/integrations/dida/request-governor.ts"),
    "utf8",
  );
  const helixService = readFileSync(
    resolve(process.cwd(), "src/services/helix-service.ts"),
    "utf8",
  );
  const didaProjectSync = [
    readFileSync(resolve(process.cwd(), "src/services/dida-project-projection.ts"), "utf8"),
    readFileSync(resolve(process.cwd(), "src/domain/dida-project-projection.ts"), "utf8"),
    readFileSync(resolve(process.cwd(), "src/domain/project-identity.ts"), "utf8"),
    readFileSync(resolve(process.cwd(), "src/storage/frontmatter.ts"), "utf8"),
  ].join("\n");
  const userReachableDiagnostics = [
    readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8"),
    readFileSync(resolve(process.cwd(), "src/services/helix-service.ts"), "utf8"),
    readFileSync(resolve(process.cwd(), "src/services/dida-project-projection.ts"), "utf8"),
    readFileSync(resolve(process.cwd(), "src/services/dida-project-projection-coordinator.ts"), "utf8"),
    readFileSync(resolve(process.cwd(), "src/domain/dida-project-projection.ts"), "utf8"),
    readFileSync(resolve(process.cwd(), "src/storage/model.ts"), "utf8"),
    readFileSync(resolve(process.cwd(), "src/services/task-references.ts"), "utf8"),
    readFileSync(resolve(process.cwd(), "src/domain/stage-focus-bridge.ts"), "utf8"),
    projectWorkspace,
  ].join("\n");

  it("uses the intended navigation order without an independent analytics tab", () => {
    expect(WORKBENCH_NAVIGATION.map((item) => item.label))
      .toEqual(["今日", "项目", "任务", "复盘", "挑战", "冲突"]);
    expect(WORKBENCH_NAVIGATION.map((item) => item.id)).not.toContain("analytics");
  });

  it("keeps rate-limit observation on the single governed request path", () => {
    expect(didaRequestGovernor).not.toContain("observeRateLimit");
  });

  it("reserves independent production budgets for contract work and cleanup", () => {
    expect(helixService).toContain("const DIDA_CONTRACT_REQUEST_TIMEOUT_MS = 30_000;");
    expect(helixService).toMatch(/timeoutMs: DIDA_CONTRACT_REQUEST_TIMEOUT_MS,\s*maxAttempts: 1,\s*maxCalls: DIDA_CONTRACT_REQUEST_BUDGET/);
    expect(helixService).toMatch(/maxAttempts: 1,\s*maxCalls: 40,\s*cooldownProbe: true,/);
    expect(helixService.match(/timeoutMs: DIDA_CONTRACT_REQUEST_TIMEOUT_MS/g)).toHaveLength(4);
    expect(helixService).not.toContain("timeoutMs: 5_000");
    expect(readFileSync(resolve(process.cwd(), "src/integrations/dida/http.ts"), "utf8"))
      .toContain("request.timeoutMs ?? 20_000");
  });

  it("places analytics below review cards inside the shared review section", () => {
    expect(view).toMatch(/renderReviews[\s\S]*helix-review-recall[\s\S]*renderAnalytics\(recall, false\)/);
    expect(view).toMatch(/renderAnalytics\(content: HTMLElement, includeTitle = true\)/);
  });

  it("refreshes only the managed summary when an existing Helix journal opens", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(main).toMatch(
      /openJournal\(period[\s\S]*helix-kind[\s\S]*helix-journal[\s\S]*patchJournalSummary\(existing\.content, generatedSummary\)[\s\S]*compareAndWrite\(existing, updated\)/,
    );
    expect(main).toContain("复盘已打开，但自动摘要未更新");
  });

  it("does not rebuild the active Stage status control on every editor transaction", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const modifyListener = main.slice(
      main.indexOf('this.app.vault.on("modify"'),
      main.indexOf('this.app.metadataCache.on("changed"'),
    );
    expect(modifyListener).not.toContain("refreshActiveStatusForPaths");
    expect(main).toMatch(
      /metadataCache\.on\("changed", \(file\) => \{\s*this\.refreshActiveStatusForPaths\(file\.path\)/,
    );
    expect(main).toContain("if (signature === this.projectStatusSignature) return;");
    expect(view).toMatch(
      /service\.subscribe[\s\S]*activeLeaf === this\.leaf[\s\S]*renderPendingWhileInactive = true/,
    );
    expect(view).toMatch(
      /active-leaf-change[\s\S]*leaf !== this\.leaf[\s\S]*renderPendingWhileInactive[\s\S]*this\.render\(\)/,
    );
    expect(view).toMatch(
      /requestAnimationFrame[\s\S]*activeLeaf !== this\.leaf[\s\S]*renderPendingWhileInactive[\s\S]*this\.render\(\)/,
    );
  });

  it("shows project task references only in the task view", () => {
    expect(view).toMatch(/renderTasks\(content[\s\S]*renderProjectLinkedTasks\(content\)/);
    expect(view).toMatch(/renderProjectLinkedTasks[\s\S]*项目关联任务[\s\S]*renderTaskRow/);
    const projects = view.slice(
      view.indexOf("private async renderProjects"),
      view.indexOf("private renderProjectLinkedTasks"),
    );
    expect(projects).not.toContain("renderProjectLinkedTasks");
    const linkedTasks = view.slice(
      view.indexOf("private renderProjectLinkedTasks"),
      view.indexOf("private async requestCycleStatusChange"),
    );
    expect(linkedTasks).not.toMatch(/didaProjectId|projection/i);
  });

  it("projects Stage actions into tasks without creating a second local task store", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const localTasks = readFileSync(
      resolve(process.cwd(), "src/services/local-project-tasks.ts"),
      "utf8",
    );
    expect(main).toMatch(
      /readLocalProjectTasks[\s\S]*loadStableWorkspace\(\)[\s\S]*adoptUnmanaged: true/,
    );
    const localRead = main.slice(
      main.indexOf("async readLocalProjectTasks"),
      main.indexOf("async createLocalProjectTask"),
    );
    expect(localRead).toContain("this.assertWritable();");
    expect(localRead).toContain("this.withProjectWorkspaceRead");
    expect(localRead).not.toContain("withWritableProjectMutation");
    expect(view).toMatch(/render\(\)[\s\S]*refreshLocalProjectTaskSnapshot\(token\)/);
    expect(view).toMatch(/localProjectTaskDidaTasks[\s\S]*this\.localProjectTaskSnapshot/);
    expect(view).toMatch(/saveLocalProjectTask[\s\S]*LocalProjectTaskEditModal/);
    expect(localTasks).not.toMatch(/data\.json|HelixDataStore|OfflineQueue/);
  });

  it("uses one compact editor shell and exposes local subtasks without Dida writes", () => {
    const localEditor = view.slice(
      view.indexOf("class LocalProjectTaskEditModal"),
      view.indexOf("function knownReminderPreset"),
    );
    expect(view).toContain('class LocalProjectTaskEditModal extends Modal');
    expect(view).toContain('class TaskEditModal extends Modal');
    expect(view.match(/addClass\("helix-task-editor-modal"\)/g)).toHaveLength(2);
    expect(view.match(/addClass\([^\n]*"helix-task-editor"/g)).toHaveLength(2);
    expect(view).toMatch(/LocalProjectTaskEditModal[\s\S]*添加子任务[\s\S]*void this\.save\(/);
    expect(view).toMatch(/const properties = this\.contentEl\.createEl\("details"[\s\S]*text: "属性"/);
    expect(css).toMatch(/\.helix-task-editor-modal[\s\S]*\.helix-task-editor-properties/);
    expect(localEditor).toMatch(/helix-task-editor-title-row[\s\S]*helix-task-editor-properties/);
    expect(localEditor).toMatch(/timeMode[\s\S]*"none"[\s\S]*"point"[\s\S]*"range"/);
    expect(css).toMatch(/\.helix-task-editor-time-inputs input \{[\s\S]*width: 70px;[\s\S]*min-width: 70px;[\s\S]*padding: 0;/);
    expect(localEditor).toMatch(/openTimePicker[\s\S]*showPicker\(\)/);
    expect(localEditor).toMatch(/helix-task-editor-date-picker[\s\S]*上个月[\s\S]*下个月[\s\S]*helix-task-editor-calendar-grid/);
    expect(localEditor).not.toContain('type: "date",\n      value: this.scheduleDate');
    expect(localEditor).toMatch(/helix-task-editor-progress-ring[\s\S]*aria-valuenow/);
    expect(localEditor).toMatch(/helix-task-editor-subtask-grip[\s\S]*draggable: "true"[\s\S]*dragstart[\s\S]*drop/);
    expect(localEditor).not.toContain('placeholder: "添加备注…"');
    expect(localEditor).not.toContain('text: "时区"');
    expect(css).toMatch(/Dense task canvas[\s\S]*grid-template-columns: repeat\(3/);
  });

  it("uses project-colored neutral stage cards with one hover action bar", () => {
    const lineage = readFileSync(
      resolve(process.cwd(), "src/ui/project-lineage-workbench.ts"),
      "utf8",
    );
    expect(lineage).toMatch(/helix-lineage-card-top[\s\S]*helix-lineage-status-button/);
    expect(lineage).not.toMatch(/helix-lineage-status-button[\s\S]{0,180}createEl\("select"/);
    expect(lineage).toMatch(/openStatusPopover[\s\S]*onEditProjectStatus[\s\S]*onEditCycleStatus/);
    expect(lineage).toMatch(/helix-lineage-status-popover[\s\S]*pointerdown[\s\S]*Escape/);
    expect(lineage).toMatch(/helix-lineage-card-actions[\s\S]*新增[\s\S]*连接[\s\S]*折叠[\s\S]*删除/);
    expect(css).toMatch(/阶段卡片：项目色统一[\s\S]*background: var\(--background-primary\)/);
    expect(css).toMatch(/\.helix-lineage-project-container \{[\s\S]*border: 1px solid[\s\S]*box-shadow: 0 2px 10px/);
    expect(css).toMatch(/\.helix-lineage-card::before \{[\s\S]*inset: 0 0 auto;[\s\S]*height: 4px/);
    expect(css).toMatch(/\.helix-lineage-card-actions[\s\S]*grid-template-columns: repeat\(4/);
    expect(css).toMatch(/\.helix-lineage-card:hover \.helix-lineage-card-relations[\s\S]*opacity: 0/);
    expect(css).toMatch(/\.helix-lineage-status-popover \{[\s\S]*position: fixed;[\s\S]*z-index: 10000;[\s\S]*gap: 4px/);
  });

  it("keeps project focus incremental and swaps structural project renders atomically", () => {
    const lineage = readFileSync(
      resolve(process.cwd(), "src/ui/project-lineage-workbench.ts"),
      "utf8",
    );
    expect(lineage).toMatch(/selectProject\(projectId:[\s\S]*focusEntity\(projectId \?\?/);
    expect(lineage).toMatch(/data-project-id[\s\S]*LINEAGE_ALL_PROJECTS_FOCUS_ID/);
    expect(view).toMatch(/onSelectProject:[\s\S]*workbench\.selectProject\(projectId\)/);
    expect(view).toMatch(/previousWorkbench[\s\S]*renderProjects\(content, token\)[\s\S]*replaceChildren\(shell\)/);
    expect(view).not.toMatch(/onSelectProject:[\s\S]{0,220}requestLineageFocus/);
  });

  it("waits for the complete Obsidian index before validating focus-bridge recovery", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(main).toMatch(/onLayoutReady[\s\S]*finishProjectStartup\(staleFocusBridgeIssues\)/);
    expect(main).toMatch(/finishProjectStartup[\s\S]*loadStableWorkspace\(\)[\s\S]*resolveRecoveryIssuesAfterValidation/);
    expect(main).toMatch(/finally \{\s*this\.projectStartupReady = true/);
    expect(main).toMatch(/scheduleProjectRefresh[\s\S]*!this\.projectStartupReady[\s\S]*return/);
    expect(main).toContain("Helix 正在等待 Obsidian 完成项目索引，稍后即可写入");
    expect(main).toMatch(/dismissResolvedRecoveryNotices\(data\.recoveryIssues\)/);
    expect(main).toMatch(/showPersistentNotice[\s\S]*helix-persistent-notice/);
  });

  it("keeps an empty quick-property suggestion menu out of layout", () => {
    expect(css).toMatch(/\.helix-task-quick-suggestions\[hidden\]\s*\{\s*display: none;/);
  });

  it("keeps shell, sidebar and header fixed while only main content scrolls", () => {
    expect(css).toMatch(/\.helix-root \{[\s\S]*height: 100%;[\s\S]*overflow: hidden !important;/);
    expect(css).toMatch(/\.helix-shell \{[\s\S]*height: 100%;[\s\S]*overflow: hidden !important;/);
    expect(css).toMatch(/\.helix-sidebar \{[\s\S]*height: 100%;[\s\S]*overflow: hidden !important;/);
    expect(css).toMatch(/\.helix-main \{[\s\S]*display: flex;[\s\S]*flex-direction: column;[\s\S]*overflow: hidden;/);
    expect(css).toMatch(/\.helix-content \{[\s\S]*flex: 1 1 auto;[\s\S]*overflow: auto;/);
    expect(css).toMatch(/\.helix-sidebar-lists \{[\s\S]*overflow: hidden !important;/);
  });

  it("keeps project layout editing local until one explicit Canvas save", () => {
    const lineage = readFileSync(
      resolve(process.cwd(), "src/ui/project-lineage-workbench.ts"),
      "utf8",
    );
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(lineage).toMatch(/if \(this\.options\.mode !== "graph"\) return;[\s\S]*text: "整理"[\s\S]*text: "保存当前布局"[\s\S]*text: "新建项目"/);
    expect(lineage).not.toContain('text: "整理全部"');
    expect(lineage).toMatch(/lineageArrangeScope[\s\S]*reason: "cross-project"/);
    expect(lineage).toMatch(/lineageArrangeScope[\s\S]*reason: "empty"/);
    expect(lineage).toMatch(/container\.addEventListener\("dblclick"[\s\S]*onSelectProject\(project\.id\)/);
    expect(lineage).toMatch(/closest\("\.helix-lineage-project-container"\)[\s\S]*"project-container"/);
    expect(lineage).toMatch(/viewport\.addEventListener\("dblclick"[\s\S]*projectIdAtPoint[\s\S]*onSelectProject\(projectId\)/);
    expect(lineage).toMatch(/bindProjectTitleDrag[\s\S]*node\.projectId === project\.id[\s\S]*recordLayoutChange/);
    expect(view).toMatch(/moveCanvasNodes\([\s\S]*recordHistory: false/);
    expect(main).toContain('private static readonly CONFIRMATION = "我确认删除该项目。";');
    expect(main).toContain("this.projectWorkspace.deleteProject(projectId)");
    expect(main).toContain("class DeleteProjectModal extends Modal");
    expect(css).toMatch(/\.helix-content\.is-project-workbench-content \{[\s\S]*overflow: hidden;/);
    expect(css).toMatch(/\.helix-lineage-viewport \{[\s\S]*overflow: auto;/);
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

  it("opens project Markdown in an active editable leaf after the card click settles", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const lineage = readFileSync(
      resolve(process.cwd(), "src/ui/project-lineage-workbench.ts"),
      "utf8",
    );
    expect(main).toMatch(
      /private async openFile\(path: string\)[\s\S]*leaf\.openFile\(file\)[\s\S]*setActiveLeaf\(leaf, \{ focus: true \}\)[\s\S]*requestAnimationFrame[\s\S]*leaf\.view\.editor\.focus\(\)/,
    );
    expect(lineage).toMatch(/helix-lineage-card-title[\s\S]*event\.preventDefault\(\)[\s\S]*onOpenNote/);
  });

  it("routes all new status saves through a recovery-mode write gate", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(view).toMatch(/this\.actions\.updateProjectStatus\(plan, status\)/);
    expect(view).toMatch(/this\.requestCycleStatusChange\(cycleId, cycle\.status, status\)/);
    expect(view).not.toMatch(/onEditProjectStatus:[\s\S]*new WorkspaceStatusModal/);
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

  it("injects only the configured Helix transaction paths after settings load", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(main).toMatch(
      /const data = await this\.store\.load\(\);[\s\S]*this\.settings = data\.settings;[\s\S]*new HelixVaultRepository\(this\.app\.vault, \[[\s\S]*stage-delete\.json[\s\S]*workspace-history\.json[\s\S]*stage-focus-bridge\.json[\s\S]*\]\)/,
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

  it("coalesces self-written Vault events until one stable project refresh", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(main).toMatch(/new ProjectRefreshBatch\(\(\) => this\.scheduleProjectRefresh\(\)\)/);
    expect(main).toMatch(/scheduleProjectRefresh[\s\S]*projectRefreshBatch\.recordEvent\(\)[\s\S]*return/);
    expect(main).toMatch(
      /withProjectMutation<T>[\s\S]*projectRefreshBatch\.begin\(\)[\s\S]*try[\s\S]*finally[\s\S]*projectRefreshBatch\.end\(\)/,
    );
    expect(main).toMatch(/onunload[\s\S]*projectRefreshBatch\?\.dispose\(\)/);
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
    expect(view).toMatch(/workspace\.canvasRepairRequired && !canSilentlyRepairProjectCanvas\(workspace\)/);
    expect(view).toMatch(/workbench\.render\(workbenchHost\)/);
    expect(view).not.toMatch(/workbench\.render\(content\)/);
  });

  it("offers structural focus repair without invalid content choices", () => {
    expect(view).toMatch(/conflict\.reason !== "simultaneous-edit"[\s\S]*按来源重建自动引用/);
    expect(view).toMatch(/打开 Markdown 手工修复/);
    expect(view).toMatch(/return;[\s\S]*addChoice\("来源"/);
  });

  it("keeps internal managed-block and adoption jargon out of visible UI strings", () => {
    expect(view).not.toMatch(/(?:text:\s*|setTitle\()["`][^"`]*(?:纳管|受管块)/u);
    expect(view).toContain('text: "交由 Helix 管理"');
    expect(view).toContain('this.setTitle("将 Canvas 连线交由 Helix 管理")');
    expect(view).toContain('text: "确认管理"');
  });

  it("keeps internal adoption jargon out of user-facing service errors", () => {
    const oldTerms = /throw new Error\([^\n]*(?:纳管|受管块|未受管|受管计划行动|受管属性)/u;
    expect(projectWorkspace).not.toMatch(oldTerms);
    expect(didaProjectSync).not.toMatch(oldTerms);
    expect(projectWorkspace).toContain("请重建自动引用或打开 Markdown 手工修复");
    expect(didaProjectSync).toContain("阶段 Markdown 在加入同步前发生变化");
    expect(didaProjectSync).toContain("尚未加入同步的清单项加入同步");
  });

  it("keeps legacy projection and managed-region jargon out of all diagnostic constructors", () => {
    const diagnosticOldTerms = /(?:new (?:Error|FocusBridgeError)|corrupt\(|issues\.push\(|reasons\.add\(|message:\s*)[^\n]*(?:投影|受管链接区块|托管|非托管|受管(?:引用|标记|包络|块))/u;
    expect(userReachableDiagnostics).not.toMatch(diagnosticOldTerms);
    expect(userReachableDiagnostics).toContain("滴答项目同步分栏创建");
    expect(userReachableDiagnostics).toContain("Helix 自动链接区块无效");
    expect(userReachableDiagnostics).toContain("自动引用区域缺失、重复或顺序错误");
    expect(userReachableDiagnostics).toContain("尚未交由 Helix 管理");
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

  it("ships only the explicitly staged Dida capabilities", () => {
    const settings = readFileSync(resolve(process.cwd(), "src/ui/settings-tab.ts"), "utf8");
    const capabilities = readFileSync(resolve(process.cwd(), "src/release-capabilities.ts"), "utf8");
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(capabilities).toContain("export const DIDA_READ_AVAILABLE = true");
    expect(capabilities).toContain("export const DIDA_CONTRACT_TEST_AVAILABLE = true");
    expect(capabilities).toContain("export const DIDA_TASK_WRITE_AVAILABLE = true");
    expect(capabilities).toContain("export const PROJECT_DIDA_PROJECTION_AVAILABLE = true");
    expect(main).toContain("if (DIDA_READ_AVAILABLE) this.registerDidaReadCommands()");
    expect(main).toContain("if (DIDA_CONTRACT_TEST_AVAILABLE) this.registerDidaContractCommands()");
    expect(main).toMatch(/new HelixService[\s\S]*didaReadAvailable: DIDA_READ_AVAILABLE[\s\S]*didaTaskWriteAvailable: DIDA_TASK_WRITE_AVAILABLE[\s\S]*didaContractTestAvailable: DIDA_CONTRACT_TEST_AVAILABLE/);
    expect(main).toMatch(/refreshAutoSync[\s\S]*if \(!DIDA_READ_AVAILABLE\) return/);
    expect(settings).toMatch(/if \(!DIDA_READ_AVAILABLE\)[\s\S]*本地正式版[\s\S]*renderTemplateSetting\(\)/);
    expect(settings).toContain("if (DIDA_CONTRACT_TEST_AVAILABLE) this.renderContractTests()");
    expect(view).toMatch(/displayState[\s\S]*if \(!DIDA_READ_AVAILABLE\) return \{ projects: \[\], tasks: \[\] \}/);
    expect(view).toMatch(/renderHeader[\s\S]*if \(!DIDA_READ_AVAILABLE\) return/);
    expect(helixService).toMatch(/async sync\(\)[\s\S]*this\.assertDidaReadAvailable\(\)[\s\S]*syncWithAuthorizationLease\(!this\.didaTaskWriteAvailable\)/);
    expect(helixService).toMatch(/runDidaWriteContractTest[\s\S]*this\.assertDidaContractTestAvailable\(\)/);
    expect(helixService).toMatch(/applyConflict[\s\S]*this\.assertDidaTaskWriteAvailable\(\)/);
    expect(helixService).toMatch(/assertDidaTaskWriteAvailable[\s\S]*当前版本暂未开放滴答普通任务写入/);
    expect(view).not.toContain("renderProjectDidaMappingBar");
    expect(view).not.toContain("ProjectDidaMappingConfirmModal");
    expect(view).not.toContain("renderProjectProjectionPanel");
    expect(view).not.toContain("adoptProjectAction");
    expect(view).not.toContain("editProjectAction");
    expect(view).not.toContain("同步此项目到滴答");
    expect(view).not.toContain("当前只写 Stage，尚未发送滴答");
    expect(settings).toMatch(/PROJECT_DIDA_PROJECTION_AVAILABLE\) this\.renderProjectProjectionSettings\(\)/);
  });

  it("registers Live Preview marker hiding and routes project changes through one background coordinator", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const service = readFileSync(resolve(process.cwd(), "src/services/helix-service.ts"), "utf8");
    expect(main).toContain("this.registerEditorExtension(helixMarkerVisibilityExtension)");
    expect(main).toMatch(/new ProjectAutoSyncCoordinator[\s\S]*scan: \(\) => this\.projectAutoSyncScan\(\)[\s\S]*synchronize: \(projectId\) => this\.syncProjectProjection\(projectId\)/);
    expect(main).toMatch(/scheduleProjectRefresh[\s\S]*refreshPersistedEvents\(\)[\s\S]*projectAutoSync\.request\(\)/);
    expect(main).toMatch(/scheduleProjectRefresh[\s\S]*localProjectTasks\.snapshot[\s\S]*adoptUnmanaged: true[\s\S]*projectAutoSync\.request\(\)/);
    expect(main).toMatch(/confirmProjectProjection[\s\S]*projectAutoSync\.request\(true\)/);
    expect(main).toMatch(/projectProjectionWriteReadiness\(\)[\s\S]*PROJECT_DIDA_PROJECTION_AVAILABLE && readiness\.ready/);
    expect(main).toMatch(/projectAutoSyncScan\(\)[\s\S]*!PROJECT_DIDA_PROJECTION_AVAILABLE[\s\S]*candidates: \[\], failures: \[\]/);
    const readiness = service.slice(
      service.indexOf("async projectProjectionWriteReadiness"),
      service.indexOf("async replaceDidaToken"),
    );
    expect(readiness).toMatch(/data\.queue\.length[\s\S]*data\.conflicts\.some[\s\S]*state\.loading[\s\S]*remoteWriteGate\.isIdle[\s\S]*recoveryIssues[\s\S]*remoteOutcomeUnknown[\s\S]*projectionOperationReceipts/);
    expect(service).toContain("new RemoteWriteGate(() => this.emit())");
    expect(view).not.toContain("syncProjectProjection:");
  });

  it("routes projection conflicts only through strict reconciliation and safe cleanup", () => {
    expect(view).toMatch(/renderProjectionConflicts[\s\S]*receiptCleanupPending/);
    expect(view).toMatch(/kind: "action", projectId: model\.project\.id, stageId, uuid/);
    expect(view).toMatch(/removeResolvedProjectProjectionReceipt\(receipt\.operationId\)/);
    expect(view).toMatch(/receipt\.outcome !== "verified"[\s\S]*receipt\.outcome !== "verified-absent"[\s\S]*此处不提供清理[\s\S]*continue;/);
    expect(view).not.toMatch(/滴答项目同步[\s\S]*强制删除收据/);
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
    expect(settings).not.toContain("ProjectionUiActionCoordinator");
    expect(settings).toMatch(/projectionActivationConfirmation\.request\(\)[\s\S]*confirmProjectProjection/);
    expect(modal).not.toMatch(/didaProjectId|滴答清单映射|verifyRemoteProject/);
    expect(modal).toMatch(/submit\(title, initialStageTitle, this\.color\)/);
    expect(modal).toMatch(/首阶段名称/);
    expect(modal).toMatch(/class RenameEntityModal extends Modal/);
  });

  it("hides projection column creation while retaining safe unknown reconciliation", () => {
    const settings = readFileSync(resolve(process.cwd(), "src/ui/settings-tab.ts"), "utf8");
    const service = readFileSync(resolve(process.cwd(), "src/services/helix-service.ts"), "utf8");
    const confirm = service.slice(
      service.indexOf("async confirmProjectionColumnCreation"),
      service.indexOf("async reconcileProjectionColumnCreation"),
    );
    expect(settings).toMatch(/PROJECTION_COLUMN_NAME[\s\S]*previewProjectProjectionColumn[\s\S]*projectionColumnConfirmation\.request\(\)[\s\S]*confirmProjectProjectionColumn/);
    expect(view).toMatch(/分栏创建结果未知[\s\S]*reconcileProjectProjectionColumn/);
    expect(service).toMatch(/status: "running"[\s\S]*api\.createColumn[\s\S]*readProjectionCatalogWithLeaseHeld/);
    expect(confirm).toMatch(/enterExclusive\("滴答项目同步分栏创建"\)/);
    expect(confirm).not.toContain("withAuthorizationLease");
    expect(service).not.toMatch(/reconcileProjectionColumnCreation[\s\S]*deleteColumn|reconcileProjectionColumnCreation[\s\S]*updateColumn/);
  });

  it("keeps recovery and column-unknown diagnostics visible when the project workspace is unreadable", () => {
    expect(view).toMatch(/loadProjectionConflictModels[\s\S]*persisted\.didaProjectionState\?\.columnCreation/);
    expect(view).toMatch(/项目工作区只读[\s\S]*滴答项目同步诊断暂不可读[\s\S]*脱敏错误/);
    expect(view).toMatch(/conflictCenterIsEmpty\([\s\S]*workspaceDiagnostic: Boolean\(projectionLoad\.diagnostic\)/);
  });

  it("uses a prioritized conflict table with inline three-step field resolution", () => {
    expect(view).toMatch(/renderConflictMasterDetail\([\s\S]*helix-conflict-workspace[\s\S]*helix-conflict-board/);
    expect(view).toMatch(/待你选择[\s\S]*已阻止写入[\s\S]*不影响其他同步/);
    expect(view).toMatch(/搜索冲突内容或路径[\s\S]*全部类型[\s\S]*项目[\s\S]*任务[\s\S]*聚焦/);
    expect(view).toMatch(/需要你选择[\s\S]*等待远端核对[\s\S]*仅需检查/);
    expect(view).toMatch(/helix-conflict-table-head[\s\S]*来源[\s\S]*对象[\s\S]*诊断[\s\S]*严重性[\s\S]*操作/);
    expect(view).toMatch(/预览差异[\s\S]*选择方案[\s\S]*完成处理/);
    expect(view).toMatch(/并排视图[\s\S]*统一视图/);
    expect(view).toMatch(/renderConflictTextDiff[\s\S]*sideBySideTextDiff[\s\S]*helix-conflict-ide-line/);
    expect(view).toMatch(/previewLimit = 400[\s\S]*前 400 行预览/);
    expect(view).toMatch(/统一差异[\s\S]*helix-conflict-ide-unified-line/);
    expect(view).toMatch(/保留本地[\s\S]*采用远端[\s\S]*手动编辑/);
    expect(view).toMatch(/helix-focus-custom[\s\S]*is-collapsed[\s\S]*helix-focus-custom-toggle/);
    expect(view).toMatch(/批量采用建议[\s\S]*清除选择[\s\S]*最近处理/);
    expect(view).toMatch(/event\.key !== "ArrowDown"[\s\S]*event\.key !== "ArrowUp"[\s\S]*event\.key !== "Enter"/);
    expect(view).toMatch(/item\.type === "focus"[\s\S]*renderFocusBridgeConflict[\s\S]*renderConflict\(detail/);
    expect(view).toMatch(/helix-conflict-custom-toggle[\s\S]*aria-expanded[\s\S]*removeClass\("is-collapsed"\)/);
    const conflictStyles = css.slice(css.indexOf(".helix-conflict-diagnostics"), css.indexOf(".helix-reconciliation-card"));
    expect(conflictStyles).toMatch(/\.helix-conflict-workspace[\s\S]*grid-template-columns: minmax\(720px, 1fr\) 190px/);
    expect(conflictStyles).toMatch(/\.helix-conflict-expanded[\s\S]*grid-template-columns: 168px minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.helix-conflict-ide-line[\s\S]*font-family: var\(--font-monospace\)/);
    expect(css).toMatch(/\.helix-conflict-option code[\s\S]*overflow-wrap: anywhere[\s\S]*white-space: normal/);
    expect(conflictStyles).not.toContain("backdrop-filter");
  });
});
