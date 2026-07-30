export function assertExistingProjectIdentity(
  content: string,
  expected: { title: string; didaProjectId?: string },
  path: string,
): void {
  assertKind(content, "helix-project", path);
  const title = /^#\s+(.+?)\s*$/m.exec(content)?.[1];
  const mapping = managedScalar(content, "helix-dida-project-id");
  const activeCycle = managedScalar(content, "helix-active-cycle");
  if (
    title !== expected.title ||
    (mapping ?? undefined) !== expected.didaProjectId ||
    activeCycle !== "[[Cycle-01]]"
  ) {
    throw new Error(`已有 Helix 项目与本次输入不一致，可能发生文件名碰撞：${path}`);
  }
}

export function assertExistingInitialCycleIdentity(content: string, path: string): void {
  assertKind(content, "helix-cycle", path);
  if (
    managedScalar(content, "helix-sequence") !== "1" ||
    managedScalar(content, "helix-project") !== "[[Project]]" ||
    managedScalar(content, "helix-predecessor") !== undefined
  ) {
    throw new Error(`已有 Cycle-01 与首轮身份不一致，拒绝复用：${path}`);
  }
}

function assertKind(content: string, expected: string, path: string): void {
  if (managedScalar(content, "helix-kind") !== expected) {
    throw new Error(`已有文件不是 ${expected}，拒绝覆盖：${path}`);
  }
}

function managedScalar(content: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...content.matchAll(new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, "gm"))];
  if (matches.length > 1) throw new Error(`重复的受管属性：${key}`);
  const raw = matches[0]?.[1];
  if (raw === undefined) return undefined;
  return raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}
