import { editorLivePreviewField } from "obsidian";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { managedActionMarkerSpans } from "../domain/dida-project-projection";

export interface TextRange {
  from: number;
  to: number;
}

const EXACT_MARKERS = [
  /^<!-- helix-focus-bridge:start version=1 -->$/,
  /^<!-- helix-focus-bridge:end -->$/,
  /^<!-- helix-focus-source:start sourceId=[^ ]+ baseHash=[0-9a-f]{64} sourceHash=[0-9a-f]{64} derivedHash=[0-9a-f]{64} state=(?:synced|conflict) -->$/,
  /^<!-- helix-focus-source:end -->$/,
];

function intersects(left: TextRange, right: TextRange): boolean {
  if (right.from === right.to) return right.from >= left.from && right.from <= left.to;
  return left.from < right.to && right.from < left.to;
}

function lines(source: string): Array<TextRange & { text: string }> {
  const result: Array<TextRange & { text: string }> = [];
  let from = 0;
  while (from <= source.length) {
    const newline = source.indexOf("\n", from);
    const rawTo = newline < 0 ? source.length : newline;
    const to = rawTo > from && source[rawTo - 1] === "\r" ? rawTo - 1 : rawTo;
    result.push({ from, to, text: source.slice(from, to) });
    if (newline < 0) break;
    from = newline + 1;
  }
  return result;
}

/** 只识别精确 focus 标记行及合法任务行末的 action marker；其他注释永远不匹配。 */
export function hiddenHelixMarkerRanges(
  source: string,
  selections: readonly TextRange[] = [],
): TextRange[] {
  const ranges: TextRange[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (const line of lines(source)) {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line.text)?.[1];
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`);
      if (closing.test(line.text)) fence = undefined;
      continue;
    }
    if (opening) {
      fence = { marker: opening[0] as "`" | "~", length: opening.length };
      continue;
    }
    if (EXACT_MARKERS.some((pattern) => pattern.test(line.text)) &&
      !selections.some((selection) => intersects(line, selection))) {
      // ViewPlugin 装饰不得改变垂直布局；只替换标记字符，保留换行与空行高度。
      ranges.push(line);
    }
  }
  try {
    for (const marker of managedActionMarkerSpans(source)) {
      if (!selections.some((selection) => intersects(marker, selection))) ranges.push(marker);
    }
  } catch {
    // 损坏、编码非 canonical、重复身份或 checkbox/state 不一致时必须保持 marker 可见。
  }
  return ranges;
}

function decorations(view: EditorView): DecorationSet {
  if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;
  const selections = view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
  return Decoration.set(hiddenHelixMarkerRanges(view.state.doc.toString(), selections)
    .map((range) => Decoration.replace({}).range(range.from, range.to)), true);
}

export const helixMarkerVisibilityExtension = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = decorations(view);
  }

  update(update: ViewUpdate): void {
    const livePreviewChanged = update.startState.field(editorLivePreviewField, false) !==
      update.state.field(editorLivePreviewField, false);
    if (update.docChanged || update.selectionSet || livePreviewChanged) {
      this.decorations = decorations(update.view);
    }
  }
}, {
  decorations: (instance) => instance.decorations,
});
