import { describe, expect, it } from "vitest";
import { projectTemplate, cycleTemplate } from "../src/domain/projects";
import { stableHash } from "../src/domain/stable";
import { ProjectWorkspaceService } from "../src/services/project-workspace";
import type { VaultRevision } from "../src/storage/vault-repository";

const CANVAS = "Helix/Project Lineage.canvas";

describe("ProjectWorkspaceService", () => {
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
    await service.moveCanvasNodes([
      { nodeId: "project-node", x: 80.4, y: 90.6 },
      { nodeId: "cycle-node", x: 120.2, y: 430.8 },
    ]);
    expect(repo.json(CANVAS).nodes).toEqual([
      expect.objectContaining({ id: "project-node", x: 80, y: 91 }),
      expect.objectContaining({ id: "cycle-node", x: 120, y: 431 }),
    ]);

    const conflicted = baseRepository();
    const conflictService = workspace(conflicted);
    conflicted.beforeCompare = () => {
      const current = conflicted.json(CANVAS);
      current.userEdit = "keep";
      conflicted.set(CANVAS, JSON.stringify(current));
    };
    await expect(conflictService.moveCanvasNodes([
      { nodeId: "project-node", x: 500, y: 500 },
      { nodeId: "cycle-node", x: 500, y: 800 },
    ])).rejects.toThrow(/conflict/);
    expect(conflicted.json(CANVAS)).toMatchObject({
      userEdit: "keep",
      nodes: [
        expect.objectContaining({ id: "project-node", x: 0, y: 0 }),
        expect.objectContaining({ id: "cycle-node", x: 0, y: 300 }),
      ],
    });
  });

  it("rolls back project files on failure and rejects duplicate Dida mappings before writing", async () => {
    const repo = baseRepository("dida-existing");
    const service = workspace(repo);
    await expect(service.createProject("重复映射", "dida-existing")).rejects.toThrow(/已映射/);
    expect(repo.paths().some((path) => path.includes("重复映射"))).toBe(false);

    repo.failCreatePath = "Helix/Projects/事务失败/Stage-01.md";
    await expect(service.createProject("事务失败")).rejects.toThrow(/废纸篓/);
    expect(repo.paths().some((path) => path.includes("事务失败"))).toBe(false);
  });

  it("creates new stages with stage-only product metadata while keeping legacy nodes readable", async () => {
    const repo = baseRepository();
    const service = workspace(repo);
    const created = await service.createProject("阶段元数据");
    const stagePath = "Helix/Projects/阶段元数据/Stage-01.md";
    const stage = await repo.read(stagePath);
    expect(stage?.content).toContain("helix-kind: helix-stage");
    expect(stage?.content).not.toContain("helix-kind: helix-cycle");
    expect(stage?.content).toContain("# 阶段 1 · 项目启动");
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
    expect(repo.json(CANVAS).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ helixStageId: first.id, x: 520, y: 300 }),
      expect.objectContaining({ helixStageId: second.id, x: 520, y: 600 }),
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
      if (path !== CANVAS || ++canvasReads !== 4) return;
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
      x: 520,
      y: 450,
    }));
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
      .toContain("# 阶段 2 · 实验路线");
    expect((await repo.read("Helix/Projects/Alpha/Stage-03.md"))?.content)
      .toContain("# 阶段 3 · 理论路线");
    const stages = repo.json(CANVAS).nodes.filter(
      (node: Record<string, unknown>) => node.helixNodeKind === "stage",
    );
    expect(stages).toEqual([
      expect.objectContaining({ x: 520, y: 300 }),
      expect.objectContaining({ x: 520, y: 600 }),
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
      x: 520,
      y: 300,
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

    await workspace(repo).deleteCycle("cycle-2");

    expect(repo.json(CANVAS).edges).toEqual([
      expect.objectContaining({
        id: "merge-a",
        fromNode: "cycle-node",
        toNode: "cycle-3-node",
        label: "继承",
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
        helixMergeGroupId: "merge-group",
      }),
      expect.objectContaining({
        id: "merge-3",
        helixRelation: "merge",
        helixMergeGroupId: "merge-group",
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
      x: 520,
      y: 750,
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
  });

  it("keeps stage numbering monotonic after the highest stage is deleted", async () => {
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
    const deletedContent = (await repo.read(stageThree.notePath))!.content;
    await service.deleteCycle(stageThree.id);
    expect((await service.snapshot()).nextStageSequenceByProject["project-1"]).toBe(4);
    repo.set(stageThree.notePath, deletedContent);

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
    expect(repo.json(CANVAS).helixStageSequences).toMatchObject({
      "project-1": 4,
    });
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
        label: "继承",
        helixRelation: "inherit",
      }),
    ]);
    await service.replaceRelation("branch-b", "inherit", ["cycle-2"]);
    expect(repo.json(CANVAS).edges).toEqual([
      expect.objectContaining({
        fromNode: "cycle-2-node",
        toNode: "cycle-3-node",
        label: "继承",
        helixRelation: "inherit",
      }),
    ]);
  });
});

function workspace(repo: MemoryRepository): ProjectWorkspaceService {
  return new ProjectWorkspaceService(
    {
      vault: {
        getMarkdownFiles: () => repo.paths()
          .filter((path) => path.endsWith(".md"))
          .map(fileFromPath),
      },
    } as never,
    repo as never,
    () => "Helix",
    () => CANVAS,
  );
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
  });
}

function cycle(id: string, projectId: string, sequence: number): string {
  return cycleTemplate({
    id,
    projectId,
    projectLink: "[[Project]]",
    sequence,
    startedAt: "2026-07-30T00:00:00.000Z",
    stageTitle: `阶段标题 ${sequence}`,
  });
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
  failCreatePath?: string;
  failTrashPath?: string;
  beforeCompare?: () => void;
  beforeRead?: (path: string) => void;
  beforeTrash?: (revision: VaultRevision) => void;

  constructor(initial: Record<string, string>) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
  }

  paths(): string[] {
    return [...this.files.keys()];
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
    this.beforeCompare?.();
    this.beforeCompare = undefined;
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
