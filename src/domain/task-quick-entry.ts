import type { DidaProject } from "./entities";

export interface TaskQuickEntryResult {
  title: string;
  projectId?: string;
  tags: string[];
  priority?: 0 | 1 | 3 | 5;
  issues: string[];
}

export interface TaskQuickSuggestion {
  kind: "project" | "tag" | "priority";
  label: string;
  token: string;
  detail?: string;
}

export interface AppliedTaskQuickSuggestion {
  value: string;
  cursor: number;
}

export function shouldSubmitTaskQuickEntryOnKey(key: string, isComposing: boolean): boolean {
  return key === "Enter" && !isComposing;
}

const PRIORITIES = new Map<string, 0 | 1 | 3 | 5>([
  ["高", 5], ["高优先级", 5], ["high", 5], ["1", 5],
  ["中", 3], ["中优先级", 3], ["medium", 3],
  ["低", 1], ["低优先级", 1], ["low", 1],
  ["无", 0], ["无优先级", 0], ["none", 0], ["0", 0],
]);

const PRIORITY_SUGGESTIONS: TaskQuickSuggestion[] = [
  { kind: "priority", label: "高", token: "!高", detail: "高优先级" },
  { kind: "priority", label: "中", token: "!中", detail: "中优先级" },
  { kind: "priority", label: "低", token: "!低", detail: "低优先级" },
  { kind: "priority", label: "无", token: "!无", detail: "清除优先级" },
];

export function taskQuickSuggestions(
  input: string,
  cursor: number,
  projects: DidaProject[],
  tags: string[],
): TaskQuickSuggestion[] {
  const active = activeQuickToken(input, cursor);
  if (!active) return [];
  const { trigger } = active;
  const query = active.token.slice(1).replace(/^"|"$/gu, "").toLocaleLowerCase();
  if (trigger === "~") {
    const nameCounts = new Map<string, number>();
    for (const project of projects) {
      const name = project.name.toLocaleLowerCase();
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    return projects
      .filter((project) =>
        !project.name.includes('"') &&
        nameCounts.get(project.name.toLocaleLowerCase()) === 1 &&
        project.name.toLocaleLowerCase().includes(query)
      )
      .map((project) => ({
        kind: "project" as const,
        label: project.name,
        token: /[\s#~!]/u.test(project.name) ? `~"${project.name}"` : `~${project.name}`,
        detail: "清单",
      }));
  }
  if (trigger === "#") {
    return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
      .filter((tag) => !/[\s#~!]/u.test(tag) && tag.toLocaleLowerCase().includes(query))
      .sort((left, right) => left.localeCompare(right, "zh-CN"))
      .map((tag) => ({ kind: "tag" as const, label: tag, token: `#${tag}`, detail: "标签" }));
  }
  return PRIORITY_SUGGESTIONS.filter((suggestion) =>
    suggestion.label.toLocaleLowerCase().includes(query) ||
    suggestion.detail?.toLocaleLowerCase().includes(query)
  );
}

export function applyTaskQuickSuggestion(
  input: string,
  cursor: number,
  suggestion: TaskQuickSuggestion,
): AppliedTaskQuickSuggestion {
  const position = Math.max(0, Math.min(cursor, input.length));
  const active = activeQuickToken(input, position);
  const expectedKind = active?.trigger === "~"
    ? "project"
    : active?.trigger === "#"
      ? "tag"
      : active?.trigger === "!"
        ? "priority"
        : undefined;
  if (!active || suggestion.kind !== expectedKind) return { value: input, cursor: position };
  const suffix = input.slice(active.end);
  const separator = suffix.startsWith(" ") ? "" : " ";
  const value = `${input.slice(0, active.start)}${suggestion.token}${separator}${suffix}`;
  return { value, cursor: active.start + suggestion.token.length + separator.length };
}

function activeQuickToken(
  input: string,
  cursor: number,
): { start: number; end: number; token: string; trigger: "~" | "#" | "!" } | null {
  const position = Math.max(0, Math.min(cursor, input.length));
  let start = position;
  while (start > 0 && !/\s/u.test(input[start - 1]!)) start -= 1;
  let end = position;
  while (end < input.length && !/\s/u.test(input[end]!)) end += 1;
  const token = input.slice(start, end);
  const trigger = token[0];
  if (trigger !== "~" && trigger !== "#" && trigger !== "!") return null;
  if (/[~#!]/u.test(token.slice(1))) return null;
  return { start, end, token, trigger };
}

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
