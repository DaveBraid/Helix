import type { SyncConflict } from "../sync/types";

export function claimConflictApplication(
  conflicts: SyncConflict[],
  conflictId: string,
  now = new Date().toISOString(),
): SyncConflict["status"] {
  const conflict = conflicts.find((candidate) => candidate.id === conflictId);
  if (!conflict) throw new Error("冲突不存在或已经解决");
  if (conflict.status === "applying") {
    throw new Error("该冲突正在应用或等待人工核对，不能重复提交");
  }
  if (conflict.status === "resolved" || conflict.status === "superseded") {
    throw new Error("该冲突已经结束");
  }
  if (conflict.fields.some((field) => !field.sameResult && !field.choice)) {
    throw new Error("仍有字段尚未选择，不能开始写回远端");
  }
  const previous = conflict.status;
  conflict.status = "applying";
  conflict.updatedAt = now;
  return previous;
}

export function releaseConflictApplication(
  conflicts: SyncConflict[],
  conflictId: string,
  previousStatus: SyncConflict["status"],
  now = new Date().toISOString(),
): void {
  const conflict = conflicts.find((candidate) => candidate.id === conflictId);
  if (!conflict || conflict.status !== "applying") return;
  conflict.status = previousStatus === "open" ? "open" : "staged";
  conflict.updatedAt = now;
}
