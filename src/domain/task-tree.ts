import type { DidaTask } from "./entities";

export interface TaskTreeRow {
  task: DidaTask;
  depth: number;
  hasChildren: boolean;
  directChildCount: number;
  completedDirectChildCount: number;
  expanded: boolean;
}

export interface TaskTreeOptions {
  collapsedIds?: ReadonlySet<string>;
  progressTasks?: readonly DidaTask[];
}

export function isTaskCompleted(task: DidaTask): boolean {
  return task.status === 2;
}

/** 保持原相对顺序，只把已完成同级任务稳定地下移。 */
export function completionLast(tasks: readonly DidaTask[]): DidaTask[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) =>
      Number(isTaskCompleted(left.task)) - Number(isTaskCompleted(right.task)) ||
      left.index - right.index)
    .map(({ task }) => task);
}

/**
 * 按真实 parentId 展开任务树。父任务不在当前筛选结果中时，子任务作为根展示；
 * 循环或损坏关系不会丢任务，而是降级为根节点。
 */
export function flattenTaskTree(
  tasks: readonly DidaTask[],
  options: TaskTreeOptions = {},
): TaskTreeRow[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, DidaTask[]>();
  const progressChildren = new Map<string, DidaTask[]>();
  const roots: DidaTask[] = [];
  for (const task of tasks) {
    const parentId = task.parentId || undefined;
    if (!parentId || parentId === task.id || !byId.has(parentId)) {
      roots.push(task);
      continue;
    }
    const group = children.get(parentId) ?? [];
    group.push(task);
    children.set(parentId, group);
  }
  for (const task of options.progressTasks ?? tasks) {
    const parentId = task.parentId || undefined;
    if (!parentId || parentId === task.id) continue;
    const group = progressChildren.get(parentId) ?? [];
    group.push(task);
    progressChildren.set(parentId, group);
  }
  const rows: TaskTreeRow[] = [];
  const visited = new Set<string>();
  const suppress = (task: DidaTask): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    for (const child of children.get(task.id) ?? []) suppress(child);
  };
  const visit = (task: DidaTask, depth: number): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    const directChildren = progressChildren.get(task.id) ?? [];
    const hasChildren = directChildren.length > 0;
    const expanded = hasChildren && !options.collapsedIds?.has(task.id);
    rows.push({
      task,
      depth,
      hasChildren,
      directChildCount: directChildren.length,
      completedDirectChildCount: directChildren.filter(isTaskCompleted).length,
      expanded,
    });
    if (hasChildren && !expanded) {
      for (const child of children.get(task.id) ?? []) suppress(child);
      return;
    }
    for (const child of completionLast(children.get(task.id) ?? [])) visit(child, depth + 1);
  };
  for (const root of completionLast(roots)) visit(root, 0);
  // 关系环中的节点不会从 roots 到达；稳定追加并确保全部任务可见。
  for (const task of completionLast(tasks.filter((candidate) => !visited.has(candidate.id)))) {
    visit(task, 0);
  }
  return rows;
}

/** 拒绝把任务移动到自身或任意后代之下；损坏关系按最保守方式拒绝。 */
export function canReparentTask(
  tasks: readonly DidaTask[],
  taskId: string,
  nextParentId?: string | null,
): boolean {
  if (!nextParentId) return true;
  if (taskId === nextParentId) return false;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  let cursor: string | undefined = nextParentId;
  while (cursor) {
    if (cursor === taskId || visited.has(cursor)) return false;
    visited.add(cursor);
    cursor = byId.get(cursor)?.parentId || undefined;
  }
  return true;
}

export function withTaskDescendants(
  tasks: readonly DidaTask[],
  selectedIds: ReadonlySet<string>,
): Set<string> {
  const result = new Set(selectedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (!task.parentId || !result.has(task.parentId) || result.has(task.id)) continue;
      result.add(task.id);
      changed = true;
    }
  }
  return result;
}
