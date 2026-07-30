import { describe, expect, it } from "vitest";
import { projectTemplate, cycleTemplate } from "../src/domain/projects";
import { stableHash } from "../src/domain/stable";
import { ProjectWorkspaceService } from "../src/services/project-workspace";
import type { VaultRevision } from "../src/storage/vault-repository";

const CANVAS = "Helix/Project Lineage.canvas";
const DELETE_JOURNAL = "Helix/.transactions/stage-delete.json";

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

    const bounded = baseRepository();
    const boundedBefore = (await bounded.read(CANVAS))!.content;
    await expect(workspace(bounded).moveCanvasNodes([
      { nodeId: "cycle-node", x: 1_000_001, y: 0 },
    ])).rejects.toThrow(/移动计划无效/);
    expect((await bounded.read(CANVAS))!.content).toBe(boundedBefore);
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
    await service.updateCycleStatus(cyclePlan, "closed");

    expect((await repo.read(projectPath))?.content).toContain("helix-status: \"paused\"");
    expect((await repo.read(projectPath))?.content).toContain("custom-owner: user");
    expect((await repo.read(cyclePath))?.content).toContain("helix-status: \"closed\"");
    expect((await repo.read(cyclePath))?.content).toContain("用户正文保留");
    expect((await service.snapshot()).projects[0]).toMatchObject({
      status: "paused",
      cycles: [expect.objectContaining({ status: "closed" })],
    });

    await service.ensureCanvas();
    expect(repo.json(CANVAS).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "project-node",
        text: expect.stringContaining("已暂停"),
      }),
      expect.objectContaining({
        id: "cycle-node",
        text: expect.stringContaining("已关闭"),
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
    }, "closed")).rejects.toThrow(/确认期间已经变化/);
    expect((await repo.read(cyclePath))?.content).toContain("helix-id: unrelated-stage");
    expect((await repo.read(cyclePath))?.content).not.toContain("helix-status: \"closed\"");
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

  it("lays out a newly created project without moving or overlapping existing cards", async () => {
    const repo = baseRepository();
    const before: Array<{ id: unknown; x: unknown; y: unknown }> =
      repo.json(CANVAS).nodes.map((node: Record<string, unknown>) => ({
      id: node.id,
      x: node.x,
      y: node.y,
    }));

    const created = await workspace(repo).createProject("布局验证");
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
      x: 816,
      y: 200,
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
        label: "继承",
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
        label: "继承",
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
      if (journalReads === 2) repo.take(path);
    };

    await expect(service.deleteCycle("cycle-2"))
      .rejects.toThrow(/日志/);

    expect(await repo.read("Helix/Projects/Alpha/Cycle-02.md")).not.toBeNull();
    expect(repo.json(CANVAS).nodes).not.toContainEqual(
      expect.objectContaining({ id: "cycle-2-node" }),
    );
    await expect(service.snapshot()).rejects.toThrow(/冻结|事务日志已保留/);
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
