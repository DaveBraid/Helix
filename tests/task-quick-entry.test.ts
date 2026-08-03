import { describe, expect, it } from "vitest";
import {
  applyTaskQuickSuggestion,
  parseTaskQuickEntry,
  shouldSubmitTaskQuickEntryOnKey,
  taskQuickSuggestions,
} from "../src/domain/task-quick-entry";

const projects = [
  { id: "research", name: "科研" },
  { id: "deep-work", name: "Deep Work" },
];

describe("parseTaskQuickEntry", () => {
  it("never submits the composer while an IME composition is active", () => {
    expect(shouldSubmitTaskQuickEntryOnKey("Enter", true)).toBe(false);
    expect(shouldSubmitTaskQuickEntryOnKey("Enter", false)).toBe(true);
    expect(shouldSubmitTaskQuickEntryOnKey("Tab", false)).toBe(false);
  });
  it("suggests projects, existing tags, and priorities for the active token", () => {
    expect(taskQuickSuggestions("读论文 ~科", 6, projects, [])).toMatchObject([
      { kind: "project", label: "科研", token: "~科研" },
    ]);
    expect(taskQuickSuggestions("#实", 2, projects, ["实验", "阅读", "实验"])).toMatchObject([
      { kind: "tag", label: "实验", token: "#实验" },
    ]);
    expect(taskQuickSuggestions("!高", 2, projects, [])).toMatchObject([
      { kind: "priority", label: "高", token: "!高" },
    ]);
  });

  it("replaces only the active token and returns the next caret position", () => {
    expect(applyTaskQuickSuggestion("写作 ~De 后续", 6, {
      kind: "project",
      label: "Deep Work",
      token: "~\"Deep Work\"",
    })).toEqual({ value: "写作 ~\"Deep Work\" 后续", cursor: 15 });
    expect(applyTaskQuickSuggestion("#实验 后续", 2, {
      kind: "tag",
      label: "实验",
      token: "#实验",
    })).toEqual({ value: "#实验 后续", cursor: 3 });
    expect(applyTaskQuickSuggestion("#实验", 0, {
      kind: "tag",
      label: "实验",
      token: "#实验",
    })).toEqual({ value: "#实验 ", cursor: 4 });
    expect(applyTaskQuickSuggestion("~科研", 3, {
      kind: "tag",
      label: "实验",
      token: "#实验",
    })).toEqual({ value: "~科研", cursor: 3 });
  });

  it("only offers tokens that round-trip through the shared parser", () => {
    const candidates = taskQuickSuggestions("~", 1, [
      ...projects,
      { id: "duplicate", name: "科研" },
      { id: "quoted", name: '含"引号' },
      { id: "special", name: "方法 #2" },
    ], []);
    expect(candidates.map((candidate) => candidate.label)).toEqual(["Deep Work", "方法 #2"]);
    for (const candidate of candidates) {
      const applied = applyTaskQuickSuggestion("任务 ~", 4, candidate);
      expect(parseTaskQuickEntry(applied.value, [
        ...projects,
        { id: "duplicate", name: "科研" },
        { id: "quoted", name: '含"引号' },
        { id: "special", name: "方法 #2" },
      ]).issues).toEqual([]);
    }
    expect(taskQuickSuggestions("#", 1, projects, ["实验", "有 空格", "坏#标签"]))
      .toMatchObject([{ label: "实验", token: "#实验" }]);
  });
  it("extracts verified list, tag and priority tokens", () => {
    expect(parseTaskQuickEntry("复现实验 ~科研 #论文 #实验 !高", projects)).toEqual({
      title: "复现实验",
      projectId: "research",
      tags: ["论文", "实验"],
      priority: 5,
      issues: [],
    });
    expect(parseTaskQuickEntry('整理资料 ~"Deep Work" !medium', projects)).toMatchObject({
      title: "整理资料",
      projectId: "deep-work",
      priority: 3,
    });
  });

  it("keeps unknown tokens visible and reports them", () => {
    expect(parseTaskQuickEntry("任务 ~不存在 !2 #标签", projects)).toEqual({
      title: "任务 ~不存在 !2",
      projectId: undefined,
      tags: ["标签"],
      priority: undefined,
      issues: ["找不到清单“不存在”", "无法识别优先级“!2”"],
    });
  });

  it("does not treat embedded punctuation as property syntax", () => {
    expect(parseTaskQuickEntry("邮件a#b.com与C~API", projects)).toMatchObject({
      title: "邮件a#b.com与C~API",
      tags: [],
      issues: [],
    });
  });

  it("rejects competing lists, priorities and duplicate list names", () => {
    expect(parseTaskQuickEntry("任务 ~科研 ~\"Deep Work\" !高 !低", projects)).toMatchObject({
      title: "任务 ~科研 ~\"Deep Work\" !高 !低",
      projectId: undefined,
      priority: undefined,
      issues: ["快捷输入包含多个不同清单", "快捷输入包含多个不同优先级"],
    });
    expect(parseTaskQuickEntry("任务 ~科研", [
      ...projects,
      { id: "research-copy", name: "科研" },
    ])).toMatchObject({
      title: "任务 ~科研",
      projectId: undefined,
      issues: ["存在多个同名清单“科研”，请先明确选择"],
    });
  });
});
