import { describe, expect, it } from "vitest";
import { createJournalDocument } from "../src/services/journal-creation";

describe("journal template consumption", () => {
  it.each([
    ["daily", "daily-review"],
    ["weekly", "weekly-review"],
    ["monthly", "monthly-review"],
    ["yearly", "yearly-review"],
  ] as const)("keeps the Helix envelope for %s while consuming its template", async (period, kind) => {
    const calls: string[] = [];
    const content = await createJournalDocument({
      period,
      title: "我的复盘",
      periodStart: "2026-08-03",
      periodEnd: "2026-08-09",
      generatedSummary: "- 完成任务：2",
      renderTemplate: async (actualKind, values) => {
        calls.push(`${actualKind}:${values.title}`);
        return "自定义复盘正文";
      },
    });
    expect(calls).toEqual([`${kind}:我的复盘`]);
    expect(content).toContain("helix-kind: helix-journal");
    expect(content).toContain(`helix-period: ${period}`);
    expect(content).toContain("# 我的复盘");
    expect(content).toContain("## 自动摘要");
    expect(content).toContain("- 完成任务：2");
    expect(content).toContain("自定义复盘正文");
  });
});
