export interface StageCodeCandidate {
  code?: string;
  sequence: number;
}

/** 仅接受一级分支编号，避免把关系层级编码进无限小数。 */
export function parseStageCode(value: unknown): { major: number; branch?: number } | null {
  if (typeof value !== "string") return null;
  const matched = /^([1-9]\d*)(?:\.([1-9]\d*))?$/.exec(value.trim());
  if (!matched) return null;
  const major = Number(matched[1]);
  const branch = matched[2] === undefined ? undefined : Number(matched[2]);
  if (!Number.isSafeInteger(major) || major < 1 ||
      (branch !== undefined && (!Number.isSafeInteger(branch) || branch < 1))) return null;
  return { major, branch };
}

export function stageCodeOrSequence(candidate: StageCodeCandidate): string {
  return parseStageCode(candidate.code) ? candidate.code!.trim() : String(candidate.sequence);
}

export function nextMajorStageCode(candidates: readonly StageCodeCandidate[]): string {
  const largest = candidates.reduce((max, candidate) =>
    Math.max(max, parseStageCode(candidate.code)?.major ?? candidate.sequence), 0);
  if (!Number.isSafeInteger(largest) || largest >= Number.MAX_SAFE_INTEGER) {
    throw new Error("阶段展示编号已达到安全上限");
  }
  return String(largest + 1);
}

export function nextUnusedMajorStageCode(
  candidates: readonly StageCodeCandidate[],
  minimum: number,
): string {
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new Error("阶段展示编号已达到安全上限");
  }
  const used = new Set(candidates.flatMap((candidate) => {
    const parsed = parseStageCode(candidate.code);
    return parsed ? [parsed.major] : [];
  }));
  let value = minimum;
  while (used.has(value)) {
    if (value >= Number.MAX_SAFE_INTEGER) throw new Error("阶段展示编号已达到安全上限");
    value += 1;
  }
  return String(value);
}

export function nextBranchStageCodes(
  source: StageCodeCandidate,
  siblings: readonly StageCodeCandidate[],
  count: number,
  minimumBranch = 1,
): string[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("分支数量无效");
  if (!Number.isSafeInteger(minimumBranch) || minimumBranch < 1) {
    throw new Error("分支编号下限无效");
  }
  const sourceMajor = parseStageCode(source.code)?.major ?? source.sequence;
  const major = sourceMajor + 1;
  if (!Number.isSafeInteger(major)) throw new Error("阶段展示编号已达到安全上限");
  const used = siblings
    .map((candidate) => parseStageCode(candidate.code))
    .filter((value): value is { major: number; branch?: number } => Boolean(value))
    .filter((value) => value.major === major && value.branch !== undefined)
    .map((value) => value.branch!);
  let branch = Math.max(used.length === 0 ? 1 : Math.max(...used) + 1, minimumBranch);
  if (!Number.isSafeInteger(branch + count - 1)) throw new Error("阶段展示编号已达到安全上限");
  return Array.from({ length: count }, () => `${major}.${branch++}`);
}
