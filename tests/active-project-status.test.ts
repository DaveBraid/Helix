import { describe, expect, it } from "vitest";
import { activeHelixStatusTarget } from "../src/domain/active-project-status";

describe("活动 Helix 状态目标", () => {
  it("只接受已知项目／阶段状态，并兼容旧值而不写回", () => {
    expect(activeHelixStatusTarget({
      "helix-kind": "helix-project", "helix-id": "p", "helix-status": "archived",
    }, "项目")).toEqual({ kind: "project", id: "p", title: "项目", status: "terminated" });
    expect(activeHelixStatusTarget({
      "helix-kind": "helix-stage", "helix-id": "s", "helix-status": "closed",
    }, "阶段")).toEqual({ kind: "stage", id: "s", title: "阶段", status: "completed" });
    expect(activeHelixStatusTarget({
      "helix-kind": "helix-stage", "helix-id": "s", "helix-status": "未知",
    }, "阶段")).toBeNull();
  });
});
