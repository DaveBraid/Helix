import { describe, expect, it } from "vitest";
import { patchManagedFrontmatter } from "../src/storage/frontmatter";

describe("managed frontmatter patching", () => {
  it("preserves unknown properties, body, and CRLF while only changing helix keys", () => {
    const source = "\uFEFF---\r\nhelix-kind: helix-project\r\nhelix-parents: []\r\nuser-field: keep\r\n---\r\n# 正文\r\n";
    const next = patchManagedFrontmatter(source, {
      "helix-parents": ["parent-a"],
      "helix-updated": "2026-07-30T10:00:00Z",
    });
    expect(next).toContain('helix-parents: ["parent-a"]\r\n');
    expect(next).toContain("user-field: keep\r\n");
    expect(next).toContain("# 正文\r\n");
    expect(next.startsWith("\uFEFF---\r\n")).toBe(true);
    expect(() => patchManagedFrontmatter(source, { status: "closed" })).toThrow(/非 Helix/);
  });

  it("replaces a complete multiline managed YAML value without touching comments or unknown fields", () => {
    const source = "\uFEFF---\r\nhelix-kind: helix-project\r\nhelix-parents:\r\n  - parent-a\r\n  - parent-b\r\n# keep this comment\r\nuser-field:\r\n  nested: keep\r\n---\r\n正文\r\n";
    const next = patchManagedFrontmatter(source, {
      "helix-parents": ["parent-c"],
    });
    expect(next).toContain('helix-parents: ["parent-c"]\r\n# keep this comment');
    expect(next).not.toContain("  - parent-a");
    expect(next).toContain("user-field:\r\n  nested: keep\r\n");
    expect(next.startsWith("\uFEFF---\r\n")).toBe(true);
  });

  it("rejects duplicate managed keys instead of guessing which one to update", () => {
    const source = "---\nhelix-kind: helix-project\nhelix-parents: []\nhelix-parents:\n  - duplicate\n---\n";
    expect(() => patchManagedFrontmatter(source, { "helix-parents": [] })).toThrow(/重复/);
  });
});
