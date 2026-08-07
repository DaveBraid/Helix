# 当前开发状态

最后更新：2026-08-07
当前基线提交：`536eca3 docs: record project workflow acceptance`
工作树状态：有尚未提交的 Live Preview 标记展示与项目后台同步改动；Vault 测试数据和运行态 `data.json` 不纳入 Git。
当前阶段：修复“加入同步”只写 Markdown、必须再手动同步的问题，并改善 Helix 内部标记的编辑体验。

## 本轮目标

- 在保持显式启用和既有安全写入管线不变的前提下，让 Project／Stage 变化自动触发滴答项目同步，并在 Live Preview 隐藏精确内部标记。
- 非目标：不启用生产项目同步，不触碰普通滴答或 Vault 数据，不发布 Release；不隐藏用户 HTML 注释、引用正文或不符合精确语法的相似文本。

## 当前事实

- 滴答是任务、远端清单、习惯和专注记录的权威源；普通任务双向同步、列表／看板呈现及专注时长读取已有既有实现。
- Project／Stage Markdown 保存项目身份、状态和正文，专用 Canvas 保存继承／分支／合并关系及布局；`data.json` 不保存项目影子真值。
- 项目向滴答仍默认关闭，必须在设置页对精确清单与分栏完成预览和二次确认。
- 启用后的项目远端写入唯一复用 `DidaProjectProjectionService`、`HelixService`、持久 `OfflineQueue`、共享 `RemoteWriteGate` 与唯一 `queueDrain`。
- “加入同步”只负责给 Stage 行动写入稳定身份；本轮后台协调器负责在其后自动唤醒真正的安全同步路径。
- 凭证只存 Obsidian SecretStorage；Base／Local／Remote 竞争必须逐字段人工解决，远端结果未知禁止盲目重发。

## 本轮改动

- `src/editor/helix-marker-visibility.ts`：Live Preview 精确隐藏 focus marker 与合法 action marker span；保留换行、标题，Source mode 及光标触及时显示。
- `src/services/project-auto-sync.ts`：新增防抖、单飞重入、严格写后指纹收敛、逐项目失败隔离、重启重扫和问题状态去重协调器；成功静默且不建立第二套队列或远端写入口。
- `src/main.ts`：接入编辑器扩展；在启动、显式启用、行动加入／编辑及 Project／Stage／Canvas 刷新后唤醒后台同步，并在卸载时取消待执行工作。
- `src/ui/helix-view.ts`、`src/ui/settings-tab.ts`：移除单项目手动同步按钮及旧文案，改为自动排队状态和阻塞提示。

## 相关约束

- 权威源、远端写门、自动同步单消费者和未知结果处理见 [ARCHITECTURE.md](ARCHITECTURE.md)。
- 自动协调器只能唤醒既有同步服务；禁止直接调用 Dida API、复制任务状态、绕过合同能力或在失败后自行重发。
- 生产授权当前全部写能力只读；自动化和已完成清理均不能解除该阻塞，也不能宣称真实项目同步可用。
- Live Preview 只能隐藏完整匹配的 Helix focus marker 和合法任务行末的精确 `helix-dida-action` span，不能吞换行、改变垂直布局或隐藏用户内容。

## 当前验证

- 已通过：全量 65 个测试文件、802 项；`typecheck`、`build`、`release:check`、`git diff --check`。
- 已通过针对性测试：Live Preview 精确匹配、Source／选择边界；后台防抖批处理、自写重入、重启扫描、阻塞／失败和卸载取消。
- 仅自动化覆盖：主插件注册、Vault 事件接线和 UI 手动按钮移除；后台协调器测试使用假同步端口。
- 真实合同：本次未通过（查询限流）；1 task＋2 project 票据已 recover 精确清理，本地 pending=false、queue=0、conflict=0，能力全只读。
- 尚未验证：当前改动的 Obsidian CLI 重载、Live Preview 实机显示、真实启用后的后台 Notice 与滴答结果。
- 不得宣称：生产项目同步、真实合同写入、当前 UI 实机或 Release 已通过。

## 未关闭问题

- 当前 API 读取连接正常；本次合同失败并完成安全清理后，生产写能力仍全只读，重新验证前后台同步只能安全暂缓。
- 当前改动尚未经过看门狗独立审查和 Obsidian 实机验收。
- 项目页与复盘体验仍是下一阶段核心，尚未达到最终产品质量。

## 下一步

1. 由看门狗审查后台调度、重入、Notice 和 CM6 装饰边界，修复 P0–P2。
2. 运行 `release:check` 与 `git diff --check`，再用 Obsidian CLI 重载验证 Live Preview；不启用真实远端项目写入。
3. 在用户明确安排真实测试后，仅用专用测试清单验证“加入同步→后台排队→远端结果”，保持普通数据零触碰。
4. 验收后更新本快照并形成阶段提交，再回到项目和复盘核心打磨。
