import type { EntityKind, EntitySnapshot } from "../domain/entities";
import { cloneValue } from "../domain/stable";
import type {
  ConflictRepository,
  ResolutionAuditEntry,
  SnapshotRepository,
  SyncConflict,
} from "../sync/types";
import { hydrateData, type HelixPersistedData } from "./model";
import {
  saveInDataGeneration,
  waitForPriorDataWrites,
  type DataGeneration,
} from "./data-generation";

export interface PluginDataPort {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export class HelixDataStore implements SnapshotRepository, ConflictRepository {
  private data: HelixPersistedData | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly plugin: PluginDataPort,
    private readonly generation?: DataGeneration,
  ) {}

  async load(): Promise<HelixPersistedData> {
    this.assertActive();
    await this.writeChain;
    this.assertActive();
    if (!this.data) {
      if (this.generation) await waitForPriorDataWrites();
      this.assertActive();
      this.data = hydrateData(await this.plugin.loadData());
    }
    return cloneValue(this.data);
  }

  async snapshot(): Promise<HelixPersistedData> {
    return this.load();
  }

  async mutate(mutator: (data: HelixPersistedData) => void): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      this.assertActive();
      if (!this.data) this.data = hydrateData(await this.plugin.loadData());
      if (this.data.recoveryIssues.length > 0) {
        throw new Error("Helix data.json 含损坏结构，当前为只读恢复模式；请先复制诊断摘要并修复数据");
      }
      const next = cloneValue(this.data);
      mutator(next);
      this.assertActive();
      if (this.generation) {
        await saveInDataGeneration(this.generation, () => this.plugin.saveData(next));
      } else {
        await this.plugin.saveData(next);
      }
      this.assertActive();
      this.data = next;
    });
    await this.writeChain;
  }

  async getBase<T>(kind: EntityKind, entityId: string): Promise<EntitySnapshot<T> | null> {
    const data = await this.load();
    return (cloneValue(data.baseSnapshots[keyOf(kind, entityId)]) as EntitySnapshot<T>) ?? null;
  }

  async getLocal<T>(kind: EntityKind, entityId: string): Promise<EntitySnapshot<T> | null> {
    const data = await this.load();
    return (cloneValue(data.localSnapshots[keyOf(kind, entityId)]) as EntitySnapshot<T>) ?? null;
  }

  async saveBase<T>(snapshot: EntitySnapshot<T>): Promise<void> {
    await this.mutate((data) => {
      data.baseSnapshots[keyOf(snapshot.kind, snapshot.entityId)] =
        snapshot as EntitySnapshot<unknown>;
    });
  }

  async saveLocal<T>(snapshot: EntitySnapshot<T>): Promise<void> {
    await this.mutate((data) => {
      data.localSnapshots[keyOf(snapshot.kind, snapshot.entityId)] =
        snapshot as EntitySnapshot<unknown>;
    });
  }

  async removeBase(kind: EntityKind, entityId: string): Promise<void> {
    await this.mutate((data) => {
      delete data.baseSnapshots[keyOf(kind, entityId)];
    });
  }

  async removeLocal(kind: EntityKind, entityId: string): Promise<void> {
    await this.mutate((data) => {
      delete data.localSnapshots[keyOf(kind, entityId)];
    });
  }

  async list(): Promise<SyncConflict[]> {
    return (await this.load()).conflicts;
  }

  async get(conflictId: string): Promise<SyncConflict | null> {
    return (await this.load()).conflicts.find((conflict) => conflict.id === conflictId) ?? null;
  }

  async save(conflict: SyncConflict): Promise<void> {
    await this.mutate((data) => {
      const index = data.conflicts.findIndex((candidate) => candidate.id === conflict.id);
      if (index === -1) data.conflicts.push(conflict);
      else data.conflicts[index] = conflict;
    });
  }

  async remove(conflictId: string): Promise<void> {
    await this.mutate((data) => {
      data.conflicts = data.conflicts.filter((conflict) => conflict.id !== conflictId);
    });
  }

  async appendAudit(entry: ResolutionAuditEntry): Promise<void> {
    await this.mutate((data) => {
      data.resolutionAudit.push(entry);
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Helix 数据存储已卸载，拒绝旧实例继续读写");
  }
}

export function keyOf(kind: EntityKind, entityId: string): string {
  return `${kind}:${entityId}`;
}
