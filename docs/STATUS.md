# 当前开发状态

最后更新：2026-08-23
父提交：`c1450fe fix: resume retained project projection safely`
工作树状态：本状态快照随 Helix 任务同级顺序修复提交更新；提交后应为干净工作树。
当前阶段：根因、修复与真实界面验证已完成，继续停留在 `dev`，尚未进入发布流程。

## 本轮目标

- 让 Helix 任务树与 Stage Markdown、滴答清单均按任务 1→2→3 展示。
- 保留 Stage Markdown 作为计划行动顺序的权威源。
- 非目标：不写入远端 `sortOrder`，不修改用户 Stage 内容，不发布新版本。

## 根因

- Stage-06 Markdown 中的行动顺序为任务 1→2→3。
- 滴答 API 快照的数组返回顺序为父任务→任务 3→2→1，该数组顺序不等于滴答界面按 `sortOrder` 呈现的顺序。
- `mergeProjectTaskCollections` 替换已绑定任务的本地字段时，`Map` 仍保留远端数组的插入顺序，任务树因此显示为 3→2→1。

## 本轮改动

- 新增纯领域函数 `applyPreferredTaskSiblingOrder`：按权威 ID 顺序重排同父级托管任务。
- 只复用托管任务原有槽位；普通滴答任务的位置、内容和远端真值保持不变。
- 完成项仍由现有 `completionLast` 在同级稳定下移。

## 验证

- 定向 3 个测试文件、66 项通过；新用例覆盖“远端 3→2→1，本地 1→2→3”、普通任务槽位不动以及 Stage 父任务根级顺序不变。
- `npm test`：71 个测试文件、1045 项全部通过。
- `npm run typecheck`、`npm run build`、`git diff --check` 通过。
- Obsidian CLI 重载最终构建后，Helix DOM 任务标题顺序为“任务 1、任务 2、任务 3”；error 与 warn 均为空。
- 独立项目主管首轮发现的根级顺序 P2 已修复；复审无剩余 P0/P1/P2。

## 未关闭问题

- Stage-07 与 Stage-09 仍有父任务 conflict，需要用户在冲突中心单独收口；不影响其他 Stage。

## 下一步

1. 形成 Helix 任务同级顺序修复的单一职责提交。
2. 后续修复继续在 `dev`；只有用户明确要求发布时才合入 `main`。
