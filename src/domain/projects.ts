import type { HelixCycle, HelixProject } from "./entities";

export const PROJECT_KIND = "helix-project";
export const CYCLE_KIND = "helix-cycle";

export interface ProjectFrontmatter {
  "helix-kind": typeof PROJECT_KIND;
  "helix-id": string;
  "helix-status": HelixProject["status"];
  "helix-area"?: string;
  "helix-dida-project-id"?: string;
  "helix-parents"?: string[];
  "helix-active-cycle"?: string;
  "helix-created": string;
  "helix-updated": string;
}

export interface CycleFrontmatter {
  "helix-kind": typeof CYCLE_KIND;
  "helix-id": string;
  "helix-project": string;
  "helix-sequence": number;
  "helix-status": HelixCycle["status"];
  "helix-predecessor"?: string;
  "helix-started"?: string;
  "helix-closed"?: string;
}

export function projectTemplate(input: {
  id: string;
  title: string;
  createdAt: string;
  didaProjectId?: string;
  activeCycleLink?: string;
}): string {
  return `---
helix-kind: ${PROJECT_KIND}
helix-id: ${input.id}
helix-status: active
${input.didaProjectId ? `helix-dida-project-id: ${input.didaProjectId}\n` : ""}
helix-parents: []
${input.activeCycleLink ? `helix-active-cycle: "${input.activeCycleLink}"\n` : ""}
helix-created: ${input.createdAt}
helix-updated: ${input.createdAt}
---

# ${input.title}

> [!info] 项目背景
> 这个项目为什么值得开展？它解决什么问题？

## 当前状态

- 当前 Cycle：
- 下一里程碑：
- 主要风险：

## 项目资料

`;
}

export function cycleTemplate(input: {
  id: string;
  projectLink: string;
  sequence: number;
  startedAt: string;
  predecessorLink?: string;
  status?: HelixCycle["status"];
}): string {
  const padded = String(input.sequence).padStart(2, "0");
  return `---
helix-kind: ${CYCLE_KIND}
helix-id: ${input.id}
helix-project: "${input.projectLink}"
helix-sequence: ${input.sequence}
helix-status: ${input.status ?? "active"}
${input.predecessorLink ? `helix-predecessor: "${input.predecessorLink}"\n` : ""}helix-started: ${input.startedAt}
---

# Cycle ${padded}

> [!question] 本轮起因
> 哪个观察、问题或上一轮结论触发了本轮？

> [!todo] 开展计划
> 本轮要验证什么？成功和停止条件分别是什么？

## 执行证据

- 关联任务：
- 实验或产物：
- 关键观察：

> [!success] 执行效果
> 实际结果与计划相比如何？哪些假设被支持或推翻？

> [!tip] 下一步计划
> 下一轮保留、调整或停止什么？

`;
}

export function assertCycleTransition(
  cycle: HelixCycle,
  nextStatus: HelixCycle["status"],
): void {
  const allowed: Record<HelixCycle["status"], HelixCycle["status"][]> = {
    planned: ["active"],
    active: ["closed"],
    closed: [],
  };
  if (!allowed[cycle.status].includes(nextStatus)) {
    throw new Error(`Invalid cycle transition: ${cycle.status} -> ${nextStatus}`);
  }
}
