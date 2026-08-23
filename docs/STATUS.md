# 当前开发状态

最后更新：2026-08-23
当前基线提交：`2b433ff release: prepare Helix 2.1.3`
工作树状态：仅有本发布基线快照的待提交更新。
当前阶段：`2.1.3` 发布候选已通过 `dev`、`main` 完整门禁与独立复审，等待推送 `main` 与 GitHub Release。

## 本轮目标

- 发布项目／阶段状态改进、“待记录”流程、子任务顺序修复与项目投影安全恢复。
- 版本统一为 `2.1.3`，最低 Obsidian 版本保持 `1.12.2`。
- 非目标：不修改用户 Project／Stage／Canvas，不创建或清理滴答对象，不扩大远端写入能力。

## 发布内容

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
- GitHub 标签、Release、附件上传与哈希核对尚未完成，不得宣称 `2.1.3` 已发布。

## 已知限制

- Stage-07 与 Stage-09 仍有父任务 conflict，需要用户在冲突中心单独收口；不影响其他 Stage。
- Stage 之间的任务移动仍未开放；远端结果未知时仍禁止盲目重试。

## 下一步

1. 提交本发布基线快照并推送 `main`。
2. 创建 `2.1.3` 标签与 GitHub Release，上传并核对 8 个发布附件。
3. 记录发布事实，再将 `main` 同步回 `dev`。
