/** 0.1.0 个人预览版不开放项目到滴答的投影写入。 */
export const PROJECT_DIDA_PROJECTION_AVAILABLE = false;

export function assertProjectDidaProjectionAvailable(): void {
  if (!PROJECT_DIDA_PROJECTION_AVAILABLE) {
    throw new Error("0.1.0 个人预览版暂未开放项目与滴答联动");
  }
}
