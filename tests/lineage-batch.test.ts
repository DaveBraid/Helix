import { describe, expect, it } from "vitest";
import { lineageBatchDecision } from "../src/services/lineage-batch";

describe("lineage batch decision", () => {
  it("pauses instead of choosing a winner when Canvas and Markdown both changed", () => {
    expect(lineageBatchDecision(true, true)).toBe("manual-conflict");
    expect(lineageBatchDecision(true, false)).toBe("apply-canvas");
    expect(lineageBatchDecision(false, true)).toBe("rebuild-canvas");
  });
});
