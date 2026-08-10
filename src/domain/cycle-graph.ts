export type CycleRelationKind = "inherit" | "branch" | "merge";

export interface CycleRelation {
  id: string;
  kind: CycleRelationKind;
  fromCycleIds: string[];
  toCycleId: string;
}

export const CYCLE_RELATION_LABELS: Record<CycleRelationKind, string> = {
  inherit: "推进",
  branch: "分支",
  merge: "合并",
};

export interface StageCreationIntent {
  relation: CycleRelationKind;
  predecessorIds: string[];
  convertedInheritanceRelationIds: string[];
  convertedInheritanceSourceIds: string[];
}

export function stageCreationIntent(
  sourceCycleIds: string[],
  relations: CycleRelation[],
): StageCreationIntent {
  const predecessorIds = [...new Set(sourceCycleIds.filter(Boolean))];
  if (predecessorIds.length === 0) {
    throw new Error("至少需要一个来源阶段");
  }
  const sources = new Set(predecessorIds);
  const convertedInheritances = relations.filter((relation) =>
    relation.kind === "inherit" &&
    relation.fromCycleIds.some((sourceId) => sources.has(sourceId)));
  if (predecessorIds.length > 1) {
    return {
      relation: "merge",
      predecessorIds,
      convertedInheritanceRelationIds: convertedInheritances.map((relation) => relation.id),
      convertedInheritanceSourceIds: convertedInheritances.flatMap(
        (relation) => relation.fromCycleIds,
      ),
    };
  }
  const sourceCycleId = predecessorIds[0]!;
  const outgoing = relations.filter((item) =>
    item.fromCycleIds.includes(sourceCycleId));
  return {
    relation: outgoing.length > 0 ? "branch" : "inherit",
    predecessorIds,
    convertedInheritanceRelationIds: convertedInheritances.map((relation) => relation.id),
    convertedInheritanceSourceIds: convertedInheritances.flatMap(
      (relation) => relation.fromCycleIds,
    ),
  };
}

export function cycleRelationKindFromLabel(
  label: unknown,
): CycleRelationKind | null {
  if (label === "inherit" || label === "branch" || label === "merge") {
    return label;
  }
  if (label === "继承" || label === "推进") return "inherit";
  if (label === "分支") return "branch";
  if (label === "合并") return "merge";
  return null;
}

export function assertCycleRelationInput(
  kind: CycleRelationKind,
  predecessorIds: string[],
): string[] {
  const unique = [...new Set(predecessorIds.filter(Boolean))];
  if ((kind === "inherit" || kind === "branch") && unique.length !== 1) {
    throw new Error(`${CYCLE_RELATION_LABELS[kind]}必须选择 1 个前置阶段`);
  }
  if (kind === "merge" && unique.length < 2) {
    throw new Error("合并必须选择至少 2 个前置阶段");
  }
  return unique;
}

export function validateCycleGraph(
  cycleIds: string[],
  relations: CycleRelation[],
): void {
  if (new Set(cycleIds).size !== cycleIds.length) {
    throw new Error("阶段 ID 重复");
  }
  const known = new Set(cycleIds);
  const edges: Array<{ from: string; to: string }> = [];
  const edgeKeys = new Set<string>();
  const incoming = new Map<string, CycleRelation[]>();
  const outgoing = new Map<string, CycleRelation[]>();
  for (const relation of relations) {
    const predecessors = assertCycleRelationInput(
      relation.kind,
      relation.fromCycleIds,
    );
    if (!known.has(relation.toCycleId)) {
      throw new Error(`阶段关系指向不存在的目标：${relation.toCycleId}`);
    }
    for (const predecessor of predecessors) {
      if (!known.has(predecessor)) {
        throw new Error(`阶段关系引用不存在的前置：${predecessor}`);
      }
      if (predecessor === relation.toCycleId) {
        throw new Error("阶段不能指向自身");
      }
      const edgeKey = `${predecessor}\u0000${relation.toCycleId}`;
      if (edgeKeys.has(edgeKey)) {
        throw new Error(`阶段关系重复：${predecessor} → ${relation.toCycleId}`);
      }
      edgeKeys.add(edgeKey);
      edges.push({ from: predecessor, to: relation.toCycleId });
      const sourceRelations = outgoing.get(predecessor) ?? [];
      sourceRelations.push(relation);
      outgoing.set(predecessor, sourceRelations);
    }
    const targetRelations = incoming.get(relation.toCycleId) ?? [];
    targetRelations.push(relation);
    incoming.set(relation.toCycleId, targetRelations);
  }
  for (const [target, targetRelations] of incoming) {
    if (targetRelations.length > 1) {
      throw new Error(`阶段 ${target} 同时存在多组入边关系`);
    }
  }
  for (const [source, sourceRelations] of outgoing) {
    const kinds = new Set(sourceRelations.map((relation) => relation.kind));
    if (kinds.has("inherit") && sourceRelations.length > 1) {
      throw new Error(`阶段 ${source} 已有后继，继续扩展必须显式转换为分支`);
    }
    const branchCount = sourceRelations.filter(
      (relation) => relation.kind === "branch",
    ).length;
    if (branchCount === 1 && sourceRelations.length === 1) {
      throw new Error(`阶段 ${source} 的分支只有一个目标`);
    }
    if (branchCount > 0 && kinds.has("inherit")) {
      throw new Error(`阶段 ${source} 的分支出边不能与继承关系混用`);
    }
  }
  assertAcyclic(cycleIds, edges);
}

function assertAcyclic(
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
): void {
  const outgoing = new Map(nodes.map((node) => [node, [] as string[]]));
  const indegree = new Map(nodes.map((node) => [node, 0]));
  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const ready = nodes.filter((node) => (indegree.get(node) ?? 0) === 0);
  let visited = 0;
  while (ready.length > 0) {
    const node = ready.shift()!;
    visited += 1;
    for (const next of outgoing.get(node) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) ready.push(next);
    }
  }
  if (visited !== nodes.length) throw new Error("阶段关系形成了环");
}
