# Canvas 卡片、任务日期与原位状态菜单视觉验收

## 证据

- 项目源图：`/var/folders/vv/5ssln5h12vz4y1b8gbp2x05c0000gn/T/codex-clipboard-9308c234-99ce-447c-8dbc-9e3cd88f88bf.png`
- 项目实现图：`/private/tmp/helix-project-border-v4.png`
- 项目聚焦并排图：`/private/tmp/helix-project-border-comparison.png`（左为源图，右为实现）
- 日期月历实现图：`/private/tmp/helix-task-calendar.png`
- 时间占位源图：`/var/folders/vv/5ssln5h12vz4y1b8gbp2x05c0000gn/T/codex-clipboard-126a2957-fbec-49e7-a78e-5c06e7706169.png`
- 时间占位实现图：`/private/tmp/helix-inline-status-selects-v2.png`
- 时间占位并排图：`/private/tmp/helix-time-placeholders-comparison.png`（左为修复前，右为修复后）
- 原位状态菜单实现图：`/private/tmp/helix-status-popover-fixed.png`
- 原位状态聚焦图：`/private/tmp/helix-status-popover-focused.png`
- 原位状态并排图：`/private/tmp/helix-status-popover-comparison.png`（左为原卡片外观，右为菜单打开状态）
- 状态间距源图：`/var/folders/vv/5ssln5h12vz4y1b8gbp2x05c0000gn/T/codex-clipboard-47c13c4c-aa6e-4a55-ac91-2cab36278b8c.png`
- 状态间距实现图：`/private/tmp/helix-status-popover-spaced.png`
- 状态间距并排图：`/private/tmp/helix-status-popover-spacing-comparison.png`（左为选项相连，右为 4 px 等距）
- viewport：Obsidian 1.13.4 桌面端；项目实现 2790 × 1846 px，日期实现同一窗口；源图 914 × 586 px。
- normalization：项目实现裁出 965 × 594 px 容器区域并等比缩放到 412 px 高；源图等比缩放到同高后左右并排，未拉伸。
- state：深色主题；项目页显示单阶段项目；任务详情月历打开，42 个日期单元完整呈现。
- time/state：任务时间段为空，两个 `--:--` 完整显示且未越过属性单元；阶段状态为右上角原样按钮，5 项 Helix 菜单保持打开等待选择，无状态模态。

## Findings

- 无未关闭 P0/P1/P2。
- [P3] 源图缩放更近，实现图保留更多容器周围画布；聚焦并排已经统一高度，足以检查四边线宽和卡片顶部色条。
- [P3] 月历没有独立视觉源图，只能按用户描述和现有 Dense task canvas 令牌验收，未宣称像素级复刻外部产品。

## 比较历史

1. P1：项目容器左侧存在 `inset 3px` 强调，视觉上四边不等宽。已删除单侧内阴影，改为统一 1 px 边框和轻外阴影；并排图显示四边一致。
2. P1：阶段卡片顶部色条受到旧 `inset: 0 auto 0 0; width: 4px` 规则影响，只剩左上短线。已显式覆盖为 `inset: -1px -1px auto; width: auto; height: 4px`，实现图显示整条项目色顶边。
3. P1：任务日期依赖平台原生日期输入，不能稳定点选。已改为模态内月历弹层，支持上下月、42 日网格、今天、清除和单击选定后自动收起。
4. P2：已经恢复的数据仍可能留下无限时长的旧身份警告 Notice。已在启动时跨 Obsidian 窗口清理不再对应当前 `recoveryIssues` 的提示，并统一跟踪、卸载时关闭新增长提示；重载后恢复模式关闭、问题数组为空、可见身份警告为 0。
5. P1：两个原生时间输入的 `--:--` 被平台时钟图标裁断；单纯放宽会越过标签属性。已隐藏重复的原生指示器、保留点击唤起 `showPicker()`，将两个输入收紧到 70 px；并排图显示两组占位完整且不重叠。
6. P2：项目与阶段状态原先点击后打开独立模态。初版原位实现使用原生 `select`，在缩放、拖拽 Canvas 中点击后会立即收起，且包装层移动了阶段状态位置。已恢复原来的右上角“图标＋状态”按钮，并改为挂载在文档层的 Helix 菜单；并排图确认卡片外观和对齐未变。菜单跨独立 CLI 事件仍保持打开，实测 `idea → paused → idea` 写入及恢复成功，点击外部／Escape 才关闭，未出现状态模态或控制台错误。
7. P2：菜单选项原先无垂直间隔，连续背景使各状态粘连。已为菜单网格增加统一 4 px 间距；实机测得四处间隔均为 4 px，并排图显示边界清晰且菜单仍保持紧凑。

## 验收面

- 字体与排版：沿用 Obsidian 字体与 Dense task canvas 的 14 px 基础字号；月历标题 14 px、日期 12 px，信息可读。
- 间距与布局：容器四边 1 px；顶部色条 4 px；月历 286 px，7 列等距，未挤压属性矩阵。
- 色彩与令牌：边框、阴影、月历背景和选中态全部使用 Obsidian／Helix 主题变量，明暗主题兼容。
- 图像与资产：无位图或自绘 SVG；箭头、日历等图标复用 Obsidian 图标库。
- 文案与行为：日期支持选择、跨月、今天、清除；时间段为空时稳定显示 `--:-- – --:--`；项目／阶段状态就地选择，菜单含五种状态、当前项勾选、键盘方向键与 Escape。
- 交互与错误：Obsidian CLI 实测菜单跨事件保持打开、5 项完整、无模态，并完成阶段状态往返保存与恢复；控制台无错误。

final result: passed
