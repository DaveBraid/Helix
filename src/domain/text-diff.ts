export type TextDiffTone = "unchanged" | "removed" | "added" | "empty";

export interface SideBySideTextDiffRow {
  leftNumber?: number;
  rightNumber?: number;
  leftText: string;
  rightText: string;
  leftTone: TextDiffTone;
  rightTone: TextDiffTone;
}

type Edit = { kind: "equal" | "delete" | "insert"; text: string };

function linesOf(value: string): string[] {
  return value.replace(/\r\n?/g, "\n").split("\n");
}

function editsOf(left: string[], right: string[]): Edit[] {
  const lengths = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] = left[i] === right[j]
        ? 1 + lengths[i + 1]![j + 1]!
        : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      edits.push({ kind: "equal", text: left[i]! });
      i += 1;
      j += 1;
    } else if (j < right.length && (i >= left.length || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)) {
      edits.push({ kind: "insert", text: right[j]! });
      j += 1;
    } else {
      edits.push({ kind: "delete", text: left[i]! });
      i += 1;
    }
  }
  return edits;
}

export function sideBySideTextDiff(leftValue: string, rightValue: string): SideBySideTextDiffRow[] {
  const edits = editsOf(linesOf(leftValue), linesOf(rightValue));
  const rows: SideBySideTextDiffRow[] = [];
  let leftNumber = 1;
  let rightNumber = 1;
  let index = 0;
  while (index < edits.length) {
    const edit = edits[index]!;
    if (edit.kind === "equal") {
      rows.push({
        leftNumber: leftNumber++,
        rightNumber: rightNumber++,
        leftText: edit.text,
        rightText: edit.text,
        leftTone: "unchanged",
        rightTone: "unchanged",
      });
      index += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (index < edits.length && edits[index]!.kind !== "equal") {
      const changed = edits[index]!;
      if (changed.kind === "delete") removed.push(changed.text);
      else added.push(changed.text);
      index += 1;
    }
    const count = Math.max(removed.length, added.length);
    for (let offset = 0; offset < count; offset += 1) {
      const leftText = removed[offset];
      const rightText = added[offset];
      rows.push({
        leftNumber: leftText === undefined ? undefined : leftNumber++,
        rightNumber: rightText === undefined ? undefined : rightNumber++,
        leftText: leftText ?? "",
        rightText: rightText ?? "",
        leftTone: leftText === undefined ? "empty" : "removed",
        rightTone: rightText === undefined ? "empty" : "added",
      });
    }
  }
  return rows;
}
