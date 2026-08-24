import type {
  DidaProjectionTarget,
  ProjectionActivationPreview,
} from "../domain/dida-project-projection";
import type {
  ProjectWorkspaceProject,
  ProjectWorkspaceSnapshot,
} from "./project-workspace";
import type {
  ProjectionProjectInput,
  ProjectionProjectReadModel,
  ProjectionCatalogSnapshot,
} from "./dida-project-projection";
import { buildProjectionActivationPreview } from "../domain/dida-project-projection";

export interface ProjectionApplicationPort {
  readProject(input: ProjectionProjectInput): Promise<ProjectionProjectReadModel>;
  previewActivation(
    target: DidaProjectionTarget,
    counts: { projectCount: number; actionCount: number },
  ): Promise<ProjectionActivationPreview>;
  activate(preview: ProjectionActivationPreview, confirmedHash: string): Promise<void>;
}

/** 确认事务已经持有排他租约；远端目录必须通过该租约提供的读取函数获取。 */
export async function confirmProjectionActivationWithLease(
  snapshot: ProjectWorkspaceSnapshot,
  projection: ProjectionApplicationPort & {
    activateVerifiedPreview(preview: ProjectionActivationPreview, confirmedHash: string): Promise<void>;
  },
  preview: ProjectionActivationPreview,
  confirmedHash: string,
  readCatalog: (projectId: string) => Promise<ProjectionCatalogSnapshot>,
): Promise<void> {
  const counts = await projectionCounts(snapshot, projection);
  const catalog = await readCatalog(preview.target.targetProjectId);
  const fresh = buildProjectionActivationPreview({
    target: preview.target,
    projects: catalog.projects,
    columns: catalog.columns,
    readiness: catalog.readiness,
    ...counts,
  });
  if (fresh.previewHash !== confirmedHash) {
    throw new Error("同步项目、行动或远端目标已变化，请重新预览确认");
  }
  await projection.activateVerifiedPreview(fresh, confirmedHash);
}

export function projectionInputFromProject(project: ProjectWorkspaceProject): ProjectionProjectInput {
  if (project.cycles.length !== 1) {
    throw new Error("阶段任务同步必须逐阶段构建输入");
  }
  return projectionInputFromStage(project, project.cycles[0]!);
}

/** 滴答层级以 Stage 为父任务；Helix Project 只负责在本地组织这些阶段。 */
export function projectionInputFromStage(
  project: ProjectWorkspaceProject,
  stage: ProjectWorkspaceProject["cycles"][number],
): ProjectionProjectInput {
  return {
    projectId: stage.id,
    projectPath: stage.notePath,
    projectTitle: stage.title,
    // 待记录表示计划行动已经收口；滴答父任务允许完成，Stage 仍由用户手动完成。
    projectStatus: stage.status === "idea"
      ? "planned"
      : stage.status,
    createWhenMissing: stage.status === "active",
    stages: [{ path: stage.notePath, stageId: stage.id }],
  };
}

export function projectionInputsFromProject(project: ProjectWorkspaceProject): ProjectionProjectInput[] {
  return project.cycles.map((stage) => projectionInputFromStage(project, stage));
}

export function projectionStageInProject(
  snapshot: ProjectWorkspaceSnapshot,
  projectId: string,
  stageId: string,
): ProjectWorkspaceProject["cycles"][number] {
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  const stage = project?.cycles.find((candidate) => candidate.id === stageId);
  if (!project || !stage) throw new Error("找不到指定项目中的阶段");
  return stage;
}

/** 冲突读模型以 Stage ID 作为远端父任务身份；据此反查唯一的本地所属项目。 */
export function projectionStageByProjectionId(
  snapshot: ProjectWorkspaceSnapshot,
  projectionProjectId: string,
  stageId: string,
): { project: ProjectWorkspaceProject; stage: ProjectWorkspaceProject["cycles"][number] } {
  if (projectionProjectId !== stageId) throw new Error("阶段同步身份与阶段 ID 不一致");
  const matches = snapshot.projects.flatMap((project) => project.cycles
    .filter((stage) => stage.id === stageId)
    .map((stage) => ({ project, stage })));
  if (matches.length !== 1) throw new Error("找不到唯一的阶段同步所属项目");
  return matches[0]!;
}

export async function projectionCounts(
  snapshot: ProjectWorkspaceSnapshot,
  projection: Pick<ProjectionApplicationPort, "readProject">,
): Promise<{ projectCount: number; actionCount: number }> {
  const inputs = snapshot.projects.flatMap(projectionInputsFromProject);
  const models = await Promise.all(inputs.map((input) => projection.readProject(input)));
  return {
    projectCount: inputs.length,
    actionCount: models.reduce((count, model) =>
      count + model.stages.reduce((total, stage) => total + stage.managed.length, 0), 0),
  };
}

/** 确认时必须基于当前稳定工作区重新计数，并重新读取远端目标。 */
export async function confirmProjectionActivation(
  snapshot: ProjectWorkspaceSnapshot,
  projection: ProjectionApplicationPort,
  preview: ProjectionActivationPreview,
  confirmedHash: string,
): Promise<void> {
  const counts = await projectionCounts(snapshot, projection);
  const fresh = await projection.previewActivation(preview.target, counts);
  if (fresh.previewHash !== confirmedHash) {
    throw new Error("同步项目或行动数量已变化，请重新预览确认");
  }
  await projection.activate(fresh, confirmedHash);
}
