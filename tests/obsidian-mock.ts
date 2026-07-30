export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is not available in unit tests");
}

export class TFile {}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export function parseYaml(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let arrayKey: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const array = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (array && arrayKey) {
      (result[arrayKey] as unknown[]).push(parseScalar(array[1]!));
      continue;
    }
    const entry = /^([^:#][^:]*):(?:\s*(.*))?$/.exec(line);
    if (!entry) continue;
    const key = entry[1]!.trim();
    const raw = entry[2]?.trim() ?? "";
    if (!raw) {
      result[key] = [];
      arrayKey = key;
    } else {
      result[key] = parseScalar(raw);
      arrayKey = undefined;
    }
  }
  return result;
}

function parseScalar(raw: string): unknown {
  const unquoted = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) return Number(unquoted);
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  return unquoted;
}
