import { App, Notice, TFile, normalizePath } from "obsidian";
import {
  adoptProjectLineageEdges,
  upsertManagedEdge,
  validateLineageCanvas,
  type CanvasDocument,
  type CanvasNode,
} from "../domain/canvas";
import { patchManagedFrontmatter } from "../storage/frontmatter";
import {
  HelixVaultRepository,
  VaultWriteConflictError,
  type VaultRevision,
} from "../storage/vault-repository";
import {
  SelfWriteTracker,
  SerializedRunner,
} from "./serialized-runner";
import { assertProjectMappingsUnique } from "../domain/project-mapping";
import { assertDag } from "../domain/dag";
import { writeBatchWithRollback } from "./vault-write-batch";

interface ProjectDescriptor {
  id: string;
  file: TFile;
  parents: string[];
  didaProjectId?: string;
}

export class LineageService {
  private readonly runner = new SerializedRunner();
  private readonly selfWrites = new SelfWriteTracker();
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly repository: HelixVaultRepository,
    private readonly canvasPath: () => string,
  ) {}

  isBusy(): boolean {
    return this.runner.isBusy();
  }

  consumeSelfWrite(path: string): boolean {
    return this.selfWrites.consume(normalizePath(path));
  }

  assertProjectIntegrity(): void {
    this.projects();
  }

  projectPaths(): string[] {
    return this.projects().map((project) => normalizePath(project.file.path));
  }

  dispose(): void {
    this.disposed = true;
    this.selfWrites.dispose();
  }

  async rebuildCanvasFromProjects(): Promise<void> {
    await this.runExclusive(async () => {
      const projects = this.projects();
      const path = normalizePath(this.canvasPath());
      const revision = await this.repository.read(path);
      const document = revision
        ? parseCanvas(revision.content)
        : { nodes: [], edges: [] };
      validateLineageCanvas(document);
      let next = structuredClone(document);
      const byProject = new Map<string, CanvasNode>();
      for (const node of next.nodes) {
        if (node.helixManaged === true && typeof node.helixProjectId === "string") {
          byProject.set(node.helixProjectId, node);
        }
      }
      for (const [index, project] of projects.entries()) {
        const existing = byProject.get(project.id);
        if (existing) {
          existing.file = project.file.path;
          continue;
        }
        const node: CanvasNode = {
          id: `helix-project-${project.id}`,
          type: "file",
          file: project.file.path,
          x: (index % 4) * 380,
          y: Math.floor(index / 4) * 260,
          width: 320,
          height: 200,
          helixManaged: true,
          helixProjectId: project.id,
        };
        next.nodes.push(node);
        byProject.set(project.id, node);
      }
      const liveIds = new Set(projects.map((project) => project.id));
      next.nodes = next.nodes.filter(
        (node) =>
          node.helixManaged !== true ||
          (typeof node.helixProjectId === "string" && liveIds.has(node.helixProjectId)),
      );
      next.edges = next.edges.filter((edge) => edge.helixManaged !== true);
      for (const project of projects) {
        const child = byProject.get(project.id);
        if (!child) continue;
        for (const parentId of project.parents) {
          const parent = byProject.get(parentId);
          if (!parent) continue;
          next = upsertManagedEdge(next, {
            id: `helix-edge-${parentId}-${project.id}`,
            fromNode: parent.id,
            toNode: child.id,
          });
        }
      }
      validateLineageCanvas(next);
      const content = `${JSON.stringify(next, null, 2)}\n`;
      if (revision) await this.compareAndWrite(revision, content);
      else {
        let token: ReturnType<SelfWriteTracker["mark"]> | undefined;
        try {
          await this.repository.create(path, content, () => {
            token = this.selfWrites.mark(path);
          });
        } catch (error) {
          if (token) this.selfWrites.cancel(token);
          throw error;
        }
      }
    });
  }

  async applyCanvasToProjects(): Promise<void> {
    await this.runExclusive(async () => {
      const revision = await this.repository.read(this.canvasPath());
      if (!revision) return;
      const parsed = parseCanvas(revision.content);
      const document = adoptProjectLineageEdges(parsed);
      validateLineageCanvas(document);
      const projects = this.projects();
      const knownProjectIds = new Set(projects.map((project) => project.id));
      for (const node of document.nodes.filter((candidate) => candidate.helixManaged === true)) {
        if (!knownProjectIds.has(String(node.helixProjectId))) {
          throw new Error(`Canvas 引用了不存在的 Helix 项目：${String(node.helixProjectId)}`);
        }
      }
      const rejectedCount = parsed.edges.length - document.edges.length;
      const normalizedContent = `${JSON.stringify(document, null, 2)}\n`;
      if (rejectedCount > 0) {
        new Notice(`Helix 已撤销 ${rejectedCount} 条会形成环的项目谱系边。`, 8_000);
      }
      const nodeProjects = new Map<string, string>();
      for (const node of document.nodes) {
        if (node.helixManaged === true && typeof node.helixProjectId === "string") {
          nodeProjects.set(node.id, node.helixProjectId);
        }
      }
      const parents = new Map<string, Set<string>>();
      for (const edge of document.edges) {
        if (edge.helixManaged !== true) continue;
        const parentId = nodeProjects.get(edge.fromNode);
        const childId = nodeProjects.get(edge.toNode);
        if (!parentId || !childId) continue;
        const set = parents.get(childId) ?? new Set<string>();
        set.add(parentId);
        parents.set(childId, set);
      }
      const plans: Array<{ revision: VaultRevision; content: string }> = [];
      if (normalizedContent !== revision.content) {
        plans.push({ revision, content: normalizedContent });
      }
      for (const project of projects) {
        const fileRevision = await this.repository.read(project.file.path);
        if (!fileRevision) throw new Error(`项目笔记在批量写入前被删除：${project.file.path}`);
        const next = patchManagedFrontmatter(fileRevision.content, {
          "helix-parents": [...(parents.get(project.id) ?? [])].sort(),
          "helix-updated": new Date().toISOString(),
        });
        if (next !== fileRevision.content) {
          plans.push({ revision: fileRevision, content: next });
        }
      }
      await this.writeBatch(plans);
    });
  }

  private projects(): ProjectDescriptor[] {
    const projects = this.app.vault.getMarkdownFiles().flatMap((file) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter?.["helix-kind"] !== "helix-project") return [];
      const id = frontmatter["helix-id"];
      if (typeof id !== "string" || !id) {
        throw new Error(`Helix 项目缺少有效 helix-id：${file.path}`);
      }
      const parents = Array.isArray(frontmatter["helix-parents"])
        ? frontmatter["helix-parents"].filter((value: unknown): value is string => typeof value === "string")
        : [];
      const didaProjectId =
        typeof frontmatter["helix-dida-project-id"] === "string" &&
        frontmatter["helix-dida-project-id"].trim()
          ? frontmatter["helix-dida-project-id"].trim()
          : undefined;
      return [{ id, file, parents, didaProjectId }];
    });
    assertProjectMappingsUnique(
      projects.map((project) => ({
        id: project.id,
        path: project.file.path,
        didaProjectId: project.didaProjectId,
      })),
    );
    const ids = new Set(projects.map((project) => project.id));
    for (const project of projects) {
      for (const parent of project.parents) {
        if (!ids.has(parent)) {
          throw new Error(`项目 ${project.id} 引用了不存在的父项目：${parent}`);
        }
      }
    }
    assertDag(
      [...ids],
      projects.flatMap((project) =>
        project.parents.map((parent) => ({ from: parent, to: project.id })),
      ),
    );
    return projects;
  }

  private async runExclusive(operation: () => Promise<void>): Promise<void> {
    return this.runner.run(async () => {
      if (this.disposed) throw new Error("Helix 已卸载，项目谱系操作已取消");
      try {
        await operation();
      } catch (error) {
        if (error instanceof VaultWriteConflictError) {
          new Notice(`项目谱系写入已暂停：${error.path} 在读取后又被修改`);
        }
        throw error;
      }
    });
  }

  private async compareAndWrite(
    revision: VaultRevision,
    nextContent: string,
  ): Promise<void> {
    await this.writeTracked(revision, nextContent);
  }

  private async writeTracked(
    revision: VaultRevision,
    nextContent: string,
  ): Promise<VaultRevision> {
    let token: ReturnType<SelfWriteTracker["mark"]> | undefined;
    try {
      return await this.repository.compareAndWrite(revision, nextContent, () => {
        token = this.selfWrites.mark(normalizePath(revision.path));
      });
    } catch (error) {
      if (token) this.selfWrites.cancel(token);
      throw error;
    }
  }

  private async writeBatch(
    plans: Array<{ revision: VaultRevision; content: string }>,
  ): Promise<void> {
    await writeBatchWithRollback(plans, async (revision, content) => {
        return this.writeTracked(revision, content);
      });
  }
}

function parseCanvas(content: string): CanvasDocument {
  const value = JSON.parse(content) as Partial<CanvasDocument>;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("项目谱系 Canvas 缺少 nodes 或 edges 数组");
  }
  return value as CanvasDocument;
}
