/** 滴答远端只读能力；独立于任何写入门禁。 */
export const DIDA_READ_AVAILABLE = true;

/** 普通滴答清单／任务写入；只读开放时仍可保持关闭。 */
export const DIDA_TASK_WRITE_AVAILABLE = false;

/** 会创建临时远端对象的专用写入合同测试。 */
export const DIDA_CONTRACT_TEST_AVAILABLE = false;

/** 当前本地正式版不开放项目到滴答的投影写入。 */
export const PROJECT_DIDA_PROJECTION_AVAILABLE = false;

export function assertProjectDidaProjectionAvailable(): void {
  if (!PROJECT_DIDA_PROJECTION_AVAILABLE) {
    throw new Error("当前本地正式版暂未开放项目与滴答联动");
  }
}
