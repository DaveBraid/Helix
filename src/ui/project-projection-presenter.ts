import type { ProjectionActivationPreview, ProjectionActionState } from "../domain/dida-project-projection";
import type {
  ProjectionCatalogSnapshot,
  ProjectionPersistentState,
  ProjectionProjectReadModel,
  ProjectionSyncSummary,
} from "../services/dida-project-projection";

export const PROJECTION_STATE_OPTIONS: Array<{ value: ProjectionActionState; label: string }> = [
  { value: "idea", label: "想法" },
  { value: "active", label: "进行中" },
  { value: "completed", label: "已完成" },
  { value: "paused", label: "暂停" },
  { value: "terminated", label: "终止" },
];

export interface ProjectionCatalogChoice {
  projectId: string;
  projectLabel: string;
  columns: Array<{ id: string; label: string }>;
}

export function projectionCatalogChoices(catalogs: ProjectionCatalogSnapshot[]): ProjectionCatalogChoice[] {
  return catalogs.map((catalog) => {
    const project = catalog.projects[0];
    if (!project) throw new Error("滴答项目同步目录缺少精确清单");
    return {
      projectId: project.id,
      projectLabel: `${project.name} · ${project.id}`,
      columns: catalog.columns.map((column) => ({ id: column.id, label: `${column.name} · ${column.id}` })),
    };
  }).sort((left, right) => left.projectLabel.localeCompare(right.projectLabel, "zh-CN"));
}

export function projectionProjectSummary(model: ProjectionProjectReadModel): {
  managed: number;
  unmanaged: number;
  orphan: number;
  frozen: number;
  cleanup: number;
} {
  const managed = model.stages.reduce((sum, stage) => sum + stage.managed.length, 0);
  const unmanaged = model.stages.reduce((sum, stage) => sum + stage.unmanaged.length, 0);
  const frozen = model.stages.reduce((sum, stage) =>
    sum + stage.managed.filter((action) => action.frozen).length, 0) +
    model.orphanDiagnostics.filter((entry) => entry.frozen).length +
    (model.parentDiagnostic?.frozen ? 1 : 0);
  return {
    managed,
    unmanaged,
    orphan: model.orphanDiagnostics.length,
    frozen,
    cleanup: model.receiptCleanupPending.length,
  };
}

export function projectionActivationText(preview: ProjectionActivationPreview): string[] {
  return [
    `${preview.projectName} · ${preview.target.targetProjectId}`,
    `${preview.columnName} · ${preview.target.targetColumnId}`,
    `${preview.projectCount} 个 Helix 项目 · ${preview.actionCount} 条已加入同步的行动`,
    preview.blockers.length === 0 ? "能力与安全条件已满足" : `阻塞：${preview.blockers.join("；")}`,
  ];
}

export function projectionTargetText(state: Pick<ProjectionPersistentState, "enabled" | "target">): string {
  if (!state.target) return "尚未选择目标清单与分栏";
  return `${state.enabled ? "已启用" : "已禁用"} · ${state.target.targetProjectId} / ${state.target.targetColumnId}`;
}

export function projectionPauseText(readiness: {
  capabilitiesBlocked: boolean;
  queueBlocked: boolean;
  conflictsBlocked: boolean;
  inProgress: boolean;
  recoveryBlocked: boolean;
  unknownBlocked: boolean;
}): string {
  const reasons = [
    readiness.capabilitiesBlocked ? "连接或写入合同尚未就绪" : "",
    readiness.queueBlocked ? "普通任务队列尚未清空" : "",
    readiness.conflictsBlocked ? "存在未解决冲突" : "",
    readiness.inProgress ? "其他远端操作正在进行" : "",
    readiness.recoveryBlocked ? "存在恢复或清理锁" : "",
    readiness.unknownBlocked ? "存在远端结果未知记录" : "",
  ].filter(Boolean);
  return reasons.length > 0 ? `后台写入已暂停：${reasons.join("；")}` : "后台写入条件已就绪";
}

export function projectionSyncSummaryText(summary: ProjectionSyncSummary): {
  text: string;
  warning: boolean;
} {
  const details = [
    `创建 ${summary.createdParents + summary.createdActions}`,
    `更新 ${summary.updatedParents + summary.updatedActions}`,
    `完成 ${summary.completedParents + summary.completedActions}`,
    `删除 ${summary.deletedActions}`,
    `冻结 ${summary.frozen.length}`,
  ].join(" · ");
  return summary.frozen.length > 0
    ? { text: `部分冻结，转冲突中心处理。${details}`, warning: true }
    : { text: `项目同步已收口。${details}`, warning: false };
}

/** 同一 UI 实例的投影动作共享串行队列；只有最后一代完成时解除 busy 并刷新。 */
export class ProjectionUiActionCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  run<T>(
    operation: () => Promise<T>,
    setBusy: (busy: boolean) => void,
    refresh: () => void,
  ): Promise<T> {
    const generation = ++this.generation;
    setBusy(true);
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      if (generation !== this.generation) return;
      setBusy(false);
      refresh();
    });
  }
}

export async function loadProjectionConflictModels(
  loadProjectIds: () => Promise<string[]>,
  readProject: (projectId: string) => Promise<ProjectionProjectReadModel>,
): Promise<{ models: ProjectionProjectReadModel[]; diagnostic?: string }> {
  let projectIds: string[];
  try {
    projectIds = await loadProjectIds();
  } catch (error) {
    return { models: [], diagnostic: projectWorkspaceReadDiagnostic(error) };
  }
  const results = await Promise.allSettled(projectIds.map(readProject));
  return {
    models: results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
  };
}

export function conflictCenterIsEmpty(input: {
  conflicts: number;
  focusConflicts: number;
  recoveryIssues: number;
  reconciliation: number;
  failed: number;
  orphanedBlocked: number;
  projectionIssues: number;
  workspaceDiagnostic: boolean;
  lineageConflict: boolean;
  contractCleanup: boolean;
  requestControlAttention: boolean;
}): boolean {
  return input.conflicts === 0 && input.focusConflicts === 0 && input.recoveryIssues === 0 &&
    input.reconciliation === 0 && input.failed === 0 && input.orphanedBlocked === 0 &&
    input.projectionIssues === 0 && !input.workspaceDiagnostic && !input.lineageConflict &&
    !input.contractCleanup && !input.requestControlAttention;
}

export function projectWorkspaceReadDiagnostic(error: unknown): string {
  const source = error instanceof Error ? error.message : String(error);
  const redacted = source
    .replace(/\b(token|secret|authorization|bearer)\b\s*[:=]?\s*\S+/giu, "$1 [敏感信息已隐藏]")
    .replace(/口令\s*[:：=]?\s*\S+/gu, "口令 [敏感信息已隐藏]")
    .replace(/https?:\/\/\S+/giu, "[URL 已隐藏]")
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\){1,}[^\s\\]*/gu, "[路径已隐藏]")
    .replace(/(?:\/[^\s/:]+){2,}/gu, "[路径已隐藏]")
    .replace(/\b[A-Za-z0-9_-]{12,}\b/gu, "[标识已隐藏]")
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 240);
  return redacted || "未知读取错误";
}
