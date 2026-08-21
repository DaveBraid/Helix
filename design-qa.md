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

- 本轮设计来源：`/var/folders/vv/5ssln5h12vz4y1b8gbp2x05c0000gn/T/codex-clipboard-f6bfcd70-f44c-44cb-9dff-f17146b08f4c.png`，843 × 1120 px；另以两张任务详情截图核对完成语义与父子计数。
- 实现截图：`/private/tmp/helix-task-tree-final.png`，1242 × 1410 px；Obsidian 1.13.7 实际窗口、亮色、Helix Projects、展开态。
- 同屏对照：`/private/tmp/helix-task-tree-final-comparison.png`，1830 × 1120 px；来源保持 843 × 1120，实现在不改变宽高比的前提下归一到 1120 px 高。CSS 视口沿用当前 Obsidian 窗口，设备像素比由 Electron 原样截图。
- 全视图证据：任务标题、次级信息和状态标签仍保持原有 13／10 px 紧凑层级；完成控件没有挤压或截断任务正文。
- 聚焦证据：CLI 计算样式确认叶节点完成圆为 24 × 24 px、父节点完成／进度圆为 44 × 44 px，均为 `999px` 圆角；完成态为绿色实心并包含 Obsidian `check` 图标，未完成父节点按直属子任务比例显示圆环。
- 间距与布局：父任务和同级普通任务标题起点一致；子级缩进从 30 px 收紧为 18 px，深层增量为 10 px；折叠箭头位于行右侧，不再占用标题前方空间。
- 颜色与视觉变量：圆环沿用 `--interactive-accent`，完成填充沿用 `--color-green`；背景、边界和文字仍由 Obsidian 主题变量控制。
- 图像与图标：没有新增图像资产；完成勾、折叠箭头均来自 Obsidian 图标库。
- 文案与内容：父节点未完成时显示直属子任务 `完成数/总数`，父节点本身完成后改为绿色勾选；来源和 Stage 状态仍作为次级信息。
- 交互与数据：CLI 临时创建一条 Stage 行动后，它立即出现在当前 `Helix Projects` 清单，随后安全删除并确认消失；完成态 Stage 父任务以 Markdown 状态为权威。自动同步与项目投影均保持关闭，未请求滴答远端。
- 运行时：Obsidian 错误缓冲为空；71 个测试文件、1009 项测试以及 typecheck、build、release:check、diff-check 全部通过。
- 比较历史：本轮初始 P1 为 Stage 详情已显示完成而任务树父圆仍显示 `0/2`；P2 为完成圆无填充、圆形受主题影响、缩进过宽且箭头占据左侧。修复后父任务与叶任务均显示严格圆形绿色勾选，父任务未完成时保留比例环，箭头移至右侧；同屏与计算样式复核未发现剩余 P0/P1/P2。

final result: passed
