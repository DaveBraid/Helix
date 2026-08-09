export interface StageCodeCandidate {
  code?: string;
  sequence: number;
}

export interface MaintainedStageCodeCandidate extends StageCodeCandidate {
  id: string;
}

export interface StageCodeRelation {
  kind: "inherit" | "branch" | "merge";
  fromCycleIds: readonly string[];
  toCycleId: string;
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
  const used = new Set(siblings
    .map((candidate) => parseStageCode(candidate.code))
    .filter((value): value is { major: number; branch?: number } => Boolean(value))
    .filter((value) => value.major === major && value.branch !== undefined)
    .map((value) => value.branch!));
  const result: string[] = [];
  let branch = minimumBranch;
  while (result.length < count) {
    if (!Number.isSafeInteger(branch)) throw new Error("阶段展示编号已达到安全上限");
    if (!used.has(branch)) result.push(`${major}.${branch}`);
    branch += 1;
  }
  return result;
}

/**
 * 按当前 DAG 维护用户可见编号；物理 sequence 不参与重用。
 * 普通继承／合并推进大编号，同一来源的并行分支共享大编号并紧凑排列小编号。
 */
export function maintainedStageCodes(
  stages: readonly MaintainedStageCodeCandidate[],
  relations: readonly StageCodeRelation[],
): Map<string, string> {
  const ordered = [...stages].sort((left, right) =>
    left.sequence - right.sequence || left.id.localeCompare(right.id));
  const stageIds = new Set(ordered.map((stage) => stage.id));
  const incoming = new Map(relations
    .filter((relation) => stageIds.has(relation.toCycleId))
    .map((relation) => [relation.toCycleId, relation] as const));
  const branchTargets = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.kind !== "branch" || relation.fromCycleIds.length !== 1 ||
      !stageIds.has(relation.toCycleId)) continue;
    const sourceId = relation.fromCycleIds[0]!;
    const targets = branchTargets.get(sourceId) ?? [];
    targets.push(relation.toCycleId);
    branchTargets.set(sourceId, targets);
  }
  const sequenceById = new Map(ordered.map((stage) => [stage.id, stage.sequence] as const));
  for (const targets of branchTargets.values()) {
    targets.sort((left, right) =>
      (sequenceById.get(left) ?? 0) - (sequenceById.get(right) ?? 0) || left.localeCompare(right));
  }

  const result = new Map<string, string>();
  let largestMajor = 0;
  for (const stage of ordered) {
    const relation = incoming.get(stage.id);
    if (relation?.kind === "branch" && relation.fromCycleIds.length === 1) {
      const source = parseStageCode(result.get(relation.fromCycleIds[0]!) ?? "");
      if (source) {
        const major = source.major + 1;
        const rank = (branchTargets.get(relation.fromCycleIds[0]!)?.indexOf(stage.id) ?? -1) + 1;
        if (rank > 0 && Number.isSafeInteger(major)) {
          result.set(stage.id, `${major}.${rank}`);
          largestMajor = Math.max(largestMajor, major);
          continue;
        }
      }
    }
    const predecessorMajor = relation?.fromCycleIds.reduce((maximum, id) =>
      Math.max(maximum, parseStageCode(result.get(id) ?? "")?.major ?? 0), 0) ?? 0;
    const major = Math.max(largestMajor + 1, predecessorMajor + 1, 1);
    if (!Number.isSafeInteger(major)) throw new Error("阶段展示编号已达到安全上限");
    result.set(stage.id, String(major));
    largestMajor = major;
  }
  return result;
}
