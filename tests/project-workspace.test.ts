import { describe, expect, it } from "vitest";
import { projectTemplate, cycleTemplate } from "../src/domain/projects";
import { stableHash } from "../src/domain/stable";
import {
  canSilentlyRepairProjectCanvas,
  ProjectWorkspaceService,
} from "../src/services/project-workspace";
import type { VaultRevision } from "../src/storage/vault-repository";

const CANVAS = "Helix/Project Lineage.canvas";
const DELETE_JOURNAL = "Helix/.transactions/stage-delete.json";
const HISTORY_JOURNAL = "Helix/.transactions/workspace-history.json";

describe("ProjectWorkspaceService", () => {
  it("does not parse ordinary Markdown between thematic breaks as Helix YAML", async () => {
    const repo = baseRepository();
    const path = "Notes/Android.md";
    const ordinary = [
      "---",
      "# 普通 Markdown 正文",
      '{"path":"Android sdk\\platform-tools"}',
      "<!-- helix-focus-bridge:start version=1 -->",
      "用户受管块样式文本",
      "<!-- helix-focus-bridge:end -->",
      "---",
      "正文继续",
    ].join("\n");
    repo.set(path, ordinary);

    await expect(workspace(repo).snapshot()).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: "project-1" })],
    });
    expect((await repo.read(path))?.content).toBe(ordinary);
  });

  it("does not read unrelated Vault Markdown during a project snapshot", async () => {
    const repo = baseRepository();
    for (let index = 0; index < 200; index += 1) {
      repo.set(`Knowledge/Note-${index}.md`, `# 普通笔记 ${index}`);
    }
    let unrelatedReads = 0;
    repo.beforeRead = (path) => {
      if (path.startsWith("Knowledge/")) unrelatedReads += 1;
    };

    await workspace(repo).snapshot();

    expect(unrelatedReads).toBe(0);
  });

  it("keeps Helix identity fields strict after the non-Helix prefilter", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Broken/Stage-02.md", [
      "---",
      "helix-kind: helix-stage",
      "helix-id: broken-stage",
      "helix-project-id: project-1",
      "helix-sequence: broken",
      "helix-status: idea",
      "---",
      "# 阶段 2",
    ].join("\n"));

    await expect(workspace(repo).snapshot()).rejects.toThrow(/阶段元数据不完整/);
  });

  it("consumes template bodies for new project and initial stage while retaining Helix envelopes", async () => {
    const repo = baseRepository();
    const calls: string[] = [];
    const service = new ProjectWorkspaceService(
      { vault: { getMarkdownFiles: () => repo.paths().filter((path) => path.endsWith(".md")).map(fileFromPath) } } as never,
      repo as never,
      () => "Helix",
      () => CANVAS,
      async (requests) => {
        calls.push(...requests.map(({ kind, values }) => `${kind}:${values.title}`));
        return requests.map(({ kind }) =>
          kind === "project" ? "自定义项目正文 {{unknown}}" : "自定义阶段正文");
      },
    );

    const created = await service.createProject("模板项目", "验证模板入口");
    const project = await repo.read(created.notePath);
    const stage = await repo.read(created.cycles[0]!.notePath);

    expect(calls).toEqual(["project:模板项目", "stage:验证模板入口"]);
    expect(project?.content).toContain("helix-kind: helix-project");
    expect(project?.content).toContain("helix-status: planned");
    expect(project?.content).not.toContain("helix-updated:");
    expect(project?.content).toContain("# 模板项目");
    expect(project?.content).toContain("自定义项目正文 {{unknown}}");
    expect(stage?.content).toContain("helix-kind: helix-stage");
    expect(stage?.content).toContain('helix-stage-code: "1"');
    expect(stage?.content).toContain("helix-status: idea");
    expect(stage?.content).toContain("# 阶段 1 · 验证模板入口");
    expect(stage?.content).toContain("自定义阶段正文");
  });

  it("renames projects and stages through Markdown while preserving identity, body and Canvas summaries", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const projectPath = "Helix/Projects/Alpha/Project.md";
    const stagePath = "Helix/Projects/Alpha/Cycle-01.md";
    repo.set(projectPath, `${(await repo.read(projectPath))!.content}\n\n用户项目正文`);
    repo.set(stagePath, `${(await repo.read(stagePath))!.content}\n\n用户阶段正文`);

    await service.renameProject("project-1", "新项目名称");
    await service.renameCycle("cycle-1", "新阶段名称");

    const projectContent = (await repo.read(projectPath))!.content;
    const stageContent = (await repo.read(stagePath))!.content;
    expect(projectContent).toContain("# 新项目名称");
    expect(projectContent).toContain("helix-id: project-1");
    expect(projectContent).toContain("用户项目正文");
    expect(stageContent).toContain("# 阶段 1 · 新阶段名称");
    expect(stageContent).toContain("helix-id: cycle-1");
    expect(stageContent).toContain("用户阶段正文");
    const canvas = repo.json(CANVAS);
    expect(canvas.nodes.find((node: { id: string }) => node.id === "project-node").text)
      .toContain("|新项目名称]]");
    expect(canvas.nodes.find((node: { id: string }) => node.id === "cycle-node").text)
      .toContain("|新阶段名称]]");
  });

  it("reads project and stage names changed directly in Markdown", async () => {
    const repo = baseRepository();
    const projectPath = "Helix/Projects/Alpha/Project.md";
    const stagePath = "Helix/Projects/Alpha/Cycle-01.md";
    repo.set(projectPath, (await repo.read(projectPath))!.content.replace("# Alpha", "# Markdown 项目名"));
    repo.set(stagePath, (await repo.read(stagePath))!.content.replace(
      "# 阶段 1 · 阶段标题 1",
      "# 阶段 1 · Markdown 阶段名",
    ));

    const service = workspace(repo);
    const snapshot = await service.snapshot();

    expect(snapshot.projects[0]?.title).toBe("Markdown 项目名");
    expect(snapshot.projects[0]?.cycles[0]?.title).toBe("Markdown 阶段名");
    await service.ensureCanvas();
    const canvas = repo.json(CANVAS);
    expect(canvas.nodes.find((node: { id: string }) => node.id === "project-node").text)
      .toContain("|Markdown 项目名]]");
    expect(canvas.nodes.find((node: { id: string }) => node.id === "cycle-node").text)
      .toContain("|Markdown 阶段名]]");
  });

  it("requires an explicit initial stage name before creating a project", async () => {
    const repo = baseRepository();
    const beforePaths = repo.paths();

    await expect(workspace(repo).createProject("新项目", "   "))
      .rejects.toThrow("请输入首阶段名称");

    expect(repo.paths()).toEqual(beforePaths);
  });

  it.each([
    "尚未确认 Helix 模板目录",
    "模板渲染失败",
  ])("does not create an empty Canvas or Markdown when project templates fail: %s", async (message) => {
    const repo = new MemoryRepository({});
    const service = new ProjectWorkspaceService(
      { vault: { getMarkdownFiles: () => repo.paths().filter((path) => path.endsWith(".md")).map(fileFromPath) } } as never,
      repo as never,
      () => "Helix",
      () => CANVAS,
      async () => { throw new Error(message); },
    );

    await expect(service.createProject("不会落盘", "首阶段")).rejects.toThrow(message);
    expect(repo.paths()).toEqual([]);
    await expect(repo.read(CANVAS)).resolves.toBeNull();
  });

  it("renders all simultaneously-created branch stages in one template batch", async () => {
    const repo = baseRepository();
    const batches: string[][] = [];
    const service = new ProjectWorkspaceService(
      { vault: { getMarkdownFiles: () => repo.paths().filter((path) => path.endsWith(".md")).map(fileFromPath) } } as never,
      repo as never,
      () => "Helix",
      () => CANVAS,
      async (requests) => {
        batches.push(requests.map(({ kind, values }) => `${kind}:${values.title}`));
        return requests.map(({ values }) =>
          `# 本阶段问题聚焦\n\n正文：${values.title}\n\n## 下一阶段聚焦问题`);
      },
    );

    await service.createCycle("project-1", "branch", ["cycle-1"], {
      confirmBranchConversion: true,
      stageTitle: "路径 A",
      secondaryStageTitle: "路径 B",
    });

    expect(batches).toEqual([["stage:路径 A", "stage:路径 B"]]);
    expect((await repo.read("Helix/Projects/Alpha/Stage-02.md"))?.content).toContain("正文：路径 A");
    expect((await repo.read("Helix/Projects/Alpha/Stage-03.md"))?.content).toContain("正文：路径 B");
  });

  it("uses stable IDs to repair renamed paths and writes real text-card summaries", async () => {
    const repo = new MemoryRepository({
      "Helix/Projects/Renamed/Project.md": project("project-1", "重命名项目"),
      "Helix/Projects/Renamed/Cycle-01.md": cycle("cycle-1", "project-1", 1),
      [CANVAS]: JSON.stringify({
        custom: { keep: true },
        nodes: [
          {
            id: "project-node",
            type: "text",
            x: 0,
            y: 0,
            width: 320,
            height: 200,
            helixManaged: true,
            helixNodeKind: "project",
            helixProjectId: "project-1",
            helixFilePath: "Helix/Projects/Old/Project.md",
            text: "stale",
            customNode: "keep",
          },
          {
            id: "cycle-node",
            type: "text",
            x: 0,
            y: 300,
            width: 360,
            height: 220,
            helixManaged: true,
            helixNodeKind: "cycle",
            helixProjectId: "project-1",
            helixCycleId: "cycle-1",
            text: "missing path",
          },
        ],
        edges: [],
      }),
    });
    const service = workspace(repo);
    expect((await service.snapshot()).canvasNodes).toHaveLength(2);
    await service.ensureCanvas();
    const canvas = repo.json(CANVAS);
    expect(canvas.custom).toEqual({ keep: true });
    expect(canvas.nodes[0]).toMatchObject({
      helixFilePath: "Helix/Projects/Renamed/Project.md",
      text: "[[Helix/Projects/Renamed/Project|重命名项目]]\n\n进行中",
      customNode: "keep",
    });
    expect(canvas.nodes[1]).toMatchObject({
      helixFilePath: "Helix/Projects/Renamed/Cycle-01.md",
      text: "[[Helix/Projects/Renamed/Cycle-01|阶段标题 1]]\n\n进行中",
    });
  });

  it("waits through an intermediate invalid Canvas write before enabling edits", async () => {
    const repo = baseRepository();
    const stableCanvas = (await repo.read(CANVAS))!.content;
    let canvasReads = 0;
    repo.beforeRead = (path) => {
      if (path !== CANVAS) return;
      canvasReads += 1;
      if (canvasReads === 2) repo.set(CANVAS, "{\"nodes\":");
      if (canvasReads === 3) repo.set(CANVAS, stableCanvas);
    };

    await expect(workspace(repo).loadStableWorkspace()).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: "project-1" })],
      migrationRequired: false,
    });
    expect(canvasReads).toBeGreaterThanOrEqual(5);
    expect((await repo.read(CANVAS))!.content).toContain("\"nodes\"");
  });

  it("requires migration decisions to remain stable across both snapshots", async () => {
    const repo = baseRepository();
    const projectPath = "Helix/Projects/Alpha/Project.md";
    const cleanProject = (await repo.read(projectPath))!.content;
    repo.set(
      projectPath,
      cleanProject.replace(
        "helix-status: active\n",
        "helix-status: active\nhelix-parents:\n  - legacy-parent\n",
      ),
    );
    let projectReads = 0;
    repo.beforeRead = (path) => {
      if (path !== projectPath || ++projectReads !== 3) return;
      repo.set(projectPath, cleanProject);
    };

    const snapshot = await workspace(repo).loadStableWorkspace();
    expect(snapshot.migrationRequired).toBe(false);
    expect(projectReads).toBeGreaterThanOrEqual(8);
  });

  it("opens an existing Canvas with legacy status text without writing a cosmetic repair", async () => {
    const repo = baseRepository();
    const stagePath = "Helix/Projects/Alpha/Cycle-01.md";
    repo.set(stagePath, (repo.take(stagePath) ?? "").replace(
      "helix-status: active",
      "helix-status: closed",
    ));
    const canvasBefore = repo.json(CANVAS);
    canvasBefore.nodes[1]!.text = "[[Helix/Projects/Alpha/Cycle-01|阶段标题 1]]\n\n已关闭";
    repo.set(CANVAS, JSON.stringify(canvasBefore));
    repo.beforeCompare = () => { throw new Error("纯打开不得写 Canvas"); };

    const service = workspace(repo);
    await expect(service.loadStableWorkspace()).resolves.toMatchObject({
      projects: [expect.objectContaining({
        cycles: [expect.objectContaining({ status: "completed" })],
      })],
      canvasRepairRequired: true,
      canvasRepairReasons: expect.arrayContaining(["Helix 管理节点摘要需要更新"]),
    });
    expect(repo.json(CANVAS).nodes[1]!.text).toContain("已关闭");
    repo.beforeCompare = undefined;
    await service.ensureCanvas();
    expect(repo.json(CANVAS).nodes[1]!.text).toContain("已完成");
  });

  it("silently repairs only derived Canvas summaries from a stable snapshot", async () => {
    const repo = baseRepository();
    const canvas = repo.json(CANVAS);
    canvas.nodes[1]!.text = "[[Helix/Projects/Alpha/Cycle-01|旧摘要]]\n\n已暂停";
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    const snapshot = await service.loadStableWorkspace();

    expect(canSilentlyRepairProjectCanvas(snapshot)).toBe(true);
    await service.repairDerivedCanvasCache(snapshot);
    expect(repo.json(CANVAS).nodes[1]!.text).toContain("阶段标题 1");
  });

  it("does not silently repair missing nodes or managed relations", async () => {
    const repo = baseRepository();
    const canvas = repo.json(CANVAS);
    canvas.nodes = canvas.nodes.filter((node: { id: string }) => node.id !== "project-node");
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    const snapshot = await service.loadStableWorkspace();
    repo.beforeCompare = () => { throw new Error("结构修复不得静默写入"); };

    expect(canSilentlyRepairProjectCanvas(snapshot)).toBe(false);
    await expect(service.repairDerivedCanvasCache(snapshot)).resolves.toBe(snapshot);
  });

  it("reports missing nodes, stale high-water and derived edges without writing on load", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    const canvas = repo.json(CANVAS);
    canvas.nodes = canvas.nodes.filter((node: { id: string }) => node.id !== "project-node");
    canvas.nodes.push(card("cycle-2-node", "cycle", "project-1", "cycle-2", 0, 560));
    canvas.helixStageSequences = { "project-1": 0 };
    canvas.edges = [{
      id: "stale-derived-edge",
      fromNode: "cycle-node",
      toNode: "cycle-2-node",
      helixManaged: true,
      helixRelation: "branch",
      label: "分支",
    }];
    repo.set(CANVAS, JSON.stringify(canvas));
    repo.beforeCompare = () => { throw new Error("纯打开不得写 Canvas"); };
    const loaded = await workspace(repo).loadStableWorkspace();
    expect(loaded).toMatchObject({ canvasRepairRequired: true });
    expect(loaded.canvasRepairReasons).toEqual(expect.arrayContaining([
      "缺少项目 Canvas 节点",
      "阶段编号高水位需要补齐",
      "Helix 管理的阶段关系需要正规化",
    ]));
  });

  it("reports a missing Canvas on open and creates it only when explicitly repaired", async () => {
    const repo = baseRepository();
    repo.take(CANVAS);
    repo.beforeCreate = () => { throw new Error("纯打开不得创建 Canvas"); };
    const service = workspace(repo);

    await expect(service.loadStableWorkspace()).resolves.toMatchObject({
      canvasRepairRequired: true,
      canvasRepairReasons: expect.arrayContaining(["项目 Canvas 不存在"]),
    });
    expect(await repo.read(CANVAS)).toBeNull();

    repo.beforeCreate = undefined;
    await service.ensureCanvas();
    expect(repo.json(CANVAS)).toMatchObject({ nodes: expect.any(Array), edges: expect.any(Array) });
  });

  it("creates a fully planned missing Canvas once and leaves no residue when creation fails", async () => {
    const repo = baseRepository();
    repo.take(CANVAS);
    repo.failCreatePath = CANVAS;

    await expect(workspace(repo).ensureCanvas()).rejects.toThrow(/injected create failure/);

    expect(await repo.read(CANVAS)).toBeNull();
    expect(repo.createCalls).toBe(1);
  });

  it("does not repair Canvas when a managed Markdown note changes after planning", async () => {
    const repo = baseRepository();
    const canvasBefore = (await repo.read(CANVAS))!.content;
    const stagePath = "Helix/Projects/Alpha/Cycle-01.md";
    let canvasReads = 0;
    repo.beforeRead = (path) => {
      if (path !== CANVAS || ++canvasReads !== 2) return;
      repo.set(stagePath, `${repo.take(stagePath)!}\n用户在修复前修改了正文\n`);
    };
    repo.beforeCompare = () => { throw new Error("Markdown 竞争后不得写 Canvas"); };

    await expect(workspace(repo).ensureCanvas()).rejects.toThrow(/Markdown 已变化，请重试/);

    expect((await repo.read(CANVAS))!.content).toBe(canvasBefore);
  });

  it("does not repair a Canvas created after a missing-file snapshot", async () => {
    const repo = baseRepository();
    repo.take(CANVAS);
    const service = workspace(repo);
    repo.beforeCreate = (path) => {
      if (path !== CANVAS) return;
      repo.set(CANVAS, JSON.stringify({
        nodes: [],
        edges: [],
        externalOwner: "keep",
      }));
    };

    await expect(service.ensureCanvas()).rejects.toThrow(/目标已经存在/);
    expect(repo.json(CANVAS)).toEqual({
      nodes: [],
      edges: [],
      externalOwner: "keep",
    });
  });

  it("tracks stable-ID Markdown paths even when notes move outside the default root", async () => {
    const repo = baseRepository();
    const oldPath = "Helix/Projects/Alpha/Cycle-01.md";
    const outsidePath = "Research/Active/Alpha-Stage.md";
    const content = repo.take(oldPath)!;
    repo.set(outsidePath, content);
    const service = workspace(repo);

    await service.snapshot();
    await expect(service.hasProjectWorkspaceIdentity(outsidePath))
      .resolves.toBe(true);
    expect(service.isKnownProjectMarkdownPath(outsidePath)).toBe(true);
    expect(service.isKnownProjectMarkdownPath(oldPath)).toBe(false);

    const renamedPath = "Archive/Alpha-Stage.md";
    repo.set(renamedPath, repo.take(outsidePath)!);
    expect(service.isKnownProjectMarkdownPath(outsidePath)).toBe(true);
    await service.snapshot();
    expect(service.isKnownProjectMarkdownPath(renamedPath)).toBe(true);
    expect(service.isKnownProjectMarkdownPath(outsidePath)).toBe(false);
  });

  it("rejects duplicate canvas IDs and prevents writes after disposal", async () => {
    const repo = baseRepository();
    const duplicated = repo.json(CANVAS);
    duplicated.nodes.push({ ...duplicated.nodes[0] });
    repo.set(CANVAS, JSON.stringify(duplicated));
    await expect(workspace(repo).snapshot()).rejects.toThrow(/节点 ID 重复/);

    const liveRepo = baseRepository();
    const service = workspace(liveRepo);
    liveRepo.beforeCompare = () => service.dispose();
    await expect(service.moveCanvasNode("project-node", 40, 60)).rejects.toThrow(/卸载/);
    expect(liveRepo.json(CANVAS).nodes[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("writes a multi-card move in one Canvas CAS and preserves all positions on conflict", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const moveRevision = (await service.snapshot()).canvasRevisionHash!;
    await service.moveCanvasNodes([
      { nodeId: "project-node", x: 80.4, y: 90.6 },
      { nodeId: "cycle-node", x: 120.2, y: 430.8 },
    ], moveRevision);
    expect(repo.json(CANVAS).nodes).toEqual([
      expect.objectContaining({ id: "project-node", x: 80, y: 91 }),
      expect.objectContaining({ id: "cycle-node", x: 120, y: 431 }),
    ]);

    const conflicted = baseRepository();
    const conflictService = workspace(conflicted);
    const conflictRevision = (await conflictService.snapshot()).canvasRevisionHash!;
    conflicted.beforeCompare = () => {
      const current = conflicted.json(CANVAS);
      current.userEdit = "keep";
      conflicted.set(CANVAS, JSON.stringify(current));
    };
    await expect(conflictService.moveCanvasNodes([
      { nodeId: "project-node", x: 500, y: 500 },
      { nodeId: "cycle-node", x: 500, y: 800 },
    ], conflictRevision)).rejects.toThrow(/conflict/);
    expect(conflicted.json(CANVAS)).toMatchObject({
      userEdit: "keep",
      nodes: [
        expect.objectContaining({ id: "project-node", x: 0, y: 0 }),
        expect.objectContaining({ id: "cycle-node", x: 0, y: 300 }),
      ],
    });

    const bounded = baseRepository();
    const boundedBefore = (await bounded.read(CANVAS))!.content;
    const boundedService = workspace(bounded);
    const boundedRevision = (await boundedService.snapshot()).canvasRevisionHash!;
    await expect(boundedService.moveCanvasNodes([
      { nodeId: "cycle-node", x: 1_000_001, y: 0 },
    ], boundedRevision)).rejects.toThrow(/移动计划无效/);
    expect((await bounded.read(CANVAS))!.content).toBe(boundedBefore);
  });

  it("undoes and redoes exact Canvas move bytes and rejects an external edit", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const before = (await repo.read(CANVAS))!.content;
    const revision = (await service.snapshot()).canvasRevisionHash!;
    await service.moveCanvasNodes([
      { nodeId: "cycle-node", x: 420, y: 260 },
    ], revision);
    const after = (await repo.read(CANVAS))!.content;
    expect(service.historyState()).toMatchObject({
      undoCount: 1,
      redoCount: 0,
      undoLabel: "移动阶段",
    });

    await service.undoLastWorkspaceChange();
    expect((await repo.read(CANVAS))!.content).toBe(before);
    expect(service.historyState()).toMatchObject({ undoCount: 0, redoCount: 1 });
    await service.redoLastWorkspaceChange();
    expect((await repo.read(CANVAS))!.content).toBe(after);

    const external = repo.json(CANVAS);
    external.userEdit = "必须保留";
    repo.set(CANVAS, JSON.stringify(external));
    await expect(service.undoLastWorkspaceChange()).rejects.toThrow(
      /不能撤销或重做/,
    );
    expect(repo.json(CANVAS).userEdit).toBe("必须保留");
  });

  it("undoes and redoes a newly created stage with its Markdown identity", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    await service.ensureCanvas();
    const beforeCanvas = (await repo.read(CANVAS))!.content;
    const created = await service.createCycle(
      "project-1",
      "auto",
      ["cycle-1"],
      {
        expectedAutoIntent: {
          relation: "inherit",
          convertedInheritanceRelationIds: [],
        },
        stageTitle: "撤销测试",
      },
    );
    const createdRevision = await repo.read(created.notePath);
    const afterCanvas = (await repo.read(CANVAS))!.content;
    expect(createdRevision).not.toBeNull();

    await service.undoLastWorkspaceChange();
    expect(await repo.read(created.notePath)).toBeNull();
    expect((await repo.read(CANVAS))!.content).toBe(beforeCanvas);
    await service.redoLastWorkspaceChange();
    expect((await repo.read(created.notePath))?.content).toBe(
      createdRevision!.content,
    );
    expect((await repo.read(CANVAS))!.content).toBe(afterCanvas);
  });

  it("applies, undoes and redoes existing Markdown updates in one journaled Canvas change", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const stagePath = "Helix/Projects/Alpha/Cycle-01.md";
    const stageBefore = (await repo.read(stagePath))!;
    const stageAfter = `${stageBefore.content}\n受管聚焦块`;
    const canvasBefore = (await repo.read(CANVAS))!;
    const canvasDocument = JSON.parse(canvasBefore.content);
    canvasDocument.transactionProbe = true;
    const canvasAfter = JSON.stringify(canvasDocument);

    await service.applyAtomicWorkspaceChange({
      label: "更新阶段聚焦关系",
      canvasBeforeHash: canvasBefore.hash,
      canvasAfterContent: canvasAfter,
      markdownUpdates: [{
        path: stagePath,
        kind: "stage",
        entityId: "cycle-1",
        projectId: "project-1",
        beforeHash: stageBefore.hash,
        afterContent: stageAfter,
      }],
    });
    expect((await repo.read(stagePath))?.content).toBe(stageAfter);
    expect((await repo.read(CANVAS))?.content).toBe(canvasAfter);
    expect(await repo.read(HISTORY_JOURNAL)).toBeNull();

    await service.undoLastWorkspaceChange();
    expect((await repo.read(stagePath))?.content).toBe(stageBefore.content);
    expect((await repo.read(CANVAS))?.content).toBe(canvasBefore.content);
    await service.redoLastWorkspaceChange();
    expect((await repo.read(stagePath))?.content).toBe(stageAfter);
    expect((await repo.read(CANVAS))?.content).toBe(canvasAfter);
  });

  it.each([
    ["rolls Markdown back when Canvas is still before", false, true, "aborted"],
    ["completes Markdown when Canvas is already after", true, false, "completed"],
  ] as const)("%s", async (_name, canvasIsAfter, stageIsAfter, expected) => {
    const repo = baseRepository();
    const stagePath = "Helix/Projects/Alpha/Cycle-01.md";
    const stageBefore = (await repo.read(stagePath))!.content;
    const stageAfter = `${stageBefore}\n恢复态聚焦块`;
    const canvasBefore = (await repo.read(CANVAS))!.content;
    const canvasDocument = JSON.parse(canvasBefore);
    canvasDocument.recoveryProbe = true;
    const canvasAfter = JSON.stringify(canvasDocument);
    if (canvasIsAfter) repo.set(CANVAS, canvasAfter);
    if (stageIsAfter) repo.set(stagePath, stageAfter);
    repo.set(HISTORY_JOURNAL, JSON.stringify({
      version: 2,
      operation: "apply-workspace-history",
      phase: canvasIsAfter ? "canvas-applied" : "markdown-applied",
      createdAt: "2026-08-04T00:00:00.000Z",
      entryId: "focus-recovery",
      direction: "redo",
      canvasPath: CANVAS,
      canvasFromContent: canvasBefore,
      canvasToContent: canvasAfter,
      markdownTransitions: [{
        path: stagePath,
        kind: "stage",
        entityId: "cycle-1",
        projectId: "project-1",
        fromContent: stageBefore,
        toContent: stageAfter,
      }],
    }, null, 2));

    await expect(workspace(repo).recoverPendingWorkspaceHistory()).resolves.toBe(expected);
    expect((await repo.read(stagePath))?.content).toBe(
      canvasIsAfter ? stageAfter : stageBefore,
    );
    expect(await repo.read(HISTORY_JOURNAL)).toBeNull();
  });

  it("retains the journal and freezes when Canvas competes after Markdown updates", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const stagePath = "Helix/Projects/Alpha/Cycle-01.md";
    const stageBefore = (await repo.read(stagePath))!;
    const stageAfter = `${stageBefore.content}\n待恢复聚焦块`;
    const canvasBefore = (await repo.read(CANVAS))!;
    const canvasAfterDocument = JSON.parse(canvasBefore.content);
    canvasAfterDocument.planned = true;
    const armCanvasCompetition = (path: string): void => {
      if (path !== CANVAS) {
        repo.beforeCompare = armCanvasCompetition;
        return;
      }
      const external = repo.json(CANVAS);
      external.userEdit = "保留";
      repo.set(CANVAS, JSON.stringify(external));
    };
    repo.beforeCompare = armCanvasCompetition;

    await expect(service.applyAtomicWorkspaceChange({
      label: "竞争事务",
      canvasBeforeHash: canvasBefore.hash,
      canvasAfterContent: JSON.stringify(canvasAfterDocument),
      markdownUpdates: [{
        path: stagePath,
        kind: "stage",
        entityId: "cycle-1",
        projectId: "project-1",
        beforeHash: stageBefore.hash,
        afterContent: stageAfter,
      }],
    })).rejects.toThrow(/事务日志已保留/);
    expect(repo.json(CANVAS).userEdit).toBe("保留");
    expect((await repo.read(stagePath))?.content).toBe(stageAfter);
    expect(await repo.read(HISTORY_JOURNAL)).not.toBeNull();
    await expect(service.snapshot()).rejects.toThrow(/人工检查|未完整结束/);
  });

  it("does not write the first Markdown when a newly created journal is changed", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const stagePath = "Helix/Projects/Alpha/Cycle-01.md";
    const stageBefore = (await repo.read(stagePath))!;
    const canvasBefore = (await repo.read(CANVAS))!;
    let journalReads = 0;
    repo.beforeRead = (path) => {
      if (path !== HISTORY_JOURNAL || ++journalReads !== 2) return;
      const current = repo.json(HISTORY_JOURNAL);
      current.createdAt = "2099-01-01T00:00:00.000Z";
      repo.set(HISTORY_JOURNAL, JSON.stringify(current, null, 2));
    };

    await expect(service.applyAtomicWorkspaceChange({
      label: "日志竞争零写",
      canvasBeforeHash: canvasBefore.hash,
      canvasAfterContent: JSON.stringify({ ...JSON.parse(canvasBefore.content), planned: true }),
      markdownUpdates: [{
        path: stagePath,
        kind: "stage",
        entityId: "cycle-1",
        projectId: "project-1",
        beforeHash: stageBefore.hash,
        afterContent: `${stageBefore.content}\n不得写入`,
      }],
    })).rejects.toThrow(/日志|清理未完成/);
    expect((await repo.read(stagePath))?.content).toBe(stageBefore.content);
    expect((await repo.read(CANVAS))?.content).toBe(canvasBefore.content);
    expect(await repo.read(HISTORY_JOURNAL)).not.toBeNull();
  });

  it("freezes a recovery journal with duplicate Markdown paths before any write", async () => {
    const repo = baseRepository();
    const stagePath = "Helix/Projects/Alpha/Cycle-01.md";
    const stageBefore = (await repo.read(stagePath))!.content;
    const stageAfter = `${stageBefore}\n第一转换`;
    const otherAfter = `${stageBefore}\n第二转换`;
    const canvasBefore = (await repo.read(CANVAS))!.content;
    const transition = {
      path: stagePath,
      kind: "stage",
      entityId: "cycle-1",
      projectId: "project-1",
      fromContent: stageBefore,
      toContent: stageAfter,
    };
    repo.set(HISTORY_JOURNAL, JSON.stringify({
      version: 2,
      operation: "apply-workspace-history",
      phase: "prepared",
      createdAt: "2026-08-04T00:00:00.000Z",
      entryId: "duplicate-path",
      direction: "redo",
      canvasPath: CANVAS,
      canvasFromContent: canvasBefore,
      canvasToContent: JSON.stringify({ ...JSON.parse(canvasBefore), changed: true }),
      markdownTransitions: [transition, { ...transition, toContent: otherAfter }],
    }, null, 2));

    await expect(workspace(repo).recoverPendingWorkspaceHistory()).rejects.toThrow(/重复路径/);
    expect((await repo.read(stagePath))?.content).toBe(stageBefore);
    expect(await repo.read(HISTORY_JOURNAL)).not.toBeNull();
  });

  it("recovers a Markdown-only transaction from its persisted phase", async () => {
    const repo = baseRepository();
    const stagePath = "Helix/Projects/Alpha/Cycle-01.md";
    const stageBefore = (await repo.read(stagePath))!;
    const stageAfter = `${stageBefore.content}\n纯 Markdown 目标态`;
    const canvas = (await repo.read(CANVAS))!;
    repo.set(stagePath, stageAfter);
    repo.set(HISTORY_JOURNAL, JSON.stringify({
      version: 2,
      operation: "apply-workspace-history",
      phase: "canvas-applied",
      createdAt: "2026-08-04T00:00:00.000Z",
      entryId: "markdown-only",
      direction: "redo",
      canvasPath: CANVAS,
      canvasFromContent: canvas.content,
      canvasToContent: canvas.content,
      markdownTransitions: [{
        path: stagePath,
        kind: "stage",
        entityId: "cycle-1",
        projectId: "project-1",
        fromContent: stageBefore.content,
        toContent: stageAfter,
      }],
    }, null, 2));

    await expect(workspace(repo).recoverPendingWorkspaceHistory()).resolves.toBe("completed");
    expect((await repo.read(stagePath))?.content).toBe(stageAfter);
    expect(await repo.read(HISTORY_JOURNAL)).toBeNull();
  });

  it("freezes a phased Markdown-only journal with mixed file states", async () => {
    const repo = baseRepository();
    const firstPath = "Helix/Projects/Alpha/Cycle-01.md";
    const secondPath = "Helix/Projects/Alpha/Cycle-02.md";
    repo.set(secondPath, cycle("cycle-2", "project-1", 2));
    const firstBefore = (await repo.read(firstPath))!.content;
    const secondBefore = (await repo.read(secondPath))!.content;
    const firstAfter = `${firstBefore}\n第一目标态`;
    const secondAfter = `${secondBefore}\n第二目标态`;
    const canvas = (await repo.read(CANVAS))!.content;
    repo.set(firstPath, firstAfter);
    repo.set(HISTORY_JOURNAL, JSON.stringify({
      version: 2,
      operation: "apply-workspace-history",
      phase: "markdown-applied",
      createdAt: "2026-08-04T00:00:00.000Z",
      entryId: "markdown-mixed",
      direction: "redo",
      canvasPath: CANVAS,
      canvasFromContent: canvas,
      canvasToContent: canvas,
      markdownTransitions: [
        { path: firstPath, kind: "stage", entityId: "cycle-1", projectId: "project-1", fromContent: firstBefore, toContent: firstAfter },
        { path: secondPath, kind: "stage", entityId: "cycle-2", projectId: "project-1", fromContent: secondBefore, toContent: secondAfter },
      ],
    }, null, 2));

    await expect(workspace(repo).recoverPendingWorkspaceHistory()).rejects.toThrow(/相位与文件状态不一致/);
    expect((await repo.read(firstPath))?.content).toBe(firstAfter);
    expect((await repo.read(secondPath))?.content).toBe(secondBefore);
    expect(await repo.read(HISTORY_JOURNAL)).not.toBeNull();
  });

  it("keeps a committed Markdown-only target when journal cleanup fails", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const stagePath = "Helix/Projects/Alpha/Cycle-01.md";
    const stageBefore = (await repo.read(stagePath))!;
    const stageAfter = `${stageBefore.content}\n清理失败目标态`;
    const canvas = (await repo.read(CANVAS))!;
    repo.failTrashPath = HISTORY_JOURNAL;

    await expect(service.applyAtomicWorkspaceChange({
      label: "纯 Markdown 清理失败",
      canvasBeforeHash: canvas.hash,
      canvasAfterContent: canvas.content,
      markdownUpdates: [{
        path: stagePath,
        kind: "stage",
        entityId: "cycle-1",
        projectId: "project-1",
        beforeHash: stageBefore.hash,
        afterContent: stageAfter,
      }],
    })).rejects.toThrow(/已提交但日志尚未清理/);
    expect((await repo.read(stagePath))?.content).toBe(stageAfter);
    expect(await repo.read(HISTORY_JOURNAL)).not.toBeNull();
  });

  it("keeps version 1 history recovery compatible when Canvas is at the target", async () => {
    const repo = baseRepository();
    const stagePath = "Helix/Projects/Alpha/Legacy-Recovered.md";
    const stageContent = cycle("legacy-recovered", "project-1", 9);
    const canvasBefore = (await repo.read(CANVAS))!.content;
    const canvasAfterDocument = JSON.parse(canvasBefore);
    canvasAfterDocument.legacyRecovery = true;
    const canvasAfter = JSON.stringify(canvasAfterDocument);
    repo.set(CANVAS, canvasAfter);
    repo.set(HISTORY_JOURNAL, JSON.stringify({
      version: 1,
      operation: "apply-workspace-history",
      createdAt: "2026-08-03T00:00:00.000Z",
      entryId: "legacy-v1",
      direction: "redo",
      canvasPath: CANVAS,
      canvasFromContent: canvasBefore,
      canvasToContent: canvasAfter,
      markdownTransitions: [{
        path: stagePath,
        kind: "stage",
        entityId: "legacy-recovered",
        projectId: "project-1",
        fromContent: null,
        toContent: stageContent,
      }],
    }, null, 2));

    await expect(workspace(repo).recoverPendingWorkspaceHistory()).resolves.toBe("completed");
    expect((await repo.read(stagePath))?.content).toBe(stageContent);
    expect(await repo.read(HISTORY_JOURNAL)).toBeNull();
  });

  it("does not create recovery Markdown when the journal changes immediately before write", async () => {
    const repo = baseRepository();
    const stagePath = "Helix/Projects/Alpha/Guarded-Recovery.md";
    const stageContent = cycle("guarded-recovery", "project-1", 10);
    const canvasBefore = (await repo.read(CANVAS))!.content;
    const canvasAfter = JSON.stringify({ ...JSON.parse(canvasBefore), guarded: true });
    repo.set(CANVAS, canvasAfter);
    const journal = {
      version: 2,
      operation: "apply-workspace-history",
      phase: "canvas-applied",
      createdAt: "2026-08-04T00:00:00.000Z",
      entryId: "guarded-recovery",
      direction: "redo",
      canvasPath: CANVAS,
      canvasFromContent: canvasBefore,
      canvasToContent: canvasAfter,
      markdownTransitions: [{
        path: stagePath,
        kind: "stage",
        entityId: "guarded-recovery",
        projectId: "project-1",
        fromContent: null,
        toContent: stageContent,
      }],
    };
    repo.set(HISTORY_JOURNAL, JSON.stringify(journal, null, 2));
    let journalReads = 0;
    repo.beforeRead = (path) => {
      if (path !== HISTORY_JOURNAL || ++journalReads !== 2) return;
      repo.set(HISTORY_JOURNAL, JSON.stringify({
        ...journal,
        createdAt: "2099-01-01T00:00:00.000Z",
      }, null, 2));
    };

    await expect(workspace(repo).recoverPendingWorkspaceHistory()).rejects.toThrow(/日志在写入前发生变化/);
    expect(await repo.read(stagePath)).toBeNull();
    expect(await repo.read(HISTORY_JOURNAL)).not.toBeNull();
  });

  it("freezes a history journal without a canonical createdAt before any write", async () => {
    const repo = baseRepository();
    const stagePath = "Helix/Projects/Alpha/Invalid-Time.md";
    const canvasBefore = (await repo.read(CANVAS))!.content;
    const canvasAfter = JSON.stringify({ ...JSON.parse(canvasBefore), invalidTime: true });
    repo.set(CANVAS, canvasAfter);
    repo.set(HISTORY_JOURNAL, JSON.stringify({
      version: 2,
      operation: "apply-workspace-history",
      phase: "canvas-applied",
      entryId: "invalid-time",
      direction: "redo",
      canvasPath: CANVAS,
      canvasFromContent: canvasBefore,
      canvasToContent: canvasAfter,
      markdownTransitions: [{
        path: stagePath,
        kind: "stage",
        entityId: "invalid-time",
        projectId: "project-1",
        fromContent: null,
        toContent: cycle("invalid-time", "project-1", 11),
      }],
    }, null, 2));

    await expect(workspace(repo).recoverPendingWorkspaceHistory()).rejects.toThrow(/字段无效/);
    expect(await repo.read(stagePath)).toBeNull();
    expect((await repo.read(CANVAS))?.content).toBe(canvasAfter);
    expect(await repo.read(HISTORY_JOURNAL)).not.toBeNull();
  });

  it("undoes and redoes a bridged stage deletion without losing the note", async () => {
    const repo = linearRepository();
    const service = workspace(repo);
    const stagePath = "Helix/Projects/Alpha/Cycle-02.md";
    const stageBefore = (await repo.read(stagePath))!.content;
    const plan = await service.planCycleDeletion("cycle-2");
    const canvasBefore = (await repo.read(CANVAS))!.content;
    await service.deleteCycle(plan, { bridge: true });
    const canvasAfter = (await repo.read(CANVAS))!.content;
    expect(await repo.read(stagePath)).toBeNull();

    await service.undoLastWorkspaceChange();
    expect((await repo.read(stagePath))?.content).toBe(stageBefore);
    expect((await repo.read(CANVAS))!.content).toBe(canvasBefore);
    await service.redoLastWorkspaceChange();
    expect(await repo.read(stagePath)).toBeNull();
    expect((await repo.read(CANVAS))!.content).toBe(canvasAfter);
  });

  it("freezes the workspace when a history journal cannot be cleaned", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const revision = (await service.snapshot()).canvasRevisionHash!;
    await service.moveCanvasNodes([
      { nodeId: "cycle-node", x: 200, y: 240 },
    ], revision);
    repo.failTrashPath = HISTORY_JOURNAL;
    repo.beforeCompare = () => {
      throw new Error("injected Canvas write failure");
    };

    await expect(service.undoLastWorkspaceChange()).rejects.toThrow(
      /清理未完成/,
    );
    expect(await repo.read(HISTORY_JOURNAL)).not.toBeNull();
    await expect(service.snapshot()).rejects.toThrow(/项目图谱历史失败/);

    repo.failTrashPath = undefined;
    const recovered = workspace(repo);
    await expect(recovered.recoverPendingWorkspaceHistory()).resolves.toBe(
      "aborted",
    );
    expect(await repo.read(HISTORY_JOURNAL)).toBeNull();
  });

  it("finishes a history transaction when Canvas committed before Markdown removal", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const created = await service.createCycle(
      "project-1",
      "auto",
      ["cycle-1"],
      {
        expectedAutoIntent: {
          relation: "inherit",
          convertedInheritanceRelationIds: [],
        },
        stageTitle: "历史恢复完成分支",
      },
    );
    repo.failTrashPath = created.notePath;
    await expect(service.undoLastWorkspaceChange()).rejects.toThrow(
      /事务日志已保留/,
    );
    expect(await repo.read(created.notePath)).not.toBeNull();
    expect(await repo.read(HISTORY_JOURNAL)).not.toBeNull();

    repo.failTrashPath = undefined;
    const recovered = workspace(repo);
    await expect(recovered.recoverPendingWorkspaceHistory()).resolves.toBe(
      "completed",
    );
    expect(await repo.read(created.notePath)).toBeNull();
    expect(await repo.read(HISTORY_JOURNAL)).toBeNull();
  });

  it("freezes an unknown Canvas version without touching pending history Markdown", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const created = await service.createCycle(
      "project-1",
      "auto",
      ["cycle-1"],
      {
        expectedAutoIntent: {
          relation: "inherit",
          convertedInheritanceRelationIds: [],
        },
        stageTitle: "历史恢复未知画布",
      },
    );
    repo.failTrashPath = created.notePath;
    await expect(service.undoLastWorkspaceChange()).rejects.toThrow(
      /事务日志已保留/,
    );
    const unknownCanvas = repo.json(CANVAS);
    unknownCanvas.externalAfterCrash = true;
    repo.set(CANVAS, JSON.stringify(unknownCanvas));
    repo.failTrashPath = undefined;
    const recovered = workspace(repo);

    await expect(recovered.recoverPendingWorkspaceHistory()).rejects.toThrow(
      /偏离撤销事务的起点和终点/,
    );
    expect(await repo.read(created.notePath)).not.toBeNull();
    expect(await repo.read(HISTORY_JOURNAL)).not.toBeNull();
  });

  it("freezes instead of guessing when both workspace journals exist", async () => {
    const repo = baseRepository();
    repo.set(HISTORY_JOURNAL, "{}");
    repo.set(DELETE_JOURNAL, "{}");
    const service = workspace(repo);

    await expect(service.recoverPendingWorkspaceHistory()).rejects.toThrow(
      /同时发现撤销事务与阶段删除事务/,
    );
    await expect(service.snapshot()).rejects.toThrow(/人工检查/);
  });

  it("drops session history by count and UTF-8 byte budgets", async () => {
    const countRepo = baseRepository();
    const countService = workspace(countRepo);
    for (let index = 0; index < 55; index += 1) {
      const revision = (await countService.snapshot()).canvasRevisionHash!;
      await countService.moveCanvasNodes([
        { nodeId: "cycle-node", x: index + 1, y: 300 },
      ], revision);
    }
    expect(countService.historyState().undoCount).toBe(50);

    const byteRepo = baseRepository();
    const canvas = byteRepo.json(CANVAS);
    canvas.largeUserField = "研".repeat(900_000);
    byteRepo.set(CANVAS, JSON.stringify(canvas));
    const byteService = workspace(byteRepo);
    const revision = (await byteService.snapshot()).canvasRevisionHash!;
    await byteService.moveCanvasNodes([
      { nodeId: "cycle-node", x: 42, y: 300 },
    ], revision);
    expect(byteService.historyState().undoCount).toBe(0);
  }, 15_000);

  it("invalidates session history after an observed external Canvas write", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const revision = (await service.snapshot()).canvasRevisionHash!;
    await service.moveCanvasNodes([
      { nodeId: "cycle-node", x: 80, y: 300 },
    ], revision);
    const external = repo.json(CANVAS);
    external.nativeEdit = true;
    repo.set(CANVAS, JSON.stringify(external));

    await service.observeCanvasChange();
    expect(service.historyState()).toMatchObject({ undoCount: 0, redoCount: 0 });
  });

  it("saves one current layout without retaining workspace undo history", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const revision = (await service.snapshot()).canvasRevisionHash!;

    await service.moveCanvasNodes([
      { nodeId: "cycle-node", x: 240, y: 360 },
    ], revision, { recordHistory: false });

    expect(repo.json(CANVAS).nodes).toContainEqual(expect.objectContaining({
      id: "cycle-node",
      x: 240,
      y: 360,
    }));
    expect(service.historyState()).toMatchObject({ undoCount: 0, redoCount: 0 });
  });

  it("preserves a non-managed Canvas edge by refusing stage deletion", async () => {
    const repo = linearRepository();
    const canvas = repo.json(CANVAS);
    canvas.edges.push({
      id: "native-user-edge",
      fromNode: "cycle-2-node",
      toNode: "project-node",
      label: "用户备注关系",
    });
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    const plan = await service.planCycleDeletion("cycle-2");
    const before = (await repo.read(CANVAS))!.content;

    await expect(service.deleteCycle(plan)).rejects.toThrow(/尚未交由 Helix 管理/);
    expect((await repo.read(CANVAS))!.content).toBe(before);
    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).not.toBeNull();
  });

  it("preserves a legacy derives-from edge by refusing stage deletion", async () => {
    const repo = linearRepository();
    const canvas = repo.json(CANVAS);
    canvas.edges.push({
      id: "legacy-derived-edge",
      fromNode: "cycle-2-node",
      toNode: "project-node",
      label: "derives-from",
      helixManaged: true,
      helixRelation: "derives-from",
    });
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    await service.acknowledgeLegacyMigration([
      (await service.snapshot()).migrationItems[0]!.id,
    ]);
    const plan = await service.planCycleDeletion("cycle-2");
    const before = (await repo.read(CANVAS))!.content;

    await expect(service.deleteCycle(plan)).rejects.toThrow(/尚未交由 Helix 管理/);
    expect((await repo.read(CANVAS))!.content).toBe(before);
    expect(repo.json(CANVAS).edges).toContainEqual(
      expect.objectContaining({ id: "legacy-derived-edge" }),
    );
  });

  it("rejects a Markdown identity replacement before stage deletion", async () => {
    const repo = linearRepository();
    const service = workspace(repo);
    const plan = await service.planCycleDeletion("cycle-2");
    const stagePath = "Helix/Projects/Alpha/Cycle-02.md";
    let stageReads = 0;
    repo.beforeRead = (path) => {
      if (path !== stagePath) return;
      stageReads += 1;
      if (stageReads === 9) {
        repo.set(stagePath, project("replacement-project", "无关内容"));
      }
    };
    const canvasBefore = (await repo.read(CANVAS))!.content;

    await expect(service.deleteCycle(plan)).rejects.toThrow(
      /其他内容替换|多个 Helix 项目|身份/,
    );
    expect((await repo.read(CANVAS))!.content).toBe(canvasBefore);
    expect((await repo.read(stagePath))?.content).toContain("replacement-project");
    expect(await repo.read(DELETE_JOURNAL)).toBeNull();
  });

  it("stores a normalized project color in Markdown and detects competing edits", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    await service.updateProjectColor("project-1", "#4d8275");
    expect((await repo.read("Helix/Projects/Alpha/Project.md"))?.content)
      .toContain('helix-color: "#4D8275"');
    expect((await service.snapshot()).projects[0]?.color).toBe("#4D8275");
    await expect(service.updateProjectColor("project-1", "green"))
      .rejects.toThrow(/#RRGGBB/);

    repo.beforeCompare = () => {
      const path = "Helix/Projects/Alpha/Project.md";
      repo.set(path, `${repo.take(path)}\nuser edit`);
    };
    await expect(service.updateProjectColor("project-1", "#5870A8"))
      .rejects.toThrow(/conflict/);
  });

  it("updates project and stage status only in managed Markdown fields", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const projectPath = "Helix/Projects/Alpha/Project.md";
    const cyclePath = "Helix/Projects/Alpha/Cycle-01.md";
    repo.set(projectPath, repo.take(projectPath)!.replace(
      "helix-status: active",
      "helix-status: active\ncustom-owner: user",
    ));
    repo.set(cyclePath, `${repo.take(cyclePath)!}\n用户正文保留`);

    const projectPlan = await service.prepareProjectStatusUpdate("project-1");
    const cyclePlan = await service.prepareCycleStatusUpdate("cycle-1");
    await service.updateProjectStatus(projectPlan, "paused");
    await service.updateCycleStatus(cyclePlan, "completed");

    expect((await repo.read(projectPath))?.content).toContain("helix-status: \"paused\"");
    expect((await repo.read(projectPath))?.content).toContain("custom-owner: user");
    expect((await repo.read(cyclePath))?.content).toContain("helix-status: \"completed\"");
    expect((await repo.read(cyclePath))?.content).toContain("用户正文保留");
    expect((await service.snapshot()).projects[0]).toMatchObject({
      status: "paused",
      cycles: [expect.objectContaining({ status: "completed" })],
    });

    await service.ensureCanvas();
    expect(repo.json(CANVAS).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "project-node",
        text: expect.stringContaining("已暂停"),
      }),
      expect.objectContaining({
        id: "cycle-node",
        text: expect.stringContaining("已完成"),
      }),
    ]));
    await expect(service.updateProjectStatus(projectPlan, "invalid" as never))
      .rejects.toThrow(/项目状态无效/);
    await expect(service.updateCycleStatus(cyclePlan, "invalid" as never))
      .rejects.toThrow(/阶段状态无效/);
  });

  it("rejects stale status dialogs and Markdown identity replacement without writing", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const projectPath = "Helix/Projects/Alpha/Project.md";
    const cyclePath = "Helix/Projects/Alpha/Cycle-01.md";
    const projectPlan = await service.prepareProjectStatusUpdate("project-1");
    const cyclePlan = await service.prepareCycleStatusUpdate("cycle-1");

    repo.set(projectPath, repo.take(projectPath)!.replace(
      "helix-status: active",
      "helix-status: completed",
    ));
    await expect(service.updateProjectStatus(projectPlan, "paused"))
      .rejects.toThrow(/确认期间已经变化/);
    expect((await repo.read(projectPath))?.content).toContain("helix-status: completed");
    expect((await repo.read(projectPath))?.content).not.toContain("helix-status: \"paused\"");

    repo.set(cyclePath, [
      "---",
      "helix-kind: helix-stage",
      "helix-id: unrelated-stage",
      "helix-project-id: project-1",
      "helix-sequence: 1",
      "helix-status: active",
      "---",
      "# 无关阶段",
    ].join("\n"));
    const replacement = await repo.read(cyclePath);
    await expect(service.updateCycleStatus({
      ...cyclePlan,
      revisionHash: replacement!.hash,
    }, "completed")).rejects.toThrow(/确认期间已经变化/);
    expect((await repo.read(cyclePath))?.content).toContain("helix-id: unrelated-stage");
    expect((await repo.read(cyclePath))?.content).not.toContain("helix-status: \"completed\"");
  });

  it("adds a physical edge, normalizes the complete graph and rejects stale plans", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    repo.set("Helix/Projects/Alpha/Cycle-03.md", cycle("cycle-3", "project-1", 3));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300),
      card("cycle-3-node", "cycle", "project-1", "cycle-3", 520, 600),
    );
    canvas.edges.push({
      id: "edge-1",
      fromNode: "cycle-node",
      toNode: "cycle-2-node",
      helixManaged: true,
      helixRelation: "inherit",
      label: "继承",
      custom: "keep",
    });
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    const plan = await service.planConnection("cycle-1", "cycle-3");
    expect(plan).toMatchObject({
      affectedNodeCount: 3,
      relabeledEdgeCount: 1,
      targetInboundCount: 0,
      resultKind: "branch",
      source: {
        projectTitle: "Alpha",
        cycleTitle: "阶段标题 1",
        sequence: 1,
      },
      target: {
        projectTitle: "Alpha",
        cycleTitle: "阶段标题 3",
        sequence: 3,
      },
    });
    const beforeTamper = (await repo.read(CANVAS))!.content;
    await expect(service.connectCycles({
      ...plan,
      affectedNodeCount: plan.affectedNodeCount + 1,
    })).rejects.toThrow(/计划已经变化/);
    await expect(service.connectCycles({
      ...plan,
      resultKind: "merge",
    })).rejects.toThrow(/计划已经变化/);
    expect((await repo.read(CANVAS))!.content).toBe(beforeTamper);
    await service.connectCycles(plan);
    expect(repo.json(CANVAS).edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "edge-1",
        helixRelation: "branch",
        custom: "keep",
      }),
      expect.objectContaining({ helixRelation: "branch" }),
    ]));
    await expect(service.connectCycles(plan)).rejects.toThrow(/已经变化/);
  });

  it("derives, removes and restores a target focus block with its Canvas relation", async () => {
    const repo = baseRepository();
    const sourcePath = "Helix/Projects/Alpha/Cycle-01.md";
    const targetPath = "Helix/Projects/Alpha/Cycle-02.md";
    repo.set(sourcePath, repo.take(sourcePath)!.replace(
      "## 下一阶段聚焦问题\n",
      "## 下一阶段聚焦问题\n验证聚焦桥接\n",
    ));
    repo.set(targetPath, cycle("cycle-2", "project-1", 2).replace(
      "# 本阶段问题聚焦\n",
      "# 本阶段问题聚焦\n用户前言\n",
    ));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300));
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);

    await service.connectCycles(await service.planConnection("cycle-1", "cycle-2"));
    const connected = (await repo.read(targetPath))!.content;
    expect(connected).toContain("sourceId=cycle-1");
    expect(connected).toContain("> 验证聚焦桥接");
    expect(connected).toContain("用户前言");
    const relationId = (await service.snapshot()).relations[0]!.id;

    await service.deleteRelation(relationId);
    const disconnected = (await repo.read(targetPath))!.content;
    expect(disconnected).not.toContain("helix-focus-bridge");
    expect(disconnected).toContain("用户前言");
    await service.undoLastWorkspaceChange();
    expect((await repo.read(targetPath))!.content).toContain("sourceId=cycle-1");
  });

  it("creates an inherited stage with its predecessor focus already derived", async () => {
    const repo = baseRepository();
    const sourcePath = "Helix/Projects/Alpha/Cycle-01.md";
    repo.set(sourcePath, repo.take(sourcePath)!.replace(
      "## 下一阶段聚焦问题\n",
      "## 下一阶段聚焦问题\n直接进入新阶段\n",
    ));
    const created = await workspace(repo).createCycle(
      "project-1",
      "inherit",
      ["cycle-1"],
      { stageTitle: "聚焦继承" },
    );
    const markdown = (await repo.read(created.notePath))!.content;
    expect(markdown).toContain("sourceId=cycle-1");
    expect(markdown).toContain("> 直接进入新阶段");
  });

  it("observes a source-only focus edit through one recoverable Markdown transaction", async () => {
    const { repo, service, sourcePath, targetPath } = await focusBridgeWorkspace();
    const historyBefore = service.historyState();
    repo.set(sourcePath, repo.take(sourcePath)!.replace("Base focus", "Source focus"));

    await service.observeFocusBridgeChanges([sourcePath]);

    expect((await repo.read(targetPath))!.content).toContain("> Source focus");
    expect(await service.listFocusBridgeConflicts()).toEqual([]);
    expect(repo.paths()).toContain("Helix/.transactions/stage-focus-bridge.json");
    expect(service.historyState()).toEqual(historyBefore);
    const targetAfter = (await repo.read(targetPath))!.content;
    const stateAfter = repo.take("Helix/.transactions/stage-focus-bridge.json")!;
    repo.set("Helix/.transactions/stage-focus-bridge.json", stateAfter);
    await service.observeFocusBridgeChanges([sourcePath, targetPath]);
    expect((await repo.read(targetPath))!.content).toBe(targetAfter);
    expect((await repo.read("Helix/.transactions/stage-focus-bridge.json"))!.content).toBe(stateAfter);
    expect(service.historyState()).toEqual(historyBefore);
  });

  it("reverse-applies a derived-only edit to source and origin target in the same transaction", async () => {
    const { repo, service, sourcePath, targetPath } = await focusBridgeWorkspace();
    repo.set(targetPath, repo.take(targetPath)!.replace("> Base focus", "> Derived focus"));

    await service.observeFocusBridgeChanges([targetPath]);

    expect((await repo.read(sourcePath))!.content).toContain("## 下一阶段聚焦问题\nDerived focus");
    const targetMarkdown = (await repo.read(targetPath))!.content;
    expect(targetMarkdown).toContain("> Derived focus");
    expect(targetMarkdown).toContain("baseHash=" + stableHash("Derived focus"));
    expect(await service.listFocusBridgeConflicts()).toEqual([]);
  });

  it("persists simultaneous focus edits across restart without blocking another pair", async () => {
    const first = await focusBridgeWorkspace();
    first.repo.set(first.sourcePath, first.repo.take(first.sourcePath)!.replace("Base focus", "Source focus"));
    first.repo.set(first.targetPath, first.repo.take(first.targetPath)!.replace("> Base focus", "> Derived focus"));

    await first.service.observeFocusBridgeChanges([first.sourcePath, first.targetPath]);

    const conflicts = await first.service.listFocusBridgeConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      baseContent: "Base focus",
      sourceContent: "Source focus",
      derivedContent: "Derived focus",
    });
    const restarted = workspace(first.repo);
    expect(await restarted.listFocusBridgeConflicts()).toEqual(conflicts);
  });

  it("rechecks exact revisions before resolving a persisted focus conflict", async () => {
    const { repo, service, sourcePath, targetPath } = await focusBridgeWorkspace();
    repo.set(sourcePath, repo.take(sourcePath)!.replace("Base focus", "Source focus"));
    repo.set(targetPath, repo.take(targetPath)!.replace("> Base focus", "> Derived focus"));
    await service.observeFocusBridgeChanges([sourcePath, targetPath]);
    const conflict = (await service.listFocusBridgeConflicts())[0]!;
    await service.resolveFocusBridgeConflict(conflict.id, "derived");

    expect((await repo.read(sourcePath))!.content).toContain("## 下一阶段聚焦问题\nDerived focus");
    expect((await repo.read(targetPath))!.content).toContain("> Derived focus");
    expect(await service.listFocusBridgeConflicts()).toEqual([]);
  });

  it("does not overwrite a concurrently advanced focus state while resolving", async () => {
    const { repo, service, sourcePath, targetPath } = await focusBridgeWorkspace();
    const statePath = "Helix/.transactions/stage-focus-bridge.json";
    repo.set(sourcePath, repo.take(sourcePath)!.replace("Base focus", "Source focus"));
    repo.set(targetPath, repo.take(targetPath)!.replace("> Base focus", "> Derived focus"));
    await service.observeFocusBridgeChanges([sourcePath, targetPath]);
    const conflict = (await service.listFocusBridgeConflicts())[0]!;
    const sourceBeforeResolution = (await repo.read(sourcePath))!.content;
    const targetBeforeResolution = (await repo.read(targetPath))!.content;
    let competed = false;
    repo.beforeCompareEvery = (path) => {
      if (path !== statePath || competed) return;
      competed = true;
      const concurrent = repo.json(statePath);
      const checkpoint = structuredClone(
        Object.values(concurrent.checkpoints)[0],
      ) as Record<string, unknown>;
      concurrent.checkpoints.concurrent = { ...checkpoint, key: "concurrent" };
      repo.set(statePath, JSON.stringify(concurrent));
    };

    await expect(service.resolveFocusBridgeConflict(conflict.id, "source"))
      .rejects.toThrow(/write conflict/);

    expect(repo.json(statePath).checkpoints.concurrent).toBeDefined();
    expect((await repo.read(sourcePath))!.content).toBe(sourceBeforeResolution);
    expect((await repo.read(targetPath))!.content).toBe(targetBeforeResolution);
  });

  it("recovers a committed focus resolution when state finalization is interrupted", async () => {
    const { repo, service, sourcePath, targetPath } = await focusBridgeWorkspace();
    const statePath = "Helix/.transactions/stage-focus-bridge.json";
    repo.set(sourcePath, repo.take(sourcePath)!.replace("Base focus", "Source focus"));
    repo.set(targetPath, repo.take(targetPath)!.replace("> Base focus", "> Derived focus"));
    await service.observeFocusBridgeChanges([sourcePath, targetPath]);
    const conflict = (await service.listFocusBridgeConflicts())[0]!;
    let stateWrites = 0;
    repo.beforeCompareEvery = (path) => {
      if (path !== statePath) return;
      stateWrites += 1;
      if (stateWrites === 2 || stateWrites === 3) throw new Error("finalize interrupted");
    };

    await expect(service.resolveFocusBridgeConflict(conflict.id, "derived"))
      .rejects.toThrow(/finalize interrupted/);
    expect(repo.json(statePath).pendingResolution).toBeDefined();
    repo.beforeCompareEvery = undefined;

    const restarted = workspace(repo);
    await restarted.initializeFocusBridgeState();

    expect((await repo.read(sourcePath))!.content).toContain("Derived focus");
    expect((await repo.read(targetPath))!.content).toContain("> Derived focus");
    expect(await restarted.listFocusBridgeConflicts()).toEqual([]);
    expect(repo.json(statePath).pendingResolution).toBeUndefined();
  });

  it("freezes every project write and preserves pending state on mixed resolution files", async () => {
    const { repo, service, sourcePath, targetPath } = await focusBridgeWorkspace();
    const statePath = "Helix/.transactions/stage-focus-bridge.json";
    repo.set(sourcePath, repo.take(sourcePath)!.replace("Base focus", "Source focus"));
    repo.set(targetPath, repo.take(targetPath)!.replace("> Base focus", "> Derived focus"));
    await service.observeFocusBridgeChanges([sourcePath, targetPath]);
    const conflict = (await service.listFocusBridgeConflicts())[0]!;
    const sourceBeforeResolution = (await repo.read(sourcePath))!.content;
    let stateWrites = 0;
    repo.beforeCompareEvery = (path) => {
      if (path !== statePath) return;
      stateWrites += 1;
      if (stateWrites === 2 || stateWrites === 3) throw new Error("finalize interrupted");
    };
    await expect(service.resolveFocusBridgeConflict(conflict.id, "derived"))
      .rejects.toThrow(/finalize interrupted/);
    repo.beforeCompareEvery = undefined;
    repo.set(sourcePath, sourceBeforeResolution);
    const projectPath = "Helix/Projects/Alpha/Project.md";
    const projectBefore = (await repo.read(projectPath))!.content;
    const restarted = workspace(repo);

    await expect(restarted.observeFocusBridgeChanges([sourcePath, targetPath]))
      .rejects.toThrow(/混合或未知版本|已冻结/);
    expect(repo.json(statePath).pendingResolution).toBeDefined();
    await expect(restarted.updateProjectColor("project-1", "#5870A8"))
      .rejects.toThrow(/已冻结/);
    expect((await repo.read(projectPath))!.content).toBe(projectBefore);
    expect(repo.json(statePath).pendingResolution).toBeDefined();
  });

  it("uses dedicated rebuild for a recoverable structural conflict", async () => {
    const { repo, service, targetPath } = await focusBridgeWorkspace();
    repo.set(targetPath, repo.take(targetPath)!.replace("|阶段标题 1]]", "|用户改坏链接]]"));
    await service.observeFocusBridgeChanges([targetPath]);
    const conflict = (await service.listFocusBridgeConflicts())[0]!;
    expect(conflict.reason).toBe("derived-structure-changed");
    await expect(service.resolveFocusBridgeConflict(conflict.id, "source"))
      .rejects.toThrow(/不能使用内容三选一/);

    await service.rebuildFocusBridgeConflict(conflict.id);

    expect((await repo.read(targetPath))!.content).toContain("|阶段标题 1]]");
    expect(await service.listFocusBridgeConflicts()).toEqual([]);
  });

  it("prunes orphan focus checkpoints and conflicts when no active relation remains", async () => {
    const { repo, service, sourcePath, targetPath } = await focusBridgeWorkspace();
    const statePath = "Helix/.transactions/stage-focus-bridge.json";
    repo.set(sourcePath, repo.take(sourcePath)!.replace("Base focus", "Source focus"));
    repo.set(targetPath, repo.take(targetPath)!.replace("> Base focus", "> Derived focus"));
    await service.observeFocusBridgeChanges([sourcePath, targetPath]);
    expect(await service.listFocusBridgeConflicts()).toHaveLength(1);
    const canvas = repo.json(CANVAS);
    canvas.edges = [];
    repo.set(CANVAS, JSON.stringify(canvas));

    await service.observeFocusBridgeChanges([sourcePath]);

    expect(repo.json(statePath)).toMatchObject({ checkpoints: {}, conflicts: [] });
  });

  it("freezes only the structurally conflicted focus pair while updating another target", async () => {
    const { repo, service, sourcePath, targetPath } = await focusBridgeWorkspace();
    const thirdPath = "Helix/Projects/Alpha/Cycle-03.md";
    repo.set(thirdPath, cycle("cycle-3", "project-1", 3));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(card("cycle-3-node", "cycle", "project-1", "cycle-3", 920, 300));
    repo.set(CANVAS, JSON.stringify(canvas));
    await service.connectCycles(await service.planConnection("cycle-1", "cycle-3"));
    await service.initializeFocusBridgeState();
    repo.set(sourcePath, repo.take(sourcePath)!.replace("Base focus", "Shared source"));
    repo.set(targetPath, repo.take(targetPath)!.replace("|阶段标题 1]]", "|Tampered]]"));

    await service.observeFocusBridgeChanges([sourcePath, targetPath]);

    expect(await service.listFocusBridgeConflicts()).toHaveLength(1);
    expect((await repo.read(targetPath))!.content).toContain("|Tampered]]");
    expect((await repo.read(thirdPath))!.content).toContain("> Shared source");
  });

  it("keeps a focus conflict frozen when either exact file revision changes before apply", async () => {
    const { repo, service, sourcePath, targetPath } = await focusBridgeWorkspace();
    repo.set(sourcePath, repo.take(sourcePath)!.replace("Base focus", "Source focus"));
    repo.set(targetPath, repo.take(targetPath)!.replace("> Base focus", "> Derived focus"));
    await service.observeFocusBridgeChanges([sourcePath, targetPath]);
    const conflict = (await service.listFocusBridgeConflicts())[0]!;
    repo.set(targetPath, `${repo.take(targetPath)!}\n外部竞争`);

    await expect(service.resolveFocusBridgeConflict(conflict.id, "source"))
      .rejects.toThrow(/已经变化/);
    expect(await service.listFocusBridgeConflicts()).toHaveLength(1);
    await service.observeFocusBridgeChanges([targetPath]);
    const refreshed = (await service.listFocusBridgeConflicts())[0]!;
    await service.resolveFocusBridgeConflict(refreshed.id, "source");
    expect((await repo.read(targetPath))!.content).toContain("外部竞争");
    expect(await service.listFocusBridgeConflicts()).toEqual([]);
  });

  it("uses a persisted non-authoritative Base checkpoint after service restart", async () => {
    const { repo, sourcePath, targetPath } = await focusBridgeWorkspace();
    const restarted = workspace(repo);
    repo.set(sourcePath, repo.take(sourcePath)!.replace("Base focus", "After restart"));

    await restarted.observeFocusBridgeChanges([sourcePath]);

    expect((await repo.read(targetPath))!.content).toContain("> After restart");
    expect(await restarted.listFocusBridgeConflicts()).toEqual([]);
  });

  it("fails closed when the persisted Base checkpoint structure is damaged", async () => {
    const { repo, service, sourcePath } = await focusBridgeWorkspace();
    const statePath = "Helix/.transactions/stage-focus-bridge.json";
    const state = repo.json(statePath);
    const checkpoint = Object.values(state.checkpoints)[0] as { baseHash: string };
    checkpoint.baseHash = "0".repeat(64);
    repo.set(statePath, JSON.stringify(state));
    repo.set(sourcePath, repo.take(sourcePath)!.replace("Base focus", "Must not write"));

    await expect(service.observeFocusBridgeChanges([sourcePath]))
      .rejects.toThrow(/检查点结构无效/);
  });

  it.each([
    ["forward", ["cycle-2", "cycle-3"]],
    ["reverse", ["cycle-3", "cycle-2"]],
  ])("freezes different reverse candidates for one source independent of order: %s", async (_name, order) => {
    const setup = await focusBridgeWorkspaceWithTwoTargets();
    setup.repo.set(setup.targetPaths[0], setup.repo.take(setup.targetPaths[0])!
      .replace("> Base focus", "> Candidate A"));
    setup.repo.set(setup.targetPaths[1], setup.repo.take(setup.targetPaths[1])!
      .replace("> Base focus", "> Candidate B"));
    const paths = order.map((id) => id === "cycle-2" ? setup.targetPaths[0] : setup.targetPaths[1]);

    await setup.service.observeFocusBridgeChanges(paths);

    expect((await setup.repo.read(setup.sourcePath))!.content).toContain("Base focus");
    expect(await setup.service.listFocusBridgeConflicts()).toHaveLength(2);
    expect((await setup.repo.read(setup.targetPaths[0]))!.content).toContain("> Candidate A");
    expect((await setup.repo.read(setup.targetPaths[1]))!.content).toContain("> Candidate B");
  });

  it("accepts identical reverse candidates only after validating both pairs", async () => {
    const setup = await focusBridgeWorkspaceWithTwoTargets();
    for (const path of setup.targetPaths) {
      setup.repo.set(path, setup.repo.take(path)!.replace("> Base focus", "> Same candidate"));
    }

    await setup.service.observeFocusBridgeChanges([...setup.targetPaths].reverse());

    expect((await setup.repo.read(setup.sourcePath))!.content).toContain("Same candidate");
    expect(await setup.service.listFocusBridgeConflicts()).toEqual([]);
    for (const path of setup.targetPaths) {
      expect((await setup.repo.read(path))!.content).toContain("> Same candidate");
    }
  });

  it.each([
    ["body", (markdown: string) => markdown.replace("> Base focus", "> Hidden edit")],
    ["structure", (markdown: string) => markdown.replace("|阶段标题 1]]", "|Hidden link edit]]")],
  ])("does not overwrite an unobserved target with an existing %s edit", async (_name, edit) => {
    const setup = await focusBridgeWorkspaceWithTwoTargets();
    setup.repo.set(setup.targetPaths[0], setup.repo.take(setup.targetPaths[0])!
      .replace("> Base focus", "> Accepted reverse"));
    setup.repo.set(setup.targetPaths[1], edit(setup.repo.take(setup.targetPaths[1])!));

    await setup.service.observeFocusBridgeChanges([setup.targetPaths[0]]);

    expect((await setup.repo.read(setup.sourcePath))!.content).toContain("Accepted reverse");
    expect((await setup.repo.read(setup.targetPaths[0]))!.content).toContain("> Accepted reverse");
    expect((await setup.repo.read(setup.targetPaths[1]))!.content)
      .toContain(_name === "body" ? "> Hidden edit" : "|Hidden link edit]]");
    expect(await setup.service.listFocusBridgeConflicts()).toHaveLength(1);
  });

  it("does not advance a checkpoint when the corresponding Markdown transaction loses CAS", async () => {
    const { repo, service, sourcePath, targetPath } = await focusBridgeWorkspace();
    const statePath = "Helix/.transactions/stage-focus-bridge.json";
    const beforeState = repo.json(statePath);
    const beforeCheckpoint = structuredClone(Object.values(beforeState.checkpoints)[0]);
    repo.set(sourcePath, repo.take(sourcePath)!.replace("Base focus", "CAS candidate"));
    repo.beforeCompare = (path) => {
      if (path === targetPath) repo.set(targetPath, `${repo.take(targetPath)!}\n竞争内容`);
    };

    await expect(service.observeFocusBridgeChanges([sourcePath])).rejects.toThrow(/变化|conflict/);

    const afterState = repo.json(statePath);
    expect(Object.values(afterState.checkpoints)[0]).toEqual(beforeCheckpoint);
    expect((await repo.read(targetPath))!.content).not.toContain("> CAS candidate");
  });

  it("keeps Canvas byte-identical when connection focus headings or markers are invalid", async () => {
    for (const damage of ["target-heading", "source-heading", "target-marker"] as const) {
      const repo = baseRepository();
      const sourcePath = "Helix/Projects/Alpha/Cycle-01.md";
      const targetPath = "Helix/Projects/Alpha/Cycle-02.md";
      repo.set(targetPath, cycle("cycle-2", "project-1", 2));
      if (damage === "target-heading") {
        repo.set(targetPath, repo.take(targetPath)!.replace("# 本阶段问题聚焦", "# 手工改名"));
      } else if (damage === "source-heading") {
        repo.set(sourcePath, repo.take(sourcePath)!.replace("## 下一阶段聚焦问题", "## 手工改名"));
      } else {
        repo.set(targetPath, repo.take(targetPath)!.replace(
          "# 本阶段问题聚焦\n",
          "# 本阶段问题聚焦\n <!-- helix-focus-bridge:start version=1 -->\n",
        ));
      }
      const canvas = repo.json(CANVAS);
      canvas.nodes.push(card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300));
      repo.set(CANVAS, JSON.stringify(canvas));
      const service = workspace(repo);
      const plan = await service.planConnection("cycle-1", "cycle-2");
      const before = (await repo.read(CANVAS))!.content;
      await expect(service.connectCycles(plan)).rejects.toThrow(/标题|标记|自动引用区域/);
      expect((await repo.read(CANVAS))!.content).toBe(before);
    }
  });

  it("keeps a native edge untouched when its target focus section is missing", async () => {
    const repo = baseRepository();
    const targetPath = "Helix/Projects/Alpha/Cycle-02.md";
    repo.set(targetPath, cycle("cycle-2", "project-1", 2).replace(
      "# 本阶段问题聚焦",
      "# 已改名聚焦",
    ));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300));
    canvas.edges.push({ id: "native-focus", fromNode: "cycle-node", toNode: "cycle-2-node" });
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    const candidate = (await service.snapshot()).nativeRelationCandidates[0]!;
    const before = (await repo.read(CANVAS))!.content;
    await expect(service.adoptNativeRelation(candidate)).rejects.toThrow(/缺少标题/);
    expect((await repo.read(CANVAS))!.content).toBe(before);
    expect(repo.json(CANVAS).edges[0]).not.toHaveProperty("helixManaged");
  });

  it("refuses a relation mutation that would overwrite an edited derived block", async () => {
    const repo = baseRepository();
    const targetPath = "Helix/Projects/Alpha/Cycle-02.md";
    repo.set(targetPath, cycle("cycle-2", "project-1", 2));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300));
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    await service.connectCycles(await service.planConnection("cycle-1", "cycle-2"));
    const relationId = (await service.snapshot()).relations[0]!.id;
    repo.set(targetPath, repo.take(targetPath)!.replace("|阶段标题 1]]", "|用户编辑来源]]"));
    const before = (await repo.read(CANVAS))!.content;
    await expect(service.deleteRelation(relationId)).rejects.toThrow(/已被编辑/);
    expect((await repo.read(CANVAS))!.content).toBe(before);
  });

  it("does not create a stage when its predecessor source heading is missing", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    await service.ensureCanvas();
    const sourcePath = "Helix/Projects/Alpha/Cycle-01.md";
    repo.set(sourcePath, repo.take(sourcePath)!.replace(
      "## 下一阶段聚焦问题",
      "## 已改名下一阶段",
    ));
    const canvasBefore = (await repo.read(CANVAS))!.content;
    await expect(service.createCycle(
      "project-1",
      "inherit",
      ["cycle-1"],
      { stageTitle: "不得创建" },
    )).rejects.toThrow(/缺少标题/);
    expect((await repo.read(CANVAS))!.content).toBe(canvasBefore);
    expect(await repo.read("Helix/Projects/Alpha/Stage-02.md")).toBeNull();
  });

  it("rolls back journaled stage creation when Canvas write fails", async () => {
    const repo = baseRepository();
    const canvasBefore = (await repo.read(CANVAS))!.content;
    const failCanvas = (path: string): void => {
      if (path !== CANVAS) {
        repo.beforeCompare = failCanvas;
        return;
      }
      throw new Error("injected Canvas failure");
    };
    repo.beforeCompare = failCanvas;
    await expect(workspace(repo).createCycle(
      "project-1",
      "inherit",
      ["cycle-1"],
      { stageTitle: "事务回滚" },
    )).rejects.toThrow(/injected Canvas failure/);
    expect((await repo.read(CANVAS))!.content).toBe(canvasBefore);
    expect(await repo.read("Helix/Projects/Alpha/Stage-02.md")).toBeNull();
    expect(await repo.read(HISTORY_JOURNAL)).toBeNull();
  });

  it("treats managed edge endpoints as truth and repairs only derived metadata", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300),
    );
    canvas.edges.push({
      id: "native-retargeted-managed-edge",
      fromNode: "cycle-node",
      toNode: "cycle-2-node",
      helixManaged: true,
      helixRelation: "merge",
      helixMergeGroupId: "stale-group",
      label: "过期标签",
      customArrowStyle: "keep",
    });
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);

    expect((await service.snapshot()).relations).toContainEqual({
      id: "native-retargeted-managed-edge",
      kind: "inherit",
      fromCycleIds: ["cycle-1"],
      toCycleId: "cycle-2",
    });
    await service.ensureCanvas();

    expect(repo.json(CANVAS).edges).toContainEqual(expect.objectContaining({
      id: "native-retargeted-managed-edge",
      fromNode: "cycle-node",
      toNode: "cycle-2-node",
      helixManaged: true,
      helixRelation: "inherit",
      label: "推进",
      customArrowStyle: "keep",
    }));
    expect(repo.json(CANVAS).edges[0]).not.toHaveProperty("helixMergeGroupId");
  });

  it("keeps a native Canvas edge untouched until explicit adoption", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300),
    );
    canvas.edges.push({
      id: "native-stage-edge",
      fromNode: "cycle-node",
      toNode: "cycle-2-node",
      label: "用户画的箭头",
      customArrowStyle: "keep",
    });
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    const before = repo.json(CANVAS).edges[0];
    const snapshot = await service.snapshot();

    expect(snapshot.relations).toEqual([]);
    expect(snapshot.nativeRelationCandidates).toEqual([
      expect.objectContaining({
        edgeId: "native-stage-edge",
        fromCycleId: "cycle-1",
        toCycleId: "cycle-2",
        crossProject: false,
      }),
    ]);
    const ensured = await service.ensureCanvas();
    expect(repo.json(CANVAS).edges[0]).toEqual(before);

    const plan = await service.planNativeRelationAdoption(
      ensured.nativeRelationCandidates[0]!,
    );
    expect(plan).toMatchObject({
      affectedNodeCount: 2,
      relabeledEdgeCount: 0,
      resultKind: "inherit",
    });
    await service.adoptNativeRelation(plan);
    expect(repo.json(CANVAS).edges).toContainEqual(expect.objectContaining({
      id: "native-stage-edge",
      helixManaged: true,
      helixRelation: "inherit",
      label: "推进",
      customArrowStyle: "keep",
    }));
    expect((await service.snapshot()).nativeRelationCandidates).toEqual([]);
    expect(service.historyState()).toMatchObject({
      undoLabel: "由 Helix 管理原生阶段连线",
      undoCount: 1,
    });
  });

  it("rejects stale, cyclic and unconfirmed cross-project native adoption", async () => {
    const staleRepo = baseRepository();
    staleRepo.set(
      "Helix/Projects/Alpha/Cycle-02.md",
      cycle("cycle-2", "project-1", 2),
    );
    const staleCanvas = staleRepo.json(CANVAS);
    staleCanvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300),
    );
    staleCanvas.edges.push({
      id: "native-stale",
      fromNode: "cycle-node",
      toNode: "cycle-2-node",
    });
    staleRepo.set(CANVAS, JSON.stringify(staleCanvas));
    const staleService = workspace(staleRepo);
    const staleCandidate = (await staleService.snapshot()).nativeRelationCandidates[0]!;
    const changed = staleRepo.json(CANVAS);
    changed.external = true;
    staleRepo.set(CANVAS, JSON.stringify(changed));
    await expect(staleService.adoptNativeRelation(staleCandidate))
      .rejects.toThrow(/已经变化/);
    expect(staleRepo.json(CANVAS).edges[0]).not.toHaveProperty("helixManaged");

    const cyclicRepo = linearRepository();
    const cyclicCanvas = cyclicRepo.json(CANVAS);
    cyclicCanvas.edges.push({
      id: "native-cycle",
      fromNode: "cycle-3-node",
      toNode: "cycle-node",
    });
    cyclicRepo.set(CANVAS, JSON.stringify(cyclicCanvas));
    const cyclicService = workspace(cyclicRepo);
    const cyclicCandidate = (await cyclicService.snapshot()).nativeRelationCandidates[0]!;
    await expect(cyclicService.adoptNativeRelation(cyclicCandidate))
      .rejects.toThrow(/环/);
    expect(cyclicRepo.json(CANVAS).edges.find(
      (edge: { id: string }) => edge.id === "native-cycle",
    )).not.toHaveProperty("helixManaged");

    const crossRepo = baseRepository();
    crossRepo.set("Helix/Projects/Beta/Project.md", project("project-2", "Beta"));
    crossRepo.set(
      "Helix/Projects/Beta/Stage-01.md",
      cycle("cycle-beta", "project-2", 1),
    );
    const crossCanvas = crossRepo.json(CANVAS);
    crossCanvas.nodes.push(
      {
        ...card("project-2-node", "project", "project-2", undefined, 0, 900),
        helixFilePath: "Helix/Projects/Beta/Project.md",
        text: "[[Helix/Projects/Beta/Project|Beta]]\n\n项目",
      },
      {
        ...card("cycle-beta-node", "cycle", "project-2", "cycle-beta", 408, 900),
        helixNodeKind: "stage",
        helixStageId: "cycle-beta",
        helixFilePath: "Helix/Projects/Beta/Stage-01.md",
        text: "[[Helix/Projects/Beta/Stage-01|阶段标题 1]]\n\n进行中",
      },
    );
    crossCanvas.edges.push({
      id: "native-cross-project",
      fromNode: "cycle-node",
      toNode: "cycle-beta-node",
    });
    crossRepo.set(CANVAS, JSON.stringify(crossCanvas));
    const crossService = workspace(crossRepo);
    const crossCandidate = (await crossService.snapshot()).nativeRelationCandidates[0]!;
    expect(crossCandidate.crossProject).toBe(true);
    await expect(crossService.adoptNativeRelation(crossCandidate))
      .rejects.toThrow(/跨项目/);
    await expect(crossService.adoptNativeRelation(
      crossCandidate,
      { confirmCrossProject: true },
    )).resolves.toBeDefined();
  });

  it("allows a target stage to accept multiple inbound edges and becomes a merge", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    repo.set("Helix/Projects/Alpha/Cycle-03.md", cycle("cycle-3", "project-1", 3));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300),
      card("cycle-3-node", "cycle", "project-1", "cycle-3", 920, 300),
    );
    canvas.edges.push({
      id: "edge-1-to-3",
      fromNode: "cycle-node",
      toNode: "cycle-3-node",
      helixManaged: true,
      helixRelation: "inherit",
      label: "继承",
    });
    repo.set(CANVAS, JSON.stringify(canvas));

    const service = workspace(repo);
    const plan = await service.planConnection("cycle-2", "cycle-3");
    expect(plan.targetCycleId).toBe("cycle-3");
    expect(plan.relabeledEdgeCount).toBe(1);
    expect(plan.targetInboundCount).toBe(1);
    expect(plan.resultKind).toBe("merge");
    await service.connectCycles(plan);

    const snapshot = await service.snapshot();
    expect(snapshot.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "merge",
        fromCycleIds: ["cycle-1", "cycle-2"],
        toCycleId: "cycle-3",
      }),
    ]));
    const inbound = repo.json(CANVAS).edges.filter(
      (edge: Record<string, unknown>) => edge.toNode === "cycle-3-node",
    );
    expect(inbound).toHaveLength(2);
    expect(inbound).toEqual([
      expect.objectContaining({
        helixRelation: "merge",
        helixMergeGroupId: "helix-merge-cycle-3",
      }),
      expect.objectContaining({
        helixRelation: "merge",
        helixMergeGroupId: "helix-merge-cycle-3",
      }),
    ]);
    const targetMarkdown = (await repo.read("Helix/Projects/Alpha/Cycle-03.md"))!.content;
    expect(targetMarkdown).toContain("sourceId=cycle-1");
    expect(targetMarkdown).toContain("sourceId=cycle-2");
    expect(targetMarkdown.indexOf("sourceId=cycle-1"))
      .toBeLessThan(targetMarkdown.indexOf("sourceId=cycle-2"));
  });

  it("persists completed-project collapse without changing physical nodes or edges", async () => {
    const repo = baseRepository();
    const before = repo.json(CANVAS);
    await workspace(repo).setCompletedProjectCollapsed("project-1", true);
    const after = repo.json(CANVAS);
    expect(after.helixCompletedCollapse).toEqual({
      version: 1,
      projectIds: ["project-1"],
    });
    expect(after.nodes).toEqual(before.nodes);
    expect(after.edges).toEqual(before.edges);
  });

  it("expands multiple completed projects in one Canvas CAS", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Beta/Project.md", project("project-2", "Beta"));
    repo.set("Helix/Projects/Beta/Stage-01.md", cycle("cycle-beta", "project-2", 1));
    const canvas = repo.json(CANVAS);
    canvas.helixCompletedCollapse = {
      version: 1,
      projectIds: ["project-1", "project-2"],
    };
    canvas.nodes.push(
      {
        ...card("project-2-node", "project", "project-2", undefined, 0, 900),
        helixFilePath: "Helix/Projects/Beta/Project.md",
        text: "[[Helix/Projects/Beta/Project|Beta]]\n\n项目",
      },
      {
        ...card("cycle-beta-node", "cycle", "project-2", "cycle-beta", 520, 900),
        helixProjectId: "project-2",
        helixFilePath: "Helix/Projects/Beta/Stage-01.md",
        text: "[[Helix/Projects/Beta/Stage-01|阶段标题 1]]\n\n进行中",
      },
    );
    repo.set(CANVAS, JSON.stringify(canvas));

    await workspace(repo).setCompletedProjectsCollapsed(
      ["project-1", "project-2"],
      false,
    );

    expect(repo.json(CANVAS).helixCompletedCollapse).toEqual({
      version: 1,
      projectIds: [],
    });
  });

  it("rolls back project files on failure and rejects duplicate Dida mappings before writing", async () => {
    const repo = baseRepository("dida-existing");
    const service = workspace(repo);
    await expect(service.createProject("重复映射", "首阶段", "dida-existing")).rejects.toThrow(/已映射/);
    expect(repo.paths().some((path) => path.includes("重复映射"))).toBe(false);

    repo.failCreatePath = "Helix/Projects/事务失败/Stage-01.md";
    await expect(service.createProject("事务失败", "首阶段")).rejects.toThrow(/废纸篓/);
    expect(repo.paths().some((path) => path.includes("事务失败"))).toBe(false);
    await expect(service.createProject("临时映射", "首阶段", " local-project-pending "))
      .rejects.toThrow(/本地临时清单/);
    expect(repo.paths().some((path) => path.includes("临时映射"))).toBe(false);
  });

  it("updates a stable Dida project mapping with revision and uniqueness checks", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const plan = await service.prepareProjectDidaMappingUpdate("project-1");
    const updated = await service.updateProjectDidaMapping(plan, "dida-project-1");
    expect(updated.projects.find((project) => project.id === "project-1")?.didaProjectId)
      .toBe("dida-project-1");
    expect((await repo.read("Helix/Projects/Alpha/Project.md"))?.content)
      .toContain('helix-dida-project-id: "dida-project-1"');
    await expect(service.updateProjectDidaMapping(plan, "dida-project-2"))
      .rejects.toThrow(/确认期间已经变化|映射确认期间已经变化/);

    await service.createProject("映射竞争", "首阶段", "dida-project-2");
    const nextPlan = await service.prepareProjectDidaMappingUpdate("project-1");
    await expect(service.updateProjectDidaMapping(nextPlan, "dida-project-2"))
      .rejects.toThrow(/已映射到另一 Helix 项目/);
    await expect(service.updateProjectDidaMapping(nextPlan, "local-project-pending"))
      .rejects.toThrow(/本地临时清单/);
  });

  it("creates new stages with stage-only product metadata while keeping legacy nodes readable", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const created = await service.createProject("阶段元数据", "自定义首阶段");
    const stagePath = "Helix/Projects/阶段元数据/Stage-01.md";
    const stage = await repo.read(stagePath);
    expect(stage?.content).toContain("helix-kind: helix-stage");
    expect(stage?.content).not.toContain("helix-kind: helix-cycle");
    expect(stage?.content).toContain("# 阶段 1 · 自定义首阶段");
    const canvas = repo.json(CANVAS);
    expect(canvas.nodes).toContainEqual(expect.objectContaining({
      id: expect.stringMatching(/^helix-stage-/),
      helixManaged: true,
      helixNodeKind: "stage",
      helixProjectId: created.id,
      helixStageId: created.cycles[0]!.id,
      helixFilePath: stagePath,
    }));
    expect((await service.snapshot()).projects).toHaveLength(2);
  });

  it("lays out a newly created project without moving or overlapping existing cards", async () => {
    const repo = baseRepository();
    const before: Array<{ id: unknown; x: unknown; y: unknown }> =
      repo.json(CANVAS).nodes.map((node: Record<string, unknown>) => ({
      id: node.id,
      x: node.x,
      y: node.y,
    }));

    const created = await workspace(repo).createProject("布局验证", "首阶段");
    const nodes = repo.json(CANVAS).nodes;

    expect(nodes.filter((node: Record<string, unknown>) =>
      before.some((item) => item.id === node.id)).map(
      (node: Record<string, unknown>) => ({ id: node.id, x: node.x, y: node.y }),
    )).toEqual(before);
    const boxes = nodes
      .filter((node: Record<string, unknown>) =>
        node.helixNodeKind === "cycle" || node.helixNodeKind === "stage")
      .map((node: Record<string, unknown>) => ({
        id: node.id as string,
        x: node.x as number,
        y: node.y as number,
      }));
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        expect(
          Math.abs(boxes[left]!.x - boxes[right]!.x) < 328 &&
          Math.abs(boxes[left]!.y - boxes[right]!.y) < 164,
        ).toBe(false);
      }
    }
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ helixStageId: created.cycles[0]!.id, x: 408 }),
    ]));
  });

  it("preserves acknowledged legacy derives-from edges during normalized writes", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300));
    const legacy = {
      id: "legacy-derives",
      fromNode: "cycle-node",
      toNode: "cycle-2-node",
      label: "derives-from",
      helixManaged: true,
      helixRelation: "derives-from",
      custom: { keep: true },
    };
    canvas.edges.push(legacy);
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    const migration = await service.snapshot();
    await service.acknowledgeLegacyMigration(
      migration.migrationItems.map((item) => item.id),
    );

    const plan = await service.planConnection("cycle-1", "cycle-2");
    await service.connectCycles(plan);

    expect(repo.json(CANVAS).edges.find(
      (edge: { id: string }) => edge.id === legacy.id,
    )).toEqual(legacy);
  });

  it("converts only the exact managed inheritance edge when creating a branch", async () => {
    const repo = baseRepository();
    repo.set(
      "Helix/Projects/Alpha/Cycle-02.md",
      cycle("cycle-2", "project-1", 2),
    );
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(card("cycle-2-node", "cycle", "project-1", "cycle-2", 0, 560));
    canvas.edges = [
      {
        id: "user-edge",
        fromNode: "cycle-node",
        toNode: "cycle-2-node",
        label: "继承",
        color: "6",
      },
      {
        id: "managed-edge",
        fromNode: "cycle-node",
        toNode: "cycle-2-node",
        label: "继承",
        helixManaged: true,
        helixRelation: "inherit",
      },
    ];
    repo.set(CANVAS, JSON.stringify(canvas));
    await workspace(repo).createCycle(
      "project-1",
      "branch",
      ["cycle-1"],
      { confirmBranchConversion: true, stageTitle: "探索分支" },
    );
    const next = repo.json(CANVAS);
    expect(next.edges.find((edge: { id: string }) => edge.id === "user-edge")).toEqual(
      canvas.edges[0],
    );
    expect(next.edges.find((edge: { id: string }) => edge.id === "managed-edge")).toMatchObject({
      helixManaged: true,
      helixRelation: "branch",
      label: "分支",
    });
  });

  it("infers inherit then branch from repeated card-plus creation without a relation menu", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const first = await service.createCycle(
      "project-1",
      "auto",
      ["cycle-1"],
      {
        expectedAutoIntent: {
          relation: "inherit",
          convertedInheritanceRelationIds: [],
        },
        stageTitle: "第一条路线",
      },
    );
    const inheritance = (await service.snapshot()).relations.find((relation) =>
      relation.kind === "inherit" &&
      relation.fromCycleIds.includes("cycle-1") &&
      relation.toCycleId === first.id);
    expect(inheritance).toBeDefined();

    await expect(service.createCycle(
      "project-1",
      "auto",
      ["cycle-1"],
      {
        expectedAutoIntent: {
          relation: "inherit",
          convertedInheritanceRelationIds: [],
        },
        stageTitle: "过期弹窗",
      },
    )).rejects.toThrow(/已经变化/);

    const second = await service.createCycle(
      "project-1",
      "auto",
      ["cycle-1"],
      {
        expectedAutoIntent: {
          relation: "branch",
          convertedInheritanceRelationIds: [inheritance!.id],
        },
        stageTitle: "第二条路线",
      },
    );
    const outgoing = (await service.snapshot()).relations.filter((relation) =>
      relation.fromCycleIds.includes("cycle-1"));
    expect(outgoing).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "branch", toCycleId: first.id }),
      expect.objectContaining({ kind: "branch", toCycleId: second.id }),
    ]));
    expect(outgoing).toHaveLength(2);
    const firstContent = (await repo.read(first.notePath))!.content;
    expect(firstContent).toContain('helix-stage-code: "2.1"');
    expect(firstContent).toContain("# 阶段 2.1 · 第一条路线");
    expect(repo.json(CANVAS).helixStageCodes).toMatchObject({
      "project-1": ["1", "2.1", "2.2"],
    });
    expect(repo.json(CANVAS).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ helixStageId: first.id, x: 816, y: 0 }),
      expect.objectContaining({ helixStageId: second.id, x: 816, y: 200 }),
    ]));
  });

  it("requires a complete expected intent for every auto creation call", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const unsafeCall = service.createCycle as unknown as (
      projectId: string,
      kind: "auto",
      predecessorIds: string[],
      options: { stageTitle: string },
    ) => Promise<unknown>;
    await expect(unsafeCall.call(
      service,
      "project-1",
      "auto",
      ["cycle-1"],
      { stageTitle: "绕过意图" },
    )).rejects.toThrow(/必须携带用户确认的完整关系意图/);
    expect(repo.paths()).not.toContain("Helix/Projects/Alpha/Stage-02.md");
  });

  it("rejects a Canvas change between auto inference and the write revision with zero writes", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    await service.ensureCanvas();
    let canvasReads = 0;
    repo.beforeRead = (path) => {
      if (path !== CANVAS || ++canvasReads !== 5) return;
      const competing = repo.json(CANVAS);
      competing.userEdit = "keep";
      repo.set(CANVAS, JSON.stringify(competing));
    };

    await expect(service.createCycle(
      "project-1",
      "auto",
      ["cycle-1"],
      {
        expectedAutoIntent: {
          relation: "inherit",
          convertedInheritanceRelationIds: [],
        },
        stageTitle: "竞争窗口",
      },
    )).rejects.toThrow(/Canvas 已变化/);
    expect(repo.paths()).not.toContain("Helix/Projects/Alpha/Stage-02.md");
    expect(repo.json(CANVAS)).toMatchObject({
      userEdit: "keep",
      edges: [],
    });
  });

  it("infers a merge when card-plus receives multiple selected stages", async () => {
    const repo = baseRepository();
    repo.set(
      "Helix/Projects/Alpha/Cycle-02.md",
      cycle("cycle-2", "project-1", 2),
    );
    repo.set(
      "Helix/Projects/Alpha/Cycle-03.md",
      cycle("cycle-3", "project-1", 3),
    );
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 0, 600),
      card("cycle-3-node", "cycle", "project-1", "cycle-3", 520, 300),
    );
    canvas.edges.push({
      id: "existing-inherit",
      fromNode: "cycle-node",
      toNode: "cycle-3-node",
      label: "继承",
      helixManaged: true,
      helixRelation: "inherit",
    });
    repo.set(CANVAS, JSON.stringify(canvas));

    const merged = await workspace(repo).createCycle(
      "project-1",
      "auto",
      ["cycle-1", "cycle-2"],
      {
        expectedAutoIntent: {
          relation: "merge",
          convertedInheritanceRelationIds: ["existing-inherit"],
        },
        stageTitle: "汇总结论",
      },
    );
    expect((await workspace(repo).snapshot()).relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "existing-inherit",
          kind: "branch",
          fromCycleIds: ["cycle-1"],
          toCycleId: "cycle-3",
        }),
        expect.objectContaining({
        kind: "merge",
        fromCycleIds: ["cycle-1", "cycle-2"],
        toCycleId: merged.id,
        }),
      ]),
    );
    expect(repo.json(CANVAS).nodes).toContainEqual(expect.objectContaining({
      helixStageId: merged.id,
      x: 816,
      y: 200,
    }));
    expect((await repo.read(merged.notePath))?.content)
      .toContain('helix-stage-code: "4"');
  });

  it("assigns a merge the next major after its branch predecessors", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    await service.createCycle("project-1", "branch", ["cycle-1"], {
      confirmBranchConversion: true,
      stageTitle: "路线甲",
      secondaryStageTitle: "路线乙",
    });
    const branches = (await service.snapshot()).projects[0]!.cycles
      .filter((cycle) => cycle.stageCode === "2.1" || cycle.stageCode === "2.2");
    const merged = await service.createCycle("project-1", "merge", branches.map((cycle) => cycle.id), {
      stageTitle: "合并结论",
    });
    expect((await repo.read(merged.notePath))?.content)
      .toContain('helix-stage-code: "3"');
  });

  it("keeps an explicit confirmation for cross-project card-plus merges", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Beta/Project.md", project("project-2", "Beta"));
    repo.set(
      "Helix/Projects/Beta/Stage-01.md",
      cycle("cycle-beta", "project-2", 1),
    );
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      {
        ...card("project-2-node", "project", "project-2", undefined, 0, 900),
        helixFilePath: "Helix/Projects/Beta/Project.md",
        text: "[[Helix/Projects/Beta/Project|Beta]]\n\n项目",
      },
      {
        ...card("cycle-beta-node", "cycle", "project-2", "cycle-beta", 0, 1200),
        helixNodeKind: "stage",
        helixStageId: "cycle-beta",
        helixFilePath: "Helix/Projects/Beta/Stage-01.md",
        text: "[[Helix/Projects/Beta/Stage-01|阶段标题 1]]\n\n进行中",
      },
    );
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);

    await expect(service.createCycle(
      "project-1",
      "auto",
      ["cycle-1", "cycle-beta"],
      {
        expectedAutoIntent: {
          relation: "merge",
          convertedInheritanceRelationIds: [],
        },
        stageTitle: "跨项目汇总",
      },
    )).rejects.toThrow(/跨项目阶段关系必须明确确认/);

    const merged = await service.createCycle(
      "project-1",
      "auto",
      ["cycle-1", "cycle-beta"],
      {
        confirmCrossProject: true,
        expectedAutoIntent: {
          relation: "merge",
          convertedInheritanceRelationIds: [],
        },
        stageTitle: "跨项目汇总",
      },
    );
    expect((await service.snapshot()).relations).toContainEqual(
      expect.objectContaining({
        kind: "merge",
        fromCycleIds: ["cycle-1", "cycle-beta"],
        toCycleId: merged.id,
      }),
    );
    expect((await repo.read(merged.notePath))?.content)
      .toContain('helix-stage-code: "2"');
  });

  it("uses user-defined branch titles and places children to the right in rows", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    await expect(service.createCycle(
      "project-1",
      "branch",
      ["cycle-1"],
      {
        stageTitle: "未确认路线一",
        secondaryStageTitle: "未确认路线二",
      },
    )).rejects.toThrow(/确认分支计划/);
    await expect(service.createCycle(
      "project-1",
      "branch",
      ["cycle-1"],
      { confirmBranchConversion: true, stageTitle: "实验路线" },
    )).rejects.toThrow(/分别填写两个分支阶段标题/);

    await service.createCycle(
      "project-1",
      "branch",
      ["cycle-1"],
      {
        confirmBranchConversion: true,
        stageTitle: "实验路线",
        secondaryStageTitle: "理论路线",
      },
    );
    expect((await repo.read("Helix/Projects/Alpha/Stage-02.md"))?.content)
      .toContain("# 阶段 2.1 · 实验路线");
    expect((await repo.read("Helix/Projects/Alpha/Stage-02.md"))?.content)
      .toContain('helix-stage-code: "2.1"');
    expect((await repo.read("Helix/Projects/Alpha/Stage-03.md"))?.content)
      .toContain("# 阶段 2.2 · 理论路线");
    expect((await repo.read("Helix/Projects/Alpha/Stage-03.md"))?.content)
      .toContain('helix-stage-code: "2.2"');
    const stages = repo.json(CANVAS).nodes.filter(
      (node: Record<string, unknown>) => node.helixNodeKind === "stage",
    );
    expect(stages).toEqual([
      expect.objectContaining({ x: 816, y: 0 }),
      expect.objectContaining({ x: 816, y: 200 }),
    ]);
  });

  it("places an inherited child on the same row and rejects multiline titles", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    await service.createCycle(
      "project-1",
      "inherit",
      ["cycle-1"],
      { stageTitle: "右侧子阶段" },
    );
    expect(repo.json(CANVAS).nodes).toContainEqual(expect.objectContaining({
      helixStageId: expect.any(String),
      x: 816,
      y: 0,
    }));
    await expect(service.createCycle(
      "project-1",
      "inherit",
      ["cycle-1"],
      { stageTitle: "错误\n标题" },
    )).rejects.toThrow(/单行/);
  });

  it("deletes a stage through Canvas CAS and moves its Markdown to trash", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300));
    canvas.edges.push({
      id: "managed-edge",
      fromNode: "cycle-node",
      toNode: "cycle-2-node",
      label: "继承",
      helixManaged: true,
      helixRelation: "inherit",
    });
    repo.set(CANVAS, JSON.stringify(canvas));

    await workspace(repo).deleteCycle("cycle-2");
    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).toBeNull();
    expect(repo.json(CANVAS).nodes).not.toContainEqual(
      expect.objectContaining({ id: "cycle-2-node" }),
    );
    expect(repo.json(CANVAS).edges).toHaveLength(0);
    expect(await repo.read(DELETE_JOURNAL)).toBeNull();
    await expect(workspace(baseRepository()).deleteCycle("cycle-1"))
      .rejects.toThrow(/至少需要保留一个阶段/);

    const rollbackRepo = baseRepository();
    rollbackRepo.set(
      "Helix/Projects/Alpha/Cycle-02.md",
      cycle("cycle-2", "project-1", 2),
    );
    const rollbackCanvas = rollbackRepo.json(CANVAS);
    rollbackCanvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300),
    );
    rollbackCanvas.edges.push({
      id: "managed-edge",
      fromNode: "cycle-node",
      toNode: "cycle-2-node",
      label: "继承",
      helixManaged: true,
      helixRelation: "inherit",
    });
    rollbackRepo.set(CANVAS, JSON.stringify(rollbackCanvas));
    const rollbackService = workspace(rollbackRepo);
    await rollbackService.ensureCanvas();
    const expectedCanvasAfterRepair = rollbackRepo.json(CANVAS);
    rollbackRepo.failTrashPath = "Helix/Projects/Alpha/Cycle-02.md";
    await expect(rollbackService.deleteCycle("cycle-2"))
      .rejects.toThrow(/Canvas 已回滚/);
    expect(await rollbackRepo.read("Helix/Projects/Alpha/Cycle-02.md")).not.toBeNull();
    expect(rollbackRepo.json(CANVAS)).toEqual(expectedCanvasAfterRepair);
  });

  it("deletes a complete project and all of its managed stages atomically", async () => {
    const repo = baseRepository();
    const service = workspace(repo);

    await service.deleteProject("project-1");

    expect(await repo.read("Helix/Projects/Alpha/Project.md")).toBeNull();
    expect(await repo.read("Helix/Projects/Alpha/Cycle-01.md")).toBeNull();
    expect(repo.json(CANVAS).nodes).toEqual([]);
    expect(repo.json(CANVAS).edges).toEqual([]);
    await expect(service.snapshot()).resolves.toMatchObject({ projects: [] });
  });

  it("refuses project deletion when an unmanaged edge is attached", async () => {
    const repo = baseRepository();
    const canvas = repo.json(CANVAS);
    canvas.nodes.push({
      id: "user-note",
      type: "text",
      text: "用户节点",
      x: 500,
      y: 300,
      width: 200,
      height: 120,
    });
    canvas.edges.push({
      id: "user-edge",
      fromNode: "cycle-node",
      toNode: "user-note",
      label: "用户关系",
    });
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    await service.ensureCanvas();
    const beforeCanvas = (await repo.read(CANVAS))!.content;

    await expect(service.deleteProject("project-1"))
      .rejects.toThrow(/未交由 Helix 管理/);

    expect((await repo.read(CANVAS))!.content).toBe(beforeCanvas);
    expect(await repo.read("Helix/Projects/Alpha/Project.md")).not.toBeNull();
    expect(await repo.read("Helix/Projects/Alpha/Cycle-01.md")).not.toBeNull();
  });

  it("bridges predecessors to successors when deleting a middle stage", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    repo.set("Helix/Projects/Alpha/Cycle-03.md", cycle("cycle-3", "project-1", 3));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300),
      card("cycle-3-node", "cycle", "project-1", "cycle-3", 1040, 300),
    );
    canvas.edges.push(
      {
        id: "edge-12",
        fromNode: "cycle-node",
        toNode: "cycle-2-node",
        helixManaged: true,
        helixRelation: "inherit",
        label: "继承",
      },
      {
        id: "edge-23",
        fromNode: "cycle-2-node",
        toNode: "cycle-3-node",
        helixManaged: true,
        helixRelation: "inherit",
        label: "继承",
      },
    );
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    const plan = await service.planCycleDeletion("cycle-2");
    expect(plan.bridgeCandidates).toEqual([{
      fromCycleId: "cycle-1",
      toCycleId: "cycle-3",
      existing: false,
      crossProject: false,
    }]);
    await service.deleteCycle(plan, { bridge: true });
    expect(repo.json(CANVAS).edges).toEqual([
      expect.objectContaining({
        fromNode: "cycle-node",
        toNode: "cycle-3-node",
        helixRelation: "inherit",
      }),
    ]);
  });

  it("re-derives bridged focus in the same deletion transaction and undo/redo", async () => {
    const repo = linearRepository();
    const firstPath = "Helix/Projects/Alpha/Cycle-01.md";
    const middlePath = "Helix/Projects/Alpha/Cycle-02.md";
    const targetPath = "Helix/Projects/Alpha/Cycle-03.md";
    repo.set(firstPath, repo.take(firstPath)!.replace(
      "## 下一阶段聚焦问题\n",
      "## 下一阶段聚焦问题\n来自阶段一\n",
    ));
    repo.set(middlePath, repo.take(middlePath)!.replace(
      "## 下一阶段聚焦问题\n",
      "## 下一阶段聚焦问题\n来自阶段二\n",
    ));
    const service = workspace(repo);
    await service.replaceRelation("edge-23", "inherit", ["cycle-2"]);
    expect((await repo.read(targetPath))!.content).toContain("sourceId=cycle-2");

    await service.deleteCycle("cycle-2", { bridge: true });
    const deleted = (await repo.read(targetPath))!.content;
    expect(await repo.read(middlePath)).toBeNull();
    expect(deleted).toContain("sourceId=cycle-1");
    expect(deleted).toContain("> 来自阶段一");
    expect(deleted).not.toContain("sourceId=cycle-2");
    expect(await repo.read(HISTORY_JOURNAL)).toBeNull();

    await service.undoLastWorkspaceChange();
    expect(await repo.read(middlePath)).not.toBeNull();
    expect((await repo.read(targetPath))!.content).toContain("sourceId=cycle-2");
    await service.redoLastWorkspaceChange();
    expect(await repo.read(middlePath)).toBeNull();
    expect((await repo.read(targetPath))!.content).toContain("sourceId=cycle-1");
  });

  it("does not delete a stage when a successor derived block was edited", async () => {
    const repo = linearRepository();
    const targetPath = "Helix/Projects/Alpha/Cycle-03.md";
    const service = workspace(repo);
    await service.replaceRelation("edge-23", "inherit", ["cycle-2"]);
    repo.set(targetPath, repo.take(targetPath)!.replace("|阶段标题 2]]", "|用户修改来源]]"));
    const canvasBefore = (await repo.read(CANVAS))!.content;

    await expect(service.deleteCycle("cycle-2", { bridge: true }))
      .rejects.toThrow(/已被编辑/);
    expect((await repo.read(CANVAS))!.content).toBe(canvasBefore);
    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).not.toBeNull();
  });

  it("removes and restores a successor envelope in a no-bridge deletion", async () => {
    const repo = linearRepository();
    const targetPath = "Helix/Projects/Alpha/Cycle-03.md";
    const service = workspace(repo);
    await service.replaceRelation("edge-23", "inherit", ["cycle-2"]);
    expect((await repo.read(targetPath))!.content).toContain("sourceId=cycle-2");

    await service.deleteCycle("cycle-2", { bridge: false });
    expect((await repo.read(targetPath))!.content).not.toContain("helix-focus-bridge");
    await service.undoLastWorkspaceChange();
    expect((await repo.read(targetPath))!.content).toContain("sourceId=cycle-2");
  });

  it("previews and applies no-bridge branch degradation with exact edge identity", async () => {
    const repo = baseRepository();
    for (const sequence of [2, 3, 4]) {
      repo.set(
        `Helix/Projects/Alpha/Cycle-0${sequence}.md`,
        cycle(`cycle-${sequence}`, "project-1", sequence),
      );
    }
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 816, 0),
      card("cycle-3-node", "cycle", "project-1", "cycle-3", 816, 200),
      card("cycle-4-node", "cycle", "project-1", "cycle-4", 1224, 0),
    );
    canvas.edges.push(
      {
        id: "edge-pv",
        fromNode: "cycle-node",
        toNode: "cycle-2-node",
        helixManaged: true,
        helixRelation: "branch",
        label: "分支",
      },
      {
        id: "edge-px",
        fromNode: "cycle-node",
        toNode: "cycle-3-node",
        helixManaged: true,
        helixRelation: "branch",
        label: "分支",
      },
      {
        id: "edge-vs",
        fromNode: "cycle-2-node",
        toNode: "cycle-4-node",
        helixManaged: true,
        helixRelation: "inherit",
        label: "推进",
      },
    );
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    const plan = await service.planCycleDeletion("cycle-2");

    expect(plan.impacts.bridge.relabeledEdges).toEqual([]);
    expect(plan.impacts.noBridge.relabeledEdges).toEqual([{
      edgeId: "edge-px",
      fromCycleId: "cycle-1",
      toCycleId: "cycle-3",
      before: "branch",
      after: "inherit",
    }]);

    await service.deleteCycle(plan, { bridge: false });

    expect(repo.json(CANVAS).edges).toEqual([
      expect.objectContaining({
        id: "edge-px",
        helixRelation: "inherit",
        label: "推进",
      }),
    ]);
  });

  it("reflows the surviving component when deleting a root or leaf stage", async () => {
    const rootRepo = linearRepository();
    const rootCanvas = rootRepo.json(CANVAS);
    rootCanvas.nodes.find((node: { id: string }) => node.id === "cycle-node").y = 5_000;
    rootRepo.set(CANVAS, JSON.stringify(rootCanvas));
    const rootService = workspace(rootRepo);
    const rootPlan = await rootService.planCycleDeletion("cycle-1");
    expect(rootPlan.impacts.bridge.affectedCycleIds).toEqual(["cycle-2", "cycle-3"]);
    await rootService.deleteCycle(rootPlan);
    expect(rootRepo.json(CANVAS).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "project-node", y: 0 }),
      expect.objectContaining({ id: "cycle-2-node", x: 408 }),
      expect.objectContaining({ id: "cycle-3-node", x: 816 }),
    ]));

    const leafRepo = linearRepository();
    const leafService = workspace(leafRepo);
    const leafPlan = await leafService.planCycleDeletion("cycle-3");
    expect(leafPlan.impacts.bridge.affectedCycleIds).toEqual(["cycle-1", "cycle-2"]);
    await leafService.deleteCycle(leafPlan);
    expect(leafRepo.json(CANVAS).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cycle-node", x: 408 }),
      expect.objectContaining({ id: "cycle-2-node", x: 816 }),
    ]));
  });

  it("rejects a tampered deletion plan before writing", async () => {
    const repo = linearRepository();
    const service = workspace(repo);
    const plan = await service.planCycleDeletion("cycle-2");
    const before = (await repo.read(CANVAS))!.content;

    await expect(service.deleteCycle({
      ...plan,
      impacts: {
        ...plan.impacts,
        bridge: {
          ...plan.impacts.bridge,
          affectedNodeCount: plan.impacts.bridge.affectedNodeCount + 1,
        },
      },
    })).rejects.toThrow(/计划已经变化/);

    expect((await repo.read(CANVAS))!.content).toBe(before);
    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).not.toBeNull();
  });

  it("changes a two-source merge to inheritance when one source is deleted", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    repo.set("Helix/Projects/Alpha/Cycle-03.md", cycle("cycle-3", "project-1", 3));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 0, 600),
      card("cycle-3-node", "cycle", "project-1", "cycle-3", 520, 450),
    );
    canvas.edges.push(
      {
        id: "merge-a",
        fromNode: "cycle-node",
        toNode: "cycle-3-node",
        label: "合并",
        helixManaged: true,
        helixRelation: "merge",
        helixMergeGroupId: "helix-merge-cycle-4",
      },
      {
        id: "merge-b",
        fromNode: "cycle-2-node",
        toNode: "cycle-3-node",
        label: "合并",
        helixManaged: true,
        helixRelation: "merge",
        helixMergeGroupId: "helix-merge-cycle-4",
      },
    );
    repo.set(CANVAS, JSON.stringify(canvas));

    await workspace(repo).deleteCycle("cycle-2");

    expect(repo.json(CANVAS).edges).toEqual([
      expect.objectContaining({
        id: "merge-a",
        fromNode: "cycle-node",
        toNode: "cycle-3-node",
        label: "推进",
        helixRelation: "inherit",
      }),
    ]);
    expect(repo.json(CANVAS).nodes).toContainEqual(
      expect.objectContaining({ id: "cycle-3-node" }),
    );
    expect((await workspace(repo).snapshot()).relations).toEqual([
      expect.objectContaining({
        kind: "inherit",
        fromCycleIds: ["cycle-1"],
        toCycleId: "cycle-3",
      }),
    ]);
  });

  it("keeps a valid merge when one source of a three-source merge is deleted", async () => {
    const repo = baseRepository();
    for (const sequence of [2, 3, 4]) {
      repo.set(
        `Helix/Projects/Alpha/Cycle-0${sequence}.md`,
        cycle(`cycle-${sequence}`, "project-1", sequence),
      );
    }
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 0, 600),
      card("cycle-3-node", "cycle", "project-1", "cycle-3", 0, 900),
      card("cycle-4-node", "cycle", "project-1", "cycle-4", 520, 600),
    );
    for (const source of [1, 2, 3]) {
      canvas.edges.push({
        id: `merge-${source}`,
        fromNode: source === 1 ? "cycle-node" : `cycle-${source}-node`,
        toNode: "cycle-4-node",
        label: "合并",
        helixManaged: true,
        helixRelation: "merge",
        helixMergeGroupId: "merge-group",
      });
    }
    repo.set(CANVAS, JSON.stringify(canvas));

    await workspace(repo).deleteCycle("cycle-2");

    expect(repo.json(CANVAS).edges).toEqual([
      expect.objectContaining({
        id: "merge-1",
        helixRelation: "merge",
        helixMergeGroupId: "helix-merge-cycle-4",
      }),
      expect.objectContaining({
        id: "merge-3",
        helixRelation: "merge",
        helixMergeGroupId: "helix-merge-cycle-4",
      }),
    ]);
    expect((await workspace(repo).snapshot()).relations).toEqual([
      expect.objectContaining({
        kind: "merge",
        fromCycleIds: ["cycle-1", "cycle-3"],
        toCycleId: "cycle-4",
      }),
    ]);
  });

  it("changes a reduced merge to branch when its survivor has another successor", async () => {
    const repo = baseRepository();
    for (const sequence of [2, 3, 4]) {
      repo.set(
        `Helix/Projects/Alpha/Cycle-0${sequence}.md`,
        cycle(`cycle-${sequence}`, "project-1", sequence),
      );
    }
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 0, 600),
      card("cycle-3-node", "cycle", "project-1", "cycle-3", 520, 450),
      card("cycle-4-node", "cycle", "project-1", "cycle-4", 520, 750),
    );
    canvas.edges.push(
      {
        id: "merge-a",
        fromNode: "cycle-node",
        toNode: "cycle-3-node",
        label: "合并",
        helixManaged: true,
        helixRelation: "merge",
        helixMergeGroupId: "merge-group",
      },
      {
        id: "merge-b",
        fromNode: "cycle-2-node",
        toNode: "cycle-3-node",
        label: "合并",
        helixManaged: true,
        helixRelation: "merge",
        helixMergeGroupId: "merge-group",
      },
      {
        id: "branch-b",
        fromNode: "cycle-2-node",
        toNode: "cycle-4-node",
        label: "分支",
        helixManaged: true,
        helixRelation: "branch",
      },
    );
    repo.set(CANVAS, JSON.stringify(canvas));

    await workspace(repo).deleteCycle("cycle-1");

    expect(repo.json(CANVAS).edges).toEqual([
      expect.objectContaining({
        id: "merge-b",
        label: "分支",
        helixRelation: "branch",
      }),
      expect.objectContaining({
        id: "branch-b",
        label: "分支",
        helixRelation: "branch",
      }),
    ]);
    await expect(workspace(repo).snapshot()).resolves.toMatchObject({
      relations: expect.arrayContaining([
        expect.objectContaining({ kind: "branch", toCycleId: "cycle-3" }),
        expect.objectContaining({ kind: "branch", toCycleId: "cycle-4" }),
      ]),
    });
  });

  it("lets any merge predecessor create a later branch", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    repo.set("Helix/Projects/Alpha/Cycle-03.md", cycle("cycle-3", "project-1", 3));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 0, 600),
      card("cycle-3-node", "cycle", "project-1", "cycle-3", 520, 450),
    );
    canvas.edges.push(
      {
        id: "merge-a",
        fromNode: "cycle-node",
        toNode: "cycle-3-node",
        label: "合并",
        helixManaged: true,
        helixRelation: "merge",
        helixMergeGroupId: "merge-group",
      },
      {
        id: "merge-b",
        fromNode: "cycle-2-node",
        toNode: "cycle-3-node",
        label: "合并",
        helixManaged: true,
        helixRelation: "merge",
        helixMergeGroupId: "merge-group",
      },
    );
    repo.set(CANVAS, JSON.stringify(canvas));

    const created = await workspace(repo).createCycle(
      "project-1",
      "branch",
      ["cycle-1"],
      {
        confirmBranchConversion: true,
        stageTitle: "合并前驱的新分支",
      },
    );

    const next = repo.json(CANVAS);
    expect(next.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "merge-a", helixRelation: "merge" }),
      expect.objectContaining({ id: "merge-b", helixRelation: "merge" }),
      expect.objectContaining({
        fromNode: "cycle-node",
        toNode: expect.any(String),
        helixRelation: "branch",
      }),
    ]));
    expect(next.nodes).toContainEqual(expect.objectContaining({
      helixStageId: created.id,
      x: 816,
      y: 200,
    }));
    await expect(workspace(repo).snapshot()).resolves.toMatchObject({
      relations: expect.arrayContaining([
        expect.objectContaining({ kind: "merge" }),
        expect.objectContaining({ kind: "branch" }),
      ]),
    });
  });

  it("rolls Canvas back when the stage Markdown is concurrently renamed", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300));
    canvas.edges.push({
      id: "managed-edge",
      fromNode: "cycle-node",
      toNode: "cycle-2-node",
      label: "继承",
      helixManaged: true,
      helixRelation: "inherit",
    });
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    await service.ensureCanvas();
    const expectedCanvas = repo.json(CANVAS);
    repo.beforeTrash = (revision) => {
      const content = repo.take(revision.path);
      if (content !== undefined) repo.set("Helix/Projects/Alpha/已重命名.md", content);
    };

    await expect(service.deleteCycle("cycle-2"))
      .rejects.toThrow(/Canvas 已回滚/);

    expect(repo.json(CANVAS)).toEqual(expectedCanvas);
    expect(await repo.read("Helix/Projects/Alpha/已重命名.md")).not.toBeNull();
    expect(await repo.read(DELETE_JOURNAL)).toBeNull();
  });

  it("resumes a journaled deletion after Canvas committed but Markdown remains", async () => {
    const repo = deletionRecoveryRepository();
    const before = (await repo.read(CANVAS))!;
    const afterContent = deletedCycleCanvasContent(before.content);
    repo.set(CANVAS, afterContent);
    repo.set(
      DELETE_JOURNAL,
      deletionJournal(before, afterContent),
    );

    await expect(workspace(repo).recoverPendingStageDeletion())
      .resolves.toBe("completed");

    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).toBeNull();
    expect(await repo.read(DELETE_JOURNAL)).toBeNull();
    expect(repo.json(CANVAS).nodes).not.toContainEqual(
      expect.objectContaining({ id: "cycle-2-node" }),
    );
  });

  it("rolls a journaled Canvas deletion back when the stage changed", async () => {
    const repo = deletionRecoveryRepository();
    const before = (await repo.read(CANVAS))!;
    const afterContent = deletedCycleCanvasContent(before.content);
    repo.set(CANVAS, afterContent);
    repo.set(
      "Helix/Projects/Alpha/Cycle-02.md",
      `${cycle("cycle-2", "project-1", 2)}\n用户并发修改\n`,
    );
    repo.set(
      DELETE_JOURNAL,
      deletionJournal(before, afterContent),
    );

    await expect(workspace(repo).recoverPendingStageDeletion())
      .resolves.toBe("rolled-back");

    expect((await repo.read(CANVAS))!.content).toBe(before.content);
    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).not.toBeNull();
    expect(await repo.read(DELETE_JOURNAL)).toBeNull();
  });

  it("freezes an unrecoverable journal when Canvas is neither before nor after", async () => {
    const repo = deletionRecoveryRepository();
    const before = (await repo.read(CANVAS))!;
    const afterContent = deletedCycleCanvasContent(before.content);
    repo.set(
      DELETE_JOURNAL,
      deletionJournal(before, afterContent),
    );
    repo.set(CANVAS, JSON.stringify({ ...repo.json(CANVAS), external: true }));

    const service = workspace(repo);
    await expect(service.recoverPendingStageDeletion())
      .rejects.toThrow(/其他修改覆盖/);
    expect(await repo.read(DELETE_JOURNAL)).not.toBeNull();
    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).not.toBeNull();
    await expect(service.snapshot()).rejects.toThrow(/人工检查/);
  });

  it.each(["before", "after"] as const)(
    "freezes when an unrelated Markdown occupies the original path with Canvas=$value",
    async (value) => {
      const repo = deletionRecoveryRepository();
      const before = (await repo.read(CANVAS))!;
      const afterContent = deletedCycleCanvasContent(before.content);
      repo.set(DELETE_JOURNAL, deletionJournal(before, afterContent));
      repo.set(
        "Helix/Projects/Alpha/Cycle-02.md",
        "---\ntitle: unrelated\n---\n\n# 无关笔记\n",
      );
      if (value === "after") repo.set(CANVAS, afterContent);
      const service = workspace(repo);

      await expect(service.recoverPendingStageDeletion())
        .rejects.toThrow(/无关 Markdown 占用/);

      expect(await repo.read(DELETE_JOURNAL)).not.toBeNull();
      expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).not.toBeNull();
      expect((await repo.read(CANVAS))!.content)
        .toBe(value === "after" ? afterContent : before.content);
      await expect(service.snapshot()).rejects.toThrow(/人工检查/);
    },
  );

  it("freezes after a committed deletion when journal cleanup fails", async () => {
    const repo = deletionRecoveryRepository();
    repo.failTrashPath = DELETE_JOURNAL;
    const service = workspace(repo);

    await expect(service.deleteCycle("cycle-2"))
      .rejects.toThrow(/日志清理失败/);

    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).toBeNull();
    expect(await repo.read(DELETE_JOURNAL)).not.toBeNull();
    expect(repo.json(CANVAS).nodes).not.toContainEqual(
      expect.objectContaining({ id: "cycle-2-node" }),
    );
    await expect(service.snapshot()).rejects.toThrow(/冻结|事务日志已保留/);
  });

  it("accepts a semantics-preserving journal rewrite before cleanup", async () => {
    const repo = deletionRecoveryRepository();
    const service = workspace(repo);
    repo.beforeTrash = (revision) => {
      if (revision.path !== "Helix/Projects/Alpha/Cycle-02.md") return;
      repo.set(DELETE_JOURNAL, JSON.stringify(repo.json(DELETE_JOURNAL)));
    };

    await expect(service.deleteCycle("cycle-2")).resolves.toBeDefined();

    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).toBeNull();
    expect(await repo.read(DELETE_JOURNAL)).toBeNull();
    expect(repo.json(CANVAS).nodes).not.toContainEqual(
      expect.objectContaining({ id: "cycle-2-node" }),
    );
  });

  it("retains and freezes a semantically changed journal before cleanup", async () => {
    const repo = deletionRecoveryRepository();
    const service = workspace(repo);
    repo.beforeTrash = (revision) => {
      if (revision.path !== "Helix/Projects/Alpha/Cycle-02.md") return;
      const journal = repo.json(DELETE_JOURNAL);
      journal.createdAt = "2099-01-01T00:00:00.000Z";
      repo.set(DELETE_JOURNAL, JSON.stringify(journal));
    };

    await expect(service.deleteCycle("cycle-2"))
      .rejects.toThrow(/事务日志清理失败|语义变化/);

    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).toBeNull();
    expect(await repo.read(DELETE_JOURNAL)).not.toBeNull();
    expect(repo.json(CANVAS).nodes).not.toContainEqual(
      expect.objectContaining({ id: "cycle-2-node" }),
    );
    await expect(service.snapshot()).rejects.toThrow(/冻结|语义变化/);
  });

  it("does not touch Canvas or Markdown when the journal disappears before write", async () => {
    const repo = deletionRecoveryRepository();
    const service = workspace(repo);
    await service.ensureCanvas();
    const beforeCanvas = (await repo.read(CANVAS))!.content;
    repo.beforeRead = (path) => {
      if (path === DELETE_JOURNAL) repo.take(path);
    };

    await expect(service.deleteCycle("cycle-2"))
      .rejects.toThrow(/日志/);

    expect((await repo.read(CANVAS))!.content).toBe(beforeCanvas);
    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).not.toBeNull();
    await expect(service.snapshot()).rejects.toThrow(/写入已冻结/);
  });

  it("does not recover a pending deletion after read-only mode freezes the workspace", async () => {
    const repo = deletionRecoveryRepository();
    const before = (await repo.read(CANVAS))!;
    const afterContent = deletedCycleCanvasContent(before.content);
    repo.set(CANVAS, afterContent);
    repo.set(DELETE_JOURNAL, deletionJournal(before, afterContent));
    const service = workspace(repo);
    service.freezePendingStageDeletion(
      "Helix data.json 处于只读恢复模式，项目写入已冻结",
    );

    await expect(service.recoverPendingStageDeletion())
      .rejects.toThrow(/只读恢复模式/);

    expect((await repo.read(CANVAS))!.content).toBe(afterContent);
    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).not.toBeNull();
    expect(await repo.read(DELETE_JOURNAL)).not.toBeNull();
  });

  it("cancels an in-flight Canvas write when recovery freezes the workspace", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    await service.ensureCanvas();
    const before = (await repo.read(CANVAS))!.content;
    repo.beforeCompare = () => {
      service.freezePendingStageDeletion("人工检查：冻结在途写入");
    };

    await expect(service.moveCanvasNode("cycle-node", 900, 900))
      .rejects.toThrow(/取消迟到写入/);

    expect((await repo.read(CANVAS))!.content).toBe(before);
  });

  it("rechecks the journal after Canvas commit and before trashing Markdown", async () => {
    const repo = deletionRecoveryRepository();
    const service = workspace(repo);
    await service.ensureCanvas();
    let journalReads = 0;
    repo.beforeRead = (path) => {
      if (path !== DELETE_JOURNAL) return;
      journalReads += 1;
      if (journalReads === 3) repo.take(path);
    };

    await expect(service.deleteCycle("cycle-2"))
      .rejects.toThrow(/日志/);

    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).not.toBeNull();
    expect(repo.json(CANVAS).nodes).not.toContainEqual(
      expect.objectContaining({ id: "cycle-2-node" }),
    );
    await expect(service.snapshot()).rejects.toThrow(/冻结|事务日志已保留/);
  });

  it("keeps physical stage sequence monotonic but reuses a deleted branch display code", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    await service.createCycle(
      "project-1",
      "branch",
      ["cycle-1"],
      {
        confirmBranchConversion: true,
        stageTitle: "路线一",
        secondaryStageTitle: "路线二",
      },
    );
    const stageThree = (await service.snapshot()).projects[0]!.cycles.find(
      (cycle) => cycle.sequence === 3,
    )!;
    await service.deleteCycle(stageThree.id);
    expect((await service.snapshot()).nextStageSequenceByProject["project-1"]).toBe(4);

    await service.createCycle(
      "project-1",
      "branch",
      ["cycle-1"],
      {
        confirmBranchConversion: true,
        stageTitle: "删除后的新路线",
      },
    );

    expect(await repo.read("Helix/Projects/Alpha/Stage-04.md")).not.toBeNull();
    expect((await repo.read("Helix/Projects/Alpha/Stage-04.md"))?.content)
      .toContain('helix-stage-code: "2.2"');
    expect(repo.json(CANVAS).helixStageSequences).toMatchObject({
      "project-1": 4,
    });
    expect(repo.json(CANVAS).helixStageCodes["project-1"]).toEqual(["1", "2.1", "2.2"]);
  });

  it("reuses deleted inheritance and merge display codes without reusing physical files", async () => {
    const inheritedRepo = baseRepository();
    const inheritedService = workspace(inheritedRepo);
    const inherited = await inheritedService.createCycle("project-1", "inherit", ["cycle-1"], {
      stageTitle: "继承阶段",
    });
    await inheritedService.deleteCycle(inherited.id);
    const recreatedInheritance = await inheritedService.createCycle(
      "project-1",
      "inherit",
      ["cycle-1"],
      { stageTitle: "重新继承" },
    );
    expect(recreatedInheritance.sequence).toBe(3);
    expect(recreatedInheritance.stageCode).toBe("2");
    expect(recreatedInheritance.notePath).toContain("Stage-03.md");

    const mergeRepo = baseRepository();
    const mergeService = workspace(mergeRepo);
    await mergeService.createCycle("project-1", "branch", ["cycle-1"], {
      confirmBranchConversion: true,
      stageTitle: "路线一",
      secondaryStageTitle: "路线二",
    });
    const branches = (await mergeService.snapshot()).projects[0]!.cycles
      .filter((cycle) => cycle.stageCode.startsWith("2."));
    const merged = await mergeService.createCycle(
      "project-1",
      "merge",
      branches.map((cycle) => cycle.id),
      { stageTitle: "合并阶段" },
    );
    await mergeService.deleteCycle(merged.id);
    const recreatedMerge = await mergeService.createCycle(
      "project-1",
      "merge",
      branches.map((cycle) => cycle.id),
      { stageTitle: "重新合并" },
    );
    expect(recreatedMerge.sequence).toBe(5);
    expect(recreatedMerge.stageCode).toBe("3");
    expect(recreatedMerge.notePath).toContain("Stage-05.md");
  });

  it("renumbers an existing bridged successor atomically when deleting a middle stage", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const middle = await service.createCycle("project-1", "inherit", ["cycle-1"], {
      stageTitle: "中间阶段",
    });
    const successor = await service.createCycle("project-1", "inherit", [middle.id], {
      stageTitle: "后继阶段",
    });

    await service.deleteCycle(middle.id, { bridge: true });

    const current = (await service.snapshot()).projects[0]!.cycles.find(
      (cycle) => cycle.id === successor.id,
    )!;
    expect(current.sequence).toBe(3);
    expect(current.stageCode).toBe("2");
    const content = (await repo.read(successor.notePath))!.content;
    expect(content).toContain('helix-stage-code: "2"');
    expect(content).toContain("# 阶段 2 · 后继阶段");
    expect(repo.json(CANVAS).helixStageCodes["project-1"]).toEqual(["1", "2"]);
  });

  it("rejects a competing inherited code before conversion without overwriting it", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const inherited = await service.createCycle("project-1", "inherit", ["cycle-1"], {
      stageTitle: "原继承",
    });
    repo.beforeCompare = () => repo.set(
      inherited.notePath,
      (repo.take(inherited.notePath) ?? "").replace('helix-stage-code: "2"', 'helix-stage-code: "7"'),
    );
    await expect(service.createCycle("project-1", "branch", ["cycle-1"], {
      confirmBranchConversion: true,
      stageTitle: "竞争分支",
    })).rejects.toThrow(/变化|conflict/);
    expect((await repo.read(inherited.notePath))?.content).toContain('helix-stage-code: "7"');
    expect(await repo.read("Helix/Projects/Alpha/Stage-03.md")).toBeNull();
  });

  it("upgrades a legacy inherited stage without a code during an explicit branch conversion", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const inherited = await service.createCycle("project-1", "inherit", ["cycle-1"], {
      stageTitle: "旧阶段",
    });
    repo.set(inherited.notePath, (repo.take(inherited.notePath) ?? "")
      .replace('helix-stage-code: "2"\n', ""));
    await service.createCycle("project-1", "branch", ["cycle-1"], {
      confirmBranchConversion: true,
      stageTitle: "新增分支",
    });
    const upgraded = (await repo.read(inherited.notePath))!.content;
    expect(upgraded).toContain('helix-stage-code: "2.1"');
    expect(upgraded).toContain("# 阶段 2.1 · 旧阶段");
  });

  it("rejects invalid codes anywhere in the issued-code ledger", async () => {
    const repo = baseRepository();
    const canvas = repo.json(CANVAS);
    canvas.helixStageCodes = { "other-project": ["02.1"] };
    repo.set(CANVAS, JSON.stringify(canvas));
    await expect(workspace(repo).snapshot()).rejects.toThrow(/展示编号账本无效/);
  });

  it.each([
    { value: 2.5, message: /高水位无效/ },
    { value: Number.MAX_SAFE_INTEGER + 1, message: /高水位无效/ },
    { value: Number.MAX_SAFE_INTEGER, message: /安全上限/ },
  ])("rejects an unsafe stage sequence high-water mark before writing: $value", async ({
    value,
    message,
  }) => {
    const repo = baseRepository();
    const canvas = repo.json(CANVAS);
    canvas.helixStageSequences = { "project-1": value };
    repo.set(CANVAS, JSON.stringify(canvas));
    const beforeCanvas = repo.json(CANVAS);
    const beforePaths = repo.paths();

    await expect(workspace(repo).createCycle(
      "project-1",
      "inherit",
      ["cycle-1"],
      { stageTitle: "不应创建" },
    )).rejects.toThrow(message);

    expect(repo.paths()).toEqual(beforePaths);
    expect(repo.json(CANVAS)).toEqual(beforeCanvas);
  });

  it.each([
    "broken",
    [],
    { "project-1": 1, "stale-project": 2.5 },
  ])("rejects a malformed stage sequence ledger without rewriting it: %j", async (
    ledger,
  ) => {
    const repo = baseRepository();
    const canvas = repo.json(CANVAS);
    canvas.helixStageSequences = ledger;
    repo.set(CANVAS, JSON.stringify(canvas));
    const before = repo.json(CANVAS);

    await expect(workspace(repo).snapshot()).rejects.toThrow(/高水位/);

    expect(repo.json(CANVAS)).toEqual(before);
  });

  it("rejects a Markdown stage sequence outside the safe integer range", async () => {
    const repo = baseRepository();
    repo.set(
      "Helix/Projects/Alpha/Cycle-02.md",
      cycle("cycle-2", "project-1", Number.MAX_SAFE_INTEGER + 1),
    );

    await expect(workspace(repo).snapshot()).rejects.toThrow(/阶段元数据不完整/);
  });

  it("updates and deletes existing relations while preserving a valid branch graph", async () => {
    const repo = baseRepository();
    repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
    repo.set("Helix/Projects/Alpha/Cycle-03.md", cycle("cycle-3", "project-1", 3));
    const canvas = repo.json(CANVAS);
    canvas.nodes.push(
      card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300),
      card("cycle-3-node", "cycle", "project-1", "cycle-3", 520, 600),
    );
    canvas.edges.push(
      {
        id: "branch-a",
        fromNode: "cycle-node",
        toNode: "cycle-2-node",
        label: "分支",
        helixManaged: true,
        helixRelation: "branch",
      },
      {
        id: "branch-b",
        fromNode: "cycle-node",
        toNode: "cycle-3-node",
        label: "分支",
        helixManaged: true,
        helixRelation: "branch",
      },
    );
    repo.set(CANVAS, JSON.stringify(canvas));
    const service = workspace(repo);
    await service.deleteRelation("branch-a");
    expect(repo.json(CANVAS).edges).toEqual([
      expect.objectContaining({
        id: "branch-b",
        label: "推进",
        helixRelation: "inherit",
      }),
    ]);
    await service.replaceRelation("branch-b", "inherit", ["cycle-2"]);
    expect(repo.json(CANVAS).edges).toEqual([
      expect.objectContaining({
        fromNode: "cycle-2-node",
        toNode: "cycle-3-node",
        label: "推进",
        helixRelation: "inherit",
      }),
    ]);
  });
});

async function focusBridgeWorkspace(): Promise<{
  repo: MemoryRepository;
  service: ProjectWorkspaceService;
  sourcePath: string;
  targetPath: string;
}> {
  const repo = baseRepository();
  const sourcePath = "Helix/Projects/Alpha/Cycle-01.md";
  const targetPath = "Helix/Projects/Alpha/Cycle-02.md";
  repo.set(sourcePath, repo.take(sourcePath)!.replace(
    "## 下一阶段聚焦问题\n",
    "## 下一阶段聚焦问题\nBase focus\n",
  ));
  repo.set(targetPath, cycle("cycle-2", "project-1", 2));
  const canvas = repo.json(CANVAS);
  canvas.nodes.push(card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300));
  repo.set(CANVAS, JSON.stringify(canvas));
  const service = workspace(repo);
  await service.connectCycles(await service.planConnection("cycle-1", "cycle-2"));
  await service.initializeFocusBridgeState();
  return { repo, service, sourcePath, targetPath };
}

async function focusBridgeWorkspaceWithTwoTargets(): Promise<{
  repo: MemoryRepository;
  service: ProjectWorkspaceService;
  sourcePath: string;
  targetPaths: [string, string];
}> {
  const setup = await focusBridgeWorkspace();
  const thirdPath = "Helix/Projects/Alpha/Cycle-03.md";
  setup.repo.set(thirdPath, cycle("cycle-3", "project-1", 3));
  const canvas = setup.repo.json(CANVAS);
  canvas.nodes.push(card("cycle-3-node", "cycle", "project-1", "cycle-3", 920, 300));
  setup.repo.set(CANVAS, JSON.stringify(canvas));
  await setup.service.connectCycles(await setup.service.planConnection("cycle-1", "cycle-3"));
  await setup.service.initializeFocusBridgeState();
  return {
    repo: setup.repo,
    service: setup.service,
    sourcePath: setup.sourcePath,
    targetPaths: [setup.targetPath, thirdPath],
  };
}

function workspace(repo: MemoryRepository): ProjectWorkspaceService {
  return new ProjectWorkspaceService(
    {
      vault: {
        getMarkdownFiles: () => repo.paths()
          .filter((path) => path.endsWith(".md"))
          .map(fileFromPath),
      },
      metadataCache: {
        getFileCache: (file: { path: string }) => {
          const kind = /^helix-kind:\s*(helix-(?:project|stage|cycle))\s*$/m
            .exec(repo.text(file.path) ?? "")?.[1];
          return kind ? { frontmatter: { "helix-kind": kind } } : null;
        },
      },
    } as never,
    repo as never,
    () => "Helix",
    () => CANVAS,
  );
}

function deletionRecoveryRepository(): MemoryRepository {
  const repo = baseRepository();
  repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
  const canvas = repo.json(CANVAS);
  canvas.nodes.push(card("cycle-2-node", "cycle", "project-1", "cycle-2", 520, 300));
  canvas.edges.push({
    id: "managed-edge",
    fromNode: "cycle-node",
    toNode: "cycle-2-node",
    label: "继承",
    helixManaged: true,
    helixRelation: "inherit",
  });
  repo.set(CANVAS, JSON.stringify(canvas));
  return repo;
}

function linearRepository(): MemoryRepository {
  const repo = baseRepository();
  repo.set("Helix/Projects/Alpha/Cycle-02.md", cycle("cycle-2", "project-1", 2));
  repo.set("Helix/Projects/Alpha/Cycle-03.md", cycle("cycle-3", "project-1", 3));
  const canvas = repo.json(CANVAS);
  canvas.nodes.find((node: { id: string }) => node.id === "cycle-node").x = 408;
  canvas.nodes.find((node: { id: string }) => node.id === "cycle-node").y = 0;
  canvas.nodes.push(
    card("cycle-2-node", "cycle", "project-1", "cycle-2", 816, 0),
    card("cycle-3-node", "cycle", "project-1", "cycle-3", 1224, 0),
  );
  canvas.edges.push(
    {
      id: "edge-12",
      fromNode: "cycle-node",
      toNode: "cycle-2-node",
      helixManaged: true,
      helixRelation: "inherit",
      label: "继承",
    },
    {
      id: "edge-23",
      fromNode: "cycle-2-node",
      toNode: "cycle-3-node",
      helixManaged: true,
      helixRelation: "inherit",
      label: "继承",
    },
  );
  repo.set(CANVAS, JSON.stringify(canvas));
  return repo;
}

function deletedCycleCanvasContent(beforeContent: string): string {
  const canvas = JSON.parse(beforeContent);
  canvas.nodes = canvas.nodes.filter((node: { id: string }) =>
    node.id !== "cycle-2-node");
  canvas.edges = canvas.edges.filter((edge: { id: string }) =>
    edge.id !== "managed-edge");
  return JSON.stringify(canvas, null, 2);
}

function deletionJournal(before: VaultRevision, afterContent: string): string {
  const stageContent = cycle("cycle-2", "project-1", 2);
  return JSON.stringify({
    version: 1,
    operation: "delete-stage",
    createdAt: "2026-07-30T00:00:00.000Z",
    stageId: "cycle-2",
    stagePath: "Helix/Projects/Alpha/Cycle-02.md",
    stageHash: stableHash(stageContent),
    canvasPath: CANVAS,
    canvasBeforeHash: before.hash,
    canvasBeforeContent: before.content,
    canvasAfterHash: stableHash(afterContent),
    canvasAfterContent: afterContent,
  }, null, 2);
}

function baseRepository(didaProjectId?: string): MemoryRepository {
  return new MemoryRepository({
    "Helix/Projects/Alpha/Project.md": project("project-1", "Alpha", didaProjectId),
    "Helix/Projects/Alpha/Cycle-01.md": cycle("cycle-1", "project-1", 1),
    [CANVAS]: JSON.stringify({
      nodes: [
        card("project-node", "project", "project-1", undefined, 0, 0),
        card("cycle-node", "cycle", "project-1", "cycle-1", 0, 300),
      ],
      edges: [],
    }),
  });
}

function card(
  id: string,
  kind: "project" | "cycle",
  projectId: string,
  cycleId: string | undefined,
  x: number,
  y: number,
): Record<string, unknown> {
  const sequence = Number.parseInt(cycleId?.match(/(\d+)$/)?.[1] ?? "1", 10);
  const stageNumber = String(sequence).padStart(2, "0");
  return {
    id,
    type: "text",
    x,
    y,
    width: kind === "project" ? 320 : 360,
    height: kind === "project" ? 200 : 220,
    helixManaged: true,
    helixNodeKind: kind,
    helixProjectId: projectId,
    ...(cycleId ? { helixCycleId: cycleId } : {}),
    helixFilePath: kind === "project"
      ? "Helix/Projects/Alpha/Project.md"
      : `Helix/Projects/Alpha/Cycle-${stageNumber}.md`,
    text: kind === "project"
      ? "[[Helix/Projects/Alpha/Project|Alpha]]\n\n项目"
      : `[[Helix/Projects/Alpha/Cycle-${stageNumber}|阶段标题 ${sequence}]]\n\n进行中`,
  };
}

function project(id: string, title: string, didaProjectId?: string): string {
  return projectTemplate({
    id,
    title,
    createdAt: "2026-07-30T00:00:00.000Z",
    didaProjectId,
  }).replace("helix-status: planned", "helix-status: active");
}

function cycle(id: string, projectId: string, sequence: number): string {
  return cycleTemplate({
    id,
    projectId,
    projectLink: "[[Project]]",
    sequence,
    startedAt: "2026-07-30T00:00:00.000Z",
    stageTitle: `阶段标题 ${sequence}`,
  }).replace("helix-status: idea", "helix-status: active");
}

function fileFromPath(path: string): {
  path: string;
  basename: string;
  parent: { path: string; name: string };
} {
  const segments = path.split("/");
  const file = segments.pop()!;
  return {
    path,
    basename: file.replace(/\.md$/, ""),
    parent: {
      path: segments.join("/"),
      name: segments.at(-1) ?? "",
    },
  };
}

class MemoryRepository {
  private readonly files = new Map<string, string>();
  createCalls = 0;
  failCreatePath?: string;
  failTrashPath?: string;
  beforeCreate?: (path: string) => void;
  beforeCompare?: (path: string) => void;
  beforeCompareEvery?: (path: string) => void;
  beforeRead?: (path: string) => void;
  beforeTrash?: (revision: VaultRevision) => void;

  constructor(initial: Record<string, string>) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  text(path: string): string | undefined {
    return this.files.get(path);
  }

  set(path: string, content: string): void {
    this.files.set(path, content);
  }

  take(path: string): string | undefined {
    const content = this.files.get(path);
    this.files.delete(path);
    return content;
  }

  json(path: string): any {
    return JSON.parse(this.files.get(path)!);
  }

  async read(path: string): Promise<VaultRevision | null> {
    this.beforeRead?.(path);
    const content = this.files.get(path);
    return content === undefined
      ? null
      : { path, content, hash: stableHash(content) };
  }

  async create(path: string, content: string): Promise<VaultRevision> {
    this.createCalls += 1;
    this.beforeCreate?.(path);
    this.beforeCreate = undefined;
    if (path === this.failCreatePath) throw new Error("injected create failure");
    if (this.files.has(path)) throw new Error(`目标已经存在：${path}`);
    this.files.set(path, content);
    return { path, content, hash: stableHash(content) };
  }

  async compareAndWrite(
    revision: VaultRevision,
    content: string,
    beforeWrite?: () => void,
  ): Promise<VaultRevision> {
    this.beforeCompareEvery?.(revision.path);
    const beforeCompare = this.beforeCompare;
    this.beforeCompare = undefined;
    beforeCompare?.(revision.path);
    const current = await this.read(revision.path);
    if (!current || current.hash !== revision.hash) throw new Error("write conflict");
    beforeWrite?.();
    this.files.set(revision.path, content);
    return { path: revision.path, content, hash: stableHash(content) };
  }

  async trashIfUnchanged(
    revision: VaultRevision,
    beforeWrite?: () => void,
    _options: { requireExisting?: boolean } = {},
  ): Promise<void> {
    if (revision.path === this.failTrashPath) throw new Error("injected trash failure");
    this.beforeTrash?.(revision);
    this.beforeTrash = undefined;
    const current = await this.read(revision.path);
    if (!current || current.hash !== revision.hash) throw new Error("trash conflict");
    beforeWrite?.();
    this.files.delete(revision.path);
  }
}
