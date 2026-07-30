import { describe, expect, it } from "vitest";
import type {
  ProjectWorkspaceCanvasNode,
  ProjectWorkspaceSnapshot,
} from "../src/services/project-workspace";
import {
  completedLineageProjection,
  creationSourcesFromSelection,
  lineageCardDragAllowed,
  lineageCameraFrame,
  lineageFocusBehavior,
  lineageFitScale,
  lineageFocusScale,
  lineageConnectionDropTarget,
  lineageClampedZoom,
  lineageCenteredZoomPlan,
  lineageCenteredPointPlan,
  lineageConnectionTargetIds,
  lineageGraphBox,
  lineageGraphEdgeAnchors,
  lineageMovePayload,
  lineageProjectContainerBox,
  lineageRequestedFocusBox,
  lineageEntitiesInSelection,
  lineageLassoSelectionState,
  lineageSelectionBox,
  lineageShouldFocusOnDoubleClick,
  lineageStructuralEntityIds,
  lineageViewportPointerIntent,
  lineageVirtualExpansionPlan,
  lineageVisibleStageIdsByProject,
  lineageZoomLabel,
  projectedLineageRelations,
} from "../src/ui/project-lineage-workbench";

describe("Project Lineage card-plus intent", () => {
  const nodes = [
    node("project", "project", 0, 0),
    node("lower", "cycle", 0, 600),
    node("upper", "cycle", 0, 300),
    node("other", "cycle", 520, 300),
  ];

  it("uses the clicked card as the sole source without a merge selection", () => {
    expect(creationSourcesFromSelection("upper", ["lower"], nodes))
      .toEqual(["upper"]);
    expect(creationSourcesFromSelection("upper", ["project", "upper"], nodes))
      .toEqual(["upper"]);
  });

  it("uses selected stage cards in visual order when plus confirms a merge", () => {
    expect(creationSourcesFromSelection(
      "lower",
      ["project", "lower", "other", "upper"],
      nodes,
    )).toEqual(["upper", "other", "lower"]);
  });

  it("uses current dragged positions instead of stale snapshot coordinates", () => {
    const currentLayout = new Map([
      ["lower", { x: 0, y: 100 }],
      ["upper", { x: 0, y: 700 }],
    ]);
    expect(creationSourcesFromSelection(
      "lower",
      ["lower", "upper"],
      nodes,
      currentLayout,
    )).toEqual(["lower", "upper"]);
  });

  it("uses one compact geometry contract regardless of native Canvas size", () => {
    const compactNative = { ...node("compact", "cycle", 0, 0), width: 120, height: 80 };
    const largeNative = { ...node("large", "cycle", 0, 0), width: 960, height: 720 };
    const point = { x: 40, y: 60 };

    expect(lineageGraphBox(compactNative, point)).toEqual({
      x: 40,
      y: 60,
      width: 248,
      height: 128,
      right: 288,
      bottom: 188,
      centerY: 124,
    });
    expect(lineageGraphBox(largeNative, point))
      .toEqual(lineageGraphBox(compactNative, point));
    expect(lineageGraphEdgeAnchors(
      compactNative,
      point,
      largeNative,
      { x: 500, y: 200 },
    )).toEqual({
      start: { x: 288, y: 124 },
      end: { x: 500, y: 264 },
    });
  });

  it("creates move payloads with coordinates only and preserves native dimensions", () => {
    const canvasNode = { ...node("move", "cycle", 0, 0), width: 960, height: 720 };
    const move = lineageMovePayload(
      canvasNode,
      { x: 300, y: 220 },
      { x: 64, y: 40 },
    );

    expect(move).toEqual({
      nodeId: "move-node",
      x: 236,
      y: 180,
    });
    expect(Object.keys(move).sort()).toEqual(["nodeId", "x", "y"]);
    expect({ width: canvasNode.width, height: canvasNode.height })
      .toEqual({ width: 960, height: 720 });
  });

  it("derives a project background container from stage cards, not the project node", () => {
    const project = node("project", "project", -8_000, -8_000);
    const first = node("first", "cycle", 40, 60);
    const second = node("second", "cycle", 500, 200);
    const layout = new Map([
      ["project", { x: -8_000, y: -8_000 }],
      ["first", { x: 40, y: 60 }],
      ["second", { x: 500, y: 200 }],
    ]);

    expect(lineageProjectContainerBox(
      "project",
      [project, first, second],
      layout,
    )).toEqual({
      x: 12,
      y: 2,
      width: 764,
      height: 354,
      right: 776,
      bottom: 356,
      centerX: 394,
      centerY: 179,
    });
  });

  it("preserves the raw logical center at every edge and extreme low zoom", () => {
    for (const viewport of [
      { scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600 },
      { scrollLeft: 9_200, scrollTop: 0, clientWidth: 800, clientHeight: 600 },
      { scrollLeft: 0, scrollTop: 9_400, clientWidth: 800, clientHeight: 600 },
      { scrollLeft: 9_200, scrollTop: 9_400, clientWidth: 800, clientHeight: 600 },
    ]) {
      const next = lineageCenteredZoomPlan(viewport, 1, 0.0004, 10_000, 10_000);
      const beforeX = (viewport.scrollLeft + viewport.clientWidth / 2);
      const beforeY = (viewport.scrollTop + viewport.clientHeight / 2);
      const afterX = (next.left + viewport.clientWidth / 2) / 0.0004 -
        next.shiftX;
      const afterY = (next.top + viewport.clientHeight / 2) / 0.0004 -
        next.shiftY;
      expect(afterX).toBeCloseTo(beforeX, 6);
      expect(afterY).toBeCloseTo(beforeY, 6);
      expect(next.left).toBeGreaterThanOrEqual(399.999);
      expect(next.top).toBeGreaterThanOrEqual(399.999);
      expect(
        (10_000 + next.shiftX + next.growRightBy) * 0.0004,
      ).toBeGreaterThanOrEqual(next.left + viewport.clientWidth + 399.999);
      expect(
        (10_000 + next.shiftY + next.growBottomBy) * 0.0004,
      ).toBeGreaterThanOrEqual(next.top + viewport.clientHeight + 399.999);
    }
  });

  it("centers a structurally operated node in the viewport", () => {
    expect(lineageCenteredPointPlan(
      { x: 1_400, y: 900 },
      0.5,
      { clientWidth: 800, clientHeight: 600 },
      8_000,
      8_000,
    )).toEqual({
      shiftX: 200,
      shiftY: 500,
      growRightBy: 0,
      growBottomBy: 0,
      left: 400,
      top: 400,
    });
  });

  it("interpolates zoom and logical center in one camera animation", () => {
    const viewport = { clientWidth: 800, clientHeight: 600 };
    expect(lineageCameraFrame(
      { x: 100, y: 200 },
      { x: 900, y: 600 },
      0.5,
      1,
      0,
      viewport,
    )).toEqual({ zoom: 0.5, left: -350, top: -200 });
    expect(lineageCameraFrame(
      { x: 100, y: 200 },
      { x: 900, y: 600 },
      0.5,
      1,
      0.5,
      viewport,
    )).toEqual({ zoom: 0.9375, left: 350, top: 215.625 });
    expect(lineageCameraFrame(
      { x: 100, y: 200 },
      { x: 900, y: 600 },
      0.5,
      1,
      1,
      viewport,
    )).toEqual({ zoom: 1, left: 500, top: 300 });
  });

  it("indexes a thousand visible stages once by project", () => {
    const nodes = Array.from({ length: 1_000 }, (_, index) => ({
      ...node(`stage-${index}`, "cycle", index * 10, index * 5),
      projectId: `project-${index % 50}`,
    }));
    const hidden = new Map([["stage-999", "stage-949"]]);
    const index = lineageVisibleStageIdsByProject(nodes, hidden);
    expect(index.size).toBe(50);
    expect([...index.values()].reduce((sum, ids) => sum + ids.length, 0)).toBe(999);
    expect(index.get("project-49")).not.toContain("stage-999");
  });

  it("normalizes reverse lasso drags and selects every intersecting card", () => {
    const nodes = [
      node("first", "cycle", 20, 30),
      node("edge", "cycle", 300, 30),
      node("outside", "cycle", 580, 30),
    ];
    const layout = new Map(nodes.map((item) => [
      item.entityId,
      { x: item.x, y: item.y },
    ]));
    const selection = lineageSelectionBox(
      { x: 300, y: 158 },
      { x: 10, y: 20 },
    );

    expect(selection).toEqual({ x: 10, y: 20, right: 300, bottom: 158 });
    expect(lineageEntitiesInSelection(nodes, layout, selection))
      .toEqual(["first", "edge"]);
  });

  it("applies replace, Shift-add, blank-click and canceled lasso selection semantics", () => {
    expect(lineageLassoSelectionState(
      ["before"],
      "relation-before",
      ["hit-a", "hit-b"],
      "replace",
    )).toEqual({
      entityIds: ["hit-a", "hit-b"],
      relationId: null,
    });
    expect(lineageLassoSelectionState(
      ["before"],
      "relation-before",
      ["hit-a", "before"],
      "add",
    )).toEqual({
      entityIds: ["before", "hit-a"],
      relationId: null,
    });
    expect(lineageLassoSelectionState(
      ["before"],
      "relation-before",
      [],
      "clear",
    )).toEqual({
      entityIds: [],
      relationId: null,
    });
    expect(lineageLassoSelectionState(
      ["before"],
      "relation-before",
      ["ignored"],
      "cancel",
    )).toEqual({
      entityIds: ["before"],
      relationId: "relation-before",
    });
  });

  it("gives Space-left and middle-button pan priority on card surfaces", () => {
    expect(lineageViewportPointerIntent(0, true, "card")).toBe("pan");
    expect(lineageViewportPointerIntent(1, false, "card")).toBe("pan");
    expect(lineageViewportPointerIntent(0, false, "card")).toBe("defer");
    expect(lineageViewportPointerIntent(0, false, "blank")).toBe("lasso");
    expect(lineageViewportPointerIntent(0, true, "button")).toBe("defer");
    expect(lineageViewportPointerIntent(1, false, "edge")).toBe("defer");
    expect(lineageViewportPointerIntent(0, false, "project-header")).toBe("defer");
    expect(lineageCardDragAllowed(0, false, false, false)).toBe(true);
    expect(lineageCardDragAllowed(0, true, false, false)).toBe(false);
    expect(lineageCardDragAllowed(1, false, false, false)).toBe(false);
    expect(lineageCardDragAllowed(0, false, true, false)).toBe(false);
    expect(lineageCardDragAllowed(0, false, false, true)).toBe(false);
  });

  it("keeps lasso hit testing linear for a large graph", () => {
    const nodes = Array.from({ length: 20_000 }, (_, index) =>
      node(`stage-${index}`, "cycle", (index % 200) * 280, Math.floor(index / 200) * 160));
    const layout = new Map(nodes.map((item) => [
      item.entityId,
      { x: item.x, y: item.y },
    ]));
    const selection = lineageSelectionBox(
      { x: 0, y: 0 },
      { x: 5_000, y: 2_000 },
    );
    const startedAt = performance.now();
    const selected = lineageEntitiesInSelection(nodes, layout, selection);
    const elapsed = performance.now() - startedAt;

    expect(selected).toHaveLength(234);
    expect(elapsed).toBeLessThan(250);
  });

  it("keeps negative Canvas coordinates when the virtual origin expands left or up", () => {
    expect(lineageMovePayload(
      node("negative", "cycle", 0, 0),
      { x: 16, y: 24 },
      { x: 2400, y: 1800 },
    )).toEqual({
      nodeId: "negative-node",
      x: -2384,
      y: -1776,
    });
  });

  it("fits graphs far larger than four viewports without the normal zoom floor", () => {
    expect(lineageFitScale(800, 600, 10_000, 8_000)).toBeCloseTo(0.069, 3);
    expect(lineageFitScale(800, 600, 2_000_000, 2_000_000))
      .toBeCloseTo(0.000276, 6);
    expect(lineageZoomLabel(0.0004)).toBe("<0.1%");
    expect(lineageZoomLabel(0.00276)).toBe("0.28%");
    expect(lineageZoomLabel(0.4)).toBe("40%");
    expect(lineageClampedZoom(0.0004 / 1.2)).toBeLessThan(0.0004);
    expect(lineageClampedZoom(0.0004 * 1.2)).toBeCloseTo(0.00048);
    expect(lineageClampedZoom(0.0004 * Math.exp(0.2))).toBeLessThan(0.001);
  });

  it("lets explicit project and card focus zoom in as well as out", () => {
    expect(lineageFocusScale(800, 600, 248, 128)).toBe(1.2);
    expect(lineageFocusScale(800, 600, 1_600, 900)).toBeCloseTo(0.47, 2);
  });

  it("turns the reduced-motion preference into an immediate focus jump", () => {
    expect(lineageFocusBehavior(false)).toBe("smooth");
    expect(lineageFocusBehavior(true)).toBe("auto");
  });

  it("ignores card double-clicks that originate inside an action button", () => {
    const cardBody = { closest: () => null } as unknown as EventTarget;
    const cardButton = (
      { closest: (selector: string) => selector === "button" }
    ) as unknown as EventTarget;
    expect(lineageShouldFocusOnDoubleClick(cardBody)).toBe(true);
    expect(lineageShouldFocusOnDoubleClick(cardButton)).toBe(false);
  });

  it("resolves the all-projects request to global bounds", () => {
    const stage = { x: 20, y: 30, width: 248, height: 128 };
    const project = { x: 10, y: 20, width: 400, height: 260 };
    const all = { x: -100, y: -80, width: 1_800, height: 900 };
    expect(lineageRequestedFocusBox(
      "helix:all-projects",
      stage,
      project,
      all,
    )).toBe(all);
    expect(lineageRequestedFocusBox("project-1", undefined, project, all))
      .toBe(project);
  });

  it("keeps folded members out of keyboard targets and expands every folded edge endpoint", () => {
    const snapshot = foldedSnapshot();
    const projection = completedLineageProjection(snapshot);

    expect([...projection.hiddenByCollapseHead.keys()].sort()).toEqual(["a2", "b2"]);
    expect([...projection.collapseCountByHead.keys()].sort()).toEqual(["a1", "b1"]);
    expect(lineageConnectionTargetIds(snapshot, "visible", projection))
      .toEqual(["visible-2"]);
    expect(lineageStructuralEntityIds(snapshot, projection))
      .toEqual(["visible", "visible-2"]);
    expect(creationSourcesFromSelection(
      "visible",
      lineageStructuralEntityIds(snapshot, projection),
      snapshot.canvasNodes,
    )).toEqual(["visible", "visible-2"]);

    const relations = projectedLineageRelations(snapshot, projection);
    expect(relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: "a1",
        targetId: "b1",
        aggregate: true,
        foldedProjectIds: ["project-a", "project-b"],
      }),
      expect.objectContaining({
        sourceId: "visible",
        targetId: "b1",
        aggregate: true,
        foldedProjectIds: ["project-b"],
      }),
      expect.objectContaining({
        sourceId: "a1",
        targetId: "visible-2",
        aggregate: true,
        foldedProjectIds: ["project-a"],
      }),
    ]));
  });

  it("rejects a closed-component contraction that would create a projected diamond cycle", () => {
    const snapshot: ProjectWorkspaceSnapshot = {
      canvasPath: "Project Lineage.canvas",
      canvasRevisionHash: "hash",
      projects: [{
        id: "project",
        title: "Project",
        status: "active",
        notePath: "Project.md",
        cycles: [
          { id: "a", title: "a", notePath: "a.md", sequence: 1, status: "closed" },
          { id: "x", title: "x", notePath: "x.md", sequence: 2, status: "active" },
          { id: "b", title: "b", notePath: "b.md", sequence: 3, status: "closed" },
        ],
      }],
      nextStageSequenceByProject: {},
      relations: [
        { id: "a-x", kind: "branch", fromCycleIds: ["a"], toCycleId: "x" },
        { id: "merge-b", kind: "merge", fromCycleIds: ["a", "x"], toCycleId: "b" },
      ],
      migrationWarnings: [],
      migrationItems: [],
      migrationRequired: false,
      canvasNodes: ["a", "x", "b"].map((id, index) => ({
        ...node(id, "cycle", index * 300, 0),
        projectId: "project",
      })),
      collapsedCompletedProjectIds: ["project"],
    };
    const projection = completedLineageProjection(snapshot);
    expect(projection.hiddenByCollapseHead.size).toBe(0);
    expect(projection.collapseHeadByMember.size).toBe(0);
    expect(projection.collapseCountByHead.size).toBe(0);
  });

  it("never submits canceled or blank connector drags", () => {
    expect(lineageConnectionDropTarget(true, true, "target")).toBeUndefined();
    expect(lineageConnectionDropTarget(true, false)).toBeUndefined();
    expect(lineageConnectionDropTarget(false, false, "target")).toBeUndefined();
    expect(lineageConnectionDropTarget(true, false, "target")).toBe("target");
  });

  it("expands the virtual plane independently in all four directions", () => {
    expect(lineageVirtualExpansionPlan({
      scrollLeft: 100,
      scrollTop: 100,
      clientWidth: 800,
      clientHeight: 600,
      scrollWidth: 8_000,
      scrollHeight: 8_000,
    })).toEqual({
      shiftX: 1_800,
      shiftY: 1_800,
      growRightBy: 0,
      growBottomBy: 0,
    });
    expect(lineageVirtualExpansionPlan({
      scrollLeft: 7_300,
      scrollTop: 7_500,
      clientWidth: 800,
      clientHeight: 600,
      scrollWidth: 8_000,
      scrollHeight: 8_000,
    })).toEqual({
      shiftX: 0,
      shiftY: 0,
      growRightBy: 1_800,
      growBottomBy: 1_800,
    });
    const raw = { x: -1_200, y: -900 };
    const offset = { x: 2_400, y: 2_400 };
    const screen = { x: raw.x + offset.x, y: raw.y + offset.y };
    const shift = { x: 1_800, y: 1_800 };
    expect({
      x: screen.x + shift.x - (offset.x + shift.x),
      y: screen.y + shift.y - (offset.y + shift.y),
    }).toEqual(raw);

    const lowZoom = lineageVirtualExpansionPlan({
      scrollLeft: 100,
      scrollTop: 100,
      clientWidth: 800,
      clientHeight: 600,
      scrollWidth: 800,
      scrollHeight: 600,
    }, 0.0004);
    expect(lowZoom.shiftX * 0.0004).toBe(1_800);
    expect(lowZoom.shiftY * 0.0004).toBe(1_800);
    expect(lowZoom.growRightBy * 0.0004).toBe(1_800);
    expect(lowZoom.growBottomBy * 0.0004).toBe(1_800);
    expect(100 + lowZoom.shiftX * 0.0004).toBeGreaterThan(320);
  });
});

function foldedSnapshot(): ProjectWorkspaceSnapshot {
  const project = (
    id: string,
    cycleIds: string[],
  ): ProjectWorkspaceSnapshot["projects"][number] => ({
    id,
    title: id,
    status: "active",
    notePath: `${id}.md`,
    cycles: cycleIds.map((cycleId, index) => ({
      id: cycleId,
      title: cycleId,
      notePath: `${cycleId}.md`,
      sequence: index + 1,
      status: cycleId.startsWith("visible") ? "active" : "closed",
    })),
  });
  const canvasNodes = ["a1", "a2", "b1", "b2", "visible", "visible-2"].map(
    (id, index) => ({
      ...node(id, "cycle", index * 300, 0),
      projectId: id.startsWith("a")
        ? "project-a"
        : id.startsWith("b")
          ? "project-b"
          : "project-visible",
    }),
  );
  return {
    canvasPath: "Project Lineage.canvas",
    canvasRevisionHash: "hash",
    projects: [
      project("project-a", ["a1", "a2"]),
      project("project-b", ["b1", "b2"]),
      project("project-visible", ["visible", "visible-2"]),
    ],
    nextStageSequenceByProject: {},
    relations: [
      { id: "aa", kind: "inherit", fromCycleIds: ["a1"], toCycleId: "a2" },
      { id: "bb", kind: "inherit", fromCycleIds: ["b1"], toCycleId: "b2" },
      { id: "ab", kind: "inherit", fromCycleIds: ["a2"], toCycleId: "b2" },
      { id: "visible-b", kind: "inherit", fromCycleIds: ["visible"], toCycleId: "b2" },
      { id: "a-visible", kind: "inherit", fromCycleIds: ["a2"], toCycleId: "visible-2" },
    ],
    migrationWarnings: [],
    migrationItems: [],
    migrationRequired: false,
    canvasNodes,
    collapsedCompletedProjectIds: ["project-a", "project-b"],
  };
}

function node(
  entityId: string,
  kind: "project" | "cycle",
  x: number,
  y: number,
): ProjectWorkspaceCanvasNode {
  return {
    nodeId: `${entityId}-node`,
    entityId,
    kind,
    projectId: "project",
    title: entityId,
    notePath: `${entityId}.md`,
    x,
    y,
    width: 360,
    height: 220,
  };
}
