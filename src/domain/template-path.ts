/**
 * 模板目录只允许指向 Vault 内的相对目录。该模块不依赖 Obsidian，
 * 让 data.json 反序列化与实际模板读写使用同一套判定。
 */
export function normalizeTemplateFolder(value: unknown): string {
  if (typeof value !== "string") throw new Error("模板目录必须是 Vault 内的相对路径，且不能包含 ..");
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[a-z]:/iu.test(trimmed) ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new Error("模板目录必须是 Vault 内的相对路径，且不能包含 ..");
  }
  const segments = trimmed.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) =>
      segment === "." || segment === ".." || segment.startsWith("~"))
  ) {
    throw new Error("模板目录必须是 Vault 内的相对路径，且不能包含 ..");
  }
  return segments.join("/");
}

export function isSafeTemplateFolder(value: unknown): value is string {
  try {
    normalizeTemplateFolder(value);
    return true;
  } catch {
    return false;
  }
}

export function helixTemplatePath(folder: unknown, filename: string): string {
  return `${normalizeTemplateFolder(folder)}/Helix/${filename}`;
}
