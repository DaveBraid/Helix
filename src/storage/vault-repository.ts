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

export class VaultDeletionClaimError extends Error {
  constructor(
    public readonly originalPath: string,
    public readonly claimPath: string,
    message: string,
  ) {
    super(`${message}；认领文件保留在：${claimPath}`);
    this.name = "VaultDeletionClaimError";
  }
}

export class HelixVaultRepository {
  private static readonly DELETE_CLAIM_SUFFIX = ".helix-delete-claim";

  constructor(private readonly vault: Vault) {}

  async read(path: string): Promise<VaultRevision | null> {
    const normalized = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalized);
    let content: string;
    if (file instanceof TFile) {
      content = await this.vault.read(file);
    } else {
      const adapter = this.vault.adapter;
      if (!adapter || !(await adapter.exists(normalized))) return null;
      content = await adapter.read(normalized);
    }
    return { path: normalized, content, hash: stableHash(content) };
  }

  async create(
    path: string,
    content: string,
    beforeWrite?: () => void,
  ): Promise<VaultRevision> {
    const normalized = normalizePath(path);
    if (
      this.vault.getAbstractFileByPath(normalized) ||
      (this.vault.adapter && await this.vault.adapter.exists(normalized))
    ) {
      throw new Error(`目标已经存在：${normalized}`);
    }
    beforeWrite?.();
    await this.ensureParent(normalized, beforeWrite);
    beforeWrite?.();
    await this.vault.create(normalized, content);
    return { path: normalized, content, hash: stableHash(content) };
  }

  async compareAndWrite(
    revision: VaultRevision,
    nextContent: string,
    beforeWrite?: () => void,
  ): Promise<VaultRevision> {
    const file = this.vault.getAbstractFileByPath(revision.path);
    if (!(file instanceof TFile)) throw new Error(`目标不是文件：${revision.path}`);
    const written = await this.vault.process(file, (currentContent) => {
      const actualHash = stableHash(currentContent);
      if (actualHash !== revision.hash) {
        throw new VaultWriteConflictError(
          revision.path,
          revision.hash,
          actualHash,
        );
      }
      beforeWrite?.();
      return nextContent;
    });
    return {
      path: revision.path,
      content: written,
      hash: stableHash(written),
    };
  }

  async trashIfUnchanged(
    revision: VaultRevision,
    beforeWrite?: () => void,
    options: { requireExisting?: boolean } = {},
  ): Promise<void> {
    const current = await this.read(revision.path);
    if (!current) {
      if (options.requireExisting) {
        throw new VaultWriteConflictError(
          revision.path,
          revision.hash,
          "<missing>",
        );
      }
      return;
    }
    if (current.hash !== revision.hash) {
      throw new VaultWriteConflictError(
        revision.path,
        revision.hash,
        current.hash,
      );
    }
    const claimPath = normalizePath(
      `${revision.path}${HelixVaultRepository.DELETE_CLAIM_SUFFIX}`,
    );
    if (await this.pathExists(claimPath)) {
      throw new VaultDeletionClaimError(
        revision.path,
        claimPath,
        "已有未恢复的删除认领，禁止覆盖",
      );
    }
    const file = this.vault.getAbstractFileByPath(revision.path);
    const adapter = this.vault.adapter;
    if (!(file instanceof TFile) && !adapter) {
      throw new Error(`目标不是文件：${revision.path}`);
    }
    beforeWrite?.();
    if (file instanceof TFile) {
      await this.vault.rename(file, claimPath);
    } else {
      await adapter!.rename(revision.path, claimPath);
    }
    try {
      const claimed = await this.read(claimPath);
      if (!claimed) throw new Error("删除认领后无法读取文件");
      if (claimed.hash !== revision.hash) {
        await this.restoreDeletionClaim(revision.path, claimPath);
        throw new VaultWriteConflictError(
          revision.path,
          revision.hash,
          claimed.hash,
        );
      }
      const claimedFile = this.vault.getAbstractFileByPath(claimPath);
      if (claimedFile instanceof TFile) {
        await this.vault.trash(claimedFile, false);
      } else {
        await adapter!.remove(claimPath);
      }
    } catch (error) {
      if (await this.pathExists(claimPath)) {
        try {
          await this.restoreDeletionClaim(revision.path, claimPath);
        } catch (restoreError) {
          throw new VaultDeletionClaimError(
            revision.path,
            claimPath,
            `删除认领失败且无法恢复原路径：${
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError)
            }`,
          );
        }
      }
      throw error;
    }
  }

  async recoverDeletionClaims(rootPath: string): Promise<string[]> {
    const root = normalizePath(rootPath);
    const claims = await this.findDeletionClaims(root);
    const restored: string[] = [];
    for (const claimPath of claims.sort()) {
      const originalPath = claimPath.slice(
        0,
        -HelixVaultRepository.DELETE_CLAIM_SUFFIX.length,
      );
      await this.restoreDeletionClaim(originalPath, claimPath);
      restored.push(originalPath);
    }
    return restored;
  }

  private async restoreDeletionClaim(
    originalPath: string,
    claimPath: string,
  ): Promise<void> {
    if (await this.pathExists(originalPath)) {
      throw new VaultDeletionClaimError(
        originalPath,
        claimPath,
        "原路径已被其他内容占用，不能自动恢复删除认领",
      );
    }
    const claimedFile = this.vault.getAbstractFileByPath(claimPath);
    if (claimedFile instanceof TFile) {
      await this.vault.rename(claimedFile, originalPath);
      return;
    }
    const adapter = this.vault.adapter;
    if (!adapter || !(await adapter.exists(claimPath))) {
      throw new VaultDeletionClaimError(
        originalPath,
        claimPath,
        "删除认领文件已不存在",
      );
    }
    await adapter.rename(claimPath, originalPath);
  }

  private async findDeletionClaims(rootPath: string): Promise<string[]> {
    const adapter = this.vault.adapter;
    if (!adapter || !(await adapter.exists(rootPath))) return [];
    const claims: string[] = [];
    const visit = async (path: string): Promise<void> => {
      const listed = await adapter.list(path);
      for (const file of listed.files) {
        const normalized = normalizePath(file);
        if (normalized.endsWith(HelixVaultRepository.DELETE_CLAIM_SUFFIX)) {
          claims.push(normalized);
        }
      }
      for (const folder of listed.folders) await visit(normalizePath(folder));
    };
    await visit(rootPath);
    return [...new Set(claims)];
  }

  private async pathExists(path: string): Promise<boolean> {
    return this.vault.getAbstractFileByPath(path) != null ||
      Boolean(this.vault.adapter && await this.vault.adapter.exists(path));
  }

  private async ensureParent(path: string, beforeWrite?: () => void): Promise<void> {
    const segments = path.split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (
        !this.vault.getAbstractFileByPath(current) &&
        !(this.vault.adapter && await this.vault.adapter.exists(current))
      ) {
        beforeWrite?.();
        await this.vault.createFolder(current);
      }
    }
  }
}
