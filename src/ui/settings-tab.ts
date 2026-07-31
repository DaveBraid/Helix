import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type HelixPlugin from "../main";
import {
  DIDA_TOKEN_MENU_PATH,
  DIDA_WEB_URL,
} from "./dida-settings-contract";
import { openInDefaultBrowser } from "./default-browser";

export class HelixSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HelixPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Helix 设置" });
    this.containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "滴答 API 口令只保存在 Obsidian SecretStorage，不写入 data.json、日志或 Markdown。",
    });
    const accountGuide = document.createDocumentFragment();
    accountGuide.append(`在滴答网页版依次打开“${DIDA_TOKEN_MENU_PATH}”创建并复制口令。`);
    new Setting(this.containerEl)
      .setName("API 口令获取入口")
      .setDesc(accountGuide)
      .addButton((button) =>
        button.setButtonText("打开滴答网页版").onClick(async () => {
          try {
            await openInDefaultBrowser(DIDA_WEB_URL);
          } catch (error) {
            new Notice(
              `无法打开系统浏览器：${error instanceof Error ? error.message : String(error)}`,
              8_000,
            );
          }
        }),
      );
    let token = "";
    new Setting(this.containerEl)
      .setName("滴答 API 口令")
      .setDesc("按上方路径在滴答网页版获取。保存后可立即测试能力范围。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(this.plugin.secrets.getDidaToken() ? "已安全保存" : "尚未配置");
        text.onChange((value) => {
          token = value;
        });
      })
      .addButton((button) =>
        button.setButtonText("保存").setCta().onClick(() => {
          try {
            this.plugin.secrets.setDidaToken(token);
            this.plugin.refreshAutoSync();
            token = "";
            new Notice("滴答 API 口令已保存到 SecretStorage");
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        }),
      )
      .addButton((button) =>
        button.setButtonText("清除").setWarning().onClick(() => {
          this.plugin.secrets.clearDidaToken();
          this.plugin.refreshAutoSync();
          new Notice("滴答 API 口令已清除");
          this.display();
        }),
      );

    new Setting(this.containerEl)
      .setName("测试连接")
      .setDesc("读取项目、任务、习惯和专注能力；不会修改远端。")
      .addButton((button) =>
        button.setButtonText("只读测试").onClick(async () => {
          button.setDisabled(true).setButtonText("测试中…");
          try {
            await this.plugin.service.probeConnection();
            new Notice("滴答连接正常；本次只读测试未执行队列写入");
          } catch (error) {
            this.plugin.service.notifySyncError(error);
          } finally {
            button.setDisabled(false).setButtonText("只读测试");
          }
        }),
      );

    new Setting(this.containerEl)
      .setName("自动同步")
      .setDesc("桌面端定时执行；冲突只暂停对应对象。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(this.containerEl)
      .setName("同步间隔")
      .setDesc("建议 5–30 分钟。")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ "5": "5 分钟", "10": "10 分钟", "15": "15 分钟", "30": "30 分钟" })
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            this.plugin.settings.syncIntervalMinutes = Number(value);
            await this.plugin.saveSettings();
          }),
      );
  }
}
