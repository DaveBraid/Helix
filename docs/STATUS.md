# 当前开发状态

最后更新：2026-08-20
当前基线提交：`4436d15 fix: stop recursive project refreshes`（分支 `dev`）
工作树状态：工作树干净。
当前阶段：项目状态交互与 Markdown 变更性能热修复完成；暂不发布、不合并主分支。

## 本轮目标

- 消除项目／阶段状态菜单自动关闭、项目页循环刷新及大型 Vault 状态编辑卡顿。
- 非目标：不执行真实滴答写入、不改变项目投影合同、不发布版本。

## 当前事实

- Project／Stage Markdown 与专用 Canvas 是项目权威源；`data.json` 只保存恢复、同步与事件状态。
- 进行中 Stage 对应 `Helix Projects` 远端父任务；`# 计划行动`对应真实 `parentId` 子任务。
- 本地计划行动与子任务直接从 Stage Markdown 投影到任务页，本地编辑使用 Stage revision CAS。
- 普通滴答任务、Stage 计划行动和 Stage 投影父任务共用唯一任务详情页，各适配器只写自己的权威源。
- 任务总览按任意深度的真实父子关系递归排列；已完成项同级后置，并可隐藏已完成。
- 项目工作区派生缓存仅供渲染；失效后由 Markdown／Canvas 重建，渲染不得补写文件。
- 普通滴答同步、项目同步、离线队列、写门和冲突合并共用 `HelixService` 管线。
- 版本为 `1.0.1`，最低 Obsidian `1.12.2`。

## 本轮改动

- `src/main.ts`：项目扫描不再进入会自行安排下一轮扫描的自写批次，切断循环刷新；Markdown 属性区和正文编辑期间均延迟派生刷新，离开编辑区后合并执行一次。
- `src/services/project-workspace.ts`：稳定快照只读取项目根目录、已知纳管路径及元数据缓存确认的 Helix Markdown，不再扫描整个 Vault。
- `src/ui/project-lineage-workbench.ts`、`src/ui/helix-view.ts`：状态菜单打开期间暂缓无关服务重绘，关闭后再合并补绘。
- 回归测试覆盖 200 篇无关 Markdown 零读取、刷新任务不自激活、属性编辑焦点和状态菜单跨广播保持。

## 相关约束

- 权威源、同步写门与任务详情适配见 [ARCHITECTURE.md](ARCHITECTURE.md)。
- 远端结果未知禁止重发；冲突禁止静默覆盖；保存失败不得关闭草稿。
- 凭证只存 SecretStorage；真实写入只使用精确 ID 与 Helix 专用对象。
- 父任务完成只切换父任务本身，不静默级联子项；父级进度只统计直属子任务。
- 未通过 `taskParentingVerified` 的普通滴答任务不得发送 `parentId`；本轮没有访问或写入真实滴答。

## 当前验证

- 完整门禁通过：71 个测试文件、1001 项测试；`typecheck`、`build`、`release:check`、`git diff --check` 全部通过。
- 针对性复验：3 个文件、185 项通过；完整门禁 71 个文件、1003 项通过；`typecheck`、`build`、`release:check`、`git diff --check` 通过。
- Obsidian CLI 实机：插件与 Vault 重载通过；Stage 与 Project 状态菜单打开 2.5 秒后仍保留 5 个选项。
- CLI 将 Stage 状态重复设置为原值耗时 0.05 秒；项目视图修订号只从 2 增至 3，随后 1.8 秒保持不变，证明未继续循环刷新。
- CLI 错误缓冲为空；未改变状态语义，未执行真实滴答写入。

## 未关闭问题

- 普通滴答子任务新增／删除／排序仍受远端合同能力限制；当前明确禁用，不伪写。
- Stage 父任务的根计划行动尚无独立排序服务，当前不开放拖拽；Stage 行动内部子任务可排序。
- 当前任务树复用未变化行，但仍一次构建全部可见行；如超大任务集仍卡顿，再引入虚拟滚动。
- 429 沿用持久请求治理；不得主动触发限流验证。

## 下一步

1. 用户实测 Markdown 状态编辑和项目状态菜单。
2. 继续以 Obsidian CLI 为首选完成本地项目体验回归。
3. 仅在真实合同验证后开放普通滴答子任务新增、删除与排序。
