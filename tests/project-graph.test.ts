import { describe, expect, it } from "vitest";
import {
  affectedWeakComponent,
  collapsedClosedComponents,
  normalizeProjectGraph,
  planDeletionBridges,
  planProjectGraphLayout,
  projectedGraphIsAcyclic,
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

  it("does not contract completed stages across an active path into a visual cycle", () => {
    expect(collapsedClosedComponents(
      ["a", "b", "c"],
      new Set(["a", "c"]),
      [edge("ab", "a", "b"), edge("bc", "b", "c")],
    )).toEqual([]);
  });

  it("detects a visual cycle introduced by contracting a closed diamond shortcut", () => {
    const edges = [
      edge("a-b", "a", "b"),
      edge("a-x", "a", "x"),
      edge("x-b", "x", "b"),
    ];
    expect(projectedGraphIsAcyclic(
      ["a", "x", "b"],
      edges,
      new Map([["a", "a"], ["b", "a"]]),
    )).toBe(false);
    expect(projectedGraphIsAcyclic(
      ["a", "x", "b"],
      edges,
      new Map(),
    )).toBe(true);
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

  it("shifts only scoped stages away from fixed project cards", () => {
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
    const movingStage = layout.stages.find((stage) => stage.id === "moving-stage")!;
    expect(movingStage.y).toBeGreaterThan(128);
    expect(layout.projects.find((project) => project.id === "moving"))
      .toEqual({ id: "moving", x: 520, y: 0 });
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

  it("treats a fixed project container as one occupied unit", () => {
    const layout = planProjectGraphLayout(
      [{ id: "fixed", x: 0, y: 0 }, { id: "moving", x: 0, y: 0 }],
      [
        { id: "fixed-top", projectId: "fixed", sequence: 1, x: 408, y: 0 },
        { id: "fixed-bottom", projectId: "fixed", sequence: 2, x: 408, y: 600 },
        { id: "moving", projectId: "moving", sequence: 1, x: 408, y: 260 },
      ],
      [],
      new Set(["moving"]),
    );
    expect(layout.stages.find((stage) => stage.id === "moving")!.y)
      .toBeGreaterThan(728);
  });

  it("uses the explicit project order for full-layout lanes", () => {
    const layout = planProjectGraphLayout(
      [
        { id: "first", x: 0, y: 90_000 },
        { id: "second", x: 0, y: -90_000 },
      ],
      [
        { id: "first-stage", projectId: "first", sequence: 1, x: 200, y: 500 },
        { id: "second-stage", projectId: "second", sequence: 1, x: 200, y: 0 },
      ],
      [],
    );
    expect(layout.stages.find((stage) => stage.id === "first-stage")!.y)
      .toBeLessThan(layout.stages.find((stage) => stage.id === "second-stage")!.y);
  });

  it("keeps explicit project order when a scoped project grows", () => {
    const layout = planProjectGraphLayout(
      [
        { id: "first", x: 0, y: 900 },
        { id: "second", x: 0, y: 0 },
      ],
      [
        { id: "first-a", projectId: "first", sequence: 1, x: 408, y: 900 },
        { id: "first-b", projectId: "first", sequence: 2, x: 816, y: 900 },
        { id: "second-a", projectId: "second", sequence: 1, x: 408, y: 0 },
      ],
      [edge("first-edge", "first-a", "first-b")],
      new Set(["first-a", "first-b"]),
    );
    const firstTop = Math.min(...layout.stages
      .filter((stage) => stage.projectId === "first")
      .map((stage) => stage.y));
    const secondTop = Math.min(...layout.stages
      .filter((stage) => stage.projectId === "second")
      .map((stage) => stage.y));
    expect(secondTop).toBeGreaterThan(firstTop);
  });

  it("sizes project lanes by the busiest depth row instead of total stage count", () => {
    const layout = planProjectGraphLayout(
      [
        { id: "wide", x: 0, y: 0 },
        { id: "next", x: 0, y: 2_000 },
      ],
      [
        { id: "a", projectId: "wide", sequence: 1, x: 0, y: 0 },
        { id: "b", projectId: "wide", sequence: 2, x: 0, y: 1 },
        { id: "c", projectId: "wide", sequence: 3, x: 0, y: 2 },
        { id: "d", projectId: "wide", sequence: 4, x: 0, y: 3 },
        { id: "e", projectId: "wide", sequence: 5, x: 0, y: 4 },
        { id: "f", projectId: "wide", sequence: 6, x: 0, y: 5 },
        { id: "g", projectId: "next", sequence: 1, x: 0, y: 2_000 },
      ],
      [
        edge("ad", "a", "d"),
        edge("be", "b", "e"),
        edge("cf", "c", "f"),
      ],
    );
    expect(layout.stages.find((stage) => stage.id === "g")?.y).toBe(672);
  });

  it("keeps a disconnected component in the same project byte-for-byte still", () => {
    const layout = planProjectGraphLayout(
      [
        { id: "project", x: 91, y: 73 },
      ],
      [
        { id: "a", projectId: "project", sequence: 1, x: 40, y: 30 },
        { id: "b", projectId: "project", sequence: 2, x: 80, y: 60 },
        { id: "c", projectId: "project", sequence: 3, x: 1_200, y: 900 },
        { id: "d", projectId: "project", sequence: 4, x: 1_600, y: 930 },
      ],
      [edge("ab", "a", "b"), edge("cd", "c", "d")],
      new Set(["a", "b"]),
    );
    expect(layout.stages.find((stage) => stage.id === "c")).toEqual({
      id: "c",
      projectId: "project",
      sequence: 3,
      x: 1_200,
      y: 900,
    });
    expect(layout.stages.find((stage) => stage.id === "d")).toEqual({
      id: "d",
      projectId: "project",
      sequence: 4,
      x: 1_600,
      y: 930,
    });
    expect(layout.projects[0]).toEqual({ id: "project", x: 91, y: 73 });
    expect(layout.stages.find((stage) => stage.id === "b")?.x)
      .toBeGreaterThan(layout.stages.find((stage) => stage.id === "a")!.x);
  });
});

function edge(id: string, fromCycleId: string, toCycleId: string) {
  return { id, fromCycleId, toCycleId };
}
