import { normalizePath, TFile, type Vault } from "obsidian";
import { stableHash } from "../domain/stable";

export interface VaultRevision {
  path: string;
  hash: string;
  content: string;
}

export class VaultWriteConflictError extends Error {
  constructor(
    public readonly path: string,
    public readonly expectedHash: string,
    public readonly actualHash: string,
  ) {
    super(`文件在写入前发生变化：${path}`);
    this.name = "VaultWriteConflictError";
  }
}

export class HelixVaultRepository {
  constructor(private readonly vault: Vault) {}

  async read(path: string): Promise<VaultRevision | null> {
    const normalized = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) return null;
    const content = await this.vault.read(file);
    return { path: normalized, content, hash: stableHash(content) };
  }

  async create(
    path: string,
    content: string,
    beforeWrite?: () => void,
  ): Promise<VaultRevision> {
    const normalized = normalizePath(path);
    if (this.vault.getAbstractFileByPath(normalized)) {
      throw new Error(`目标已经存在：${normalized}`);
    }
    await this.ensureParent(normalized);
    beforeWrite?.();
    await this.vault.create(normalized, content);
    return { path: normalized, content, hash: stableHash(content) };
  }

  async compareAndWrite(
    revision: VaultRevision,
    nextContent: string,
    beforeWrite?: () => void,
  ): Promise<VaultRevision> {
    const current = await this.read(revision.path);
    if (!current) throw new Error(`目标已经删除：${revision.path}`);
    if (current.hash !== revision.hash) {
      throw new VaultWriteConflictError(revision.path, revision.hash, current.hash);
    }
    const file = this.vault.getAbstractFileByPath(revision.path);
    if (!(file instanceof TFile)) throw new Error(`目标不是文件：${revision.path}`);
    beforeWrite?.();
    await this.vault.modify(file, nextContent);
    return {
      path: revision.path,
      content: nextContent,
      hash: stableHash(nextContent),
    };
  }

  private async ensureParent(path: string): Promise<void> {
    const segments = path.split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.vault.getAbstractFileByPath(current)) {
        await this.vault.createFolder(current);
      }
    }
  }
}
