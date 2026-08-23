# 当前开发状态

最后更新：2026-08-23
当前基线提交：本阶段 `fix: accept recording parent completion` 提交
工作树状态：本状态快照随阶段提交收口；提交后为干净工作树。
当前阶段：Helix `2.1.3` 已正式发布；发布后发现的父任务状态映射回归已在 `dev` 完成提交，尚未发布新版。

## 本轮目标

- 修复计划行动全部完成后，滴答自动完成 Stage 父任务被误判为远端竞争的问题。
- 保持“待记录”与“已完成”的 Helix 语义边界：远端父任务可以完成，Stage 仍只由用户手动设为已完成。
- 非目标：不批量清理真实冲突，不覆盖 Base／Local／Remote，不修改用户 Project／Stage／Canvas。

## 当前修复

- 根因：`recording` 在投影协调器中被降级成 `active`，父任务期望状态因此仍为未完成；滴答自动完成父任务后触发了正常的三方差异冻结。
- 修复：投影输入保留 `recording` 语义，并统一把 `recording` 与 `completed` 映射为滴答父任务完成态。
- 已有幽灵冻结：Stage-06 与 Stage-09 已在实机同步中按既有安全路径自动清除；Stage-07 的真实差异继续冻结。
- 全量验证：71 个测试文件、1047 项通过；`typecheck`、生产构建与 `git diff --check` 通过。
- Obsidian CLI 重载后执行一次测试项目投影同步，结果为零创建、零更新、零完成、零删除；同步中心、队列、专注冲突均为零，控制台无 warning/error。
- 项目主管独立审查提出的架构文档 P2 已修复，最终无剩余 P0/P1/P2。

## 发布内容

- `2.1.3` 是当前正式版，标签指向已验证发布基线 `a79b8f6`。
- 项目状态在关系图容器和横排选单中使用统一图标与颜色。
- 阶段“想法”显示为“计划中”；所有根行动完成后自动进入“待记录”，由用户手动确认已完成。
- 滴答子任务创建顺序与 Helix Markdown 行序一致；Helix 任务树也在同父托管槽位内恢复该顺序。
- 当前版本的停用投影配置可按稳定清单 ID 原位恢复；单个 Stage 冲突不再扩大为全局阻塞。
- 合法 marker 后遗留可见文本的历史行会安全收口，可见文本保留。
- `manifest.json`、`package.json`、`package-lock.json`、`versions.json`、README 和 `docs/releases/2.1.3.md` 已准备统一发布版本。

## 发布边界

- Project／Stage Markdown 与专用 Canvas 继续是项目数据权威源；滴答继续是普通任务、清单、习惯与专注记录权威源。
- 口令继续只存于 Obsidian SecretStorage；投影配置按 Vault 独立保存。
- Release 必须包含 BRAT 运行文件、第三方声明与完整许可证附件。

## 发布前证据

- 开发阶段全量门禁：71 个测试文件、1045 项通过；`typecheck`、`build`、`git diff --check` 通过。
- Obsidian CLI 重载后，Helix DOM 任务顺序为任务 1→2→3，error 与 warn 为空。
- 项目主管对最终开发基线复审无剩余 P0/P1/P2。
- `2.1.3` 全量测试、`release:check` 与 `git diff --check` 在 `dev` 和快进后的 `main` 均已通过；发布元数据独立复审无剩余 P0/P1/P2。
- GitHub Release 为非草稿、非预发布；8 个附件均为 `uploaded`，下载文件与本地产物 SHA-256 逐项一致。
- 本地与远端 `2.1.3` 注释标签均解析到 `a79b8f6`；Release 地址为 `https://github.com/DaveBraid/Helix/releases/tag/2.1.3`。

## 已知限制

- Stage-07 仍有真实父任务 conflict，需要用户单独复核；不影响其他 Stage。
- Stage 之间的任务移动仍未开放；远端结果未知时仍禁止盲目重试。

## 下一步

1. 只有用户再次明确要求发布时才合入 `main`。
