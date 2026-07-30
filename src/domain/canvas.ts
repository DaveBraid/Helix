import { assertDag, type DirectedEdge } from "./dag";

export interface CanvasNode extends Record<string, unknown> {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  file?: string;
}

export interface CanvasEdge extends Record<string, unknown> {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
  fromEnd?: string;
  toEnd?: string;
}

export interface CanvasDocument extends Record<string, unknown> {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const MANAGED_LABEL = "derives-from";
const MANAGED_FLAG = "helixManaged";

export function managedLineage(document: CanvasDocument): DirectedEdge[] {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  return document.edges
    .filter((edge) => isLineageEdge(document, edge))
    .map((edge) => ({
      from: String(nodes.get(edge.fromNode)?.helixProjectId ?? ""),
      to: String(nodes.get(edge.toNode)?.helixProjectId ?? ""),
    }));
}

export function validateLineageCanvas(document: CanvasDocument): void {
  const nodeIds = document.nodes.map((node) => node.id);
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new Error("项目谱系 Canvas 含重复节点 ID，已进入只读降级");
  }
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const managedProjectIds = document.nodes
    .filter((node) => node.helixManaged === true)
    .map((node) => {
      if (!isManagedProjectNode(node)) {
        throw new Error(`托管节点 ${node.id} 缺少有效 helixProjectId，已进入只读降级`);
      }
      return node.helixProjectId as string;
    });
  if (new Set(managedProjectIds).size !== managedProjectIds.length) {
    throw new Error("项目谱系 Canvas 含重复 helixProjectId，已进入只读降级");
  }
  for (const edge of document.edges.filter((candidate) => candidate[MANAGED_FLAG] === true)) {
    const from = nodes.get(edge.fromNode);
    const to = nodes.get(edge.toNode);
    if (!isManagedProjectNode(from) || !isManagedProjectNode(to)) {
      throw new Error(`托管谱系边 ${edge.id} 引用了缺失或非 Helix 项目节点，已进入只读降级`);
    }
  }
  assertDag(managedProjectIds, managedLineage(document));
}

export function adoptProjectLineageEdges(
  document: CanvasDocument,
): CanvasDocument {
  const source = structuredClone(document);
  const candidates = source.edges.filter(
    (edge) =>
      edge[MANAGED_FLAG] !== true &&
      (edge.label === undefined || edge.label === "" || edge.label === MANAGED_LABEL) &&
      isLineageEdge(source, edge),
  );
  const candidateIds = new Set(candidates.map((edge) => edge.id));
  const next: CanvasDocument = {
    ...source,
    nodes: source.nodes,
    edges: source.edges.filter((edge) => !candidateIds.has(edge.id)),
  };
  validateLineageCanvas(next);
  for (const edge of candidates) {
    const managed = {
      ...edge,
      [MANAGED_FLAG]: true,
      label: MANAGED_LABEL,
      fromEnd: edge.fromEnd ?? "none",
      toEnd: edge.toEnd ?? "arrow",
    };
    const trial = { ...next, edges: [...next.edges, managed] };
    try {
      validateLineageCanvas(trial);
      next.edges = trial.edges;
    } catch {
      // 只丢弃本次导致成环的新手绘边；已有托管谱系损坏仍在上方抛错。
    }
  }
  return next;
}

export function upsertManagedEdge(
  document: CanvasDocument,
  edge: CanvasEdge,
): CanvasDocument {
  const next = structuredClone(document);
  const managedEdge: CanvasEdge = {
    ...edge,
    label: MANAGED_LABEL,
    [MANAGED_FLAG]: true,
    fromEnd: edge.fromEnd ?? "none",
    toEnd: edge.toEnd ?? "arrow",
  };
  const index = next.edges.findIndex((candidate) => candidate.id === managedEdge.id);
  if (index === -1) next.edges.push(managedEdge);
  else next.edges[index] = { ...next.edges[index], ...managedEdge };
  validateLineageCanvas(next);
  return next;
}

export function removeManagedEdge(
  document: CanvasDocument,
  edgeId: string,
): CanvasDocument {
  const next = structuredClone(document);
  const edge = next.edges.find((candidate) => candidate.id === edgeId);
  if (edge?.[MANAGED_FLAG] === true) {
    next.edges = next.edges.filter((candidate) => candidate.id !== edgeId);
  }
  return next;
}

function isLineageEdge(
  document: CanvasDocument,
  edge: CanvasEdge,
): boolean {
  if (edge[MANAGED_FLAG] === true) return true;
  if (edge.label !== undefined && edge.label !== "" && edge.label !== MANAGED_LABEL) {
    return false;
  }
  const from = document.nodes.find((node) => node.id === edge.fromNode);
  const to = document.nodes.find((node) => node.id === edge.toNode);
  return (
    from?.helixManaged === true &&
    typeof from.helixProjectId === "string" &&
    to?.helixManaged === true &&
    typeof to.helixProjectId === "string"
  );
}

function isManagedProjectNode(node: CanvasNode | undefined): boolean {
  return !!node &&
    node.helixManaged === true &&
    typeof node.helixProjectId === "string" &&
    node.helixProjectId.length > 0;
}
