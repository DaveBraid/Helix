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

## “更多属性”折叠热修复验收

- 设计事实：用户问题截图 `/var/folders/vv/5ssln5h12vz4y1b8gbp2x05c0000gn/T/codex-clipboard-1475d6f8-255a-4a8a-995f-710747613e75.png`，2336 × 1284 px，亮色主题、折叠态。
- 实现证据：`/private/tmp/helix-more-properties-fixed.png`，4990 × 2820 px；Obsidian 实际窗口由 CLI 原样截图，CSS 密度沿用当前桌面窗口。
- 同屏对照：`/private/tmp/helix-more-properties-comparison.png`，3200 × 900 px；左右等高归一化，仅聚焦模态框及折叠栏区域。
- 展开态证据：`/private/tmp/helix-more-properties-open.png`；折叠与展开均只有一个 Helix 箭头，摘要保持同一行，展开内容正常出现。
- 字体与排版：标题、摘要字号和字重沿用统一任务详情页；折叠栏高度实测 42 px，标签与摘要基线差约 2 px。
- 间距与布局：摘要改为单行 flex，右侧摘要自动贴右；未引入宽度溢出或额外行高。
- 颜色与视觉变量：未更改主题变量、边框或背景；明亮主题对比度保持原有实现。
- 图像与图标：没有新增图像资产；隐藏浏览器／主题注入的原生伪元素，仅保留现有图标库渲染的 Helix 箭头。
- 文案：保留“更多属性”和“清单 · 提醒 · 重复”，不新增说明文字。
- 交互与错误：CLI 实测折叠 → 展开 → 折叠；控制台与错误缓冲均为空；取消关闭弹窗且未保存、未写入滴答。
- 比较历史：初始问题为原生／主题 disclosure 与自定义箭头重复，且三列 grid 使摘要换行；修复后以 `summary::before`、marker 抑制及 flex 布局消除，复查未发现 P0/P1/P2。
- 聚焦区域足以判断本轮目标；其余任务详情页未发生视觉或行为变更。

## 纯缩进递归任务树验收

- 设计来源：`/var/folders/vv/5ssln5h12vz4y1b8gbp2x05c0000gn/T/codex-clipboard-48633b97-29ee-4ac3-ad57-d7fae7b19045.png`，1827 × 861 px；亮色、展开态、三级任务树。
- 实现截图：`/private/tmp/helix-task-tree-final.jpg`，1353 × 768 px；Obsidian 实际窗口、亮色、展开态。当前应用缩放与设计图密度不同，因此只对内容区等宽归一化，不把缩放造成的字号差异记为缺陷。
- 全视图同屏对照：`/private/tmp/helix-task-tree-comparison.png`，2000 × 900 px；左右各 1000 px 归一化。
- 聚焦同屏对照：`/private/tmp/helix-task-tree-focused-comparison.png`，2000 × 900 px；用于检查箭头、进度圆、三级缩进、摘要与元数据对齐。
- 字体与排版：标题 16 px、摘要 14 px、元数据 13 px；标题最多两行，摘要单行截断，信息层级与参考一致。
- 间距与布局：扁平行 DOM 按深度计算 30 px 缩进，六级后压缩并设视觉上限；无连接线、导轨、层级角标、独立卡片或阴影。仅标题行高 70 px，含摘要 92 px。
- 颜色与视觉变量：行背景默认透明，只有悬停／聚焦时出现极淡主题色；边界和状态颜色均使用 Obsidian 主题变量，未引入固定亮色背景。
- 图像与图标：没有新增图片资产；箭头、完成勾和省略号均使用 Obsidian 图标库，尺寸与笔画风格统一。
- 文案与内容：父节点显示直属子任务 `完成数/总数`；叶节点显示普通完成控件；来源、清单、标签、日期作为次级信息，未添加解释文案。
- 交互：实机验证三级递归展开、单节点收起／恢复、会话内折叠保持及悬停菜单；折叠不触发远端写入。父任务完成只切换父任务本身，不静默级联子项。
- 拖拽：实现顶层与新父节点目标提示；领域测试拒绝任务成为自身或后代。仅已通过父子任务合同的普通滴答任务可拖动，本地 Stage 任务保持只读层级。
- 性能：稳定任务 ID 作为缓存键，未变化行复用原 DOM；重绘保存纵横滚动位置，折叠仅改变对应子树。71 个测试文件、1001 项测试通过。
- 比较历史：初次实现已满足参考图的纯缩进、圆形进度和扁平行结构；终检补齐拖拽结束态清理与父进度成功反馈，复查未发现 P0/P1/P2。当前应用缩放造成的视觉密度差异属于验收环境差异，不影响实际 CSS 尺寸。

final result: passed
