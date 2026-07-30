# 第三方声明

## Obsidian-DidaSync

Helix 的滴答清单接入与同步行为参考并部分改写自 `CYZice/Obsidian-DidaSync`。

- 已审查提交：`c33aedd`
- 已审查版本：`1.7.6`
- 许可证：MIT
- 源代码：<https://github.com/CYZice/Obsidian-DidaSync>

Copyright (c) 2026 CYZice

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Helix 将衍生实现隔离在 `src/integrations/dida`。上游更新只在人工审查后按安全、认证、接口兼容或同步正确性需要移植，不自动合并 UI 与一般功能。

## Obsidian Research Card Manager

Helix 项目工作台的关系图、卡片、看板、缩放、平移和多选交互参考并改写自 `andrewliang01/obsidian-research-card-manager`。

- 已审查提交：`7fbd19388756419d89f3423d1ba774ddef767dbd`
- 许可证：MIT
- 源代码：<https://github.com/andrewliang01/obsidian-research-card-manager>

MIT License

Copyright (c) 2026 Stepan

Modifications Copyright (c) 2026 LiangYujun

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Apache ECharts

- 版本：`6.1.0`
- 许可证：Apache License 2.0
- Copyright 2017-2026 The Apache Software Foundation
- 源代码与许可证：<https://github.com/apache/echarts>

This product includes software developed at The Apache Software Foundation (https://www.apache.org/).

发布包同时包含：

- `licenses/ECHARTS_LICENSE.txt`：Apache License 2.0 完整文本及 ECharts 子组件声明。
- `licenses/ECHARTS_NOTICE.txt`：ECharts 原始 NOTICE。
- `licenses/D3_LICENSE.txt`：ECharts 内嵌 d3.js 部分的 BSD 3-Clause 完整文本。

## ZRender

ECharts 构建中包含 ZRender。

- 版本：`6.1.0`
- 许可证：BSD 3-Clause
- Copyright (c) 2017, Baidu Inc.
- 源代码与许可证：<https://github.com/ecomfe/zrender>

发布包同时包含 `licenses/ZRENDER_LICENSE.txt`，其中保留 BSD 3-Clause
全部条件与免责声明。上述许可证文件由 `release:check` 强制校验，不依赖
不会随 BRAT 发布的 `node_modules`。
