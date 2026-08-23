# 当前开发状态

最后更新：2026-08-23
当前基线提交：`a79b8f6 docs: snapshot Helix 2.1.3 release baseline`
工作树状态：本状态快照随最终发布收口提交更新；提交后应为干净工作树。
当前阶段：Helix `2.1.3` 已在 GitHub 正式发布，`main` 与 `dev` 的发布基线和结果记录已同步。

## 本轮目标

- 发布项目／阶段状态改进、“待记录”流程、子任务顺序修复与项目投影安全恢复。
- 版本统一为 `2.1.3`，最低 Obsidian 版本保持 `1.12.2`。
- 非目标：不修改用户 Project／Stage／Canvas，不创建或清理滴答对象，不扩大远端写入能力。

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

- Stage-07 与 Stage-09 仍有父任务 conflict，需要用户在冲突中心单独收口；不影响其他 Stage。
- Stage 之间的任务移动仍未开放；远端结果未知时仍禁止盲目重试。

## 下一步

1. 用户可通过 BRAT 或 GitHub Release 更新到 `2.1.3`。
2. 后续修复继续在 `dev`；只有用户再次明确要求发布时才合入 `main`。
