export function patchManagedFrontmatter(
  content: string,
  updates: Record<string, unknown>,
): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? content.slice(1) : content;
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(body);
  if (!match) throw new Error("文件没有可识别的 YAML frontmatter");
  const lines = match[2]!.split(/\r?\n/);
  for (const [key, value] of Object.entries(updates)) {
    if (!key.startsWith("helix-")) {
      throw new Error(`拒绝修改非 Helix 属性：${key}`);
    }
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const indices = lines.flatMap((line, index) =>
      new RegExp(`^${escaped}\\s*:`).test(line) ? [index] : [],
    );
    if (indices.length > 1) throw new Error(`重复的受管属性：${key}`);
    const index = indices[0];
    if (value === undefined) {
      if (index === undefined) continue;
      let end = index + 1;
      while (end < lines.length && /^[ \t]+/.test(lines[end] ?? "")) end += 1;
      lines.splice(index, end - index);
      continue;
    }
    const encoded = encodeYamlInline(value);
    if (index === undefined) {
      lines.push(`${key}: ${encoded}`);
      continue;
    }
    let end = index + 1;
    while (end < lines.length && /^[ \t]+/.test(lines[end] ?? "")) end += 1;
    lines.splice(index, end - index, `${key}: ${encoded}`);
  }
  return `${bom}${match[1]}${lines.join(newline)}${match[3]}${body.slice(match[0].length)}`;
}

function encodeYamlInline(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}
