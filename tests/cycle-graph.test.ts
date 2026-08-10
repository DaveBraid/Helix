import { describe, expect, it } from "vitest";
import {
  CYCLE_RELATION_LABELS,
  assertCycleRelationInput,
  cycleRelationKindFromLabel,
  stageCreationIntent,
  validateCycleGraph,
  type CycleRelation,
} from "../src/domain/cycle-graph";

describe("Cycle graph", () => {
  it("presents inheritance as progression while reading legacy labels", () => {
    expect(CYCLE_RELATION_LABELS.inherit).toBe("推进");
    expect(cycleRelationKindFromLabel("推进")).toBe("inherit");
    expect(cycleRelationKindFromLabel("继承")).toBe("inherit");
  });

  it("accepts inherit, branch, merge and cross-project identities in one DAG", () => {
    const relations: CycleRelation[] = [
      { id: "i", kind: "inherit", fromCycleIds: ["a"], toCycleId: "b" },
      { id: "b1", kind: "branch", fromCycleIds: ["b"], toCycleId: "c" },
      { id: "b2", kind: "branch", fromCycleIds: ["b"], toCycleId: "d" },
      { id: "m", kind: "merge", fromCycleIds: ["c", "x"], toCycleId: "e" },
    ];
    expect(() =>
      validateCycleGraph(["a", "b", "c", "d", "x", "e"], relations),
    ).not.toThrow();
  });

  it("requires branch cardinality and merge predecessors", () => {
    expect(() =>
      validateCycleGraph(
        ["a", "b"],
        [{ id: "b", kind: "branch", fromCycleIds: ["a"], toCycleId: "b" }],
      ),
    ).toThrow(/分支只有一个目标/);
    expect(() => assertCycleRelationInput("merge", ["a"])).toThrow(/至少 2 个/);
  });

  it("allows a merge predecessor to continue into a new branch", () => {
    expect(() =>
      validateCycleGraph(
        ["a", "b", "c", "d"],
        [
          { id: "merge", kind: "merge", fromCycleIds: ["a", "b"], toCycleId: "c" },
          { id: "branch", kind: "branch", fromCycleIds: ["a"], toCycleId: "d" },
        ],
      ),
    ).not.toThrow();
  });

  it("derives inheritance, branch conversion and merge from the clicked cards", () => {
    expect(stageCreationIntent(["a"], [])).toEqual({
      relation: "inherit",
      predecessorIds: ["a"],
      convertedInheritanceRelationIds: [],
      convertedInheritanceSourceIds: [],
    });
    expect(stageCreationIntent(
      ["a"],
      [{ id: "ab", kind: "inherit", fromCycleIds: ["a"], toCycleId: "b" }],
    )).toEqual({
      relation: "branch",
      predecessorIds: ["a"],
      convertedInheritanceRelationIds: ["ab"],
      convertedInheritanceSourceIds: ["a"],
    });
    expect(stageCreationIntent(
      ["b", "a", "b"],
      [{ id: "ab", kind: "inherit", fromCycleIds: ["a"], toCycleId: "x" }],
    )).toEqual({
      relation: "merge",
      predecessorIds: ["b", "a"],
      convertedInheritanceRelationIds: ["ab"],
      convertedInheritanceSourceIds: ["a"],
    });
  });

  it("rejects cycles, duplicate edges, mixed incoming groups and unknown endpoints", () => {
    expect(() =>
      validateCycleGraph(
        ["a", "b"],
        [
          { id: "ab", kind: "inherit", fromCycleIds: ["a"], toCycleId: "b" },
          { id: "ba", kind: "inherit", fromCycleIds: ["b"], toCycleId: "a" },
        ],
      ),
    ).toThrow(/形成了环/);
    expect(() =>
      validateCycleGraph(
        ["a", "b"],
        [
          { id: "one", kind: "inherit", fromCycleIds: ["a"], toCycleId: "b" },
          { id: "two", kind: "inherit", fromCycleIds: ["a"], toCycleId: "b" },
        ],
      ),
    ).toThrow(/关系重复/);
    expect(() =>
      validateCycleGraph(
        ["a", "b", "c"],
        [
          { id: "one", kind: "inherit", fromCycleIds: ["a"], toCycleId: "c" },
          { id: "two", kind: "inherit", fromCycleIds: ["b"], toCycleId: "c" },
        ],
      ),
    ).toThrow(/多组入边/);
    expect(() =>
      validateCycleGraph(
        ["a"],
        [{ id: "missing", kind: "inherit", fromCycleIds: ["a"], toCycleId: "x" }],
      ),
    ).toThrow(/不存在的目标/);
  });
});
