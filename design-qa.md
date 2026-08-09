# Canvas 身份提示、项目边框与任务日期视觉验收

## 证据

- 项目源图：`/var/folders/vv/5ssln5h12vz4y1b8gbp2x05c0000gn/T/codex-clipboard-9308c234-99ce-447c-8dbc-9e3cd88f88bf.png`
- 项目实现图：`/private/tmp/helix-project-border-v4.png`
- 项目聚焦并排图：`/private/tmp/helix-project-border-comparison.png`（左为源图，右为实现）
- 日期月历实现图：`/private/tmp/helix-task-calendar.png`
- viewport：Obsidian 1.13.4 桌面端；项目实现 2790 × 1846 px，日期实现同一窗口；源图 914 × 586 px。
- normalization：项目实现裁出 965 × 594 px 容器区域并等比缩放到 412 px 高；源图等比缩放到同高后左右并排，未拉伸。
- state：深色主题；项目页显示单阶段项目；任务详情月历打开，42 个日期单元完整呈现。

## Findings

- 无未关闭 P0/P1/P2。
- [P3] 源图缩放更近，实现图保留更多容器周围画布；聚焦并排已经统一高度，足以检查四边线宽和卡片顶部色条。
- [P3] 月历没有独立视觉源图，只能按用户描述和现有 Dense task canvas 令牌验收，未宣称像素级复刻外部产品。

## 比较历史

1. P1：项目容器左侧存在 `inset 3px` 强调，视觉上四边不等宽。已删除单侧内阴影，改为统一 1 px 边框和轻外阴影；并排图显示四边一致。
2. P1：阶段卡片顶部色条受到旧 `inset: 0 auto 0 0; width: 4px` 规则影响，只剩左上短线。已显式覆盖为 `inset: -1px -1px auto; width: auto; height: 4px`，实现图显示整条项目色顶边。
3. P1：任务日期依赖平台原生日期输入，不能稳定点选。已改为模态内月历弹层，支持上下月、42 日网格、今天、清除和单击选定后自动收起。
4. P2：已经恢复的数据仍可能留下无限时长的旧身份警告 Notice。已在启动时跨 Obsidian 窗口清理不再对应当前 `recoveryIssues` 的提示，并统一跟踪、卸载时关闭新增长提示；重载后恢复模式关闭、问题数组为空、可见身份警告为 0。

## 验收面

- 字体与排版：沿用 Obsidian 字体与 Dense task canvas 的 14 px 基础字号；月历标题 14 px、日期 12 px，信息可读。
- 间距与布局：容器四边 1 px；顶部色条 4 px；月历 286 px，7 列等距，未挤压属性矩阵。
- 色彩与令牌：边框、阴影、月历背景和选中态全部使用 Obsidian／Helix 主题变量，明暗主题兼容。
- 图像与资产：无位图或自绘 SVG；箭头、日历等图标复用 Obsidian 图标库。
- 文案与行为：日期支持选择、跨月、今天、清除；选定后立即回填并收起，不写入滴答。
- 交互与错误：Obsidian CLI 实测 42 个日期按钮；重载后 `recoveryMode=false`、`recoveryIssues=[]`、工作区身份错误为空。

final result: passed
