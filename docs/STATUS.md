# 当前开发状态

最后更新：2026-08-04
当前基线提交：`90fa0ec feat: add recoverable stage focus bridge foundation`
工作树状态：3C 的默认 Stage 正文、关系桥接服务、专项测试及本快照尚未提交；Vault 文件与运行态 `data.json` 不纳入 Git。
当前阶段：阶段 3C 关系命令接入进行中；删除阶段尚未接入。

## 本轮目标

- 让新建、连接、纳管、替换和断开关系只按 Canvas 托管入边派生 Stage 聚焦引用，并与 Canvas 同事务。
- 非目标：本批不接删除阶段、监听、冲突 UI、滴答同步、发布或迁移。

## 当前事实

- 滴答清单是任务、清单、习惯和专注记录的权威源；Project/Stage Markdown 保存项目身份、状态与正文，专用 Canvas 只保存阶段关系和布局，见 [ARCHITECTURE.md](ARCHITECTURE.md)。
- 滴答写入合同版本为 4；旧合同、授权不符、结果未知或身份不明均冻结为只读，禁止盲目重试。真实合同临时对象已精确清理，当前阶段不扩展滴答写入。
- 工作台导航为今日、项目、任务、复盘、挑战、冲突；侧栏固定，主内容独立滚动；复盘已合并原分析页。
- 六份默认模板位于可配置 Vault 目录（当前 `Template/Helix/`）；只补缺失文件，绝不覆盖现有模板。创建 Project/Stage 只消费模板正文并生成必要受管属性。
- 项目状态为计划中、进行中、完成、暂停、终止；阶段状态为想法、进行中、完成、暂停、终止。旧 `archived/planned/closed` 仅兼容读取，不批量回写。
- 阶段编号写入 `helix-stage-code`：分支使用 `N.1/N.2`，继承与合并推进大号，历史编号不复用；继承转分支是唯一受控改码例外并同步受管 H1。
- 活动 Project/Stage 笔记通过公开状态栏和命令编辑状态；项目页状态、关系、布局、折叠、颜色、撤销/重做及修复均经过恢复模式写入闸门。
- 项目页纯读取仅报告 `canvasRepairRequired/reasons`，绝不写 Canvas；显式修复使用稳定双快照、受管 Markdown 最终复核和 Canvas CAS，竞争时零写入。
- 阶段 2 看板仅从 Project/Stage Markdown 快照派生阶段卡片，不依赖 Canvas 节点或完成折叠；状态迁移只写对应 Stage Markdown，并复用恢复模式写闸门。

## 本轮改动

- `src/services/project-workspace.ts`：关系入口生成聚焦更新；新 Stage 与受控改码改用 v2 日志原子创建，不再提前落盘。
- `src/domain/projects.ts`：内置 Stage 兜底正文与当前默认模板结构一致。
- `tests/project-workspace.test.ts`：覆盖继承／合并、连线／断线／撤销、缺标题、损坏标记、受管编辑、创建回滚和 Canvas 零写。

## 相关约束

- 凭证仅存 SecretStorage；不得进入仓库、`data.json`、日志、Markdown、Notice 或夹具。
- 用户 Markdown/Canvas 优先；只修改明确受管字段、块、节点和边，写前必须复核修订。冲突不得静默覆盖。
- 恢复模式下项目页可读，但所有写入口必须拒绝；纯读取不得顺手修复派生数据。
- 真实滴答测试仅限唯一标记的专用对象；未知结果、残留或清理身份不明立即停止。
- `ObDevTestVault` 内数据已获用户授权，可直接修改用于插件测试；该授权不扩展到用户真实滴答数据。

## 当前验证

- 已通过：全量 58 个测试文件、626 项，`typecheck`、`build`、`release:check`、`git diff --check` 全绿。
- 审查：3A P0/P1/P2=0，3B P0/P1=0；两段均未接入 UI。
- 3C 第一批：专项 145/145、看门狗 P0/P1/P2=0；新建／连线／纳管／替换／断开已通过，删除阶段尚未接入，故完整 3C 仍未完成。
- 实机（提交基线）：Obsidian 1.13.4 深色模式五列横排／独立横滚正常；隔离 Stage 跨列写入与计数一致，同列拖拽零写，键盘和 ARIA 正常，`dev:errors` 为 0。
- 实机：临时 Project/Stage 已移入 Obsidian 废纸篓并移除空目录；当时既有 Project/Stage、模板和 Canvas 前后哈希一致。
- 实机：3A/3B 尚未接入 UI，不适用；阶段 3C 接入后统一用 Obsidian CLI 验收。

## 未关闭问题

- 真正首次安装的模板目录弹窗仅有自动化覆盖；未伪造当前安装状态。

## 下一步

1. 实施 3C：只从 Canvas 托管入边生成聚焦引用，覆盖新建、连边、换边、断边、删除、撤销重做。
2. 实施监听与逐字段冲突 UI，再用 Obsidian CLI 完成阶段 3 实机验收。
3. 阶段 3 稳定后开始 Helix→滴答隔离投影。
