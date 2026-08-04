import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKBENCH_NAVIGATION } from "../src/domain/workbench-navigation";

describe("workbench layout and navigation structure", () => {
  const view = readFileSync(resolve(process.cwd(), "src/ui/helix-view.ts"), "utf8");
  const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");

  it("uses the intended navigation order without an independent analytics tab", () => {
    expect(WORKBENCH_NAVIGATION.map((item) => item.label))
      .toEqual(["今日", "项目", "任务", "复盘", "挑战", "冲突"]);
    expect(WORKBENCH_NAVIGATION.map((item) => item.id)).not.toContain("analytics");
  });

  it("places analytics below review cards inside the shared review section", () => {
    expect(view).toMatch(/renderReviews[\s\S]*helix-review-recall[\s\S]*renderAnalytics\(recall, false\)/);
    expect(view).toMatch(/renderAnalytics\(content: HTMLElement, includeTitle = true\)/);
  });

  it("keeps shell, sidebar and header fixed while only main content scrolls", () => {
    expect(css).toMatch(/\.helix-root \{[\s\S]*height: 100%;[\s\S]*overflow: hidden !important;/);
    expect(css).toMatch(/\.helix-shell \{[\s\S]*height: 100%;[\s\S]*overflow: hidden !important;/);
    expect(css).toMatch(/\.helix-sidebar \{[\s\S]*height: 100%;[\s\S]*overflow: hidden !important;/);
    expect(css).toMatch(/\.helix-main \{[\s\S]*display: flex;[\s\S]*flex-direction: column;[\s\S]*overflow: hidden;/);
    expect(css).toMatch(/\.helix-content \{[\s\S]*flex: 1 1 auto;[\s\S]*overflow: auto;/);
    expect(css).toMatch(/\.helix-sidebar-lists \{[\s\S]*overflow: hidden !important;/);
  });

  it("routes Canvas repair through the dedicated write-gated action", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(view).toMatch(/this\.actions\.repairProjectCanvas\(\)/);
    expect(view).not.toMatch(/Canvas 需要修复[\s\S]*projectWorkspace\.ensureCanvas\(\)/);
    expect(main).toMatch(/repairProjectCanvas: \(\) => this\.repairProjectCanvas\(\)/);
    expect(main).toMatch(
      /private async repairProjectCanvas\(\): Promise<void> \{[\s\S]*this\.withWritableProjectMutation\(\(\) => this\.projectWorkspace\.ensureCanvas\(\)\)/,
    );
  });

  it("routes all new status saves through a recovery-mode write gate", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(view).toMatch(/this\.actions\.updateProjectStatus\(plan, status\)/);
    expect(view).toMatch(/this\.actions\.updateCycleStatus\(plan, status\)/);
    expect(view).not.toMatch(/projectWorkspace\.updateProjectStatus\(plan, status\)/);
    expect(view).not.toMatch(/projectWorkspace\.updateCycleStatus\(plan, status\)/);
    expect(main).toMatch(/updateProjectStatus: \(plan, status\) => this\.updateProjectStatus\(plan, status\)/);
    expect(main).toMatch(/updateCycleStatus: \(plan, status\) => this\.updateCycleStatus\(plan, status\)/);
    expect(main).toMatch(
      /private async updateProjectStatus\([\s\S]*this\.withWritableProjectMutation\(\(\) => this\.projectWorkspace\.updateProjectStatus\(plan, status\)\)/,
    );
    expect(main).toMatch(
      /private async updateCycleStatus\([\s\S]*this\.withWritableProjectMutation\(\(\) => this\.projectWorkspace\.updateCycleStatus\(plan, status\)\)/,
    );
  });

  it("keeps project reads available while recovery mode rejects all View mutations before writing", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(main).toMatch(/readProjectWorkspace: \(operation\) => this\.withProjectWorkspaceRead\(operation\)/);
    expect(main).toMatch(/mutateProjectWorkspace: \(operation\) => this\.withWritableProjectMutation\(operation\)/);
    expect(main).toMatch(
      /private async withWritableProjectMutation<T>\(operation: \(\) => Promise<T>\): Promise<T> \{[\s\S]*this\.assertWritable\(\);[\s\S]*return this\.withProjectMutation\(operation\);/,
    );
    expect(view).toMatch(/workspace = await this\.actions\.readProjectWorkspace\([\s\S]*loadStableWorkspace\(\)/);
  });

  it("keeps Canvas repair diagnostics beside the lineage workbench", () => {
    expect(view).toMatch(/Canvas 需要修复[\s\S]*const workbenchHost = content\.createDiv\(\{ cls: "helix-project-workbench-host" \}\)/);
    expect(view).toMatch(/this\.projectWorkbench\.render\(workbenchHost\)/);
    expect(view).not.toMatch(/this\.projectWorkbench\.render\(content\)/);
  });
});
