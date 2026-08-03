# 开发、验证与发布

本文件只负责工程操作：环境、命令、Git 阶段提交、质量闸门、上游接入和 BRAT Release。产品边界见 `ARCHITECTURE.md`。

## 1. 本地环境

- 插件目录：`.obsidian/plugins/helix-productivity`
- Node.js：当前使用 Node 24
- 构建：TypeScript + esbuild
- 测试：Vitest
- UI：Obsidian 原生 DOM 与内置图标，图表使用 ECharts

```bash
npm install
npm test
npm run typecheck
npm run build
npm run release:check
```

## 2. Git 工作流

Helix 使用独立 Git 仓库，暂不配置远端。

- `main` 保持阶段验证通过的状态。
- 开发可在短期功能分支进行；当前单人阶段允许直接在 `main` 工作，但提交前必须通过质量闸门。
- 禁止提交 `node_modules`、`data.json`、凭证、真实用户数据、临时诊断和构建缓存。
- 提交应对应一个完整阶段，不使用“临时”“杂项”式提交信息。
- 提交前更新 `docs/STATUS.md`，记录验证命令与结果。

当前仓库是在完整纵向切片通过质量闸门后才建立历史，因此首次提交应诚实记录这一事实，例如：

`feat: establish helix desktop foundation`

后续每个可独立验证的功能或修复形成单独提交，不为制造历史而拆分已经同时完成的首个纵向版本。

## 3. 质量闸门

所有阶段：

- `npm test`
- `npm run typecheck`
- `npm run build`
- 项目主管智能体审查无未解决 P0/P1/P2

实现与审查必须主动检查逻辑冗余：相同业务规则只能有一个领域实现，多个视图通过组合调用共享投影；不得为单个界面复制筛选、日期、时区、快捷属性、同步或冲突算法，也不得用第二份缓存保存可从权威数据确定性重算的集合。若确需重复状态，必须在 `ARCHITECTURE.md` 说明权威来源、失效和一致性策略。

同步阶段额外要求：

- Base/Local/Remote 真值表测试。
- 离线、重启恢复、结果未知创建、退避和多对象隔离测试。
- HTTP 夹具测试与一次性滴答测试清单真实合同测试。
- 凭证和日志脱敏检查。

首次提交的范围例外：它只建立“桌面本地基础与未验证的滴答适配基线”，允许在没有用户滴答测试环境时提交，但不得据此发布 Release、宣称真实同步可用或把合同测试标为通过。下一同步阶段必须使用一次性测试清单完成上述真实合同测试并形成独立提交；Release 闸门不享受此例外。

文件阶段额外要求：

- Markdown/Canvas 未知字段、正文、中文、CRLF、并发改动和非法环测试。

界面阶段额外要求：

- 真实 Obsidian 桌面端启停、重载和主流程交互。
- Today 前三项与展开、冲突未选字段禁提交、内嵌项目工作区及三类阶段关系。
- 控制台无错误，并与设计稿完成视觉对比。

## 4. DidaSync 上游策略

- 固定上游：`CYZice/Obsidian-DidaSync@c33aedd`。
- 仅人工移植安全、认证、接口兼容与同步正确性修复。
- 不自动合并上游 UI 与功能提交。
- 每次移植在 `docs/STATUS.md` 记录上游提交、原因、修改范围和回归测试。

## 5. BRAT 与 Release

当前不提交 Obsidian 社区目录。接入远端后通过 GitHub Release 和 BRAT 分发。

每个 Release 必须：

1. 更新 `manifest.json`、`package.json` 和 `versions.json` 的同一版本号。
2. 运行全部阶段验证。
3. 构建并在 Release 附件中提供：
   - `manifest.json`
   - `main.js`
   - `styles.css`
   - `THIRD_PARTY_NOTICES.md`
   - `licenses/ECHARTS_LICENSE.txt`
   - `licenses/ECHARTS_NOTICE.txt`
   - `licenses/ZRENDER_LICENSE.txt`
   - `licenses/D3_LICENSE.txt`
4. Git 标签与 manifest 版本完全一致，例如 `0.1.0`。
5. Release 说明包含迁移、已知限制、数据位置和上游变更。

正式连接远端、推送、打标签和发布 Release 必须由用户另行授权。

`npm run release:check` 会构建并校验版本一致性、桌面限定、BRAT 必需的三个运行产物，以及第三方声明与完整许可证载荷。
