import type { HelixTemplateManager } from "./template-manager";

export interface TemplateSettingsState {
  templateFolder: string;
  templateSetupCompleted: boolean;
}

/**
 * 设置切换的发布边界：恢复模式在接触模板前拒绝；模板管理器负责
 * 补齐与失败回滚，本协调器只在持久化成功后发布运行时设置。
 */
export async function configureTemplateSettings<T extends TemplateSettingsState>(input: {
  recoveryMode: boolean;
  folder: string;
  manager: Pick<HelixTemplateManager, "configure">;
  /** 在模板管理器串行锁内读取并持久化最新设置，返回已提交版本。 */
  persist: (folder: string) => Promise<T>;
  publish: (next: T) => void;
}): Promise<string[]> {
  if (input.recoveryMode) {
    throw new Error("Helix 当前处于只读恢复模式，不能设置模板目录");
  }
  let committed: T | null = null;
  return input.manager.configure(
    input.folder,
    async (folder) => {
      committed = await input.persist(folder);
    },
    () => {
      if (!committed) throw new Error("模板设置尚未持久化，拒绝发布运行时目录");
      input.publish(committed);
    },
  );
}
