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
    if (!project) throw new Error("投影目录缺少精确清单");
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
  canSync: boolean;
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
    canSync: model.enabled && frozen === 0 && model.receiptCleanupPending.length === 0,
  };
}

export function projectionActivationText(preview: ProjectionActivationPreview): string[] {
  return [
    `${preview.projectName} · ${preview.target.targetProjectId}`,
    `${preview.columnName} · ${preview.target.targetColumnId}`,
    `${preview.projectCount} 个 Helix 项目 · ${preview.actionCount} 条受管行动`,
    preview.blockers.length === 0 ? "能力与安全条件已满足" : `阻塞：${preview.blockers.join("；")}`,
  ];
}

export function projectionTargetText(state: Pick<ProjectionPersistentState, "enabled" | "target">): string {
  if (!state.target) return "尚未选择目标清单与分栏";
  return `${state.enabled ? "已启用" : "已禁用"} · ${state.target.targetProjectId} / ${state.target.targetColumnId}`;
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
