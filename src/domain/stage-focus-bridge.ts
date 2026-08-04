import { stableHash } from "./stable";

export const FOCUS_SOURCE_HEADING = "下一阶段聚焦问题";
export const FOCUS_TARGET_HEADING = "本阶段问题聚焦";

const OUTER_START = "<!-- helix-focus-bridge:start version=1 -->";
const OUTER_END = "<!-- helix-focus-bridge:end -->";
const CHILD_END = "<!-- helix-focus-source:end -->";
const CHILD_START = /^<!-- helix-focus-source:start sourceId=([^ ]+) baseHash=([0-9a-f]{64}) sourceHash=([0-9a-f]{64}) derivedHash=([0-9a-f]{64}) state=(synced|conflict) -->$/;

export type FocusBridgeState = "synced" | "conflict";
export type FocusBridgeErrorCode =
  | "heading-missing"
  | "heading-duplicate"
  | "marker-corrupt"
  | "source-duplicate"
  | "source-empty"
  | "source-missing"
  | "managed-edit-would-be-lost"
  | "bridge-conflict";

export class FocusBridgeError extends Error {
  constructor(readonly code: FocusBridgeErrorCode, message: string) {
    super(message);
    this.name = "FocusBridgeError";
  }
}

export interface FocusSection {
  level: number;
  headingLine: number;
  bodyStartLine: number;
  bodyEndLine: number;
  content: string;
  normalizedContent: string;
  hash: string;
  eol: "\n" | "\r\n";
}

export interface FocusSource {
  id: string;
  notePath: string;
  title: string;
  stageCode?: string;
  markdown: string;
}

export interface FocusBridgeBlock {
  sourceId: string;
  baseHash: string;
  sourceHash: string;
  derivedHash: string;
  currentDerivedHash: string;
  state: FocusBridgeState;
  content: string;
  startLine: number;
  endLine: number;
}

export type ParsedFocusEnvelope =
  | { kind: "absent"; target: FocusSection }
  | {
      kind: "present";
      target: FocusSection;
      startLine: number;
      endLine: number;
      blocks: FocusBridgeBlock[];
    };

export interface FocusPlan {
  action: "noop" | "insert" | "replace" | "remove";
  sourceIds: string[];
  content: string;
  markdown: string;
}

export function normalizeFocusHashContent(content: string): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return lines.join("\n");
}

export function focusContentHash(content: string): string {
  return stableHash(normalizeFocusHashContent(content));
}

export function scanFocusSection(
  markdown: string,
  heading: string,
  level: number,
): FocusSection {
  const document = markdownDocument(markdown);
  const headings = scanHeadings(document.lines).filter((candidate) =>
    candidate.level === level && candidate.text === heading);
  if (headings.length === 0) {
    throw new FocusBridgeError("heading-missing", `缺少标题：${"#".repeat(level)} ${heading}`);
  }
  if (headings.length > 1) {
    throw new FocusBridgeError("heading-duplicate", `标题重复：${"#".repeat(level)} ${heading}`);
  }
  const selected = headings[0]!;
  const next = scanHeadings(document.lines).find((candidate) =>
    candidate.line > selected.line && candidate.level <= level);
  const bodyStartLine = selected.line + 1;
  const bodyEndLine = next?.line ?? document.lines.length;
  const content = document.lines.slice(bodyStartLine, bodyEndLine).join(document.eol);
  const normalizedContent = normalizeFocusHashContent(content);
  return {
    level,
    headingLine: selected.line,
    bodyStartLine,
    bodyEndLine,
    content,
    normalizedContent,
    hash: focusContentHash(content),
    eol: document.eol,
  };
}

/** 兼容早期调用；新代码应使用带明确 level 的 scanFocusSection。 */
export function scanFocusSections(markdown: string, heading: string):
  | { ok: true; content: string }
  | { ok: false; reason: string } {
  try {
    const section = scanFocusSection(
      markdown,
      heading,
      heading === FOCUS_TARGET_HEADING ? 1 : 2,
    );
    return { ok: true, content: section.normalizedContent };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function renderFocusBridgeEnvelope(sources: readonly FocusSource[]): string {
  if (sources.length === 0) {
    throw new FocusBridgeError("source-empty", "无前置阶段时不得生成聚焦问题受管包络");
  }
  assertUniqueSourceIds(sources.map((source) => source.id));
  const ordered = [...sources].sort(compareSources);
  const blocks = ordered.map((source) => {
    const section = scanFocusSection(source.markdown, FOCUS_SOURCE_HEADING, 2);
    const hash = section.hash;
    return renderBlock({
      sourceId: source.id,
      notePath: source.notePath,
      title: source.title,
      content: section.normalizedContent,
      baseHash: hash,
      sourceHash: hash,
      state: "synced",
    });
  });
  return [OUTER_START, ...joinBlocks(blocks), OUTER_END].join("\n");
}

export function parseFocusBridgeEnvelope(markdown: string): ParsedFocusEnvelope {
  const document = markdownDocument(markdown);
  const target = scanFocusSection(markdown, FOCUS_TARGET_HEADING, 1);
  const body = document.lines.slice(target.bodyStartLine, target.bodyEndLine);
  const documentMarkers = managedMarkerLines(document.lines);
  if (documentMarkers.some((item) =>
    item.line < target.bodyStartLine || item.line >= target.bodyEndLine)) {
    throw corrupt("受管标记位于本阶段问题聚焦小节之外");
  }
  const markerLines = documentMarkers.map((item) => ({
    line: item.line - target.bodyStartLine,
    text: item.text,
  }));
  if (markerLines.length === 0) return { kind: "absent", target };
  const outerStarts = markerLines.filter((item) => item.text === OUTER_START);
  const outerEnds = markerLines.filter((item) => item.text === OUTER_END);
  if (outerStarts.length !== 1 || outerEnds.length !== 1 || outerStarts[0]!.line >= outerEnds[0]!.line) {
    throw corrupt("受管包络缺失、重复或顺序错误");
  }
  const outerStart = outerStarts[0]!.line;
  const outerEnd = outerEnds[0]!.line;
  if (markerLines.some((item) => item.line < outerStart || item.line > outerEnd)) {
    throw corrupt("受管标记发生嵌套或越界");
  }
  const blocks: FocusBridgeBlock[] = [];
  const sourceIds = new Set<string>();
  let cursor = outerStart + 1;
  while (cursor < outerEnd) {
    if (body[cursor]!.trim() === "") {
      cursor += 1;
      continue;
    }
    const match = CHILD_START.exec(body[cursor]!);
    if (!match) throw corrupt(`受管包络中存在未知内容（第 ${cursor + 1} 行）`);
    const startLine = cursor;
    const sourceId = decodeSourceId(match[1]!);
    if (!sourceId || sourceIds.has(sourceId)) throw corrupt(`来源 ID 重复或为空：${sourceId}`);
    sourceIds.add(sourceId);
    cursor += 1;
    const visible: string[] = [];
    while (cursor < outerEnd && body[cursor] !== CHILD_END) {
      if (CHILD_START.test(body[cursor]!) || body[cursor] === OUTER_START || body[cursor] === OUTER_END) {
        throw corrupt("来源子块嵌套或标记错位");
      }
      visible.push(body[cursor]!);
      cursor += 1;
    }
    if (cursor >= outerEnd || body[cursor] !== CHILD_END) throw corrupt("来源子块缺少结束标记");
    const content = parseVisibleQuote(visible);
    blocks.push({
      sourceId,
      baseHash: match[2]!,
      sourceHash: match[3]!,
      derivedHash: match[4]!,
      currentDerivedHash: focusContentHash(visible.join("\n")),
      state: match[5]! as FocusBridgeState,
      content,
      startLine: target.bodyStartLine + startLine,
      endLine: target.bodyStartLine + cursor,
    });
    cursor += 1;
  }
  return {
    kind: "present",
    target,
    startLine: target.bodyStartLine + outerStart,
    endLine: target.bodyStartLine + outerEnd,
    blocks,
  };
}

export function replaceFocusBridgeEnvelope(markdown: string, envelope: string | null): string {
  const parsed = parseFocusBridgeEnvelope(markdown);
  const document = markdownDocument(markdown);
  const replacement = envelope?.replace(/\r\n?/g, "\n").split("\n") ?? [];
  if (parsed.kind === "present") {
    document.lines.splice(
      parsed.startLine,
      parsed.endLine - parsed.startLine + 1,
      ...replacement,
    );
    return document.lines.join(document.eol);
  }
  if (!envelope) return markdown;
  const insertAt = parsed.target.bodyEndLine;
  document.lines.splice(insertAt, 0, ...replacement);
  return document.lines.join(document.eol);
}

export function planStageFocusBridge(
  sourceIds: readonly string[],
  sources: ReadonlyMap<string, FocusSource>,
  targetMarkdown = `# ${FOCUS_TARGET_HEADING}\n`,
): FocusPlan {
  assertUniqueSourceIds(sourceIds);
  const parsed = parseFocusBridgeEnvelope(targetMarkdown);
  const selected = sourceIds.map((id) => {
    const source = sources.get(id);
    if (!source) throw new FocusBridgeError("source-missing", `缺少来源阶段：${id}`);
    return source;
  }).sort(compareSources);
  const orderedIds = selected.map((source) => source.id);
  if (selected.length === 0) {
    if (parsed.kind === "absent") {
      return { action: "noop", sourceIds: [], content: "", markdown: targetMarkdown };
    }
    assertEnvelopeSafeToReplace(parsed);
    return {
      action: "remove",
      sourceIds: [],
      content: "",
      markdown: replaceFocusBridgeEnvelope(targetMarkdown, null),
    };
  }
  if (parsed.kind === "present") assertEnvelopeSafeToReplace(parsed);
  const content = renderFocusBridgeEnvelope(selected);
  const markdown = replaceFocusBridgeEnvelope(targetMarkdown, content);
  return {
    action: parsed.kind === "absent" ? "insert" : markdown === targetMarkdown ? "noop" : "replace",
    sourceIds: orderedIds,
    content,
    markdown,
  };
}

function assertEnvelopeSafeToReplace(parsed: Extract<ParsedFocusEnvelope, { kind: "present" }>): void {
  for (const block of parsed.blocks) {
    if (block.state === "conflict") {
      throw new FocusBridgeError("bridge-conflict", `来源 ${block.sourceId} 的引用仍处于冲突状态`);
    }
    if (block.currentDerivedHash !== block.derivedHash) {
      throw new FocusBridgeError(
        "managed-edit-would-be-lost",
        `来源 ${block.sourceId} 的引用已被编辑，拒绝覆盖或移除`,
      );
    }
  }
}

function renderBlock(input: {
  sourceId: string;
  notePath: string;
  title: string;
  content: string;
  baseHash: string;
  sourceHash: string;
  state: FocusBridgeState;
}): string {
  const path = input.notePath.replace(/\|/g, "%7C").replace(/\]/g, "%5D");
  const title = input.title.replace(/\]/g, "\\]");
  const quoted = input.content === ""
    ? []
    : input.content.split("\n").map((line) => line === "" ? ">" : `> ${line}`);
  const visible = [
    `> [!quote] 来源：[[${path}|${title}]]`,
    ">",
    ...quoted,
  ];
  const derivedHash = focusContentHash(visible.join("\n"));
  const start = `<!-- helix-focus-source:start sourceId=${encodeURIComponent(input.sourceId)} baseHash=${input.baseHash} sourceHash=${input.sourceHash} derivedHash=${derivedHash} state=${input.state} -->`;
  return [
    start,
    ...visible,
    CHILD_END,
  ].join("\n");
}

function parseVisibleQuote(lines: readonly string[]): string {
  if (lines.length < 2 || !/^> \[!quote\] 来源：\[\[.+\]\]$/.test(lines[0]!) || lines[1] !== ">") {
    throw corrupt("来源子块的 callout 标题或分隔行损坏");
  }
  return lines.slice(2).map((line) => {
    if (line === ">") return "";
    if (line.startsWith("> ")) return line.slice(2);
    throw corrupt("来源子块存在未加引用前缀的可见内容");
  }).join("\n");
}

function joinBlocks(blocks: readonly string[]): string[] {
  return blocks.flatMap((block, index) => index === 0 ? [block] : ["", block]);
}

function assertUniqueSourceIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) {
      throw new FocusBridgeError("source-duplicate", `来源阶段 ID 重复或为空：${id}`);
    }
    seen.add(id);
  }
}

function compareSources(left: FocusSource, right: FocusSource): number {
  return (left.stageCode ?? "").localeCompare(right.stageCode ?? "", "zh-CN", { numeric: true }) ||
    left.id.localeCompare(right.id);
}

function decodeSourceId(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw corrupt("来源 ID 编码无效");
  }
}

function corrupt(message: string): FocusBridgeError {
  return new FocusBridgeError("marker-corrupt", message);
}

function markdownDocument(markdown: string): { lines: string[]; eol: "\n" | "\r\n" } {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  return { lines: markdown.replace(/\r\n?/g, "\n").split("\n"), eol };
}

function scanHeadings(lines: readonly string[]): Array<{ line: number; level: number; text: string }> {
  const result: Array<{ line: number; level: number; text: string }> = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  lines.forEach((original, line) => {
    const value = line === 0 ? original.replace(/^\uFEFF/, "") : original;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(value);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]! as "`" | "~";
      const length = fenceMatch[1]!.length;
      if (!fence) {
        fence = { marker, length };
        return;
      }
      if (marker === fence.marker && length >= fence.length && fenceMatch[2]!.trim() === "") {
        fence = null;
      }
      return;
    }
    if (fence) return;
    const match = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(value);
    if (!match) return;
    const text = match[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim();
    result.push({ line, level: match[1]!.length, text });
  });
  return result;
}

function managedMarkerLines(lines: readonly string[]): Array<{ line: number; text: string }> {
  const result: Array<{ line: number; text: string }> = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  lines.forEach((value, line) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(value);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]! as "`" | "~";
      const length = fenceMatch[1]!.length;
      if (!fence) fence = { marker, length };
      else if (marker === fence.marker && length >= fence.length && fenceMatch[2]!.trim() === "") fence = null;
      return;
    }
    if (!fence && /<!--[^>]*helix-focus|helix-focus[^<]*-->/.test(value)) {
      result.push({ line, text: value });
    }
  });
  return result;
}
