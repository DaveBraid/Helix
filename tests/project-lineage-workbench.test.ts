import { describe, expect, it } from "vitest";
import type { ProjectWorkspaceCanvasNode } from "../src/services/project-workspace";
import { creationSourcesFromSelection } from "../src/ui/project-lineage-workbench";

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
});

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
