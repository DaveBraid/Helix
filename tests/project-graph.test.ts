import { describe, expect, it } from "vitest";
import {
  affectedWeakComponent,
  collapsedClosedComponents,
  normalizeProjectGraph,
  planDeletionBridges,
  planProjectGraphLayout,
} from "../src/domain/project-graph";

describe("project graph normalization", () => {
  it("derives inherit, branch and merge from the complete physical edge set", () => {
    const graph = normalizeProjectGraph(
      ["a", "b", "c", "d", "e"],
      [
        edge("ab", "a", "b"),
        edge("ac", "a", "c"),
        edge("bd", "b", "d"),
        edge("ed", "e", "d"),
      ],
    );
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ab", kind: "branch" }),
      expect.objectContaining({ id: "ac", kind: "branch" }),
      expect.objectContaining({
        id: "bd",
        kind: "merge",
        mergeGroupId: "helix-merge-d",
      }),
      expect.objectContaining({
        id: "ed",
        kind: "merge",
        mergeGroupId: "helix-merge-d",
      }),
    ]));
  });

  it("rejects self loops, duplicate pairs and cycles", () => {
    expect(() => normalizeProjectGraph(["a"], [edge("aa", "a", "a")]))
      .toThrow(/自身/);
    expect(() => normalizeProjectGraph(
      ["a", "b"],
      [edge("one", "a", "b"), edge("two", "a", "b")],
    )).toThrow(/重复/);
    expect(() => normalizeProjectGraph(
      ["a", "b"],
      [edge("ab", "a", "b"), edge("ba", "b", "a")],
    )).toThrow(/形成环/);
  });

  it("finds only the affected weak component", () => {
    expect([...affectedWeakComponent(
      ["b"],
      [edge("ab", "a", "b"), edge("cd", "c", "d")],
    )].sort()).toEqual(["a", "b"]);
  });

  it("plans 0×N, 1×N and M×N deletion bridges with reuse and cross-project labels", () => {
    const owners = new Map([
      ["a", "p1"],
      ["b", "p1"],
      ["v", "p1"],
      ["x", "p1"],
      ["y", "p2"],
    ]);
    expect(planDeletionBridges(
      "v",
      [edge("vx", "v", "x"), edge("vy", "v", "y")],
      owners,
    )).toEqual([]);
    expect(planDeletionBridges(
      "v",
      [edge("av", "a", "v"), edge("vx", "v", "x"), edge("vy", "v", "y")],
      owners,
    )).toEqual([
      { fromCycleId: "a", toCycleId: "x", existing: false, crossProject: false },
      { fromCycleId: "a", toCycleId: "y", existing: false, crossProject: true },
    ]);
    expect(planDeletionBridges(
      "v",
      [
        edge("av", "a", "v"),
        edge("bv", "b", "v"),
        edge("vx", "v", "x"),
        edge("vy", "v", "y"),
        edge("ax", "a", "x"),
      ],
      owners,
    )).toEqual([
      { fromCycleId: "a", toCycleId: "x", existing: true, crossProject: false },
      { fromCycleId: "a", toCycleId: "y", existing: false, crossProject: true },
      { fromCycleId: "b", toCycleId: "x", existing: false, crossProject: false },
      { fromCycleId: "b", toCycleId: "y", existing: false, crossProject: true },
    ]);
  });

  it("exposes a 25-edge bridge fanout for the service safety threshold", () => {
    const owners = new Map<string, string>();
    const edges = [];
    for (let index = 0; index < 5; index += 1) {
      const predecessor = `p${index}`;
      const successor = `s${index}`;
      owners.set(predecessor, "project");
      owners.set(successor, "project");
      edges.push(edge(`in-${index}`, predecessor, "v"));
      edges.push(edge(`out-${index}`, "v", successor));
    }
    expect(planDeletionBridges("v", edges, owners)).toHaveLength(25);
  });
});

describe("project graph presentation", () => {
  it("folds each closed weak component independently without changing the graph", () => {
    expect(collapsedClosedComponents(
      ["a", "b", "c", "d", "e"],
      new Set(["a", "b", "d", "e"]),
      [edge("ab", "a", "b"), edge("bc", "b", "c"), edge("de", "d", "e")],
    )).toEqual([
      { headId: "a", memberIds: ["a", "b"] },
      { headId: "d", memberIds: ["d", "e"] },
    ]);
  });

  it("produces deterministic layers while leaving nodes outside scope untouched", () => {
    const projects = [
      { id: "p1", x: 99, y: 50 },
      { id: "p2", x: 99, y: 500 },
    ];
    const stages = [
      { id: "a", projectId: "p1", sequence: 1, x: 10, y: 10 },
      { id: "b", projectId: "p1", sequence: 2, x: 20, y: 20 },
      { id: "c", projectId: "p2", sequence: 1, x: 777, y: 888 },
    ];
    const first = planProjectGraphLayout(
      projects,
      stages,
      [edge("ab", "a", "b")],
      new Set(["a", "b"]),
    );
    const second = planProjectGraphLayout(
      projects,
      [...stages].reverse(),
      [edge("ab", "a", "b")],
      new Set(["a", "b"]),
    );
    expect(first).toEqual(second);
    expect(first.stages.find((stage) => stage.id === "c"))
      .toMatchObject({ x: 777, y: 888 });
    expect(first.stages.find((stage) => stage.id === "b")!.x)
      .toBeGreaterThan(first.stages.find((stage) => stage.id === "a")!.x);
  });

  it("shifts a scoped project and stage together away from fixed project cards", () => {
    const layout = planProjectGraphLayout(
      [
        { id: "fixed", x: 0, y: 0 },
        { id: "moving", x: 520, y: 0 },
      ],
      [
        { id: "fixed-stage", projectId: "fixed", sequence: 1, x: 408, y: 0 },
        { id: "moving-stage", projectId: "moving", sequence: 1, x: 520, y: 300 },
      ],
      [],
      new Set(["moving-stage"]),
    );
    const movingProject = layout.projects.find((project) => project.id === "moving")!;
    const movingStage = layout.stages.find((stage) => stage.id === "moving-stage")!;
    expect(movingProject.y).toBe(movingStage.y);
    expect(movingProject.y).toBeGreaterThan(128);
    expect(layout.projects.find((project) => project.id === "fixed"))
      .toEqual({ id: "fixed", x: 0, y: 0 });
    expect(layout.stages.find((stage) => stage.id === "fixed-stage"))
      .toEqual({
        id: "fixed-stage",
        projectId: "fixed",
        sequence: 1,
        x: 408,
        y: 0,
      });
  });
});

function edge(id: string, fromCycleId: string, toCycleId: string) {
  return { id, fromCycleId, toCycleId };
}
