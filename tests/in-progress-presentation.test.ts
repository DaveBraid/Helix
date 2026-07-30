import { describe, expect, it } from "vitest";
import { inProgressPresentation } from "../src/ui/in-progress-presentation";

describe("inProgressPresentation", () => {
  it("shows three real items with a working expand affordance when four exist", () => {
    const collapsed = inProgressPresentation(["a", "b", "c", "d"], false);
    expect(collapsed).toEqual({
      visible: ["a", "b", "c"],
      canExpand: true,
    });

    const expanded = inProgressPresentation(["a", "b", "c", "d"], true);
    expect(expanded).toEqual({
      visible: ["a", "b", "c", "d"],
      canExpand: true,
    });
  });
});
