# Helix

Helix 是面向科研工作流的 Obsidian 桌面插件。它把滴答清单任务、项目阶段、日周月年复盘、习惯与专注统计，以及可选挑战系统组织到一个统一工作台中。

## 当前能力

- 滴答数据接入、离线队列和 Base/Local/Remote 逐字段冲突处理。
- Helix 独立“正在进行”标记，首页显示前三项及所属项目，并可展开全部。
- 稳定项目、可独立命名的阶段、卡片/看板和内嵌项目关系图。
- 日、周、月、年结构化复盘模板与自动摘要。
- 事件驱动的趋势、活跃度、XP、成就及周/月挑战。

当前仅支持桌面端。真实滴答合同测试和 GitHub/BRAT 发布尚待后续阶段。

## 开发

```bash
npm install
npm test
npm run release:check
```

最新状态见 [`docs/STATUS.md`](docs/STATUS.md)，开发规范入口见 [`AGENTS.md`](AGENTS.md)，架构边界见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 安装计划

首个可分发版本将通过 GitHub Release 提供 `manifest.json`、`main.js`、`styles.css`、第三方声明及完整许可证载荷，并使用 BRAT 安装与更新。当前没有发布到 Obsidian 插件社区的计划。
