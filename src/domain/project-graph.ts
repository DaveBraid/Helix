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
export const PROJECT_GRAPH_ROW_STEP = CARD_HEIGHT + Y_GAP;
const PROJECT_TO_STAGE_GAP = 160;
const PROJECT_SIDE_PADDING = 28;
const PROJECT_TOP_PADDING = 58;
const PROJECT_BOTTOM_PADDING = 28;
const PROJECT_LANE_GAP = 72;

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
  preferredYByStage?: ReadonlyMap<string, number>,
): ProjectGraphLayout {
  const stagesByProject = new Map<string, StageLayoutNode[]>();
  for (const stage of stages) {
    const group = stagesByProject.get(stage.projectId) ?? [];
    group.push(stage);
    stagesByProject.set(stage.projectId, group);
  }
  // 调用方传入的项目顺序是完整布局的显式 lane 顺序；局部布局仍只移动 scope。
  const projectOrder = [...projects];
  const ownerRank = new Map(projectOrder.map((project, index) => [project.id, index]));
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
  const rowsByProjectDepth = new Map<string, number>();
  const laneRowsByProject = new Map<string, number>();
  for (const stage of stages) {
    const key = `${stage.projectId}\u0000${depth(stage.id)}`;
    const rows = (rowsByProjectDepth.get(key) ?? 0) + 1;
    rowsByProjectDepth.set(key, rows);
    laneRowsByProject.set(
      stage.projectId,
      Math.max(laneRowsByProject.get(stage.projectId) ?? 0, rows),
    );
  }
  const movingProjectIds = scope
    ? new Set(stages.filter((stage) => scope.has(stage.id)).map((stage) => stage.projectId))
    : new Set(projects.map((project) => project.id));
  const effectiveScope = scope
    ? new Set(stages
      .filter((stage) => scope.has(stage.id))
      .map((stage) => stage.id))
    : undefined;
  const rowByProjectDepth = new Map<string, number>();
  const laneStart = new Map<string, number>();
  if (!scope) {
    let nextLaneY = 0;
    for (const project of projectOrder) {
      const count = Math.max(1, laneRowsByProject.get(project.id) ?? 0);
      laneStart.set(project.id, nextLaneY);
      nextLaneY += count * PROJECT_GRAPH_ROW_STEP + PROJECT_LANE_GAP;
    }
  } else {
    for (const projectId of movingProjectIds) {
      laneStart.set(projectId, 0);
    }
  }
  let nextStages = orderedStages.map((stage) => {
    if (effectiveScope && !effectiveScope.has(stage.id)) return { ...stage };
    const key = `${stage.projectId}\u0000${depth(stage.id)}`;
    const row = rowByProjectDepth.get(key) ?? 0;
    rowByProjectDepth.set(key, row + 1);
    return {
      ...stage,
      x: CARD_WIDTH + PROJECT_TO_STAGE_GAP +
        (depth(stage.id) - 1) * (CARD_WIDTH + X_GAP),
      y: (laneStart.get(stage.projectId) ?? 0) + row * PROJECT_GRAPH_ROW_STEP,
    };
  });
  if (preferredYByStage && preferredYByStage.size > 0) {
    nextStages = nextStages.map((stage) => {
      const preferredY = preferredYByStage.get(stage.id);
      return preferredY === undefined ? stage : { ...stage, y: preferredY };
    });
  }
  let nextProjects = projectOrder.map((project) => {
    const projectStages = nextStages.filter((stage) => stage.projectId === project.id);
    if (scope) return { ...project };
    const top = laneStart.get(project.id) ?? 0;
    const bottom = Math.max(top, ...projectStages.map((stage) => stage.y));
    return { ...project, x: 0, y: Math.round((top + bottom) / 2) };
  });
  if (scope) {
    // Fixed projects are collision units. Treating every card as a separate
    // obstacle allowed a moving project's padded container to wrap around or
    // overlap another project even when no cards intersected.
    const fixedByProject = new Map<string, StageLayoutNode[]>();
    for (const stage of nextStages.filter((candidate) => !effectiveScope?.has(candidate.id))) {
      const group = fixedByProject.get(stage.projectId) ?? [];
      group.push(stage);
      fixedByProject.set(stage.projectId, group);
    }
    const placedMovingProjectBoxes: Array<{
      projectId: string;
      box: { x: number; y: number; right: number; bottom: number };
    }> = [];
    for (const project of projectOrder.filter((item) => movingProjectIds.has(item.id))) {
      const movingStages = nextStages.filter((stage) =>
        stage.projectId === project.id && effectiveScope?.has(stage.id));
      const original = projectStageContainerBox(movingStages);
      if (!original) continue;
      const projectRank = ownerRank.get(project.id) ?? Number.MAX_SAFE_INTEGER;
      const occupied = [
        ...[...fixedByProject.entries()].flatMap(([fixedProjectId, projectStages]) => {
          const fixedRank = ownerRank.get(fixedProjectId) ?? Number.MAX_SAFE_INTEGER;
          if (fixedProjectId !== project.id && fixedRank > projectRank) return [];
          const box = projectStageContainerBox(projectStages);
          return box ? [box] : [];
        }),
        ...placedMovingProjectBoxes
          .filter(({ projectId }) =>
            (ownerRank.get(projectId) ?? Number.MAX_SAFE_INTEGER) <= projectRank)
          .map(({ box }) => box),
      ];
      let shift = 0;
      for (;;) {
        const shifted = {
          ...original,
          y: original.y + shift,
          bottom: original.bottom + shift,
        };
        const conflicts = occupied.filter((fixed) =>
          containerBoxesOverlap(shifted, fixed));
        if (conflicts.length === 0) {
          placedMovingProjectBoxes.push({ projectId: project.id, box: shifted });
          break;
        }
        shift = Math.max(
          shift,
          ...conflicts.map((fixed) =>
            fixed.bottom + PROJECT_LANE_GAP - original.y),
        );
      }
      if (shift > 0) {
        nextStages = nextStages.map((stage) =>
          stage.projectId === project.id && effectiveScope?.has(stage.id)
            ? { ...stage, y: stage.y + shift }
            : stage);
      }
    }

    // 局部整理可以扩大一个项目容器，但不得改变显式项目顺序。按调用方
    // 提供的 helixProjectOrder 逐项向下避让；较晚项目可以移动，较早项目
    // 不会因为新增 Stage 被推到队尾。
    let previousBottom: number | undefined;
    for (const project of projectOrder) {
      const projectStages = nextStages.filter((stage) => stage.projectId === project.id);
      const box = projectStageContainerBox(projectStages);
      if (!box) continue;
      const minimumTop = previousBottom === undefined
        ? box.y
        : previousBottom + PROJECT_LANE_GAP;
      const shift = Math.max(0, minimumTop - box.y);
      if (shift > 0) {
        nextStages = nextStages.map((stage) =>
          stage.projectId === project.id
            ? { ...stage, y: stage.y + shift }
            : stage);
        nextProjects = nextProjects.map((candidate) =>
          candidate.id === project.id
            ? { ...candidate, y: candidate.y + shift }
            : candidate);
      }
      previousBottom = box.bottom + shift;
    }
  }
  return { projects: nextProjects, stages: nextStages };
}

function projectStageContainerBox(
  stages: StageLayoutNode[],
): { x: number; y: number; right: number; bottom: number } | undefined {
  if (stages.length === 0) return undefined;
  return {
    x: Math.min(...stages.map((stage) => stage.x)) - PROJECT_SIDE_PADDING,
    y: Math.min(...stages.map((stage) => stage.y)) - PROJECT_TOP_PADDING,
    right: Math.max(...stages.map((stage) => stage.x + CARD_WIDTH)) +
      PROJECT_SIDE_PADDING,
    bottom: Math.max(...stages.map((stage) => stage.y + CARD_HEIGHT)) +
      PROJECT_BOTTOM_PADDING,
  };
}

function containerBoxesOverlap(
  left: { x: number; y: number; right: number; bottom: number },
  right: { x: number; y: number; right: number; bottom: number },
): boolean {
  return left.x < right.right &&
    left.right > right.x &&
    left.y < right.bottom &&
    left.bottom > right.y;
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

export function projectedGraphIsAcyclic(
  cycleIds: Iterable<string>,
  edges: ProjectGraphEdge[],
  representativeByNode: ReadonlyMap<string, string>,
): boolean {
  const representatives = new Set<string>();
  for (const id of cycleIds) {
    representatives.add(representativeByNode.get(id) ?? id);
  }
  const pairs = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map([...representatives].map((id) => [id, 0]));
  for (const edge of edges) {
    const from = representativeByNode.get(edge.fromCycleId) ?? edge.fromCycleId;
    const to = representativeByNode.get(edge.toCycleId) ?? edge.toCycleId;
    if (from === to) continue;
    const pair = `${from}\u0000${to}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    const targets = outgoing.get(from) ?? [];
    targets.push(to);
    outgoing.set(from, targets);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const queue = [...indegree]
    .filter(([, value]) => value === 0)
    .map(([id]) => id);
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
  return visited === representatives.size;
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
