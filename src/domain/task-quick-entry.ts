import type { DidaProject } from "./entities";

export interface TaskQuickEntryResult {
  title: string;
  projectId?: string;
  tags: string[];
  priority?: 0 | 1 | 3 | 5;
  issues: string[];
}

const PRIORITIES = new Map<string, 0 | 1 | 3 | 5>([
  ["高", 5], ["高优先级", 5], ["high", 5], ["1", 5],
  ["中", 3], ["中优先级", 3], ["medium", 3],
  ["低", 1], ["低优先级", 1], ["low", 1],
  ["无", 0], ["无优先级", 0], ["none", 0], ["0", 0],
]);

/**
 * 解析 Helix 明确支持的快捷属性。只移除已确认的 token；未知清单或优先级
 * 会保留在标题并返回问题，避免静默改写用户输入。
 */
export function parseTaskQuickEntry(
  input: string,
  projects: DidaProject[],
): TaskQuickEntryResult {
  const issues: string[] = [];
  const tags: string[] = [];
  let projectId: string | undefined;
  let priority: 0 | 1 | 3 | 5 | undefined;
  const projectsByName = new Map<string, DidaProject[]>();
  for (const project of projects) {
    const key = project.name.toLocaleLowerCase();
    projectsByName.set(key, [...(projectsByName.get(key) ?? []), project]);
  }
  const tokenPattern = /(^|\s)(#([^\s#~!]+)|~(?:"([^"]+)"|([^\s#~!]+))|!([^\s#~!]+))/gu;
  const matches = [...input.matchAll(tokenPattern)];
  const resolvedProjectIds = new Set<string>();
  const resolvedPriorities = new Set<0 | 1 | 3 | 5>();
  for (const match of matches) {
    const name = match[4] ?? match[5];
    if (name) {
      const candidates = projectsByName.get(name.toLocaleLowerCase()) ?? [];
      if (candidates.length === 0) pushUnique(issues, `找不到清单“${name}”`);
      else if (candidates.length > 1) pushUnique(issues, `存在多个同名清单“${name}”，请先明确选择`);
      else resolvedProjectIds.add(candidates[0]!.id);
    }
    const priorityToken = match[6];
    if (priorityToken) {
      const value = PRIORITIES.get(priorityToken.toLocaleLowerCase());
      if (value === undefined) pushUnique(issues, `无法识别优先级“!${priorityToken}”`);
      else resolvedPriorities.add(value);
    }
  }
  if (resolvedProjectIds.size > 1) pushUnique(issues, "快捷输入包含多个不同清单");
  if (resolvedPriorities.size > 1) pushUnique(issues, "快捷输入包含多个不同优先级");
  const title = input.replace(tokenPattern, (whole, prefix: string, token: string,
    tag: string | undefined, quotedList: string | undefined, bareList: string | undefined,
    priorityToken: string | undefined) => {
    if (tag) {
      if (!tags.includes(tag)) tags.push(tag);
      return prefix;
    }
    if (quotedList || bareList) {
      const name = quotedList ?? bareList!;
      const candidates = projectsByName.get(name.toLocaleLowerCase()) ?? [];
      if (candidates.length !== 1 || resolvedProjectIds.size > 1) {
        return whole;
      }
      projectId = candidates[0]!.id;
      return prefix;
    }
    if (priorityToken) {
      const value = PRIORITIES.get(priorityToken.toLocaleLowerCase());
      if (value === undefined || resolvedPriorities.size > 1) {
        return whole;
      }
      priority = value;
      return prefix;
    }
    return token;
  }).replace(/\s+/gu, " ").trim();
  return { title, projectId, tags, priority, issues };
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}
