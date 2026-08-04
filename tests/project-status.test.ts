import { describe, expect, it } from "vitest";
import {
  isProjectStatus,
  isStageStatus,
  projectStatusFromFrontmatter,
  stageStatusFromFrontmatter,
} from "../src/domain/project-status";
import {
  nextBranchStageCodes,
  nextMajorStageCode,
  nextUnusedMajorStageCode,
  parseStageCode,
} from "../src/domain/stage-numbering";

describe("项目与阶段状态", () => {
  it("兼容旧值但不把未知值静默归一", () => {
    expect(projectStatusFromFrontmatter("archived")).toBe("terminated");
    expect(stageStatusFromFrontmatter("planned")).toBe("idea");
    expect(stageStatusFromFrontmatter("closed")).toBe("completed");
    expect(projectStatusFromFrontmatter("unknown")).toBeNull();
    expect(stageStatusFromFrontmatter("unknown")).toBeNull();
    expect(isProjectStatus("terminated")).toBe(true);
    expect(isProjectStatus("archived")).toBe(false);
    expect(isStageStatus("completed")).toBe(true);
    expect(isStageStatus("closed")).toBe(false);
  });
});

describe("阶段展示编号", () => {
  it("覆盖继承、首个分支、追加分支与删除后不复用", () => {
    expect(nextMajorStageCode([{ sequence: 1, code: "1" }])).toBe("2");
    expect(nextBranchStageCodes({ sequence: 1, code: "1" }, [], 2))
      .toEqual(["2.1", "2.2"]);
    expect(nextBranchStageCodes(
      { sequence: 1, code: "1" },
      [{ sequence: 2, code: "2.1" }, { sequence: 3, code: "2.2" }],
      1,
    )).toEqual(["2.3"]);
    expect(nextBranchStageCodes(
      { sequence: 1, code: "1" },
      [{ sequence: 2, code: "2.1" }],
      1,
      3,
    )).toEqual(["2.3"]);
    expect(nextMajorStageCode([{ sequence: 1, code: "1" }, { sequence: 2, code: "2.2" }]))
      .toBe("3");
    expect(nextUnusedMajorStageCode([{ sequence: 3, code: "3.1" }], 3)).toBe("4");
    expect(parseStageCode("2.1")).toEqual({ major: 2, branch: 1 });
    expect(parseStageCode("2.1.1")).toBeNull();
  });
});
