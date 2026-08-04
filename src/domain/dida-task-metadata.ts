import type { DidaTask } from "./entities";
import { deepEqual } from "./stable";

/** 滴答写入后自行更新的并发／时间戳字段，不属于用户业务字段。 */
export const DIDA_TASK_REMOTE_METADATA_FIELDS = [
  "etag",
  "modifiedTime",
  "etimestamp",
] as const;

export type DidaTaskRemoteMetadataField =
  typeof DIDA_TASK_REMOTE_METADATA_FIELDS[number];

export function didaTaskWithoutRemoteMetadata(
  task: DidaTask,
): Omit<DidaTask, DidaTaskRemoteMetadataField> {
  const copy = { ...task } as Record<string, unknown>;
  for (const field of DIDA_TASK_REMOTE_METADATA_FIELDS) delete copy[field];
  return copy as Omit<DidaTask, DidaTaskRemoteMetadataField>;
}

export function sameDidaTaskExcept(
  left: DidaTask,
  right: DidaTask,
  omitted: ReadonlyArray<keyof DidaTask | DidaTaskRemoteMetadataField> = [],
): boolean {
  const leftCopy = { ...didaTaskWithoutRemoteMetadata(left) } as Record<string, unknown>;
  const rightCopy = { ...didaTaskWithoutRemoteMetadata(right) } as Record<string, unknown>;
  for (const field of omitted) {
    delete leftCopy[field];
    delete rightCopy[field];
  }
  return deepEqual(leftCopy, rightCopy);
}

export function didaTaskDifferenceFields(
  left: DidaTask,
  right: DidaTask,
  omitted: ReadonlyArray<keyof DidaTask | DidaTaskRemoteMetadataField> = [],
): string[] {
  const ignored = new Set<string>([
    ...DIDA_TASK_REMOTE_METADATA_FIELDS,
    ...omitted,
  ]);
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].filter((key) =>
    !ignored.has(key) && !deepEqual(leftRecord[key], rightRecord[key]));
}
