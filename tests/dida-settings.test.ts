import { describe, expect, it } from "vitest";
import {
  DIDA_TOKEN_MENU_PATH,
  DIDA_WEB_URL,
} from "../src/ui/dida-settings-contract";
import { resolveMacDefaultBrowserBundleId } from "../src/ui/default-browser";

describe("Dida settings contract", () => {
  it("keeps the account entry and token menu path visible", () => {
    expect(DIDA_WEB_URL).toBe("https://dida365.com/webapp/");
    expect(DIDA_TOKEN_MENU_PATH).toBe("头像 → 设置 → 账户与安全 → API 口令");
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
});
