import type { TaskMatrixRules } from "../domain/task-views";
import { SerializedRunner } from "./serialized-runner";

/**
 * 串行保存显示规则，并且只在持久化成功后发布到运行时。
 * 这样快速连续修改或单次写入失败都不会制造内存与磁盘分叉。
 */
export class TaskMatrixRuleUpdater {
  constructor(private readonly runner: SerializedRunner) {}

  update(
    rules: TaskMatrixRules,
    persist: (snapshot: TaskMatrixRules) => Promise<void>,
    publish: (snapshot: TaskMatrixRules) => void,
  ): Promise<void> {
    const snapshot = { ...rules };
    return this.runner.run(async () => {
      await persist(snapshot);
      publish(snapshot);
    });
  }
}
