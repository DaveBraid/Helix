import type { CycleRelation, CycleRelationKind } from "./cycle-graph";

export interface ProjectGraphEdge {
  id: string;
  fromCycleId: string;
  toCycleId: string;
}

export interface NormalizedProjectGraph {
  edges: Array<ProjectGraphEdge & {
    kind: CycleRelationKind;
    mergeGroupId?: string;
  }>;
  relations: CycleRelation[];
}

export interface StageLayoutNode {
  id: string;
  projectId: string;
  sequence: number;
  x: number;
  y: number;
}

export interface ProjectLayoutNode {
  id: string;
  x: number;
  y: number;
}

export interface ProjectGraphLayout {
  projects: ProjectLayoutNode[];
  stages: StageLayoutNode[];
}

export interface DeletionBridgeCandidate {
  fromCycleId: string;
  toCycleId: string;
  existing: boolean;
  crossProject: boolean;
}

const X_GAP = 160;
const Y_GAP = 72;
const CARD_WIDTH = 248;
const CARD_HEIGHT = 128;
const PROJECT_TO_STAGE_GAP = 160;

export function normalizeProjectGraph(
  cycleIds: Iterable<string>,
  physicalEdges: ProjectGraphEdge[],
): NormalizedProjectGraph {
  const known = new Set(cycleIds);
  const pairs = new Set<string>();
  const indegree = new Map<string, number>();
  const outdegree = new Map<string, number>();
  for (const edge of physicalEdges) {
    if (!known.has(edge.fromCycleId) || !known.has(edge.toCycleId)) {
      throw new Error("项目关系引用了不存在的阶段");
    }
    if (edge.fromCycleId === edge.toCycleId) throw new Error("阶段不能连接到自身");
    const pair = `${edge.fromCycleId}\u0000${edge.toCycleId}`;
    if (pairs.has(pair)) throw new Error("两个阶段之间存在重复关系");
    pairs.add(pair);
    indegree.set(edge.toCycleId, (indegree.get(edge.toCycleId) ?? 0) + 1);
    outdegree.set(edge.fromCycleId, (outdegree.get(edge.fromCycleId) ?? 0) + 1);
  }
  assertAcyclic(known, physicalEdges);

  const normalizedEdges = physicalEdges.map((edge) => {
    const kind: CycleRelationKind = (indegree.get(edge.toCycleId) ?? 0) >= 2
      ? "merge"
      : (outdegree.get(edge.fromCycleId) ?? 0) >= 2
        ? "branch"
        : "inherit";
    return {
      ...edge,
      kind,
      ...(kind === "merge"
        ? { mergeGroupId: `helix-merge-${edge.toCycleId}` }
        : {}),
    };
  });
  const relations: CycleRelation[] = [];
  const mergeTargets = new Map<string, typeof normalizedEdges>();
  for (const edge of normalizedEdges) {
    if (edge.kind === "merge") {
      const group = mergeTargets.get(edge.toCycleId) ?? [];
      group.push(edge);
      mergeTargets.set(edge.toCycleId, group);
    } else {
      relations.push({
        id: edge.id,
        kind: edge.kind,
        fromCycleIds: [edge.fromCycleId],
        toCycleId: edge.toCycleId,
      });
    }
  }
  for (const [target, edges] of mergeTargets) {
    const sorted = [...edges].sort((left, right) =>
      left.fromCycleId.localeCompare(right.fromCycleId) || left.id.localeCompare(right.id));
    relations.push({
      id: `helix-merge-${target}`,
      kind: "merge",
      fromCycleIds: sorted.map((edge) => edge.fromCycleId),
      toCycleId: target,
    });
  }
  relations.sort((left, right) =>
    left.toCycleId.localeCompare(right.toCycleId) || left.id.localeCompare(right.id));
  return { edges: normalizedEdges, relations };
}

export function affectedWeakComponent(
  seeds: Iterable<string>,
  edges: ProjectGraphEdge[],
): Set<string> {
  const result = new Set(seeds);
  const queue = [...result];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.fromCycleId !== current && edge.toCycleId !== current) continue;
      const other = edge.fromCycleId === current ? edge.toCycleId : edge.fromCycleId;
      if (result.has(other)) continue;
      result.add(other);
      queue.push(other);
    }
  }
  return result;
}

export function planDeletionBridges(
  cycleId: string,
  edges: ProjectGraphEdge[],
  ownerByCycle: ReadonlyMap<string, string>,
): DeletionBridgeCandidate[] {
  const predecessors = [...new Set(edges
    .filter((edge) => edge.toCycleId === cycleId)
    .map((edge) => edge.fromCycleId))].sort();
  const successors = [...new Set(edges
    .filter((edge) => edge.fromCycleId === cycleId)
    .map((edge) => edge.toCycleId))].sort();
  return predecessors.flatMap((fromCycleId) =>
    successors.flatMap((toCycleId) => {
      if (fromCycleId === toCycleId) return [];
      return [{
        fromCycleId,
        toCycleId,
        existing: edges.some((edge) =>
          edge.fromCycleId === fromCycleId && edge.toCycleId === toCycleId),
        crossProject: ownerByCycle.get(fromCycleId) !== ownerByCycle.get(toCycleId),
      }];
    }));
}

export function planProjectGraphLayout(
  projects: ProjectLayoutNode[],
  stages: StageLayoutNode[],
  edges: ProjectGraphEdge[],
  scope?: ReadonlySet<string>,
): ProjectGraphLayout {
  const projectOrder = [...projects].sort((left, right) =>
    left.y - right.y || left.x - right.x || left.id.localeCompare(right.id));
  const ownerRank = new Map(projectOrder.map((project, index) => [project.id, index]));
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.toCycleId) ?? [];
    list.push(edge.fromCycleId);
    incoming.set(edge.toCycleId, list);
  }
  const memo = new Map<string, number>();
  const depth = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const predecessors = incoming.get(id) ?? [];
    const value = predecessors.length === 0
      ? 1
      : 1 + Math.max(...predecessors.map(depth));
    memo.set(id, value);
    return value;
  };
  for (const stage of stages) depth(stage.id);

  const orderedStages = [...stages].sort((left, right) =>
    (ownerRank.get(left.projectId) ?? Number.MAX_SAFE_INTEGER) -
      (ownerRank.get(right.projectId) ?? Number.MAX_SAFE_INTEGER) ||
    depth(left.id) - depth(right.id) ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id));
  const rowByProjectDepth = new Map<string, number>();
  const laneStart = new Map<string, number>();
  let nextLaneY = 0;
  for (const project of projectOrder) {
    const count = Math.max(1, stages.filter((stage) => stage.projectId === project.id).length);
    laneStart.set(project.id, nextLaneY);
    nextLaneY += count * (CARD_HEIGHT + Y_GAP) + Y_GAP;
  }
  let nextStages = orderedStages.map((stage) => {
    if (scope && !scope.has(stage.id)) return { ...stage };
    const key = `${stage.projectId}\u0000${depth(stage.id)}`;
    const row = rowByProjectDepth.get(key) ?? 0;
    rowByProjectDepth.set(key, row + 1);
    return {
      ...stage,
      x: CARD_WIDTH + PROJECT_TO_STAGE_GAP +
        (depth(stage.id) - 1) * (CARD_WIDTH + X_GAP),
      y: (laneStart.get(stage.projectId) ?? 0) + row * (CARD_HEIGHT + Y_GAP),
    };
  });
  let nextProjects = projectOrder.map((project) => {
    const projectStages = nextStages.filter((stage) => stage.projectId === project.id);
    if (scope && !projectStages.some((stage) => scope.has(stage.id))) return { ...project };
    const top = laneStart.get(project.id) ?? 0;
    const bottom = Math.max(top, ...projectStages.map((stage) => stage.y));
    return { ...project, x: 0, y: Math.round((top + bottom) / 2) };
  });
  if (scope) {
    const movingProjectIds = new Set(nextStages
      .filter((stage) => scope.has(stage.id))
      .map((stage) => stage.projectId));
    const movingBoxes = (): Array<{ x: number; y: number }> => [
      ...nextProjects
        .filter((project) => movingProjectIds.has(project.id))
        .map(({ x, y }) => ({ x, y })),
      ...nextStages
        .filter((stage) => scope.has(stage.id))
        .map(({ x, y }) => ({ x, y })),
    ];
    const fixedBoxes = [
      ...nextProjects
        .filter((project) => !movingProjectIds.has(project.id))
        .map(({ x, y }) => ({ x, y })),
      ...nextStages
        .filter((stage) => !scope.has(stage.id))
        .map(({ x, y }) => ({ x, y })),
    ];
    let shift = 0;
    while (movingBoxes().some((moving) =>
      fixedBoxes.some((fixed) =>
        boxesOverlap({ ...moving, y: moving.y + shift }, fixed)))) {
      shift += CARD_HEIGHT + Y_GAP;
    }
    if (shift > 0) {
      nextStages = nextStages.map((stage) =>
        scope.has(stage.id) ? { ...stage, y: stage.y + shift } : stage);
      nextProjects = nextProjects.map((project) =>
        movingProjectIds.has(project.id) ? { ...project, y: project.y + shift } : project);
    }
  }
  return { projects: nextProjects, stages: nextStages };
}

function boxesOverlap(
  left: { x: number; y: number },
  right: { x: number; y: number },
): boolean {
  return Math.abs(left.x - right.x) < CARD_WIDTH + X_GAP / 2 &&
    Math.abs(left.y - right.y) < CARD_HEIGHT + Y_GAP / 2;
}

export function collapsedClosedComponents(
  projectStageIds: string[],
  closedStageIds: ReadonlySet<string>,
  edges: ProjectGraphEdge[],
): Array<{ headId: string; memberIds: string[] }> {
  const candidates = new Set(projectStageIds.filter((id) => closedStageIds.has(id)));
  const seen = new Set<string>();
  const components: Array<{ headId: string; memberIds: string[] }> = [];
  for (const start of [...candidates].sort()) {
    if (seen.has(start)) continue;
    const memberIds: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      memberIds.push(current);
      for (const edge of edges) {
        if (!candidates.has(edge.fromCycleId) || !candidates.has(edge.toCycleId)) continue;
        if (edge.fromCycleId !== current && edge.toCycleId !== current) continue;
        const other = edge.fromCycleId === current ? edge.toCycleId : edge.fromCycleId;
        if (!seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
      }
    }
    if (memberIds.length < 2) continue;
    const members = new Set(memberIds);
    const heads = memberIds.filter((id) =>
      !edges.some((edge) => edge.toCycleId === id && members.has(edge.fromCycleId)));
    components.push({
      headId: [...(heads.length > 0 ? heads : memberIds)].sort()[0]!,
      memberIds: memberIds.sort(),
    });
  }
  return components;
}

function assertAcyclic(
  cycleIds: ReadonlySet<string>,
  edges: ProjectGraphEdge[],
): void {
  const outgoing = new Map<string, string[]>();
  const indegree = new Map([...cycleIds].map((id) => [id, 0]));
  for (const edge of edges) {
    const targets = outgoing.get(edge.fromCycleId) ?? [];
    targets.push(edge.toCycleId);
    outgoing.set(edge.fromCycleId, targets);
    indegree.set(edge.toCycleId, (indegree.get(edge.toCycleId) ?? 0) + 1);
  }
  const queue = [...indegree].filter(([, value]) => value === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;
    for (const target of outgoing.get(current) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (visited !== cycleIds.size) throw new Error("阶段关系不能形成环");
}
