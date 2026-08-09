# 阶段 1 计划：状态、属性与阶段编号

## 目标

- 项目支持 `planned / active / completed / paused / terminated`，对应计划中、进行中、完成、暂停、终止。
- 阶段与计划行动共用 `idea / active / completed / paused / terminated`，对应想法、进行中、完成、暂停、终止。
- Markdown 是身份、状态和滴答映射的唯一本地真值；Canvas 只保存关系和布局。
- 将用户当前 Project/Stage 模板内容固化为“缺失文件的默认种子”，不覆盖任何既有模板。
- 新阶段使用关系型展示编号 `helix-stage-code`；保留整数 `helix-sequence` 作稳定文件路径、高水位和兼容顺序。2026-08-10 起，删除会按当前 DAG 原子维护展示编号，物理 sequence 仍不复用。

## 必要属性

- Project 新建时只写 `helix-kind`、`helix-id`、`helix-status`、`helix-created`；颜色和滴答根任务 ID 只在存在时写入。`helix-updated` 只在 Helix 后续状态或受管内容修改时写入，不作为新建冗余属性。
- Stage：`helix-kind`、`helix-id`、`helix-project-id`、`helix-project`、`helix-sequence`、`helix-stage-code`、`helix-status`、`helix-started`；终态时才写结束时间。
- 不在 Markdown 复制 Canvas 的父级或关系真值。
- Obsidian 没有可靠的公开 API 为普通属性声明枚举类型；Helix 在激活笔记时提供中文候选控件，最终仍通过 CAS 写回 `helix-status`。未知手工值显示诊断，不静默归一。

## 编号规则

1. 无前置阶段的首节点为 `1`。
2. 单继承产生下一个未使用大号，例如 `1 → 2`。
3. 从同一来源首次分支时，共享下一个大号并使用后缀，例如 `1 → 2.1 / 2.2`；后加分支取当前最小空位。若原先已有单继承 `1 → 2`，新增第二后继时必须在同一事务中将原后继改为 `2.1`、新节点为 `2.2`；删除后按继承、分支、合并关系紧凑维护现存编号，任一 Markdown/Canvas CAS 失败都不能留下混合编号。
4. 合并使用所有前置中最大的大号加一，例如 `2.1 + 2.2 → 3`。
5. 对分支节点再分支时，先进入下一代大号，再分配后缀；不产生无限小数层级。
6. 跨项目合并各项目独立编号，目标项目使用自身下一大号；不按 Canvas 坐标推断。

## 兼容与边界

- 旧项目 `archived` 和旧阶段 `closed` 仅做兼容读取，分别展示为终止和完成；不批量改写用户笔记。
- 旧阶段没有 `helix-stage-code` 时使用 `helix-sequence` 显示；只在用户显式操作该节点或确认迁移时补写。
- 不改文件路径，不批量改标题，不触碰现有 Canvas/Markdown 数据。

## 验收

- 状态域、中文标签、旧值兼容和非法值拒绝均有纯领域测试。
- Project/Stage 创建只写上述必要属性，Project 初建不写 `helix-updated`，模板正文与用户版本一致。
- 编号覆盖继承、首次/追加分支、合并、删除后紧凑维护和跨项目。
- 状态更新使用 Markdown 修订 CAS，保留未知属性与正文。
- 全量门禁、Obsidian CLI 实机显示和看门狗审查通过后完成提交。

## 非目标

- 本阶段不拖拽看板、不写聚焦问题引用块、不访问滴答写入端点。
