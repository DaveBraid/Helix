import {
  projectStatusFromFrontmatter,
  stageStatusFromFrontmatter,
} from "./project-status";

export interface ActiveHelixStatusTarget {
  kind: "project" | "stage";
  id: string;
  title: string;
  status: string;
}

/** 将活动 Markdown 的原始 frontmatter 映射为可编辑目标；未知值必须返回 null。 */
export function activeHelixStatusTarget(
  frontmatter: Record<string, unknown> | undefined,
  title: string | undefined,
): ActiveHelixStatusTarget | null {
  const id = frontmatter?.["helix-id"];
  if (!title || typeof id !== "string" || !id) return null;
  if (frontmatter["helix-kind"] === "helix-project") {
    const status = projectStatusFromFrontmatter(frontmatter["helix-status"]);
    return status ? { kind: "project", id, title, status } : null;
  }
  if (frontmatter["helix-kind"] === "helix-stage" || frontmatter["helix-kind"] === "helix-cycle") {
    const status = stageStatusFromFrontmatter(frontmatter["helix-status"]);
    return status ? { kind: "stage", id, title, status } : null;
  }
  return null;
}
