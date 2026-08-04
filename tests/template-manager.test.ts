import { describe, expect, it } from "vitest";
import {
  HelixTemplateManager,
  normalizeTemplateFolder,
  renderTemplateBody,
  TemplateConfigureRollbackError,
  templatePath,
} from "../src/services/template-manager";
import { stableHash } from "../src/domain/stable";

class MemoryTemplates {
  readonly files = new Map<string, string>();

  async read(path: string) {
    const content = this.files.get(path);
    return content === undefined ? null : { path, content, hash: stableHash(content) };
  }

  async create(path: string, content: string) {
    if (this.files.has(path)) throw new Error("already exists");
    this.files.set(path, content);
    return { path, content, hash: stableHash(content) };
  }

  async trashIfUnchanged(revision: { path: string; hash: string }) {
    const current = await this.read(revision.path);
    if (!current || current.hash !== revision.hash) throw new Error("trash conflict");
    this.files.delete(revision.path);
  }
}

describe("HelixTemplateManager", () => {
  it("creates exactly the six missing defaults and never overwrites a custom template", async () => {
    const repository = new MemoryTemplates();
    repository.files.set("Template/Helix/Project.md", "自定义 {{title}}\n{{unknown}}");
    const manager = new HelixTemplateManager(repository as never, () => "Template");

    const created = await manager.ensureDefaults();

    expect(created).toHaveLength(5);
    expect(repository.files.get("Template/Helix/Project.md")).toBe("自定义 {{title}}\n{{unknown}}");
    await expect(manager.render("project", { title: "量子实验" }))
      .resolves.toBe("自定义 量子实验\n{{unknown}}");
  });

  it("renders only the documented placeholders and accepts an intentionally empty template", async () => {
    const repository = new MemoryTemplates();
    repository.files.set("Template/Helix/Daily Review.md", "");
    const manager = new HelixTemplateManager(repository as never, () => "Template");
    await expect(manager.render("daily-review", { title: "日记", date: "2026-08-04" })).resolves.toBe("");
    expect(renderTemplateBody("{{title}} {{unknown}} {{date}}", {
      title: "标题", date: "2026-08-04",
    })).toBe("标题 {{unknown}} 2026-08-04");
  });

  it("rejects path traversal and normalizes valid Vault-relative folders", () => {
    expect(normalizeTemplateFolder(" Template/ ")).toBe("Template");
    expect(templatePath("Template", "stage")).toBe("Template/Helix/Stage.md");
    for (const unsafe of ["../Template", "/Template", "\\\\server\\share", "C:\\Template", "Template\\Child", "Template/./Child", "~/Template", ""]) {
      expect(() => normalizeTemplateFolder(unsafe)).toThrow(/相对路径/);
    }
  });

  it("tolerates a concurrent creator that wins before the fallback reread", async () => {
    const repository = new MemoryTemplates();
    let first = true;
    const originalCreate = repository.create.bind(repository);
    repository.create = async (path, content) => {
      if (first) {
        first = false;
        repository.files.set(path, "另一流程的模板");
        throw new Error("already exists");
      }
      return originalCreate(path, content);
    };
    const manager = new HelixTemplateManager(repository as never, () => "Template");
    await expect(manager.ensureDefaults()).resolves.toHaveLength(5);
    expect(repository.files.get("Template/Helix/Project.md")).toBe("另一流程的模板");
  });

  it("does not create templates while first-install confirmation is absent", async () => {
    const repository = new MemoryTemplates();
    const manager = new HelixTemplateManager(repository as never, () => "Template", () => false);

    await expect(manager.render("project", { title: "未确认" }))
      .rejects.toThrow(/尚未确认/);
    expect(repository.files).toEqual(new Map());
  });

  it("serializes configuration with renderMany so one creation observes one folder snapshot", async () => {
    const repository = new MemoryTemplates();
    for (const [folder, project, stage] of [
      ["Template", "旧项目", "旧阶段"],
      ["Next", "新项目", "新阶段"],
    ] as const) {
      repository.files.set(`${folder}/Helix/Project.md`, project);
      repository.files.set(`${folder}/Helix/Stage.md`, stage);
    }
    let folder = "Template";
    const manager = new HelixTemplateManager(repository as never, () => folder);
    let releasePersist!: () => void;
    const persisted = new Promise<void>((resolve) => { releasePersist = resolve; });
    let markPersistStarted!: () => void;
    const persistStarted = new Promise<void>((resolve) => { markPersistStarted = resolve; });
    const configuring = manager.configure(
      "Next",
      async () => {
        markPersistStarted();
        await persisted;
      },
      (next) => { folder = next; },
    );
    await persistStarted;
    const rendered = manager.renderMany([
      { kind: "project", values: { title: "x" } },
      { kind: "stage", values: { title: "y" } },
    ]);
    releasePersist();
    await expect(configuring).resolves.toHaveLength(4);
    await expect(rendered).resolves.toEqual(["新项目", "新阶段"]);
  });

  it("rolls back only the revisions created by a failed configuration", async () => {
    const repository = new MemoryTemplates();
    const originalCreate = repository.create.bind(repository);
    repository.create = async (path, content) => {
      if (path.endsWith("Stage.md")) throw new Error("第 N 个创建失败");
      return originalCreate(path, content);
    };
    const manager = new HelixTemplateManager(repository as never, () => "Template");
    await expect(manager.configure("Candidate", async () => undefined, () => undefined))
      .rejects.toThrow(/第 N 个创建失败/);
    expect(repository.files).toEqual(new Map());
  });

  it("rolls back templates and keeps runtime folder unchanged when persistence fails", async () => {
    const repository = new MemoryTemplates();
    let folder = "Template";
    const manager = new HelixTemplateManager(repository as never, () => folder);
    await expect(manager.configure(
      "Candidate",
      async () => { throw new Error("保存失败"); },
      (next) => { folder = next; },
    )).rejects.toThrow(/保存失败/);
    expect(folder).toBe("Template");
    expect(repository.files).toEqual(new Map());
  });

  it("reports the exact residual path if a concurrent edit prevents rollback", async () => {
    const repository = new MemoryTemplates();
    const manager = new HelixTemplateManager(repository as never, () => "Template");
    let captured: unknown;
    try {
      await manager.configure(
        "Candidate",
        async () => {
          repository.files.set("Candidate/Helix/Project.md", "并发修改");
          throw new Error("保存失败");
        },
        () => undefined,
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(TemplateConfigureRollbackError);
    expect((captured as TemplateConfigureRollbackError).leftoverPaths)
      .toEqual(["Candidate/Helix/Project.md"]);
    expect(repository.files).toEqual(new Map([["Candidate/Helix/Project.md", "并发修改"]]));
  });
});
