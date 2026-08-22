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
  it("binds write-contract buttons after their Setting declarations complete", () => {
    const source = readFileSync(resolve(process.cwd(), "src/ui/settings-tab.ts"), "utf8");
    expect(source).toContain("setting.addButton((button) => this.bindWriteContractButton(");
    expect(source).toContain("writeTestSetting.addButton((button) => this.bindWriteContractButton(");
    expect(source).toContain("开启自动同步");
    expect(source).toContain("if (passed && enableAutoSyncOnPass)");
    expect(source).not.toContain(".setDesc(this.writeTestDescription())\n      .addButton");
    const guideDeclaration = source.slice(
      source.indexOf("const setting = new Setting(this.containerEl)"),
      source.indexOf("setting.addButton((button) => this.bindWriteContractButton("),
    );
    expect(guideDeclaration).toContain("随后还需验证写入能力。\");");
  });

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
    expect(source).toMatch(/new Setting\(developmentContent\)[\s\S]*\.setName\("任务时间能力"\)/);
    expect(source).toMatch(/renderDidaWriteEnablementGuide\(\)[\s\S]*\.setName\("启用滴答写入"\)/);
    expect(source).toContain("API 口令目前只允许读取");
    expect(source).toContain("远端写入仍保持只读，请先完成上方写入验证");
    expect(source).toMatch(/new Setting\(this\.containerEl\)[\s\S]*\.setName\("自动同步"\)/);
    expect(source).toMatch(/\.setName\("Helix 模板目录"\)[\s\S]*保存并补齐默认模板/);
  });
});
