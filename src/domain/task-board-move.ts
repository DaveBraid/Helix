import type { DidaColumn, DidaProject } from "./entities";

export interface TaskBoardMoveAvailability {
  enabled: boolean;
  reason: string;
}

export function taskBoardMoveAvailability(
  input: {
    connected: boolean;
    demoMode: boolean;
    boardPlacementVerified: boolean;
  },
  project: DidaProject,
  currentColumnId: string | null | undefined,
): TaskBoardMoveAvailability {
  if (input.demoMode) return { enabled: false, reason: "演示数据不能同步看板分栏" };
  if (!input.boardPlacementVerified) {
    return { enabled: false, reason: "当前滴答账号尚未通过看板归栏合同测试" };
  }
  if (!input.connected) return { enabled: false, reason: "当前离线，请联网同步后再移动" };
  if (project.permission && project.permission !== "write") {
    return { enabled: false, reason: "该清单没有写入权限" };
  }
  if (project.boardStale) return { enabled: false, reason: "看板详情已过期，请先同步" };
  const targets = (project.columns ?? []).filter((column) => column.id !== currentColumnId);
  if (targets.length === 0) return { enabled: false, reason: "没有其他可移动的目标分栏" };
  return { enabled: true, reason: "移动到其他分栏" };
}

export function taskBoardColumnLabels(columns: DidaColumn[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const column of columns) counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
  return new Map(columns.map((column, index) => [
    column.id,
    (counts.get(column.name) ?? 0) > 1
      ? `${column.name} · 第 ${index + 1} 列`
      : column.name,
  ]));
}

export async function commitTaskBoardMove(
  targetColumnId: string,
  move: (targetColumnId: string) => Promise<void>,
  afterSuccess: () => void | Promise<void>,
): Promise<void> {
  if (!targetColumnId) throw new Error("请选择目标分栏");
  await move(targetColumnId);
  await afterSuccess();
}

export function taskBoardDropTarget(
  currentColumnId: string | null | undefined,
  targetColumnId: string | null | undefined,
): string | null {
  if (!targetColumnId || targetColumnId === currentColumnId) return null;
  return targetColumnId;
}

export function taskBoardKeyboardTarget(
  columns: DidaColumn[],
  currentColumnId: string | null | undefined,
  direction: "left" | "right",
): string | null {
  if (columns.length === 0) return null;
  const currentIndex = columns.findIndex((column) => column.id === currentColumnId);
  if (currentIndex < 0) {
    return direction === "right" ? columns[0]!.id : columns[columns.length - 1]!.id;
  }
  const targetIndex = currentIndex + (direction === "right" ? 1 : -1);
  return columns[targetIndex]?.id ?? null;
}

export function normalizeInlineTaskTitle(value: string): string {
  const title = value.trim();
  if (!title) throw new Error("任务标题不能为空");
  return title;
}
