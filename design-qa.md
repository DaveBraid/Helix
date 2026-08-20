# 设计验收：统一任务详情页

最后更新：2026-08-20

## 对照范围

- 设计来源：`/var/folders/vv/5ssln5h12vz4y1b8gbp2x05c0000gn/T/codex-clipboard-545dfda1-6cff-4c00-b84a-8e6bde903dc0.png`
- 实现入口：`src/ui/unified-task-detail-modal.ts`
- 领域与适配契约：`src/domain/task-detail.ts`
- 适配接线：`src/ui/helix-view.ts`
- 样式：`styles.css`
- 基准视口：1600 × 960 CSS px；窄窗口：720 × 960 CSS px。

## 验收证据

- 同屏对照：`/private/tmp/helix-task-detail-comparison.png`。
- Stage 投影详情：`/private/tmp/helix-unified-stage-final.png`。
- 窄窗口：`/private/tmp/helix-unified-narrow.png`，详情内容横向溢出为 0。
- 暗色主题：`/private/tmp/helix-unified-dark.png`。
- Obsidian CLI 实机确认 Stage 投影面包屑、Markdown 权威同步状态与 3 个计划行动；普通滴答任务显示清单同步状态与“更多属性”。

## 检查结果

- 通过：单一模态框、直接标题编辑、属性矩阵、日历、时间点／时间段、标签、子任务进度、增删改与拖拽能力入口、删除／取消／保存。
- 通过：标题旁无重复铅笔；无备注大区、时区文案、“滴答扩展”或“Helix 关联”。
- 通过：普通滴答、Stage 计划行动、Stage 投影父任务共用相同 DOM 与视觉，仅由 capabilities 控制可编辑能力。
- 通过：保存失败路径保留草稿并保持弹窗打开；各适配器只写自己的权威源。
- 通过：亮色、暗色、720px 窄窗口；键盘使用原生可聚焦控件，Escape／取消不保存。
- 有意限制：普通滴答子任务新增／删除／排序与 Stage 根行动排序在相应写入合同缺失时保持禁用，不伪造成功。

最终结果：通过。
