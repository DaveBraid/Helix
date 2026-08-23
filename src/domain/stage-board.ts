import type { HelixStageStatus } from "./project-status";
import { STAGE_STATUS_LABELS } from "./project-status";

/** 看板、关系图与卡片列表共用的阶段状态呈现定义。 */
export const STAGE_BOARD_COLUMNS: ReadonlyArray<HelixStageStatus> = [
  "idea",
  "active",
  "recording",
  "completed",
  "paused",
  "terminated",
];

export const STAGE_STATUS_PRESENTATION: Record<HelixStageStatus, {
  label: string;
  icon: "lightbulb" | "play" | "notebook-pen" | "circle-check-big" | "pause" | "circle-x";
  tone: HelixStageStatus;
}> = {
  idea: { label: STAGE_STATUS_LABELS.idea, icon: "lightbulb", tone: "idea" },
  active: { label: STAGE_STATUS_LABELS.active, icon: "play", tone: "active" },
  recording: { label: STAGE_STATUS_LABELS.recording, icon: "notebook-pen", tone: "recording" },
  completed: { label: STAGE_STATUS_LABELS.completed, icon: "circle-check-big", tone: "completed" },
  paused: { label: STAGE_STATUS_LABELS.paused, icon: "pause", tone: "paused" },
  terminated: { label: STAGE_STATUS_LABELS.terminated, icon: "circle-x", tone: "terminated" },
};

export function stageBoardMoveDecision(
  source: HelixStageStatus,
  target: HelixStageStatus,
  pending: boolean,
): "noop" | "busy" | "commit" {
  if (pending) return "busy";
  return source === target ? "noop" : "commit";
}

/** 看板成员只由 Markdown 快照中的阶段派生，绝不读取 Canvas 节点或折叠投影。 */
export function stageBoardCycleIds(
  projects: ReadonlyArray<{ id: string; cycles: ReadonlyArray<{ id: string }> }>,
  selectedProjectId: string | null,
): string[] {
  return projects.flatMap((project) =>
    selectedProjectId && project.id !== selectedProjectId
      ? []
      : project.cycles.map((cycle) => cycle.id));
}

export function stageBoardPointerDecision(
  distance: number,
  source: HelixStageStatus,
  target: HelixStageStatus | undefined,
  canceled: boolean,
): { suppressOpen: boolean; move: "noop" | "commit" } {
  if (distance < 7) return { suppressOpen: false, move: "noop" };
  if (canceled || !target || target === source) return { suppressOpen: true, move: "noop" };
  return { suppressOpen: true, move: "commit" };
}

/** 让 UI 编排可测试：预读状态必须仍等于拖起时的值，提交器负责 CAS/恢复门禁。 */
export async function requestStageBoardStatusChange<TPlan extends { currentStatus: HelixStageStatus }>(
  cycleId: string,
  expectedStatus: HelixStageStatus,
  nextStatus: HelixStageStatus,
  prepare: (cycleId: string) => Promise<TPlan>,
  commit: (plan: TPlan, status: HelixStageStatus) => Promise<void>,
): Promise<void> {
  const plan = await prepare(cycleId);
  if (plan.currentStatus !== expectedStatus) {
    throw new Error("阶段状态已变化，请刷新后重试");
  }
  await commit(plan, nextStatus);
}

/** 看板异步提交的最小会话闸门：结束总会释放锁，失活实例不得再更新 DOM。 */
export class StageBoardMoveRegistry {
  private readonly pending = new Set<string>();

  tryBegin(id: string): boolean {
    if (this.pending.has(id)) return false;
    this.pending.add(id);
    return true;
  }

  finish(id: string, alive: boolean): boolean {
    this.pending.delete(id);
    return alive;
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }
}
