/** 项目与阶段状态的唯一规范化入口。旧值只读兼容，绝不在读取时回写。 */
export type HelixProjectStatus =
  | "planned"
  | "active"
  | "completed"
  | "paused"
  | "terminated";

export type HelixStageStatus =
  | "idea"
  | "active"
  | "recording"
  | "completed"
  | "paused"
  | "terminated";

export function projectStatusFromFrontmatter(value: unknown): HelixProjectStatus | null {
  if (value === "archived") return "terminated";
  return value === "planned" || value === "active" || value === "completed" ||
    value === "paused" || value === "terminated" ? value : null;
}

export function stageStatusFromFrontmatter(value: unknown): HelixStageStatus | null {
  if (value === "planned") return "idea";
  if (value === "closed") return "completed";
  return value === "idea" || value === "active" || value === "recording" || value === "completed" ||
    value === "paused" || value === "terminated" ? value : null;
}

export function isProjectStatus(value: unknown): value is HelixProjectStatus {
  return projectStatusFromFrontmatter(value) === value;
}

export function isStageStatus(value: unknown): value is HelixStageStatus {
  return stageStatusFromFrontmatter(value) === value;
}

export const PROJECT_STATUS_LABELS: Record<HelixProjectStatus, string> = {
  planned: "计划中",
  active: "进行中",
  completed: "已完成",
  paused: "已暂停",
  terminated: "已终止",
};

export const STAGE_STATUS_LABELS: Record<HelixStageStatus, string> = {
  idea: "计划中",
  active: "进行中",
  recording: "待记录",
  completed: "已完成",
  paused: "已暂停",
  terminated: "已终止",
};

export function isTerminalStageStatus(status: HelixStageStatus): boolean {
  return status === "completed" || status === "terminated";
}
