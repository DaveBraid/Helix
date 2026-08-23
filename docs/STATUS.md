# 当前开发状态

最后更新：2026-08-23
父提交：`415ce23 docs: record Helix 2.1.2 publication`
工作树状态：本状态快照随项目／阶段状态职责提交更新；提交后应为干净工作树。
当前阶段：本轮开发和验证已完成，继续停留在 `dev`，尚未进入发布流程。

## 本轮目标

- 项目关系图容器和顶部横排项目选单均用图标、文字与颜色区分项目状态。
- 阶段“想法”改显示为“计划中”，在“进行中”和“已完成”之间新增“待记录”。
- 全部根行动完成后自动进入“待记录”；用户手动将 Stage 设为“已完成”。
- 非目标：不修改 Project／Stage／Canvas 用户数据，不发布新版本，不扩大滴答写入能力。

## 当前事实

- Project／Stage Markdown 仍是项目身份、状态和正文的权威源；专用 Canvas 仍是关系和布局的权威源。
- Stage 状态为 `idea/active/recording/completed/paused/terminated`，界面依次显示“计划中／进行中／待记录／已完成／已暂停／已终止”。
- `recording` 使用 `notebook-pen` 图标和青色视觉；阶段关系图弹出选单与六列看板复用同一呈现定义。
- 全部根行动完成时，`idea/active` Stage 自动进入 `recording`；手动完成后保持 `completed`。根行动重新打开时，`recording/completed` 按行动状态回到 `idea/active`；暂停与终止不自动改写。
- `recording` 只属于 Stage，不进入计划行动状态。滴答父任务将其映射为开放态，且不会为该状态首次创建远端父任务；只有手动 `completed` 才完成父任务。
- 项目状态在关系图容器和顶部项目胶囊中均显示共享图标，并按计划中、进行中、已完成、已暂停、已终止使用独立状态色。

## 本轮改动

- `project-status`、`stage-board`：新增合法 `recording` 枚举、标签、图标、颜色与六列顺序；阶段 `idea` 标签改为“计划中”。
- `local-project-tasks`：自动完成派生改为自动待记录，并保留手动完成与重新打开收敛规则。
- `dida-project-projection-coordinator`：待记录映射为远端开放态，保持仅进行中 Stage 可首次创建父任务。
- `project-lineage-workbench`、`styles.css`：项目容器和横排选单补状态图标、状态色；阶段待记录补完整视觉。
- 统一任务详情允许 Stage 手动选择待记录或已完成，同时拒绝把待记录写入行动任务。
- `docs/ARCHITECTURE.md` 已同步权威状态与派生规则；`docs/经验.md` 已按当前 Obsidian CLI 实际语法更新。

## 当前验证

- `npm test`：71 个测试文件、1033 项全部通过。
- `npm run typecheck`、`npm run build`、`git diff --check` 通过。
- Obsidian CLI 在 `ObDevTestVault` 完成插件重载和真实 DOM 验收；错误缓冲及 error 级控制台均为空。
- 项目横排选单实测：计划中 `circle-dashed`／灰蓝，进行中 `play-circle`／靛蓝；项目容器复用相同图标与颜色。
- 阶段状态选单实测 6 项顺序正确；待记录为 `notebook-pen`／青色。六列看板的标签、图标和计算颜色均正确。
- 最终看板计算样式返回 6 个显式网格列；独立项目主管审查无 P0/P1/P2/P3。

## 未关闭问题

- 当前 CLI 的后台窗口在 `requestAnimationFrame` 未推进时可能先出现空白 Helix 根节点；显式前台激活并调用既有渲染后正常，未捕获运行时错误。本轮状态功能不依赖该现象，后续可单独诊断。

## 下一步

1. 在测试 Vault 继续观察“全部计划任务完成→待记录→手动完成”的日常交互。
2. 后续修复继续在 `dev`；只有用户明确要求发布时才合入 `main`。
