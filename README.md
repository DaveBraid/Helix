# Helix

Helix 是面向科研工作流的 Obsidian 桌面插件。它把滴答清单任务、项目阶段、日周月年复盘、习惯与专注统计，以及可选挑战系统组织到一个统一工作台中。

## 当前能力

- Stage 计划行动生成本地任务，并支持子任务、状态、日期、时间和标签编辑。
- Helix 独立“正在进行”标记，首页显示前三项及所属项目，并可展开全部。
- 稳定项目、可独立命名的阶段、卡片／看板和内嵌项目关系图。
- 日、周、月、年结构化复盘模板与自动摘要。
- 事件驱动的趋势、活跃度、XP、成就及周/月挑战。

当前正式版为 `1.0.0`，仅支持 Obsidian `1.12.2` 及以上桌面端。本版本专注本地项目、阶段、任务、复盘、分析与挑战体验；所有滴答网络同步及项目投影暂不开放，既有 API 口令仍安全保留在 SecretStorage，后续稳定版本再启用。

## 开发

```bash
npm install
npm test
npm run release:check
```

最新状态见 [`docs/STATUS.md`](docs/STATUS.md)，开发规范入口见 [`AGENTS.md`](AGENTS.md)，架构边界见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 安装

通过 GitHub Release 或 BRAT 安装与更新。BRAT 仓库地址为 `DaveBraid/Helix`；当前没有发布到 Obsidian 插件社区的计划。

兼容策略：`manifest.json`、`package.json` 与 `versions.json` 始终使用同一版本；`versions.json` 固定记录该版本的最低 Obsidian 版本。升级前运行完整门禁，用户 Markdown、Canvas 与未知字段不得被静默迁移或覆盖。
