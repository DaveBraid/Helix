export interface DirectedEdge {
  from: string;
  to: string;
}

export function assertDag(nodes: Iterable<string>, edges: DirectedEdge[]): void {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const edge of edges) {
    if (edge.from === edge.to) throw new Error("项目不能继承自身");
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) throw new Error("项目继承关系必须是有向无环图");
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of adjacency.get(node) ?? []) visit(target);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of adjacency.keys()) visit(node);
}

export function wouldCreateCycle(edges: DirectedEdge[], candidate: DirectedEdge): boolean {
  try {
    assertDag(
      new Set([...edges.flatMap((edge) => [edge.from, edge.to]), candidate.from, candidate.to]),
      [...edges, candidate],
    );
    return false;
  } catch {
    return true;
  }
}
