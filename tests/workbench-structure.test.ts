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
});
