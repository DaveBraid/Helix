import { describe, expect, it } from "vitest";
import { stableHash } from "../src/domain/stable";
import {
  TaskReferenceConflictError,
  TaskReferenceService,
  taskReferenceRuntimeIssues,
} from "../src/services/task-references";
import type { VaultRevision } from "../src/storage/vault-repository";

describe("TaskReferenceService", () => {
  const didaContext = { didaProjectId: "dida-list-1" } as const;

  it("requires verified remote task context without coupling to project projection", async () => {
    const repo = new MemoryReferenceRepository();
    const mapped = taskReferences(repo, "dida-list-1", false);
    await expect(mapped.saveTaskReference(
      "task-remote-missing-context",
      { projectId: "project-1", stageIds: [] },
      null,
    )).rejects.toThrow(/必须提供.*滴答清单上下文/);
    await expect(mapped.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: [] },
      null,
      { didaProjectId: "dida-other" },
    )).resolves.toMatchObject({ committed: true });

    const unmapped = taskReferences(new MemoryReferenceRepository(), "", false);
    await expect(unmapped.saveTaskReference(
      "task-remote-2",
      { projectId: "project-1", stageIds: [] },
      null,
      { didaProjectId: "dida-list-1" },
    )).resolves.toMatchObject({ committed: true });
  });
  it("stores only stable identities and Obsidian links in one Markdown note", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: ["stage-2", "stage-1"] },
      null,
    );

    const reference = created.reference!;
    expect(reference).toMatchObject({
      taskId: "task-remote-1",
      provider: "dida",
      projectId: "project-1",
      stageIds: ["stage-1", "stage-2"],
      issues: [],
    });
    const snapshot = await service.snapshot();
    expect(snapshot.byTaskId.get("task-remote-1")?.refId).toBe(reference.refId);
    expect(snapshot.byProjectId.get("project-1")?.map((item) => item.refId))
      .toEqual([reference.refId]);
    expect(snapshot.byStageId.get("stage-1")?.map((item) => item.refId))
      .toEqual([reference.refId]);
    const content = (await repo.read(reference.notePath))!.content;
    expect(content).toContain("helix-kind: helix-task-reference");
    expect(content).toContain("helix-provider: dida");
    expect(content).toContain('helix-dida-task-id: "task-remote-1"');
    expect(content).toContain("[[Helix/Projects/Alpha/Project]]");
    expect(content).toContain("[[Helix/Projects/Alpha/Stage-01]]");
    expect(content).toContain("[[Helix/Projects/Alpha/Stage-02]]");
    expect(content).not.toContain("任务标题");
    expect(content).not.toContain("status:");
    expect(content).not.toContain("dueDate");
  });

  it("updates the managed block while preserving user notes", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: ["stage-1"] },
      null,
    );
    const reference = created.reference!;
    const revision = (await repo.read(reference.notePath))!;
    repo.set(reference.notePath, `${revision.content}用户自己的说明\n`);

    const updated = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: ["stage-2"] },
      {
        refId: reference.refId,
        revisionHash: stableHash(`${revision.content}用户自己的说明\n`),
      },
    );

    expect(updated.reference).toMatchObject({
      stageIds: ["stage-2"],
    });
    const content = (await repo.read(reference.notePath))!.content;
    expect(content).toContain("用户自己的说明");
    expect(content).not.toContain("[[Helix/Projects/Alpha/Stage-01]]");
    expect(content).toContain("[[Helix/Projects/Alpha/Stage-02]]");
  });

  it("preserves BOM, CRLF, unknown frontmatter and user body", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: [] },
      null,
    );
    const reference = created.reference!;
    const changed = `\uFEFF${repo.content(reference.notePath)
      .replace("helix-updated:", "custom-key: keep\r\nhelix-updated:")
      .replace(/\r?\n/g, "\r\n")}用户正文\r\n`;
    repo.set(reference.notePath, changed);
    const reopened = (await service.snapshot()).byTaskId.get("task-remote-1")!;

    await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: ["stage-1"] },
      { refId: reopened.refId, revisionHash: reopened.revisionHash },
    );
    const content = repo.content(reference.notePath);
    expect(content.startsWith("\uFEFF---\r\n")).toBe(true);
    expect(content).toContain("custom-key: keep\r\n");
    expect(content).toContain("用户正文\r\n");
    expect(content.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("removes an unassigned reference through revision-checked trash", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: [] },
      null,
    );
    const path = created.reference!.notePath;

    const next = await service.saveTaskReference(
      "task-remote-1",
      { projectId: undefined, stageIds: [] },
      {
        refId: created.reference!.refId,
        revisionHash: created.reference!.revisionHash,
      },
    );

    expect(next.reference).toBeUndefined();
    expect(await repo.read(path)).toBeNull();
    expect(repo.trashed).toEqual([path]);
  });

  it("migrates a rebuilt remote task ID without changing the reference identity", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-old",
      { projectId: "project-1", stageIds: ["stage-1"] },
      null,
    );
    const before = created.reference!;

    await service.rebindTaskId("task-old", "task-new", {
      refId: before.refId,
      revisionHash: before.revisionHash,
    }, { didaProjectId: "dida-list-1" });
    const after = (await service.snapshot()).references[0]!;

    expect(after).toMatchObject({
      refId: before.refId,
      taskId: "task-new",
      notePath: before.notePath,
    });
    await expect(service.rebindTaskId("task-old", "task-new", {
      refId: before.refId,
      revisionHash: before.revisionHash,
    }, { didaProjectId: "dida-list-1" })).resolves.toBeUndefined();
  });

  it("allows explicit verified rebind across Dida lists", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-old",
      { projectId: "project-1", stageIds: [] },
      null,
    );
    await expect(service.rebindTaskId(
      "task-old",
      "task-other-list",
      {
        refId: created.reference!.refId,
        revisionHash: created.reference!.revisionHash,
      },
      { didaProjectId: "dida-list-2" },
    )).resolves.toBeUndefined();
    const snapshot = await service.snapshot();
    expect(snapshot.byTaskId.has("task-old")).toBe(false);
    expect(snapshot.byTaskId.has("task-other-list")).toBe(true);
  });

  it("does not treat project mapping or task list moves as reference damage", async () => {
    const mappedReference = {
      refId: "ref-1",
      provider: "dida" as const,
      taskId: "task-1",
      projectId: "project-1",
      stageIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      notePath: "reference.md",
      revisionHash: "hash",
      project: {
        id: "project-1",
        title: "Alpha",
        status: "active" as const,
        notePath: "Project.md",
        didaProjectId: "dida-list-1",
        cycles: [],
      },
      stages: [],
      issues: [],
    };
    expect(taskReferenceRuntimeIssues(mappedReference, { projectId: "dida-list-2" }))
      .toEqual([]);
    expect(taskReferenceRuntimeIssues({
      ...mappedReference,
      project: { ...mappedReference.project, didaProjectId: undefined },
    }, { projectId: "dida-list-1" }))
      .toEqual([]);
    expect(taskReferenceRuntimeIssues(mappedReference))
      .toEqual(["当前同步缓存未包含任务 task-1，不据此推断远端已删除"]);
  });

  it("rejects rebind when the referenced Helix project no longer exists", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-old",
      { projectId: "project-1", stageIds: [] },
      null,
    );
    repo.set(
      created.reference!.notePath,
      repo.content(created.reference!.notePath).replace(
        "helix-project-id: project-1",
        "helix-project-id: project-missing",
      ),
    );
    const broken = (await service.snapshot()).byTaskId.get("task-old")!;

    await expect(service.rebindTaskId("task-old", "task-new", {
      refId: broken.refId,
      revisionHash: broken.revisionHash,
    }, { didaProjectId: "dida-list-1" })).rejects.toThrow(/项目已不存在/);
    const preserved = (await service.snapshot()).byTaskId.get("task-old")!;
    expect(preserved.refId).toBe(broken.refId);
    expect(preserved.projectId).toBe("project-missing");
  });

  it("blocks writes when duplicate or broken reference structure exists", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: ["stage-1"] },
      null,
    );
    const content = (await repo.read(created.reference!.notePath))!.content;
    repo.set(
      "Moved/duplicate.md",
      content.replace(/helix-id: .+/, "helix-id: duplicate-ref"),
    );

    const snapshot = await service.snapshot();
    expect(snapshot.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/多份 Helix 引用/),
    ]));
    await expect(service.saveTaskReference(
      "task-remote-2",
      { projectId: "project-1", stageIds: [] },
      null,
    )).rejects.toThrow(/暂停写入/);
  });

  it("rejects a concurrent Markdown change without overwriting it", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: [] },
      null,
    );
    const path = created.reference!.notePath;
    repo.beforeCompare = () => {
      repo.set(path, `${repo.content(path)}并发修改\n`);
    };

    await expect(service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: ["stage-1"] },
      {
        refId: created.reference!.refId,
        revisionHash: created.reference!.revisionHash,
      },
    )).rejects.toThrow(/conflict/);
    expect(repo.content(path)).toContain("并发修改");
  });

  it("rejects a stale modal revision before changing any managed field", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: ["stage-1"] },
      null,
    );
    const reference = created.reference!;
    repo.set(
      reference.notePath,
      repo.content(reference.notePath).replace(
        'helix-stage-ids: ["stage-1"]',
        'helix-stage-ids: ["stage-2"]',
      ),
    );

    await expect(service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: [] },
      { refId: reference.refId, revisionHash: reference.revisionHash },
    )).rejects.toBeInstanceOf(TaskReferenceConflictError);
    expect(repo.content(reference.notePath)).toContain(
      'helix-stage-ids: ["stage-2"]',
    );
  });

  it("does not allow a temporary local task identity to become reference truth", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);

    await expect(service.saveTaskReference(
      "local-123",
      { projectId: "project-1", stageIds: [] },
      null,
    )).rejects.toThrow(/远端 ID/);
    expect(repo.paths()).toEqual([]);
  });

  it("freezes an externally written local task identity", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: [] },
      null,
    );
    repo.set(
      created.reference!.notePath,
      repo.content(created.reference!.notePath).replace(
        'helix-dida-task-id: "task-remote-1"',
        'helix-dida-task-id: "local-external"',
      ),
    );

    const snapshot = await service.snapshot();
    expect(snapshot.references).toEqual([]);
    expect(snapshot.blockingIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/本地临时 ID/),
    ]));
  });

  it.each([
    ["missing start", "<!-- helix-task-reference:start -->", ""],
    [
      "duplicate end",
      "<!-- helix-task-reference:end -->",
      "<!-- helix-task-reference:end -->\n<!-- helix-task-reference:end -->",
    ],
  ])("freezes a %s managed link block", async (_label, search, replacement) => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: [] },
      null,
    );
    repo.set(
      created.reference!.notePath,
      repo.content(created.reference!.notePath).replace(search, replacement),
    );

    const snapshot = await service.snapshot();
    expect(snapshot.blockingIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/Helix 自动链接区块无效/),
    ]));
  });

  it("keeps a missing-project reference visible and allows explicit repair", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    const created = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: [] },
      null,
    );
    const before = created.reference!;
    repo.set(
      before.notePath,
      repo.content(before.notePath).replace(
        "helix-project-id: project-1",
        "helix-project-id: project-missing",
      ),
    );
    const broken = await service.snapshot();
    const brokenReference = broken.references[0]!;
    expect(brokenReference.issues).toContain("关联的 Helix 项目已不存在");
    expect(broken.blockingIssues).toEqual([]);

    const repaired = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: ["stage-1"] },
      {
        refId: brokenReference.refId,
        revisionHash: brokenReference.revisionHash,
      },
    );
    expect(repaired.reference).toMatchObject({
      projectId: "project-1",
      stageIds: ["stage-1"],
      issues: [],
    });
  });

  it("discovers a task reference after an external empty-create and move", async () => {
    const repo = new MemoryReferenceRepository();
    const service = taskReferences(repo);
    repo.set("External/reference.md", "");
    expect(await service.hasTaskReferenceIdentity("External/reference.md")).toBe(false);

    const created = await service.saveTaskReference(
      "task-remote-1",
      { projectId: "project-1", stageIds: [] },
      null,
    );
    const content = repo.content(created.reference!.notePath);
    repo.delete(created.reference!.notePath);
    repo.set("External/reference.md", content);

    expect(await service.hasTaskReferenceIdentity("External/reference.md")).toBe(true);
    await service.snapshot();
    expect(service.isKnownTaskReferencePath("External/reference.md")).toBe(true);
  });
});

function taskReferences(
  repo: MemoryReferenceRepository,
  didaProjectId = "dida-list-1",
  supplyVerifiedContext = true,
): TaskReferenceService {
  const projectSnapshot = {
    projects: [{
      id: "project-1",
      title: "Alpha",
      status: "active",
      notePath: "Helix/Projects/Alpha/Project.md",
      didaProjectId,
      cycles: [
        {
          id: "stage-1",
          title: "准备",
          notePath: "Helix/Projects/Alpha/Stage-01.md",
          sequence: 1,
          status: "active",
        },
        {
          id: "stage-2",
          title: "验证",
          notePath: "Helix/Projects/Alpha/Stage-02.md",
          sequence: 2,
          status: "planned",
        },
      ],
    }],
  };
  const service = new TaskReferenceService(
    {
      vault: {
        getMarkdownFiles: () => repo.paths().map((path) => ({ path })),
      },
    } as never,
    repo as never,
    { snapshot: async () => projectSnapshot } as never,
    () => "Helix",
  );
  if (supplyVerifiedContext) {
    const save = service.saveTaskReference.bind(service);
    service.saveTaskReference = ((taskId, selection, expected, context) =>
      save(
        taskId,
        selection,
        expected,
        context ?? (selection.projectId ? { didaProjectId: "dida-list-1" } : undefined),
      )) as TaskReferenceService["saveTaskReference"];
  }
  return service;
}

class MemoryReferenceRepository {
  private readonly files = new Map<string, string>();
  readonly trashed: string[] = [];
  beforeCompare?: () => void;

  paths(): string[] {
    return [...this.files.keys()].filter((path) => path.endsWith(".md"));
  }

  set(path: string, content: string): void {
    this.files.set(path, content);
  }

  delete(path: string): void {
    this.files.delete(path);
  }

  content(path: string): string {
    return this.files.get(path)!;
  }

  async read(path: string): Promise<VaultRevision | null> {
    const content = this.files.get(path);
    return content === undefined
      ? null
      : { path, content, hash: stableHash(content) };
  }

  async create(path: string, content: string): Promise<VaultRevision> {
    if (this.files.has(path)) throw new Error("create conflict");
    this.files.set(path, content);
    return { path, content, hash: stableHash(content) };
  }

  async compareAndWrite(
    revision: VaultRevision,
    content: string,
  ): Promise<VaultRevision> {
    this.beforeCompare?.();
    this.beforeCompare = undefined;
    const current = await this.read(revision.path);
    if (!current || current.hash !== revision.hash) throw new Error("write conflict");
    this.files.set(revision.path, content);
    return { path: revision.path, content, hash: stableHash(content) };
  }

  async trashIfUnchanged(revision: VaultRevision): Promise<void> {
    const current = await this.read(revision.path);
    if (!current || current.hash !== revision.hash) throw new Error("trash conflict");
    this.files.delete(revision.path);
    this.trashed.push(revision.path);
  }
}
