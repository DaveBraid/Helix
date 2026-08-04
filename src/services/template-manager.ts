import {
  helixTemplatePath,
  normalizeTemplateFolder as normalizeTemplateFolderValue,
} from "../domain/template-path";
import { SerializedRunner } from "./serialized-runner";
import type { HelixVaultRepository } from "../storage/vault-repository";

export type HelixTemplateKind =
  | "project"
  | "stage"
  | "daily-review"
  | "weekly-review"
  | "monthly-review"
  | "yearly-review";

export interface HelixTemplateVariables {
  title: string;
  date?: string;
  periodStart?: string;
  periodEnd?: string;
  project?: string;
  stage?: string;
}

export interface HelixTemplateRenderRequest {
  kind: HelixTemplateKind;
  values: HelixTemplateVariables;
}

const FILES: Record<HelixTemplateKind, string> = {
  project: "Project.md",
  stage: "Stage.md",
  "daily-review": "Daily Review.md",
  "weekly-review": "Weekly Review.md",
  "monthly-review": "Monthly Review.md",
  "yearly-review": "Yearly Review.md",
};

const DEFAULT_BODIES: Record<HelixTemplateKind, string> = {
  project: `# 项目背景

> [!abstract] 为何立项？

## 项目资料

> [!info] 存放项目可用的各阶段共享资料

# 项目边界

## 计划产出

> [!tip] 打算有什么实际性的收获？

## 边界

> [!attention] 什么是本项目明确不做的？
> 明确边界有助于防止项目跑偏，花时间到没用的工作上。

# 成功标准

> [!success] 达到什么程度算成功？
> 例如：完成“计划产出”中的某几项

# 暂停 / 终止 备注

> [!fail] 若不幸暂停或终止此项目，在此留下备注，记录为何暂停或终止本项目
>
> 目的是之后如果重启项目，可以想起为何停止。
>
> ***预祝项目成功，不需要填写此项！***
`,
  stage: `# 本阶段问题聚焦



# 计划行动

- [ ]

# 行动结果



## 结果记录



## 学到真东西了



## 下一阶段聚焦问题
`,
  "daily-review": `> [!question] 今日事实
> 今天完成了什么、发生了什么？只写可验证事实。

> [!question] 执行感受
> 哪些任务顺畅或卡住？原因是什么？

> [!question] 项目联系
> 今天的证据改变了哪个项目或阶段？

> [!question] 明日调整
> 明天最重要的推进是什么？

## 自由记录
`,
  "weekly-review": `> [!question] 本周产出
> 本周最有价值的产物、决策和完成事项是什么？

> [!question] 偏差复盘
> 计划与实际差异最大在哪里？

> [!question] 项目组合
> 哪些项目应继续、暂停、结束或重新排序？

> [!question] 下周策略
> 下周的三个核心结果是什么？

## 自由记录
`,
  "monthly-review": `> [!question] 月度证据
> 哪些数据说明这个月正在向正确方向前进？

> [!question] 系统问题
> 有哪些反复出现的阻塞、过载或错误估计？

> [!question] 资源重配
> 时间和注意力应从哪里移向哪里？

> [!question] 下月主题
> 下个月只强调一个主题，它是什么？

## 自由记录
`,
  "yearly-review": `> [!question] 年度成果
> 今年真正改变长期轨迹的成果是什么？

> [!question] 重要选择
> 哪些选择最值得保留，哪些应停止？

> [!question] 能力增长
> 形成了哪些可复用能力和工作系统？

> [!question] 下一年度
> 下一年的方向、边界和首个阶段是什么？

## 自由记录
`,
};

export function normalizeTemplateFolder(value: string): string {
  return normalizeTemplateFolderValue(value);
}

export function templatePath(folder: string, kind: HelixTemplateKind): string {
  return helixTemplatePath(folder, FILES[kind]);
}

export function renderTemplateBody(body: string, values: HelixTemplateVariables): string {
  const known: Record<string, string | undefined> = {
    title: values.title,
    date: values.date,
    periodStart: values.periodStart,
    periodEnd: values.periodEnd,
    project: values.project,
    stage: values.stage,
  };
  return body.replace(/\{\{(title|date|periodStart|periodEnd|project|stage)\}\}/gu, (_all, name: string) =>
    known[name] ?? "",
  );
}

/** 只创建缺失的 Helix 默认模板；任何既有用户文件始终原样保留。 */
export class HelixTemplateManager {
  private readonly runner = new SerializedRunner();

  constructor(
    private readonly repository: HelixVaultRepository,
    private readonly folder: () => string,
    private readonly isReady: () => boolean = () => true,
  ) {}

  async ensureDefaults(): Promise<string[]> {
    return this.runner.run(async () => {
      this.assertReady();
      try {
        return (await this.ensureDefaultsAt(normalizeTemplateFolder(this.folder())))
          .map((revision) => revision.path);
      } catch (error) {
        const leftovers = await this.rollbackCreated(
          error instanceof TemplateDefaultsError ? error.created : [],
        );
        if (leftovers.length > 0) throw new TemplateConfigureRollbackError(error, leftovers);
        throw error;
      }
    });
  }

  /**
   * 在同一串行事务内补齐、持久化、再发布新目录。任何失败都不切换运行时设置。
   */
  async configure(
    candidate: string,
    persist: (folder: string) => Promise<void>,
    publish: (folder: string) => void,
  ): Promise<string[]> {
    const folder = normalizeTemplateFolder(candidate);
    return this.runner.run(async () => {
      let created: Awaited<ReturnType<HelixTemplateManager["ensureDefaultsAt"]>> = [];
      try {
        created = await this.ensureDefaultsAt(folder);
        await persist(folder);
        publish(folder);
        return created.map((revision) => revision.path);
      } catch (error) {
        const createdByAttempt = error instanceof TemplateDefaultsError
          ? error.created
          : created;
        const leftovers = await this.rollbackCreated(createdByAttempt);
        if (leftovers.length > 0) {
          throw new TemplateConfigureRollbackError(error, leftovers);
        }
        throw error;
      }
    });
  }

  async render(kind: HelixTemplateKind, values: HelixTemplateVariables): Promise<string> {
    return (await this.renderMany([{ kind, values }]))[0]!;
  }

  /** 同一次创建读取同一目录快照，目录切换不会把多份正文混用。 */
  async renderMany(requests: readonly HelixTemplateRenderRequest[]): Promise<string[]> {
    return this.runner.run(async () => {
      this.assertReady();
      const folder = normalizeTemplateFolder(this.folder());
      return Promise.all(requests.map(async ({ kind, values }) => {
        const path = templatePath(folder, kind);
        const template = await this.repository.read(path);
        if (!template) throw new Error(`找不到模板：${path}；请在设置中补齐默认模板`);
        return renderTemplateBody(template.content, values);
      }));
    });
  }

  private assertReady(): void {
    if (!this.isReady()) {
      throw new Error("尚未确认 Helix 模板目录；请在设置中选择目录并补齐默认模板后再创建");
    }
  }

  private async ensureDefaultsAt(folder: string): Promise<Array<{ path: string; hash: string; content: string }>> {
    const created: Array<{ path: string; hash: string; content: string }> = [];
    try {
      for (const kind of Object.keys(FILES) as HelixTemplateKind[]) {
        const path = templatePath(folder, kind);
        if (await this.repository.read(path)) continue;
        try {
          created.push(await this.repository.create(path, DEFAULT_BODIES[kind]));
        } catch (error) {
          // 并发创建后若文件已存在，接受用户／另一流程先完成的内容；其他错误明确暴露。
          if (await this.repository.read(path)) continue;
          throw new Error(`无法补齐默认模板 ${path}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return created;
    } catch (error) {
      throw new TemplateDefaultsError(error, created);
    }
  }

  private async rollbackCreated(
    created: Array<{ path: string; hash: string; content: string }>,
  ): Promise<string[]> {
    const leftovers: string[] = [];
    for (const revision of [...created].reverse()) {
      try {
        await this.repository.trashIfUnchanged(revision);
      } catch {
        leftovers.push(revision.path);
      }
    }
    return leftovers;
  }
}

export class TemplateConfigureRollbackError extends Error {
  constructor(cause: unknown, readonly leftoverPaths: string[]) {
    super(
      `模板目录设置未保存，以下新建模板因并发修改未自动清理：${leftoverPaths.join("、")}；` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "TemplateConfigureRollbackError";
  }
}

class TemplateDefaultsError extends Error {
  constructor(cause: unknown, readonly created: Array<{ path: string; hash: string; content: string }>) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TemplateDefaultsError";
  }
}
