import { describe, expect, it } from "vitest";
import {
  assertProjectMappingsUnique,
  assertUniqueDidaProjectMapping,
} from "../src/domain/project-mapping";

describe("one-to-one Dida project mapping", () => {
  it("rejects reuse by another Helix project but permits exact recovery of the same path", () => {
    const existing = [{ path: "Helix/Projects/A/Project.md", didaProjectId: "dida-1" }];
    expect(() =>
      assertUniqueDidaProjectMapping(existing, "dida-1", "Helix/Projects/B/Project.md"),
    ).toThrow(/另一 Helix 项目/);
    expect(() =>
      assertUniqueDidaProjectMapping(existing, "dida-1", "Helix/Projects/A/Project.md"),
    ).not.toThrow();
  });

  it("rejects duplicate Helix IDs and duplicate mappings across the whole vault", () => {
    expect(() => assertProjectMappingsUnique([
      { id: "same", path: "A.md", didaProjectId: "dida-a" },
      { id: "same", path: "B.md", didaProjectId: "dida-b" },
    ])).toThrow(/项目 ID 重复/);
    expect(() => assertProjectMappingsUnique([
      { id: "a", path: "A.md", didaProjectId: "dida-same" },
      { id: "b", path: "B.md", didaProjectId: "dida-same" },
    ])).toThrow(/清单映射重复/);
  });
});
