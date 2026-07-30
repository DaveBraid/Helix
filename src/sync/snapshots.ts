import type { EntityKind, EntitySnapshot } from "../domain/entities";
import { cloneValue, stableHash } from "../domain/stable";

export function createSnapshot<T>(
  kind: EntityKind,
  entityId: string,
  value: T,
  options: { etag?: string; modifiedAt?: string; capturedAt?: string } = {},
): EntitySnapshot<T> {
  return {
    kind,
    entityId,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    value: cloneValue(value),
    stamp: {
      etag: options.etag,
      modifiedAt: options.modifiedAt,
      hash: stableHash(value),
    },
  };
}

export function snapshotChanged(
  current: EntitySnapshot<unknown>,
  base: EntitySnapshot<unknown>,
): boolean {
  if (current.stamp.etag && base.stamp.etag && current.stamp.etag !== base.stamp.etag) {
    return true;
  }
  return current.stamp.hash !== base.stamp.hash;
}
