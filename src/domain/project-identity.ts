export function assertExistingProjectIdentity(
  content: string,
  expected: { title: string; didaProjectId?: string },
  path: string,
): void {
  assertKind(content, "helix-project", path);
  const title = /^#\s+(.+?)\s*$/m.exec(content)?.[1];
  const mapping = managedScalar(content, "helix-dida-project-id");
  if (
    title !== expected.title ||
    (mapping ?? undefined) !== expected.didaProjectId
  ) {
    throw new Error(`已有 Helix 项目与本次输入不一致，可能发生文件名碰撞：${path}`);
  }
}

export function assertExistingInitialCycleIdentity(content: string, path: string): void {
  assertOneOfKinds(content, ["helix-stage", "helix-cycle"], path);
  if (
    managedScalar(content, "helix-sequence") !== "1" ||
    managedScalar(content, "helix-project") !== "[[Project]]" ||
    managedScalar(content, "helix-predecessor") !== undefined
  ) {
    throw new Error(`已有 Stage-01 与首个阶段身份不一致，拒绝复用：${path}`);
  }
}

function assertKind(content: string, expected: string, path: string): void {
  if (managedScalar(content, "helix-kind") !== expected) {
    throw new Error(`已有文件不是 ${expected}，拒绝覆盖：${path}`);
  }
}

function assertOneOfKinds(content: string, expected: string[], path: string): void {
  const actual = managedScalar(content, "helix-kind");
  if (!actual || !expected.includes(actual)) {
    throw new Error(`已有文件不是 Helix 阶段，拒绝覆盖：${path}`);
  }
}

function managedScalar(content: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...content.matchAll(new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, "gm"))];
  if (matches.length > 1) throw new Error(`重复的 Helix 管理属性：${key}`);
  const raw = matches[0]?.[1];
  if (raw === undefined) return undefined;
  return raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}
