# 当前开发状态

最后更新：2026-08-23
父提交：`a909eb6 feat: add recording stage workflow and status visuals`
工作树状态：本状态快照随滴答子任务创建顺序修复提交更新；提交后应为干净工作树。
当前阶段：开发与验证已完成，继续停留在 `dev`，尚未进入发布流程。

## 本轮目标

- Stage `# 计划行动` 批量生成滴答普通子任务后，滴答展示顺序与 Helix 行序一致。
- Helix Markdown 继续作为计划行动顺序的权威源。
- 非目标：不写 `task.sortOrder`，不修改用户 Project／Stage／Canvas 数据，不发布新版本。

## 当前事实

- 滴答为同一父任务连续创建子任务时，后创建任务取得更小的安全 `sortOrder`，界面显示在更上方；按 Helix 正序发送会形成完整倒序。
- 同轮待创建行动现在按 Helix 行序逆序发送，滴答逐次置顶后的最终展示顺序即为 Helix 正序。
- 创建批次中任一请求未发送、结果未验证或 Markdown 回填竞争时，停止该轮其余创建；未发送行动不进入同步 Base，下轮可按完整顺序重新规划。
- 现有写入合同尚未证明普通任务排序碰撞与重排语义，因此本修复不发送 `sortOrder`，也不触碰未托管远端任务。

## 本轮改动

- `dida-project-projection`：仅重排同轮 `create-action` 的执行顺序，其他更新、完成、重开与删除意图保持原顺序和既有安全队列。
- 失败收口：逆序创建批次遇到阻断后移除尚未发送行动的临时账本项，避免把未创建对象误推进 Base。
- 自动化测试模拟滴答“后建置顶”，覆盖三项批量创建以及首项能力拒绝后完整重试。
- `docs/ARCHITECTURE.md` 同步记录创建顺序和零 `sortOrder` 写入边界。

## 当前验证

- `npm test`：71 个测试文件、1035 项全部通过；其中 `tests/dida-project-projection.test.ts` 57 项通过。
- `npm run typecheck`、`npm run build`、`git diff --check` 通过。
- Obsidian CLI 已在 `ObDevTestVault` 重载插件；错误缓冲与 error 级控制台均为空。
- 独立项目主管审查无 P0/P1/P2。

## 未关闭问题

- 本修复保证同一同步轮次的批量创建顺序；普通任务远端拖动及跨轮任意插入仍不由 Helix 写回，需未来隔离合同证明 `task.sortOrder` 方向、间隔、碰撞与重排语义后才能扩展。

## 下一步

1. 在测试 Vault 后续新建 Stage 计划行动时观察滴答展示顺序。
2. 后续修复继续在 `dev`；只有用户明确要求发布时才合入 `main`。
