import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  HelixVaultRepository,
  VaultDeletionClaimError,
  VaultWriteConflictError,
} from "../src/storage/vault-repository";

describe("HelixVaultRepository", () => {
  it("performs the revision check inside Vault.process", async () => {
    const file = new TFile();
    let content = "初始内容";
    let processCalls = 0;
    const repository = new HelixVaultRepository({
      getAbstractFileByPath: () => file,
      read: async () => content,
      process: async (_file: TFile, update: (current: string) => string) => {
        processCalls += 1;
        content = update(content);
        return content;
      },
    } as never);

    const revision = await repository.read("Helix/Projects/Alpha/Stage-02.md");
    content = "原生编辑器并发修改";

    await expect(repository.compareAndWrite(
      revision!,
      "Helix 修改",
    )).rejects.toMatchObject({
      name: "VaultWriteConflictError",
    } satisfies Partial<VaultWriteConflictError>);
    expect(processCalls).toBe(1);
    expect(content).toBe("原生编辑器并发修改");
  });

  it("returns the exact content accepted by Vault.process", async () => {
    const file = new TFile();
    let content = "初始内容";
    const repository = new HelixVaultRepository({
      getAbstractFileByPath: () => file,
      read: async () => content,
      process: async (_file: TFile, update: (current: string) => string) => {
        content = `${update(content)}\n`;
        return content;
      },
    } as never);
    const revision = await repository.read("Helix/Projects/Alpha/Stage-02.md");
    const written = await repository.compareAndWrite(revision!, "下一版");

    expect(written.content).toBe("下一版\n");
    expect(written.hash).not.toBe(revision!.hash);
  });

  it("moves unchanged files to the vault-local trash after the write fence", async () => {
    const file = new TFile();
    let content = "阶段内容";
    let systemTrash: boolean | undefined;
    let fenced = false;
    let currentPath = "Helix/Projects/Alpha/Stage-02.md";
    const repository = new HelixVaultRepository({
      getAbstractFileByPath: (path: string) => path === currentPath ? file : null,
      read: async () => content,
      rename: async (_file: TFile, path: string) => {
        currentPath = path;
      },
      trash: async (_file: TFile, system: boolean) => {
        expect(fenced).toBe(true);
        systemTrash = system;
        content = "";
      },
    } as never);
    const revision = await repository.read("Helix/Projects/Alpha/Stage-02.md");
    expect(revision).not.toBeNull();
    await repository.trashIfUnchanged(revision!, () => {
      fenced = true;
    });
    expect(systemTrash).toBe(false);
  });

  it("restores a claimed file when its content changed before deletion", async () => {
    const file = new TFile();
    const originalPath = "Helix/Projects/Alpha/Stage-02.md";
    let currentPath = originalPath;
    let content = "阶段内容";
    let trashed = false;
    const repository = new HelixVaultRepository({
      getAbstractFileByPath: (path: string) => path === currentPath ? file : null,
      read: async () => content,
      rename: async (_file: TFile, path: string) => {
        currentPath = path;
        if (path !== originalPath) content = "并发修改";
      },
      trash: async () => {
        trashed = true;
      },
      adapter: {
        exists: async (path: string) => path === currentPath,
      },
    } as never);
    const revision = await repository.read(originalPath);

    await expect(repository.trashIfUnchanged(revision!)).rejects.toMatchObject({
      name: "VaultWriteConflictError",
    } satisfies Partial<VaultWriteConflictError>);
    expect(currentPath).toBe(originalPath);
    expect(content).toBe("并发修改");
    expect(trashed).toBe(false);
  });

  it("restores the original path when vault trash fails", async () => {
    const file = new TFile();
    const originalPath = "Helix/Projects/Alpha/Stage-02.md";
    let currentPath = originalPath;
    const repository = new HelixVaultRepository({
      getAbstractFileByPath: (path: string) => path === currentPath ? file : null,
      read: async () => "阶段内容",
      rename: async (_file: TFile, path: string) => {
        currentPath = path;
      },
      trash: async () => {
        throw new Error("trash failed");
      },
    } as never);
    const revision = await repository.read(originalPath);

    await expect(repository.trashIfUnchanged(revision!)).rejects.toThrow(
      "trash failed",
    );
    expect(currentPath).toBe(originalPath);
  });

  it("keeps the deterministic claim when the original path is occupied", async () => {
    const file = new TFile();
    const originalPath = "Helix/Projects/Alpha/Stage-02.md";
    const claimPath = `${originalPath}.helix-delete-claim`;
    let currentPath = originalPath;
    let originalOccupied = false;
    const repository = new HelixVaultRepository({
      getAbstractFileByPath: (path: string) => {
        if (path === currentPath) return file;
        if (path === originalPath && originalOccupied) return {} as TFile;
        return null;
      },
      read: async () => "阶段内容",
      rename: async (_file: TFile, path: string) => {
        currentPath = path;
        originalOccupied = true;
      },
      trash: async () => {
        throw new Error("trash failed");
      },
    } as never);
    const revision = await repository.read(originalPath);

    await expect(repository.trashIfUnchanged(revision!)).rejects.toMatchObject({
      name: "VaultDeletionClaimError",
      claimPath,
    } satisfies Partial<VaultDeletionClaimError>);
    expect(currentPath).toBe(claimPath);
  });

  it("uses the same claim protocol for unindexed adapter files", async () => {
    const originalPath = "Helix/.transactions/stage-delete.json";
    const claimPath = `${originalPath}.helix-delete-claim`;
    const files = new Map([[originalPath, "日志"]]);
    const repository = new HelixVaultRepository({
      getAbstractFileByPath: () => null,
      adapter: {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => files.get(path)!,
        rename: async (from: string, to: string) => {
          const content = files.get(from)!;
          files.delete(from);
          files.set(to, to === claimPath ? "并发日志" : content);
        },
        remove: async (path: string) => {
          files.delete(path);
        },
      },
    } as never);
    const revision = await repository.read(originalPath);

    await expect(repository.trashIfUnchanged(revision!)).rejects.toMatchObject({
      name: "VaultWriteConflictError",
    } satisfies Partial<VaultWriteConflictError>);
    expect(files.get(originalPath)).toBe("并发日志");
    expect(files.has(claimPath)).toBe(false);
  });

  it("recovers deterministic deletion claims before transaction recovery", async () => {
    const claimPath =
      "Helix/Projects/Alpha/Stage-02.md.helix-delete-claim";
    const originalPath = "Helix/Projects/Alpha/Stage-02.md";
    const files = new Map([[claimPath, "阶段内容"]]);
    const repository = new HelixVaultRepository({
      getAbstractFileByPath: () => null,
      adapter: {
        exists: async (path: string) =>
          path === "Helix" || path === "Helix/Projects" ||
          path === "Helix/Projects/Alpha" || files.has(path),
        list: async (path: string) => {
          if (path === "Helix") {
            return { files: [], folders: ["Helix/Projects"] };
          }
          if (path === "Helix/Projects") {
            return { files: [], folders: ["Helix/Projects/Alpha"] };
          }
          return { files: [...files.keys()], folders: [] };
        },
        rename: async (from: string, to: string) => {
          const content = files.get(from)!;
          files.delete(from);
          files.set(to, content);
        },
      },
    } as never);

    await expect(repository.recoverDeletionClaims("Helix")).resolves.toEqual([
      originalPath,
    ]);
    expect(files.get(originalPath)).toBe("阶段内容");
    expect(files.has(claimPath)).toBe(false);
  });

  it("treats a missing file as a conflict when deletion requires the original path", async () => {
    const repository = new HelixVaultRepository({
      getAbstractFileByPath: () => null,
    } as never);

    await expect(repository.trashIfUnchanged(
      {
        path: "Helix/Projects/Alpha/Stage-02.md",
        content: "阶段内容",
        hash: "expected",
      },
      undefined,
      { requireExisting: true },
    )).rejects.toMatchObject({
      name: "VaultWriteConflictError",
      actualHash: "<missing>",
    } satisfies Partial<VaultWriteConflictError>);
  });

  it("recovers and removes an unchanged machine journal outside the TFile index", async () => {
    const journalPath = "Helix/.transactions/stage-delete.json";
    const files = new Map([[journalPath, "{\"operation\":\"delete-stage\"}"]]);
    let fenced = false;
    const repository = new HelixVaultRepository({
      getAbstractFileByPath: () => null,
      adapter: {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error("missing");
          return content;
        },
        rename: async (from: string, to: string) => {
          const content = files.get(from)!;
          files.delete(from);
          files.set(to, content);
        },
        remove: async (path: string) => {
          expect(fenced).toBe(true);
          files.delete(path);
        },
      },
    } as never);

    const revision = await repository.read(journalPath);
    expect(revision?.content).toBe("{\"operation\":\"delete-stage\"}");

    await repository.trashIfUnchanged(revision!, () => {
      fenced = true;
    }, { requireExisting: true });

    expect(await repository.read(revision!.path)).toBeNull();
  });
});
