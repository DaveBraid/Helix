/** 当前本地正式版暂不开放任何滴答网络同步。 */
export const DIDA_SYNC_AVAILABLE = false;

/** 当前本地正式版不开放项目到滴答的投影写入。 */
export const PROJECT_DIDA_PROJECTION_AVAILABLE = false;

export function assertProjectDidaProjectionAvailable(): void {
  if (!PROJECT_DIDA_PROJECTION_AVAILABLE) {
    throw new Error("当前本地正式版暂未开放项目与滴答联动");
  }
}
