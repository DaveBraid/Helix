export type WorkbenchSection =
  | "today"
  | "projects"
  | "tasks"
  | "reviews"
  | "challenges"
  | "conflicts";

/** 工作台唯一导航模型；分析回顾属于复盘，而非独立入口。 */
export const WORKBENCH_NAVIGATION: ReadonlyArray<{
  id: WorkbenchSection;
  label: string;
}> = [
  { id: "today", label: "今日" },
  { id: "projects", label: "项目" },
  { id: "tasks", label: "任务" },
  { id: "reviews", label: "复盘" },
  { id: "challenges", label: "挑战" },
  { id: "conflicts", label: "冲突" },
];
