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
  /** 初建不写；首次 Helix 受管修改后才写入。 */
  "helix-updated"?: string;
}

export interface CycleFrontmatter {
  "helix-kind": typeof STAGE_KIND;
  "helix-id": string;
  "helix-project-id": string;
  "helix-project": string;
  "helix-sequence": number;
  "helix-stage-code": string;
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
helix-status: planned
${input.didaProjectId ? `helix-dida-project-id: ${input.didaProjectId}\n` : ""}
${input.color ? `helix-color: "${input.color}"\n` : ""}
helix-created: ${input.createdAt}
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
  stageCode?: string;
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
helix-stage-code: "${input.stageCode ?? String(input.sequence)}"
helix-status: ${input.status ?? "idea"}
helix-started: ${input.startedAt}
---

# 阶段 ${input.stageCode ?? input.sequence} · ${stageTitle}

${body ?? `# 本阶段问题聚焦



# 计划行动

- [ ]

# 行动结果



## 结果记录



## 学到真东西了



## 下一阶段聚焦问题
`}`;
}
