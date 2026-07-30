export interface ExistingProjectMapping {
  path: string;
  didaProjectId?: string;
}

export function assertUniqueDidaProjectMapping(
  existing: ExistingProjectMapping[],
  requestedDidaProjectId: string | undefined,
  targetProjectPath: string,
): void {
  if (!requestedDidaProjectId) return;
  const owner = existing.find(
    (project) =>
      project.didaProjectId === requestedDidaProjectId &&
      project.path !== targetProjectPath,
  );
  if (owner) {
    throw new Error(`该滴答清单已映射到另一 Helix 项目：${owner.path}`);
  }
}

export function assertProjectMappingsUnique(
  existing: Array<ExistingProjectMapping & { id: string }>,
): void {
  const ids = new Map<string, string>();
  const didaIds = new Map<string, string>();
  for (const project of existing) {
    const idOwner = ids.get(project.id);
    if (idOwner) throw new Error(`Helix 项目 ID 重复：${project.id}（${idOwner}、${project.path}）`);
    ids.set(project.id, project.path);
    if (!project.didaProjectId) continue;
    const didaOwner = didaIds.get(project.didaProjectId);
    if (didaOwner) {
      throw new Error(
        `滴答清单映射重复：${project.didaProjectId}（${didaOwner}、${project.path}）`,
      );
    }
    didaIds.set(project.didaProjectId, project.path);
  }
}
