import { describe, expect, it } from "vitest";
import {
  assertExistingInitialCycleIdentity,
  assertExistingProjectIdentity,
} from "../src/domain/project-identity";
import { cycleTemplate, projectTemplate } from "../src/domain/projects";

describe("recoverable project creation identity", () => {
  it("accepts an exact rerun but rejects a sanitized filename collision", () => {
    const content = projectTemplate({
      id: "project-1",
      title: "A/B",
      createdAt: "2026-07-30T00:00:00Z",
      didaProjectId: "dida-1",
    });
    expect(() =>
      assertExistingProjectIdentity(content, { title: "A/B", didaProjectId: "dida-1" }, "Project.md"),
    ).not.toThrow();
    expect(() =>
      assertExistingProjectIdentity(content, { title: "A:B", didaProjectId: "dida-1" }, "Project.md"),
    ).toThrow(/文件名碰撞/);
    expect(() =>
      assertExistingProjectIdentity(content, { title: "A/B", didaProjectId: "dida-2" }, "Project.md"),
    ).toThrow(/不一致/);
  });

  it("only reuses a genuine Cycle 01 for Project", () => {
    const content = cycleTemplate({
      id: "cycle-1",
      projectLink: "[[Project]]",
      sequence: 1,
      startedAt: "2026-07-30T00:00:00Z",
    });
    expect(() => assertExistingInitialCycleIdentity(content, "Cycle-01.md")).not.toThrow();
    expect(() =>
      assertExistingInitialCycleIdentity(content.replace("helix-sequence: 1", "helix-sequence: 2"), "Cycle-01.md"),
    ).toThrow(/身份不一致/);
  });
});
