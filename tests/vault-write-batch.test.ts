import { describe, expect, it } from "vitest";
import { writeBatchWithRollback } from "../src/services/vault-write-batch";

interface Revision {
  path: string;
  content: string;
  version: number;
}

describe("vault write batch", () => {
  it("rolls back every earlier write when a later compare-and-swap fails", async () => {
    const contents = new Map([
      ["A.md", "A0"],
      ["B.md", "B0"],
    ]);
    const versions = new Map([
      ["A.md", 0],
      ["B.md", 0],
    ]);
    const write = async (revision: Revision, content: string): Promise<Revision> => {
      if (revision.path === "B.md" && content === "B1") {
        versions.set("B.md", 1);
      }
      if (versions.get(revision.path) !== revision.version) {
        throw new Error(`CAS failed: ${revision.path}`);
      }
      const nextVersion = revision.version + 1;
      versions.set(revision.path, nextVersion);
      contents.set(revision.path, content);
      return { path: revision.path, content, version: nextVersion };
    };

    await expect(writeBatchWithRollback([
      { revision: { path: "A.md", content: "A0", version: 0 }, content: "A1" },
      { revision: { path: "B.md", content: "B0", version: 0 }, content: "B1" },
    ], write)).rejects.toThrow(/已回滚/);

    expect(contents.get("A.md")).toBe("A0");
    expect(contents.get("B.md")).toBe("B0");
  });
});
