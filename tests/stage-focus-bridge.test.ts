import { describe, expect, it } from "vitest";
import {
  FOCUS_SOURCE_HEADING,
  FocusBridgeError,
  focusContentHash,
  parseFocusBridgeEnvelope,
  planStageFocusBridge,
  renderFocusBridgeEnvelope,
  replaceFocusBridgeEnvelope,
  scanFocusSection,
  type FocusSource,
} from "../src/domain/stage-focus-bridge";

function source(id: string, body: string, extras: Partial<FocusSource> = {}): FocusSource {
  return {
    id,
    notePath: `Helix/Projects/A/${id}.md`,
    title: id.toUpperCase(),
    stageCode: id === "a" ? "2.1" : "2.2",
    markdown: `# 阶段\n\n## ${FOCUS_SOURCE_HEADING}\n${body}\n\n## 其他\n保留`,
    ...extras,
  };
}

function target(body = "用户前言\n"): string {
  return `# 本阶段问题聚焦\n${body}\n# 计划行动\n- [ ] x\n`;
}

describe("阶段聚焦桥接纯领域协议", () => {
  it("scans source H2 and target H1 with their own boundaries", () => {
    expect(scanFocusSection(source("a", "问题").markdown, FOCUS_SOURCE_HEADING, 2).normalizedContent)
      .toBe("问题");
    expect(scanFocusSection(target("正文\n## 更深标题\n仍属正文"), "本阶段问题聚焦", 1).normalizedContent)
      .toContain("仍属正文");
  });

  it("ignores exact-looking headings inside matching fenced code", () => {
    const markdown = "```ts\n## 下一阶段聚焦问题\n~~~\n```\n## 下一阶段聚焦问题\n真实";
    expect(scanFocusSection(markdown, FOCUS_SOURCE_HEADING, 2).normalizedContent).toBe("真实");
  });

  it("supports tilde fences and a longer matching closing fence", () => {
    const markdown = "~~~~js\n## 下一阶段聚焦问题\n```\n~~~~~\n## 下一阶段聚焦问题\n真实";
    expect(scanFocusSection(markdown, FOCUS_SOURCE_HEADING, 2).normalizedContent).toBe("真实");
  });

  it("rejects missing and duplicate real headings with typed diagnostics", () => {
    expect(() => scanFocusSection("# x", FOCUS_SOURCE_HEADING, 2))
      .toThrowError(expect.objectContaining({ code: "heading-missing" }));
    expect(() => scanFocusSection("## 下一阶段聚焦问题\na\n## 下一阶段聚焦问题\nb", FOCUS_SOURCE_HEADING, 2))
      .toThrowError(expect.objectContaining({ code: "heading-duplicate" }));
  });

  it("accepts ATX closing hashes and ignores a blockquoted heading", () => {
    const markdown = "> ## 下一阶段聚焦问题\n## 下一阶段聚焦问题 ##\n内容";
    expect(scanFocusSection(markdown, FOCUS_SOURCE_HEADING, 2).normalizedContent).toBe("内容");
  });

  it("normalizes only hash input so CRLF and LF bodies hash equally", () => {
    expect(focusContentHash("\r\nA\r\n\r\nB\r\n")).toBe(focusContentHash("A\n\nB"));
  });

  it("renders stable multi-source order and complete hash/state markers", () => {
    const envelope = renderFocusBridgeEnvelope([source("b", "B"), source("a", "A")]);
    expect(envelope.indexOf("sourceId=a")).toBeLessThan(envelope.indexOf("sourceId=b"));
    expect(envelope).toMatch(/baseHash=[0-9a-f]{64} sourceHash=[0-9a-f]{64} derivedHash=[0-9a-f]{64} state=synced/);
  });

  it("rejects an empty renderer input instead of creating an empty envelope", () => {
    expect(() => renderFocusBridgeEnvelope([]))
      .toThrowError(expect.objectContaining({ code: "source-empty" }));
  });

  it("quotes and parses empty content without a synthetic content line", () => {
    const markdown = replaceFocusBridgeEnvelope(target(), renderFocusBridgeEnvelope([source("a", "")]));
    const parsed = parseFocusBridgeEnvelope(markdown);
    expect(parsed.kind).toBe("present");
    if (parsed.kind === "present") expect(parsed.blocks[0]!.content).toBe("");
  });

  it("round-trips multiline lists, blank lines and a nested quote by one layer", () => {
    const body = "- 一\n  - 二\n\n> 原引用\n尾部  ";
    const markdown = replaceFocusBridgeEnvelope(target(), renderFocusBridgeEnvelope([source("a", body)]));
    const parsed = parseFocusBridgeEnvelope(markdown);
    if (parsed.kind !== "present") throw new Error("missing envelope");
    expect(parsed.blocks[0]!.content).toBe(body);
    expect(markdown).toContain("> > 原引用");
  });

  it("preserves CRLF and all target text outside the managed envelope", () => {
    const original = target("用户前言\n\n用户结尾").replace(/\n/g, "\r\n");
    const next = replaceFocusBridgeEnvelope(original, renderFocusBridgeEnvelope([source("a", "A")]));
    expect(next).not.toMatch(/(^|[^\r])\n/);
    expect(next).toContain("用户前言\r\n\r\n用户结尾");
    expect(next).toContain("# 计划行动\r\n- [ ] x");
  });

  it("preserves a leading BOM while scanning and replacing", () => {
    const original = `\uFEFF${target("手工内容")}`;
    const next = replaceFocusBridgeEnvelope(original, renderFocusBridgeEnvelope([source("a", "A")]));
    expect(next.startsWith("\uFEFF# 本阶段问题聚焦")).toBe(true);
    expect(scanFocusSection(next, "本阶段问题聚焦", 1).normalizedContent).toContain("手工内容");
  });

  it("ignores marker-looking text inside a target code fence", () => {
    const markdown = target("```\n<!-- helix-focus-bridge:start version=1 -->\n```\n用户正文");
    expect(parseFocusBridgeEnvelope(markdown).kind).toBe("absent");
  });

  it.each([
    ["duplicate outer", (value: string) => value.replace("<!-- helix-focus-bridge:end -->", "<!-- helix-focus-bridge:start version=1 -->\n<!-- helix-focus-bridge:end -->")],
    ["missing child end", (value: string) => value.replace("<!-- helix-focus-source:end -->", "")],
    ["nested child", (value: string) => value.replace("> [!quote]", "<!-- helix-focus-source:start sourceId=x baseHash=" + "0".repeat(64) + " sourceHash=" + "0".repeat(64) + " derivedHash=" + "0".repeat(64) + " state=synced -->\n> [!quote]")],
    ["unknown managed content", (value: string) => value.replace("<!-- helix-focus-bridge:end -->", "用户内容\n<!-- helix-focus-bridge:end -->")],
  ])("rejects corrupt markers: %s", (_name, mutate) => {
    const valid = replaceFocusBridgeEnvelope(target(), renderFocusBridgeEnvelope([source("a", "A")]));
    expect(() => parseFocusBridgeEnvelope(mutate(valid)))
      .toThrowError(expect.objectContaining({ code: "marker-corrupt" }));
  });

  it("freezes a plan when marker comments are only slightly damaged", () => {
    const sources = new Map([["a", source("a", "A")]]);
    const valid = planStageFocusBridge(["a"], sources, target()).markdown;
    const damaged = valid
      .replace("<!-- helix-focus-bridge:start", " <!-- helix-focus-bridge:start")
      .replace("<!-- helix-focus-bridge:end -->", " <!-- helix-focus-bridge:end -->");
    expect(() => planStageFocusBridge(["a"], sources, damaged))
      .toThrowError(expect.objectContaining({ code: "marker-corrupt" }));
  });

  it.each([
    ["before target", (value: string) => `<!-- helix-focus-bridge:start version=1 -->\n${value}`],
    ["after target", (value: string) => `${value}<!-- helix-focus-source:end -->\n`],
  ])("freezes a plan for a suspicious marker %s", (_name, mutate) => {
    const sources = new Map([["a", source("a", "A")]]);
    expect(() => planStageFocusBridge(["a"], sources, mutate(target())))
      .toThrowError(expect.objectContaining({ code: "marker-corrupt" }));
  });

  it("rejects duplicate source ids instead of silently deduplicating them", () => {
    const sources = new Map([["a", source("a", "A")]]);
    expect(() => planStageFocusBridge(["a", "a"], sources, target()))
      .toThrowError(expect.objectContaining({ code: "source-duplicate" }));
  });

  it("does not create an envelope for a first stage without inbound sources", () => {
    const markdown = target("手工聚焦");
    expect(planStageFocusBridge([], new Map(), markdown))
      .toEqual({ action: "noop", sourceIds: [], content: "", markdown });
  });

  it("inserts, parses and removes a synced envelope without changing manual text", () => {
    const sources = new Map([["a", source("a", "A")]]);
    const original = target("前\n\n后");
    const inserted = planStageFocusBridge(["a"], sources, original);
    expect(inserted.action).toBe("insert");
    expect(parseFocusBridgeEnvelope(inserted.markdown).kind).toBe("present");
    const removed = planStageFocusBridge([], new Map(), inserted.markdown);
    expect(removed.action).toBe("remove");
    expect(removed.markdown).toBe(original);
  });

  it("refuses to overwrite or remove a user-edited derived quote", () => {
    const sources = new Map([["a", source("a", "A")]]);
    const inserted = planStageFocusBridge(["a"], sources, target());
    const edited = inserted.markdown.replace("> A", "> 用户修改");
    expect(() => planStageFocusBridge([], new Map(), edited))
      .toThrowError(expect.objectContaining({ code: "managed-edit-would-be-lost" }));
  });

  it("treats an edited visible source link as a derived edit", () => {
    const sources = new Map([["a", source("a", "A")]]);
    const inserted = planStageFocusBridge(["a"], sources, target());
    const edited = inserted.markdown.replace("|A]]", "|用户改名]]");
    expect(() => planStageFocusBridge(["a"], sources, edited))
      .toThrowError(expect.objectContaining({ code: "managed-edit-would-be-lost" }));
  });

  it("freezes a persisted conflict instead of replacing it", () => {
    const sources = new Map([["a", source("a", "A")]]);
    const inserted = planStageFocusBridge(["a"], sources, target());
    const conflict = inserted.markdown.replace("state=synced", "state=conflict");
    expect(() => planStageFocusBridge(["a"], sources, conflict))
      .toThrowError(expect.objectContaining({ code: "bridge-conflict" }));
  });

  it("does not infer an extra relationship from an ordinary user quote", () => {
    const sources = new Map([
      ["a", source("a", "A")],
      ["b", source("b", "B")],
    ]);
    const plan = planStageFocusBridge(["a"], sources, target("> [[B]] 只是用户文字"));
    expect(plan.sourceIds).toEqual(["a"]);
    expect(plan.content).not.toContain("sourceId=b");
  });
});
