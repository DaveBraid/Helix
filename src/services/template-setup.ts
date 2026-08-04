import type { HelixTemplateManager } from "./template-manager";

export type TemplateStartupAction = "none" | "ensure-existing" | "prompt";

/** 恢复模式严格零模板写入／零设置保存。 */
export function templateStartupAction(
  recoveryMode: boolean,
  setupCompleted: boolean,
): TemplateStartupAction {
  if (recoveryMode) return "none";
  return setupCompleted ? "ensure-existing" : "prompt";
}

export async function runTemplateStartup(
  action: TemplateStartupAction,
  manager: Pick<HelixTemplateManager, "ensureDefaults">,
): Promise<string[]> {
  if (action !== "ensure-existing") return [];
  return manager.ensureDefaults();
}
