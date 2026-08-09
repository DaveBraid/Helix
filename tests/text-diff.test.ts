import { describe, expect, it } from "vitest";
import { sideBySideTextDiff } from "../src/domain/text-diff";

describe("sideBySideTextDiff", () => {
  it("aligns unchanged, replaced, inserted and deleted lines with real line numbers", () => {
    expect(sideBySideTextDiff(
      "# 结论\n- 准确率 81%\n- 显存稳定\n下一步",
      "# 结论\n- 准确率 83%\n- 延迟降低 8%\n- 显存稳定",
    )).toEqual([
      { leftNumber: 1, rightNumber: 1, leftText: "# 结论", rightText: "# 结论", leftTone: "unchanged", rightTone: "unchanged" },
      { leftNumber: 2, rightNumber: 2, leftText: "- 准确率 81%", rightText: "- 准确率 83%", leftTone: "removed", rightTone: "added" },
      { leftNumber: undefined, rightNumber: 3, leftText: "", rightText: "- 延迟降低 8%", leftTone: "empty", rightTone: "added" },
      { leftNumber: 3, rightNumber: 4, leftText: "- 显存稳定", rightText: "- 显存稳定", leftTone: "unchanged", rightTone: "unchanged" },
      { leftNumber: 4, rightNumber: undefined, leftText: "下一步", rightText: "", leftTone: "removed", rightTone: "empty" },
    ]);
  });

  it("normalizes CRLF and keeps an empty trailing line visible", () => {
    expect(sideBySideTextDiff("a\r\n", "a\n")).toHaveLength(2);
  });
});
