import { describe, expect, it } from "vitest";
import {
  FOCUS_SOURCE_HEADING,
  FocusBridgeError,
  coordinateStageFocusBridge,
  focusContentHash,
  parseFocusBridgeEnvelope,
  planStageFocusBridge,
  renderFocusBridgeEnvelope,
  replaceFocusBridgeEnvelope,
  resolveStageFocusBridge,
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

  it("collapses template padding to one blank line around the managed quote", () => {
    const padded = "# 本阶段问题聚焦\n\n\n\n# 计划行动\n- [ ] x\n";
    const next = replaceFocusBridgeEnvelope(
      padded,
      renderFocusBridgeEnvelope([source("a", "继承内容")]),
    );
    expect(next).toContain(
      "# 本阶段问题聚焦\n\n<!-- helix-focus-bridge:start version=1 -->",
    );
    expect(next).toMatch(/<!-- helix-focus-bridge:end -->\n\n# 计划行动/);
    expect(next).not.toContain("# 本阶段问题聚焦\n\n\n");
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
    const removed = planStageFocusBridge([], sources, inserted.markdown);
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

  describe("3D 双向协调", () => {
    function syncedPair(base = "Base"): { sourceNote: FocusSource; targetMarkdown: string } {
      const sourceNote = source("a", base);
      return {
        sourceNote,
        targetMarkdown: planStageFocusBridge(
          [sourceNote.id],
          new Map([[sourceNote.id, sourceNote]]),
          target(),
        ).markdown,
      };
    }

    it("returns noop when source and derived remain at their managed hashes", () => {
      const pair = syncedPair();
      expect(coordinateStageFocusBridge({
        source: pair.sourceNote,
        targetMarkdown: pair.targetMarkdown,
        baseContent: "Base",
      })).toEqual({ action: "noop", sourceId: "a" });
    });

    it("silently normalizes legacy padding around an unchanged derived quote", () => {
      const pair = syncedPair();
      const padded = pair.targetMarkdown
        .replace("# 本阶段问题聚焦\n\n", "# 本阶段问题聚焦\n\n\n\n")
        .replace("<!-- helix-focus-bridge:end -->\n\n", "<!-- helix-focus-bridge:end -->\n\n\n\n");
      const result = coordinateStageFocusBridge({
        source: pair.sourceNote,
        targetMarkdown: padded,
        baseContent: "Base",
      });
      expect(result.action).toBe("update-derived");
      if (result.action !== "update-derived") throw new Error("unexpected action");
      expect(result.targetMarkdown).toContain(
        "用户前言\n\n<!-- helix-focus-bridge:start version=1 -->",
      );
      expect(result.targetMarkdown).toMatch(/<!-- helix-focus-bridge:end -->\n\n# 计划行动/);
    });

    it("accepts only the Obsidian-equivalent .md WikiLink form as canonical", () => {
      const pair = syncedPair();
      const withoutExtension = pair.targetMarkdown.replace("a.md|A]]", "a|A]]");
      const parsed = parseFocusBridgeEnvelope(withoutExtension);
      if (parsed.kind !== "present") throw new Error("missing envelope");
      const legacyEquivalent = withoutExtension.replace(
        `derivedHash=${parsed.blocks[0]!.derivedHash}`,
        `derivedHash=${parsed.blocks[0]!.currentDerivedHash}`,
      );

      expect(coordinateStageFocusBridge({
        source: pair.sourceNote,
        targetMarkdown: legacyEquivalent,
        baseContent: "Base",
      })).toEqual({ action: "noop", sourceId: "a" });
      expect(planStageFocusBridge(
        ["a"],
        new Map([["a", pair.sourceNote]]),
        legacyEquivalent,
      ).action).toBe("replace");
    });

    it("rejects a forged derivedHash even during a controlled presentation rewrite", () => {
      const pair = syncedPair();
      const original = parseFocusBridgeEnvelope(pair.targetMarkdown);
      if (original.kind !== "present") throw new Error("missing envelope");
      const edited = pair.targetMarkdown.replace("|A]]", "|伪造标题]]");
      const editedParsed = parseFocusBridgeEnvelope(edited);
      if (editedParsed.kind !== "present") throw new Error("missing edited envelope");
      const forged = edited.replace(
        `derivedHash=${editedParsed.blocks[0]!.derivedHash}`,
        `derivedHash=${editedParsed.blocks[0]!.currentDerivedHash}`,
      );
      const expected = new Set([original.blocks[0]!.currentDerivedHash]);

      expect(coordinateStageFocusBridge({
        source: pair.sourceNote,
        targetMarkdown: forged,
        baseContent: "Base",
        expectedPresentationHashes: expected,
        rewritePresentation: true,
      })).toMatchObject({
        action: "conflict",
        conflict: { reason: "derived-structure-changed" },
      });
      expect(() => planStageFocusBridge(
        ["a"],
        new Map([["a", pair.sourceNote]]),
        forged,
        { expectedPresentationHashes: new Map([["a", expected]]) },
      )).toThrowError(expect.objectContaining({ code: "managed-edit-would-be-lost" }));
    });

    it("turns a source-only edit into one derived block update", () => {
      const pair = syncedPair();
      const changedSource = source("a", "Source changed");
      const result = coordinateStageFocusBridge({
        source: changedSource,
        targetMarkdown: pair.targetMarkdown,
        baseContent: "Base",
      });
      expect(result.action).toBe("update-derived");
      if (result.action !== "update-derived") throw new Error("unexpected action");
      const parsed = parseFocusBridgeEnvelope(result.targetMarkdown);
      if (parsed.kind !== "present") throw new Error("missing envelope");
      expect(parsed.blocks[0]).toMatchObject({
        sourceId: "a",
        content: "Source changed",
        state: "synced",
      });
      expect(parsed.blocks[0]!.baseHash).toBe(focusContentHash("Source changed"));
      expect(parsed.blocks[0]!.sourceHash).toBe(focusContentHash("Source changed"));
      expect(result.targetMarkdown).toContain("# 计划行动\n- [ ] x");
    });

    it("turns a derived-only edit into an exact source-section update and rederive id", () => {
      const pair = syncedPair();
      const editedTarget = pair.targetMarkdown.replace("> Base", "> Derived changed");
      const result = coordinateStageFocusBridge({
        source: pair.sourceNote,
        targetMarkdown: editedTarget,
        baseContent: "Base",
      });
      expect(result.action).toBe("update-source");
      if (result.action !== "update-source") throw new Error("unexpected action");
      expect(result.rederiveSourceIds).toEqual(["a"]);
      expect(scanFocusSection(result.sourceMarkdown, FOCUS_SOURCE_HEADING, 2).normalizedContent)
        .toBe("Derived changed");
      expect(result.sourceMarkdown).toContain("## 其他\n保留");
      expect(result.sourceMarkdown).toContain("# 阶段");
      const accepted = parseFocusBridgeEnvelope(result.originTargetMarkdown);
      if (accepted.kind !== "present") throw new Error("missing accepted envelope");
      expect(accepted.blocks[0]).toMatchObject({
        content: "Derived changed",
        baseHash: focusContentHash("Derived changed"),
        sourceHash: focusContentHash("Derived changed"),
        state: "synced",
      });
      expect(accepted.blocks[0]!.currentDerivedHash).toBe(accepted.blocks[0]!.derivedHash);
    });

    it("returns Base Source Derived snapshots for simultaneous edits", () => {
      const pair = syncedPair();
      const editedTarget = pair.targetMarkdown.replace("> Base", "> Derived changed");
      const result = coordinateStageFocusBridge({
        source: source("a", "Source changed"),
        targetMarkdown: editedTarget,
        baseContent: "Base",
      });
      expect(result).toMatchObject({
        action: "conflict",
        sourceId: "a",
        conflict: {
          sourceId: "a",
          reason: "simultaneous-edit",
          base: { content: "Base", hash: focusContentHash("Base") },
          source: { content: "Source changed", hash: focusContentHash("Source changed") },
          derived: { content: "Derived changed", hash: focusContentHash("Derived changed") },
        },
      });
    });

    it("fails descriptively for damaged markers or a mismatched Base snapshot", () => {
      const pair = syncedPair();
      expect(() => coordinateStageFocusBridge({
        source: pair.sourceNote,
        targetMarkdown: pair.targetMarkdown.replace("sourceHash=", "sourceHash=broken"),
        baseContent: "Base",
      })).toThrowError(expect.objectContaining({ code: "marker-corrupt" }));
      expect(() => coordinateStageFocusBridge({
        source: pair.sourceNote,
        targetMarkdown: pair.targetMarkdown,
        baseContent: "Wrong base",
      })).toThrowError(expect.objectContaining({
        code: "marker-corrupt",
        message: expect.stringContaining("Base 快照"),
      }));
    });

    it.each([
      ["link", (markdown: string) => markdown.replace("|A]]", "|Renamed]]")],
      ["callout title", (markdown: string) => markdown.replace("[!quote]", "[!info]")],
      ["separator", (markdown: string) => markdown.replace("\n>\n> Base", "\n> changed\n> Base")],
    ])("freezes a derived %s edit instead of treating it as source body", (_name, edit) => {
      const pair = syncedPair();
      const result = coordinateStageFocusBridge({
        source: pair.sourceNote,
        targetMarkdown: edit(pair.targetMarkdown),
        baseContent: "Base",
      });
      expect(result).toMatchObject({
        action: "conflict",
        conflict: { reason: "derived-structure-changed" },
      });
    });

    it("detects a structure edit even when derivedHash is also forged to match it", () => {
      const pair = syncedPair();
      const linkEdited = pair.targetMarkdown.replace("|A]]", "|Forged]]");
      const parsedEdited = parseFocusBridgeEnvelope(linkEdited);
      if (parsedEdited.kind !== "present") throw new Error("missing edited envelope");
      const forged = linkEdited.replace(
        `derivedHash=${parsedEdited.blocks[0]!.derivedHash}`,
        `derivedHash=${parsedEdited.blocks[0]!.currentDerivedHash}`,
      );
      const result = coordinateStageFocusBridge({
        source: pair.sourceNote,
        targetMarkdown: forged,
        baseContent: "Base",
      });
      expect(result).toMatchObject({
        action: "conflict",
        conflict: { reason: "derived-structure-changed" },
      });
    });

    it("makes the general planner reject a forged canonical link and derivedHash", () => {
      const pair = syncedPair();
      const sources = new Map([["a", pair.sourceNote]]);
      const linkEdited = pair.targetMarkdown.replace("|A]]", "|Forged]]");
      const parsedEdited = parseFocusBridgeEnvelope(linkEdited);
      if (parsedEdited.kind !== "present") throw new Error("missing edited envelope");
      const forged = linkEdited.replace(
        `derivedHash=${parsedEdited.blocks[0]!.derivedHash}`,
        `derivedHash=${parsedEdited.blocks[0]!.currentDerivedHash}`,
      );
      expect(() => planStageFocusBridge(["a"], sources, forged))
        .toThrowError(expect.objectContaining({ code: "managed-edit-would-be-lost" }));
    });

    it("preserves CRLF, target exterior text and source H2 siblings during reverse update", () => {
      const sourceNote = source("a", "Base", {
        markdown: source("a", "Base").markdown.replace(/\n/g, "\r\n"),
      });
      const targetMarkdown = planStageFocusBridge(
        ["a"],
        new Map([["a", sourceNote]]),
        target("外部前言\n\n外部结尾").replace(/\n/g, "\r\n"),
      ).markdown;
      const result = coordinateStageFocusBridge({
        source: sourceNote,
        targetMarkdown: targetMarkdown.replace("> Base", "> Reverse"),
        baseContent: "Base",
      });
      expect(result.action).toBe("update-source");
      if (result.action !== "update-source") throw new Error("unexpected action");
      expect(result.sourceMarkdown).not.toMatch(/(^|[^\r])\n/);
      expect(result.originTargetMarkdown).not.toMatch(/(^|[^\r])\n/);
      expect(result.sourceMarkdown).toContain("## 其他\r\n保留");
      expect(result.originTargetMarkdown).toContain("外部前言\r\n\r\n外部结尾");
      expect(result.originTargetMarkdown).toContain("# 计划行动\r\n- [ ] x");
    });

    it("handles empty Base, Source and Derived bodies without synthetic text", () => {
      const empty = syncedPair("");
      const sourceOnly = coordinateStageFocusBridge({
        source: source("a", "Source"),
        targetMarkdown: empty.targetMarkdown,
        baseContent: "",
      });
      expect(sourceOnly.action).toBe("update-derived");

      const derivedOnlyTarget = empty.targetMarkdown.replace(
        "\n<!-- helix-focus-source:end -->",
        "\n> Derived\n<!-- helix-focus-source:end -->",
      );
      const derivedOnly = coordinateStageFocusBridge({
        source: empty.sourceNote,
        targetMarkdown: derivedOnlyTarget,
        baseContent: "",
      });
      expect(derivedOnly.action).toBe("update-source");
      if (derivedOnly.action !== "update-source") throw new Error("unexpected action");
      expect(scanFocusSection(derivedOnly.sourceMarkdown, FOCUS_SOURCE_HEADING, 2).normalizedContent)
        .toBe("Derived");

      const emptyDerived = coordinateStageFocusBridge({
        source: source("a", "Base"),
        targetMarkdown: syncedPair("Base").targetMarkdown.replace("\n> Base", ""),
        baseContent: "Base",
      });
      expect(emptyDerived.action).toBe("update-source");
      if (emptyDerived.action !== "update-source") throw new Error("unexpected action");
      expect(scanFocusSection(emptyDerived.sourceMarkdown, FOCUS_SOURCE_HEADING, 2).normalizedContent)
        .toBe("");
    });

    it("canonicalizes one chosen conflict value into both source and target plans", () => {
      const pair = syncedPair();
      const targetEdited = pair.targetMarkdown.replace("> Base", "> Derived");
      const resolved = resolveStageFocusBridge({
        source: source("a", "Source"),
        targetMarkdown: targetEdited,
        acceptedContent: "Custom\n\n- item",
      });
      expect(scanFocusSection(resolved.sourceMarkdown, FOCUS_SOURCE_HEADING, 2).normalizedContent)
        .toBe("Custom\n\n- item");
      const parsed = parseFocusBridgeEnvelope(resolved.targetMarkdown);
      if (parsed.kind !== "present") throw new Error("missing resolved envelope");
      expect(parsed.blocks[0]).toMatchObject({
        content: "Custom\n\n- item",
        baseHash: resolved.acceptedHash,
        sourceHash: resolved.acceptedHash,
        state: "synced",
      });
      expect(parsed.blocks[0]!.currentDerivedHash).toBe(parsed.blocks[0]!.derivedHash);
    });
  });
});
