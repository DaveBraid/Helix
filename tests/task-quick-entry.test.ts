import { describe, expect, it } from "vitest";
import { parseTaskQuickEntry } from "../src/domain/task-quick-entry";

const projects = [
  { id: "research", name: "科研" },
  { id: "deep-work", name: "Deep Work" },
];

describe("parseTaskQuickEntry", () => {
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
