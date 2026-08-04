import type { EntityKind, EntitySnapshot, RemoteEntity } from "../domain/entities";
import { DIDA_TASK_REMOTE_METADATA_FIELDS } from "../domain/dida-task-metadata";
import { cloneValue, deepEqual, stableHash } from "../domain/stable";
import { createSnapshot, snapshotChanged } from "./snapshots";
import {
  applyResolutions,
  buildConflictFields,
  setFieldResolution,
  unresolvedFields,
} from "./three-way-merge";
import type {
  ConflictRepository,
  RemoteEntityAdapter,
  ResolutionAuditEntry,
  ResolutionChoice,
  SnapshotRepository,
  SyncConflict,
  SyncQueueOperation,
} from "./types";

export type PersistQueue = (operations: SyncQueueOperation[]) => Promise<void>;

export interface ResolvedConflict<T> {
  outcome: "resolved";
  snapshot: EntitySnapshot<T>;
  audit: ResolutionAuditEntry;
  previousEntityId?: string;
}

export interface SyncEngineDependencies<T extends RemoteEntity> {
  adapter: RemoteEntityAdapter<T>;
  snapshots: SnapshotRepository;
  conflicts: ConflictRepository;
  deviceId: string;
  now?: () => Date;
  deferConflictFinalization?: boolean;
  validateWrite?: (value: T, remoteBeforeWrite: T | null) => void;
}

export class SyncEngine<T extends RemoteEntity> {
  private readonly now: () => Date;

  constructor(private readonly dependencies: SyncEngineDependencies<T>) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async process(operation: SyncQueueOperation<T>): Promise<
    | { outcome: "pushed"; snapshot: EntitySnapshot<T> }
    | { outcome: "pulled"; snapshot: EntitySnapshot<T> }
    | { outcome: "conflict"; conflict: SyncConflict<T> }
    | { outcome: "deleted" }
    | { outcome: "noop" }
  > {
    if (operation.operation === "create") return this.create(operation);
    const remoteValue = await this.dependencies.adapter.get(operation.entityId, {
      projectId: operation.projectId,
    });
    const remoteSnapshot = remoteValue
      ? this.snapshot(remoteValue, operation.entityId)
      : null;
    const base = operation.base ?? (await this.dependencies.snapshots.getBase<T>(
      operation.kind,
      operation.entityId,
    ));
    const local = operation.local;

    if (!base) {
      if (!remoteSnapshot) return { outcome: "noop" };
      const conflict = await this.openConflict(
        operation,
        this.emptySnapshot(operation.kind, operation.entityId),
        local,
        remoteSnapshot,
        "缺少同步基线",
      );
      return { outcome: "conflict", conflict };
    }

    if (operation.operation === "delete") {
      if (!remoteSnapshot) return { outcome: "deleted" };
      if (snapshotChanged(remoteSnapshot, base)) {
        const deletedLocal = this.snapshot(null as unknown as T, operation.entityId);
        const conflict = await this.openConflict(
          operation,
          base,
          deletedLocal,
          remoteSnapshot,
          "删除与远端修改冲突",
        );
        return { outcome: "conflict", conflict };
      }
      await this.dependencies.adapter.delete(operation.entityId, {
        projectId: operation.projectId,
        writeFields: operation.writeFields,
      });
      const verified = await this.dependencies.adapter.get(operation.entityId, {
        projectId: operation.projectId,
      });
      if (verified !== null) throw new Error("删除后验证失败：远端记录仍然存在");
      return { outcome: "deleted" };
    }

    if (!remoteSnapshot) {
      const conflict = await this.openConflict(
        operation,
        base,
        local,
        this.snapshot(null as unknown as T, operation.entityId),
        "远端删除与本地修改冲突",
      );
      return { outcome: "conflict", conflict };
    }

    const localChanged = snapshotChanged(local, base);
    const remoteChanged = snapshotChanged(remoteSnapshot, base);
    if (localChanged && remoteChanged && local.stamp.hash !== remoteSnapshot.stamp.hash) {
      const conflict = await this.openConflict(
        operation,
        base,
        local,
        remoteSnapshot,
        "本地与远端同时修改",
      );
      return { outcome: "conflict", conflict };
    }

    if (localChanged) {
      const written = await this.safeWrite(operation, base, remoteSnapshot, local);
      if ("conflict" in written) return { outcome: "conflict", conflict: written.conflict };
      return { outcome: "pushed", snapshot: written.snapshot };
    }
    if (remoteChanged) {
      await this.dependencies.snapshots.saveBase(remoteSnapshot);
      await this.dependencies.snapshots.saveLocal(remoteSnapshot);
      return { outcome: "pulled", snapshot: remoteSnapshot };
    }
    return { outcome: "noop" };
  }

  async choose(
    conflictId: string,
    path: string,
    choice: ResolutionChoice,
    customValue?: unknown,
  ): Promise<SyncConflict> {
    const conflict = await this.dependencies.conflicts.get(conflictId);
    if (!conflict) throw new Error("冲突不存在或已经解决");
    if (conflict.status === "applying") {
      throw new Error("冲突正在写回远端，当前不可修改字段选择");
    }
    if (conflict.status === "resolved" || conflict.status === "superseded") {
      throw new Error("冲突已经结束，当前不可修改字段选择");
    }
    const updated = setFieldResolution(conflict, path, choice, customValue);
    await this.dependencies.conflicts.save(updated);
    return updated;
  }

  async applyConflict(
    conflictId: string,
    context?: { projectId?: string },
  ): Promise<
    | ResolvedConflict<T>
    | { outcome: "remote-changed"; conflict: SyncConflict<T> }
  > {
    const conflict = (await this.dependencies.conflicts.get(conflictId)) as
      | SyncConflict<T>
      | null;
    if (!conflict) throw new Error("冲突不存在或已经解决");
    if (unresolvedFields(conflict).length > 0) throw new Error("仍有字段尚未选择");

    const freshRemote = await this.dependencies.adapter.get(conflict.entityId, context);
    const freshRemoteSnapshot = freshRemote
      ? this.snapshot(freshRemote, conflict.entityId)
      : this.snapshot(null as unknown as T, conflict.entityId);
    if (freshRemoteSnapshot.stamp.hash !== conflict.remote.stamp.hash) {
      const refreshed = this.rebaseConflict(conflict, freshRemoteSnapshot);
      await this.dependencies.conflicts.save(refreshed);
      return { outcome: "remote-changed", conflict: refreshed };
    }

    const merged = applyResolutions<T | null>(conflict as unknown as SyncConflict<T | null>);
    const resolved = await this.writeConflictResolution(conflict, freshRemote, merged, context);
    if ("conflict" in resolved) return resolved;
    const verifiedSnapshot = resolved.snapshot;

    const audit = this.auditEntry(conflict, verifiedSnapshot);
    if (!this.dependencies.deferConflictFinalization) {
      if (verifiedSnapshot.value === null) {
        await this.dependencies.snapshots.removeBase(conflict.kind, conflict.entityId);
        await this.dependencies.snapshots.removeLocal(conflict.kind, conflict.entityId);
      } else {
        if (verifiedSnapshot.entityId !== conflict.entityId) {
          await this.dependencies.snapshots.removeBase(conflict.kind, conflict.entityId);
          await this.dependencies.snapshots.removeLocal(conflict.kind, conflict.entityId);
        }
        await this.dependencies.snapshots.saveBase(verifiedSnapshot);
        await this.dependencies.snapshots.saveLocal(verifiedSnapshot);
      }
      await this.dependencies.conflicts.appendAudit(audit);
      await this.dependencies.conflicts.remove(conflictId);
    }
    return {
      outcome: "resolved",
      snapshot: verifiedSnapshot,
      audit,
      previousEntityId:
        verifiedSnapshot.entityId !== conflict.entityId
          ? conflict.entityId
          : undefined,
    };
  }

  async verifyAppliedConflict(
    conflictId: string,
    context?: { projectId?: string },
    remoteEntityId?: string,
  ): Promise<ResolvedConflict<T>> {
    const conflict = (await this.dependencies.conflicts.get(conflictId)) as
      | SyncConflict<T>
      | null;
    if (!conflict || conflict.status !== "applying") {
      throw new Error("冲突不在等待远端核对状态");
    }
    if (unresolvedFields(conflict).length > 0) throw new Error("仍有字段尚未选择");
    const merged = applyResolutions<T | null>(
      conflict as unknown as SyncConflict<T | null>,
    );
    const lookupId = remoteEntityId?.trim() || conflict.entityId;
    const remote = await this.dependencies.adapter.get(lookupId, {
      projectId: projectIdOf(merged) ?? context?.projectId,
    });
    if (merged === null) {
      if (remote !== null) throw new Error("远端记录仍然存在，不能采纳为已完成删除");
    } else {
      if (!remote) {
        throw new Error(
          lookupId === conflict.entityId
            ? "远端记录不存在；若本次是重建，请填写新记录 ID"
            : "填写的远端记录不存在",
        );
      }
      if (!equivalentForVerification(merged, remote, lookupId !== conflict.entityId)) {
        throw new Error("远端记录与已选择的合并结果不一致，拒绝采纳");
      }
    }
    const snapshot = merged === null
      ? this.snapshot(null as unknown as T, conflict.entityId)
      : this.snapshot(remote!, lookupId);
    return {
      outcome: "resolved",
      snapshot,
      audit: this.auditEntry(conflict, snapshot),
      previousEntityId: lookupId !== conflict.entityId ? conflict.entityId : undefined,
    };
  }

  private async create(
    operation: SyncQueueOperation<T>,
  ): Promise<{ outcome: "pushed"; snapshot: EntitySnapshot<T> }> {
    this.dependencies.validateWrite?.(operation.local.value, null);
    const created = await this.dependencies.adapter.create(operation.local.value);
    const createdId = created.id || operation.entityId;
    let verified: T | null;
    try {
      verified = await this.dependencies.adapter.get(createdId, {
        projectId: operation.projectId,
      });
    } catch (error) {
      throw {
        category: "unknown-outcome",
        message: `远端已返回创建结果，但复读验证失败：${error instanceof Error ? error.message : String(error)}`,
        remoteOutcomeUnknown: true,
      };
    }
    if (!verified || !equivalentForVerification(operation.local.value, verified, true)) {
      throw {
        category: "unknown-outcome",
        message: "远端创建结果无法通过复读验证，已转入待核对状态",
        remoteOutcomeUnknown: true,
      };
    }
    const snapshot = this.snapshot(verified, createdId);
    await this.dependencies.snapshots.saveBase(snapshot);
    await this.dependencies.snapshots.saveLocal(snapshot);
    if (createdId !== operation.entityId) {
      await this.dependencies.snapshots.removeBase(operation.kind, operation.entityId);
      await this.dependencies.snapshots.removeLocal(operation.kind, operation.entityId);
    }
    return { outcome: "pushed", snapshot };
  }

  private async safeWrite(
    operation: SyncQueueOperation<T>,
    base: EntitySnapshot<T>,
    expectedRemote: EntitySnapshot<T>,
    desired: EntitySnapshot<T>,
  ): Promise<
    | { snapshot: EntitySnapshot<T> }
    | { conflict: SyncConflict<T> }
  > {
    const preflight = await this.dependencies.adapter.get(operation.entityId, {
      projectId: operation.projectId,
    });
    if (!preflight) {
      return {
        conflict: await this.openConflict(
          operation,
          base,
          desired,
          this.snapshot(null as unknown as T, operation.entityId),
          "写入前远端记录已删除",
        ),
      };
    }
    const preflightSnapshot = this.snapshot(preflight, operation.entityId);
    if (preflightSnapshot.stamp.hash !== expectedRemote.stamp.hash) {
      return {
        conflict: await this.openConflict(
          operation,
          base,
          desired,
          preflightSnapshot,
          "写入前远端再次变化",
        ),
      };
    }
    this.dependencies.validateWrite?.(desired.value, preflight);
    await this.dependencies.adapter.update(operation.entityId, desired.value, {
      projectId: operation.projectId,
      writeFields: operation.writeFields,
    });
    const verificationProjectId = projectIdOf(desired.value) ?? operation.projectId;
    const verified = await this.dependencies.adapter.get(operation.entityId, {
      projectId: verificationProjectId,
    });
    if (!verified) throw new Error("写入后验证失败：远端记录不可读");
    if (!equivalentForVerification(desired.value, verified)) {
      return {
        conflict: await this.openConflict(
          operation,
          base,
          desired,
          this.snapshot(verified, operation.entityId),
          "写入后服务器结果与本地提交不一致",
        ),
      };
    }
    const snapshot = this.snapshot(verified, operation.entityId);
    await this.dependencies.snapshots.saveBase(snapshot);
    await this.dependencies.snapshots.saveLocal(snapshot);
    return { snapshot };
  }

  private async writeConflictResolution(
    conflict: SyncConflict<T>,
    freshRemote: T | null,
    merged: T | null,
    context?: { projectId?: string },
  ): Promise<
    | { snapshot: EntitySnapshot<T> }
    | { outcome: "remote-changed"; conflict: SyncConflict<T> }
  > {
    if (merged === null) {
      if (freshRemote !== null) {
        await this.dependencies.adapter.delete(conflict.entityId, context);
      }
      const verified = await this.dependencies.adapter.get(conflict.entityId, context);
      if (verified !== null) throw new Error("删除合并后验证失败：远端记录仍然存在");
      return {
        snapshot: this.snapshot(null as unknown as T, conflict.entityId),
      };
    }

    if (freshRemote === null) {
      this.dependencies.validateWrite?.(merged, null);
      const created = await this.dependencies.adapter.create(merged);
      const createdId = created.id || conflict.entityId;
      let verified: T | null;
      try {
        verified = await this.dependencies.adapter.get(createdId, {
          projectId: (created as T & { projectId?: string }).projectId ?? context?.projectId,
        });
      } catch (error) {
        throw unknownRemoteOutcome(
          `远端重建已返回结果，但复读失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!verified || !equivalentForVerification(merged, verified, true)) {
        throw unknownRemoteOutcome("远端重建结果无法通过复读验证，必须人工核对");
      }
      return { snapshot: this.snapshot(verified, createdId) };
    }

    if (!equivalentForVerification(merged, freshRemote)) {
      this.dependencies.validateWrite?.(merged, freshRemote);
      await this.dependencies.adapter.update(conflict.entityId, merged, {
        ...context,
        writeFields: [...new Set(conflict.fields
          .filter((field) => field.choice === "local" || field.choice === "custom")
          .map((field) => adapterWriteField(field.path)))],
      });
    }
    const verified = await this.dependencies.adapter.get(conflict.entityId, {
      projectId: projectIdOf(merged) ?? context?.projectId,
    });
    if (!verified) throw new Error("合并写入后无法读取远端记录");
    const verifiedSnapshot = this.snapshot(verified, conflict.entityId);
    if (!equivalentForVerification(merged, verified)) {
      const refreshed = this.rebaseConflict(conflict, verifiedSnapshot);
      refreshed.status = "open";
      await this.dependencies.conflicts.save(refreshed);
      return { outcome: "remote-changed", conflict: refreshed };
    }
    return { snapshot: verifiedSnapshot };
  }

  private async openConflict(
    operation: SyncQueueOperation<T>,
    base: EntitySnapshot<T>,
    local: EntitySnapshot<T>,
    remote: EntitySnapshot<T>,
    reason: string,
  ): Promise<SyncConflict<T>> {
    const timestamp = this.now().toISOString();
    const conflict: SyncConflict<T> = {
      id: `conflict-${stableHash([
        operation.kind,
        operation.entityId,
        base.stamp.hash,
        remote.stamp.hash,
      ])}`,
      kind: operation.kind,
      entityId: operation.entityId,
      title: titleOf(local.value) || titleOf(remote.value) || reason,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "open",
      base,
      local,
      remote,
      fields: buildConflictFields(base.value, local.value, remote.value),
      remoteRecheckCount: 0,
      sourceDeviceId: this.dependencies.deviceId,
    };
    await this.dependencies.conflicts.save(conflict);
    return conflict;
  }

  private rebaseConflict(
    conflict: SyncConflict<T>,
    remote: EntitySnapshot<T>,
  ): SyncConflict<T> {
    const fields = buildConflictFields(conflict.base.value, conflict.local.value, remote.value);
    for (const field of fields) {
      const previous = conflict.fields.find((candidate) => candidate.path === field.path);
      if (!previous?.choice) continue;
      if (deepEqual(previous.remoteValue, field.remoteValue)) {
        field.choice = previous.choice;
        field.customValue = cloneValue(previous.customValue);
      }
    }
    return {
      ...cloneValue(conflict),
      updatedAt: this.now().toISOString(),
      status: "open",
      remote,
      fields,
      remoteRecheckCount: conflict.remoteRecheckCount + 1,
    };
  }

  private snapshot(value: T, entityId: string): EntitySnapshot<T> {
    const withMetadata = value as T & { etag?: string; modifiedTime?: string };
    return createSnapshot(this.dependencies.adapter.kind, entityId, value, {
      etag: withMetadata?.etag,
      modifiedAt: withMetadata?.modifiedTime,
      capturedAt: this.now().toISOString(),
    });
  }

  private emptySnapshot(kind: EntityKind, entityId: string): EntitySnapshot<T> {
    return createSnapshot(kind, entityId, {} as T, { capturedAt: this.now().toISOString() });
  }

  private auditEntry(
    conflict: SyncConflict<T>,
    remoteAfter: EntitySnapshot<T>,
  ): ResolutionAuditEntry {
    return {
      id: crypto.randomUUID(),
      conflictId: conflict.id,
      entityId: conflict.entityId,
      kind: conflict.kind,
      resolvedAt: this.now().toISOString(),
      sourceDeviceId: this.dependencies.deviceId,
      choices: Object.fromEntries(
        conflict.fields.map((field) => {
          const choice = field.choice ?? field.suggestedChoice ?? "local";
          const value =
            choice === "custom"
              ? field.customValue
              : choice === "remote"
                ? field.remoteValue
                : field.localValue;
          return [field.path, { choice, valueHash: stableHash(value) }];
        }),
      ),
      remoteBeforeHash: conflict.remote.stamp.hash,
      remoteAfterHash: remoteAfter.stamp.hash,
    };
  }
}

/** 适配器只接受根字段；嵌套检查项等路径的写意图归并为其原子根集合。 */
function adapterWriteField(path: string): string {
  return path.split(/[.[\]]/, 1)[0] || path;
}

function unknownRemoteOutcome(message: string): {
  category: "unknown-outcome";
  message: string;
  remoteOutcomeUnknown: true;
} {
  return {
    category: "unknown-outcome",
    message,
    remoteOutcomeUnknown: true,
  };
}

function titleOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return String(record.title ?? record.name ?? record.note ?? "");
}

function equivalentForVerification(
  expected: unknown,
  actual: unknown,
  ignoreGeneratedId = false,
): boolean {
  if (deepEqual(expected, actual)) return true;
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") {
    return false;
  }
  const ignored = new Set([
    ...DIDA_TASK_REMOTE_METADATA_FIELDS,
    "createdTime",
    // 本阶段 status/completedTime 由滴答 App 管理；普通冲突只写用户选择的
    // 业务字段，写后快照必须采纳远端状态，不能因旧 merged 值反复开冲突。
    "status",
    "completedTime",
  ]);
  if (ignoreGeneratedId) ignored.add("id");
  if (ignoreGeneratedId) {
    return Object.entries(expected as Record<string, unknown>)
      .filter(([key, value]) => !ignored.has(key) && value !== undefined)
      .every(([key, value]) => deepEqual(value, (actual as Record<string, unknown>)[key]));
  }
  const withoutServerMetadata = (value: unknown): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([key]) => !ignored.has(key)),
    );
  return deepEqual(
    withoutServerMetadata(expected),
    withoutServerMetadata(actual),
  );
}

function projectIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const projectId = (value as Record<string, unknown>).projectId;
  return typeof projectId === "string" ? projectId : undefined;
}
