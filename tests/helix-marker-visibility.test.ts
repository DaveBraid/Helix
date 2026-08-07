import { describe, expect, it } from "vitest";
import { hiddenHelixMarkerRanges } from "../src/editor/helix-marker-visibility";

function hidden(source: string, selections: Array<{ from: number; to: number }> = []): string[] {
  return hiddenHelixMarkerRanges(source, selections).map((range) => source.slice(range.from, range.to).trim());
}

function stage(action: string): string {
  return `---\nhelix-kind: helix-stage\nhelix-id: stage-1\n---\n# 计划行动\n${action}\n# 行动结果\n`;
}

describe("Live Preview Helix marker visibility", () => {
  const hash = "a".repeat(64);
  const markers = [
    "<!-- helix-focus-bridge:start version=1 -->",
    `<!-- helix-focus-source:start sourceId=source-1 baseHash=${hash} sourceHash=${hash} derivedHash=${hash} state=synced -->`,
    "<!-- helix-focus-source:end -->",
    "<!-- helix-focus-bridge:end -->",
  ];

  it("hides only exact focus bridge marker lines", () => {
    const source = [markers[0], "> [!quote]", "> 用户正文", markers[1], markers[2], markers[3]].join("\n");
    expect(hidden(source)).toEqual(markers);
  });

  it("preserves user comments, malformed markers and quoted text", () => {
    const source = [
      "<!-- 用户注释 -->",
      " <!-- helix-focus-bridge:start version=1 -->",
      "> <!-- helix-focus-bridge:end -->",
      "普通正文 <!-- helix-dida-action:v1 uuid=u remoteId=- state=active -->",
    ].join("\n");
    expect(hidden(source)).toEqual([]);
  });

  it("hides only an exact action marker at the end of a valid checkbox task", () => {
    const marker = "<!-- helix-dida-action:v1 uuid=u-1 remoteId=- state=active -->";
    const source = stage(`- [ ] 用户行动 ${marker}`);
    expect(hidden(source)).toEqual([marker]);
    const markerFrom = source.indexOf(marker);
    expect(hidden(source, [{ from: markerFrom + 2, to: markerFrom + 2 }])).toEqual([]);
    expect(hidden(source, [{ from: 3, to: 3 }])).toEqual([marker]);
    expect(hidden(source, [{ from: 0, to: markerFrom }])).toEqual([marker]);
  });

  it("keeps damaged, non-canonical or checkbox-inconsistent action markers visible", () => {
    expect(hidden(stage("- [x] 行动 <!-- helix-dida-action:v1 uuid=u remoteId=- state=active -->"))).toEqual([]);
    expect(hidden(stage("- [ ] 行动 <!-- helix-dida-action:v1 uuid=%75 remoteId=- state=active -->"))).toEqual([]);
    expect(hidden("- [ ] 行动 <!-- helix-dida-action:v1 uuid=u remoteId=- state=active -->")).toEqual([]);
  });

  it("reveals a marker whenever a cursor or selection touches its line", () => {
    const source = `${markers[0]}\n正文\n${markers[3]}`;
    expect(hidden(source, [{ from: 2, to: 2 }])).toEqual([markers[3]]);
    expect(hidden(source, [{ from: markers[0]!.length + 1, to: markers[0]!.length + 1 }]))
      .toEqual([markers[0], markers[3]]);
    expect(hidden(source, [{ from: 0, to: source.length }])).toEqual([]);
  });

  it("keeps marker examples visible inside backtick or tilde fences", () => {
    const action = "- [ ] 示例 <!-- helix-dida-action:v1 uuid=u remoteId=- state=active -->";
    const source = `${stage(["```md", markers[0], action, "```", "~~~", markers[3], "~~~"].join("\n"))}${markers[3]}`;
    expect(hidden(source)).toEqual([markers[3]]);
  });

  it("recognizes exact markers with CRLF without replacing carriage returns", () => {
    const source = `${markers[0]}\r\n正文\r\n${markers[3]}`;
    const ranges = hiddenHelixMarkerRanges(source);
    expect(ranges.map((range) => source.slice(range.from, range.to))).toEqual([markers[0], markers[3]]);
    expect(ranges.every((range) => !source.slice(range.from, range.to).includes("\r"))).toBe(true);
  });
});
