import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function resolveMacDefaultBrowserBundleId(launchServices: string): string | null {
  const schemeIndex = launchServices.search(/LSHandlerURLScheme\s*=\s*"?https"?\s*;/i);
  if (schemeIndex < 0) return null;
  const preceding = launchServices.slice(0, schemeIndex);
  const rolePattern = /LSHandlerRoleAll\s*=\s*"?([^";\n]+)"?\s*;/gi;
  let match: RegExpExecArray | null;
  let candidate: string | null = null;
  while ((match = rolePattern.exec(preceding)) !== null) {
    const value = match[1]?.trim();
    if (value && value !== "-" && value.toLowerCase() !== "none") candidate = value;
  }
  return candidate;
}

export async function openInDefaultBrowser(url: string): Promise<void> {
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync(
      "/usr/bin/defaults",
      ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"],
      { encoding: "utf8" },
    );
    const bundleId = resolveMacDefaultBrowserBundleId(stdout);
    if (!bundleId) throw new Error("无法识别 macOS 默认浏览器");
    await execFileAsync("/usr/bin/open", ["-b", bundleId, url]);
    return;
  }
  const electron = require("electron") as {
    shell: { openExternal(target: string): Promise<void> };
  };
  await electron.shell.openExternal(url);
}
