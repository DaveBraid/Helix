import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  HelixVaultRepository,
  VaultWriteConflictError,
} from "../src/storage/vault-repository";

describe("HelixVaultRepository", () => {
  it("moves unchanged files to the vault-local trash after the write fence", async () => {
    const file = new TFile();
    let content = "阶段内容";
    let systemTrash: boolean | undefined;
    let fenced = false;
    const repository = new HelixVaultRepository({
      getAbstractFileByPath: () => file,
      read: async () => content,
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
});
