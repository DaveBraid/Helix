# Helix

Helix 是面向科研工作流的 Obsidian 桌面插件。它把滴答清单任务、项目阶段、日周月年复盘、习惯与专注统计，以及可选挑战系统组织到一个统一工作台中。

## 当前能力

- 滴答数据接入、离线队列和 Base/Local/Remote 逐字段冲突处理。
- Helix 独立“正在进行”标记，首页显示前三项及所属项目，并可展开全部。
- 稳定项目、可独立命名的阶段、卡片/看板和内嵌项目关系图。
- 日、周、月、年结构化复盘模板与自动摘要。
- 事件驱动的趋势、活跃度、XP、成就及周/月挑战。

当前版本为 `0.1.5` 个人预览版，仅支持 Obsidian `1.12.2` 及以上桌面端。普通滴答清单、任务、习惯与专注数据同步保留；Helix 项目到滴答任务/检查项的投影暂未开放，项目与复盘先以 Obsidian Markdown 和 Canvas 为权威数据源。

## 开发

```bash
npm install
npm test
npm run release:check
```

最新状态见 [`docs/STATUS.md`](docs/STATUS.md)，开发规范入口见 [`AGENTS.md`](AGENTS.md)，架构边界见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 安装计划

后续可分发版本将通过 GitHub Release 提供 `manifest.json`、`main.js`、`styles.css`、第三方声明及完整许可证载荷，并使用 BRAT 安装与更新。当前没有发布到 Obsidian 插件社区的计划，也尚未配置远端或发布 Release。

兼容策略：`manifest.json`、`package.json` 与 `versions.json` 始终使用同一版本；`versions.json` 固定记录该版本的最低 Obsidian 版本。升级前运行完整门禁，用户 Markdown、Canvas 与未知字段不得被静默迁移或覆盖。
