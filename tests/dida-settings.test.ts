import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIDA_TOKEN_MENU_PATH,
  DIDA_WEB_URL,
  DIDA_WRITE_CONTRACT_VERSION_LABEL,
} from "../src/ui/dida-settings-contract";
import {
  HELIX_DEVELOPMENT_TESTS_LABEL,
  HELIX_DEVELOPMENT_TESTS_WARNING,
} from "../src/ui/settings-development-tests";
import { resolveMacDefaultBrowserBundleId } from "../src/ui/default-browser";
import { DIDA_CONTRACT_PROBE_VERSION } from "../src/domain/task-schedule";

describe("Dida settings contract", () => {
  it("keeps the account entry and token menu path visible", () => {
    expect(DIDA_WEB_URL).toBe("https://dida365.com/webapp/");
    expect(DIDA_TOKEN_MENU_PATH).toBe("头像 → 设置 → 账户与安全 → API 口令");
    expect(DIDA_WRITE_CONTRACT_VERSION_LABEL).toBe(`合同版本 ${DIDA_CONTRACT_PROBE_VERSION}`);
  });

  it("resolves the macOS default browser instead of the URL-associated app", () => {
    expect(resolveMacDefaultBrowserBundleId(`
      {
        LSHandlerPreferredVersions = {
          LSHandlerRoleAll = "-";
        };
        LSHandlerRoleAll = "com.example.browser";
        LSHandlerURLScheme = https;
      }
    `)).toBe("com.example.browser");
    expect(resolveMacDefaultBrowserBundleId("LSHandlerURLScheme = ticktick;")).toBeNull();
  });

  it("keeps contract controls in an initially collapsed, semantic development-test disclosure", () => {
    const source = readFileSync(resolve(process.cwd(), "src/ui/settings-tab.ts"), "utf8");
    expect(HELIX_DEVELOPMENT_TESTS_LABEL).toBe("开发测试");
    expect(HELIX_DEVELOPMENT_TESTS_WARNING).toMatch(/专用测试对象.*可能产生真实远端写入/);
    expect(source).toMatch(/createEl\("details",\s*\{[\s\S]*helix-settings-development-tests/);
    expect(source).toMatch(/createEl\("summary",\s*\{ text: HELIX_DEVELOPMENT_TESTS_LABEL \}\)/);
    expect(source).toMatch(/new Setting\(developmentContent\)[\s\S]*\.setName\("写入合同测试"\)/);
    expect(source).toMatch(/scheduleModeSetting = new Setting\(developmentContent\)/);
    expect(source).toMatch(/new Setting\(this\.containerEl\)[\s\S]*\.setName\("自动同步"\)/);
  });
});
