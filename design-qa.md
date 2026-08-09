# 冲突中心视觉验收

- source visual truth path: `/var/folders/vv/5ssln5h12vz4y1b8gbp2x05c0000gn/T/codex-clipboard-ea337a37-dca3-4e8c-be29-31a766afcb16.png`
- user-reported implementation path: `/var/folders/vv/5ssln5h12vz4y1b8gbp2x05c0000gn/T/codex-clipboard-4da469a7-e2c0-4f21-b546-ac0098f2b25d.png`
- final implementation screenshot path: `/private/tmp/helix-conflict-ide-v2.png`
- full-view comparison: `/private/tmp/helix-conflict-ide-full-compare.png`
- focused IDE comparison: `/private/tmp/helix-conflict-ide-focus-compare-v2.png`
- viewport: Obsidian 桌面端深色模式；实现截图 4970 × 2820 px，约对应 2485 × 1410 CSS px，device scale factor 2。
- dimensions and normalization: 源图 1487 × 1058 px；全景比较将实现图等比缩放到 1058 px 高后并排。局部比较裁切源图 IDE 区域 `1015 × 360`、实现图 IDE 区域 `3600 × 800`，均等比缩放到 520 px 高后并排，未拉伸。
- state: 六类仅内存拟真冲突；任务正文冲突选中，正文为 7 行 Markdown，其他三个属性冲突默认折叠。
- primary interactions tested: 并排视图渲染 14 个左右行单元；统一视图渲染 11 行并恢复并排；所有冲突按钮扫描无文字溢出；属性冲突可展开；未触发真实写回。
- console errors checked: 冲突渲染与交互无异常；捕获到一条 Electron `ResizeObserver loop completed`，来自既有观察器循环，未影响本界面。

## 对照结论

实现已具备源图的 IDE 式原文差异：真实行号、等宽字体、本地／远端双栏、未变行、删除红底、新增绿底、空行对齐、行范围标题及两侧采用按钮。统一视图使用单栏 `−／＋` 行流，不再只是视觉开关。Base 共同基线保留在标题区，其他标量属性按需展开，首屏结构与源图一致。

冲突中心关键正文提高到 12–13 px、1.4–1.6 行高；对象标题为 13 px，步骤标题为 13 px。所有按钮改为自适应高度与正常换行，自动扫描结果为 0 个 `scrollWidth > clientWidth` 溢出项。

## 比较历史

1. P1：用户截图中的正文仍是普通三方值卡片，没有源图 IDE 行级差异。已新增 LCS 行对齐模型、并排 IDE 与统一差异视图；局部并排证据显示行号、红绿变更和双栏结构已落实。
2. P1：原界面大量 8–10 px 字号，在高密度桌面截图中难以阅读。已把冲突表格、步骤、正文、按钮及时间线提高到 10–13 px，并增加行高。
3. P1：本地／远端值和中部按钮受主题固定高度影响发生文字溢出。已取消固定高度，允许值换行和按钮自适应；实机扫描全部按钮无溢出。
4. P2：IDE 后继续展开三个标量字段导致首屏过长。已折叠为“其他 3 个属性冲突”，需要时再展开，合并按钮紧随差异区。
5. P2：初版“统一视图”只改变列布局，没有统一 diff 语义。已改为带本地／远端行号及 `−／＋` 前缀的单列差异流，实机切换通过。
6. 最终未发现未关闭的 P0、P1 或 P2。可接受差异：源图以固定第 12–18 行为概念内容；实现使用真实字段正文和实际第 1–N 行，不伪造文件行号。

## 验收面

- 字体与排版：正文、步骤、表格和按钮达到可读字号，等宽 diff 行节奏稳定。
- 间距与布局：IDE 双栏对齐，属性默认折叠，操作区紧随正文，无文字溢出。
- 色彩与令牌：删除／新增使用 Helix 危险色与成功色，深色模式对比清晰。
- 图像与资产：无位图依赖；继续使用 Obsidian 图标和主题字体。
- 文案与安全：只显示真实行号和真实值；远端结果未知仍冻结，未增加盲目重试。

final result: passed
