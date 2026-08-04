import type { HelixCycle, HelixProject } from "./entities";

export const PROJECT_KIND = "helix-project";
export const STAGE_KIND = "helix-stage";
export const LEGACY_CYCLE_KIND = "helix-cycle";

export interface ProjectFrontmatter {
  "helix-kind": typeof PROJECT_KIND;
  "helix-id": string;
  "helix-status": HelixProject["status"];
  "helix-area"?: string;
  "helix-color"?: string;
  "helix-dida-project-id"?: string;
  "helix-parents"?: string[];
  "helix-active-cycle"?: string;
  "helix-created": string;
  "helix-updated": string;
}

export interface CycleFrontmatter {
  "helix-kind": typeof STAGE_KIND;
  "helix-id": string;
  "helix-project-id": string;
  "helix-project": string;
  "helix-sequence": number;
  "helix-status": HelixCycle["status"];
  "helix-started"?: string;
  "helix-closed"?: string;
}

export function projectTemplate(input: {
  id: string;
  title: string;
  createdAt: string;
  didaProjectId?: string;
  color?: string;
}, body?: string): string {
  return `---
helix-kind: ${PROJECT_KIND}
helix-id: ${input.id}
helix-status: active
${input.didaProjectId ? `helix-dida-project-id: ${input.didaProjectId}\n` : ""}
${input.color ? `helix-color: "${input.color}"\n` : ""}
helix-created: ${input.createdAt}
helix-updated: ${input.createdAt}
---

# ${input.title}

${body ?? `> [!info] 项目背景
> 这个项目为什么值得开展？它解决什么问题？

## 当前状态

- 当前阶段：
- 下一里程碑：
- 主要风险：

## 项目资料

`}`;
}

export function cycleTemplate(input: {
  id: string;
  projectId?: string;
  projectLink: string;
  sequence: number;
  startedAt: string;
  status?: HelixCycle["status"];
  stageTitle?: string;
}, body?: string): string {
  const stageTitle = input.stageTitle?.trim() || "未命名阶段";
  return `---
helix-kind: ${STAGE_KIND}
helix-id: ${input.id}
${input.projectId ? `helix-project-id: ${input.projectId}\n` : ""}
helix-project: "${input.projectLink}"
helix-sequence: ${input.sequence}
helix-status: ${input.status ?? "active"}
helix-started: ${input.startedAt}
---

# 阶段 ${input.sequence} · ${stageTitle}

${body ?? `> [!question] 本轮起因
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

`}`;
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
