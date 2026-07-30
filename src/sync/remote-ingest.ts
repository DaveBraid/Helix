import type { EntityKind, EntitySnapshot } from "../domain/entities";
import { stableHash } from "../domain/stable";
import type { HelixPersistedData } from "../storage/model";
import { createSnapshot } from "./snapshots";
import { buildConflictFields } from "./three-way-merge";
import type { SyncConflict } from "./types";

export interface RemoteRecord {
  id?: string;
  projectId?: string;
}

export function ingestRemoteRecords<T extends RemoteRecord>(
  data: HelixPersistedData,
  kind: Extract<EntityKind, "task" | "project">,
  records: T[],
  options: {
    capturedAt: string;
    coveredEntityIds?: Set<string>;
  },
): void {
  const remoteIds = new Set<string>();
  for (const record of records) {
    if (!record.id) continue;
    remoteIds.add(record.id);
    const key = `${kind}:${record.id}`;
    const metadata = record as RemoteRecord & { etag?: string; modifiedTime?: string };
    const remote = createSnapshot(kind, record.id, record, {
      capturedAt: options.capturedAt,
      etag: typeof metadata.etag === "string" ? metadata.etag : undefined,
      modifiedAt: typeof metadata.modifiedTime === "string" ? metadata.modifiedTime : undefined,
    });
    const base = data.baseSnapshots[key] as EntitySnapshot<T> | undefined;
    const local = data.localSnapshots[key] as EntitySnapshot<T> | undefined;
    if (!base || !local) {
      data.baseSnapshots[key] = remote;
      data.localSnapshots[key] = remote;
      continue;
    }
    const localChanged = local.stamp.hash !== base.stamp.hash;
    const remoteChanged = remote.stamp.hash !== base.stamp.hash;
    if (!localChanged) {
      data.baseSnapshots[key] = remote;
      data.localSnapshots[key] = remote;
    } else if (remoteChanged && local.stamp.hash !== remote.stamp.hash) {
      upsertPullConflict(data, kind, record.id, base, local, remote, options.capturedAt);
    }
  }

  if (!options.coveredEntityIds) return;
  for (const key of Object.keys(data.baseSnapshots)) {
    if (!key.startsWith(`${kind}:`)) continue;
    const entityId = key.slice(kind.length + 1);
    if (!options.coveredEntityIds.has(entityId) || remoteIds.has(entityId)) continue;
    const base = data.baseSnapshots[key] as EntitySnapshot<T>;
    const local = data.localSnapshots[key] as EntitySnapshot<T> | undefined;
    if (!local || local.stamp.hash === base.stamp.hash) {
      delete data.baseSnapshots[key];
      delete data.localSnapshots[key];
      continue;
    }
    const remote = createSnapshot(
      kind,
      entityId,
      null as unknown as T,
      { capturedAt: options.capturedAt },
    );
    upsertPullConflict(data, kind, entityId, base, local, remote, options.capturedAt);
  }
}

function upsertPullConflict<T>(
  data: HelixPersistedData,
  kind: Extract<EntityKind, "task" | "project">,
  entityId: string,
  base: EntitySnapshot<T>,
  local: EntitySnapshot<T>,
  remote: EntitySnapshot<T>,
  now: string,
): void {
  const existing = data.conflicts.find(
    (conflict) => conflict.kind === kind && conflict.entityId === entityId,
  );
  if (existing) return;
  const fields = buildConflictFields(base.value, local.value, remote.value);
  const conflict: SyncConflict<T> = {
    id: `conflict-${stableHash([kind, entityId, base.stamp.hash, remote.stamp.hash])}`,
    kind,
    entityId,
    title: titleOf(local.value) || titleOf(remote.value) || "远端删除",
    createdAt: now,
    updatedAt: now,
    status: "open",
    base,
    local,
    remote,
    fields,
    remoteRecheckCount: 0,
    sourceDeviceId: data.deviceId,
  };
  data.conflicts.push(conflict);
}

function titleOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return String(record.title ?? record.name ?? "");
}
