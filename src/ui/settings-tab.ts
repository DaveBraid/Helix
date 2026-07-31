import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type HelixPlugin from "../main";
import {
  DIDA_TOKEN_MENU_PATH,
  DIDA_WEB_URL,
} from "./dida-settings-contract";
import { openInDefaultBrowser } from "./default-browser";

export class HelixSettingTab extends PluginSettingTab {
  private writeTestArmed = false;
  private writeTestResult: string | null = null;

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
        button.setButtonText("保存").setCta().onClick(async () => {
          try {
            await this.plugin.service.replaceDidaToken(token);
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
        button.setButtonText("清除").setWarning().onClick(async () => {
          try {
            await this.plugin.service.clearDidaToken();
            this.plugin.refreshAutoSync();
            new Notice("滴答 API 口令已清除");
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
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

    let scheduleModeSetting: Setting | null = null;
    const writeTestSetting = new Setting(this.containerEl)
      .setName("写入合同测试")
      .setDesc(this.writeTestDescription())
      .addButton((button) =>
        button.setButtonText(this.writeTestArmed ? "再次点击开始" : "运行专用测试").onClick(async () => {
          if (!this.writeTestArmed) {
            this.writeTestArmed = true;
            button.setButtonText("再次点击开始").setWarning();
            new Notice("再次点击后将创建并清理专用测试清单；不会操作既有清单或任务", 8_000);
            return;
          }
          this.writeTestArmed = false;
          this.writeTestResult = "最近结果：测试运行中，其他远端写入与口令变更已冻结。";
          writeTestSetting.setDesc(this.writeTestDescription());
          button.setDisabled(true).setButtonText("测试中…");
          try {
            const report = await this.plugin.service.runDidaWriteContractTest((progress) => {
              const attempt = progress.attempt && progress.maxAttempts
                ? `（${progress.attempt}/${progress.maxAttempts}）`
                : "";
              this.writeTestResult = `最近结果：测试运行中 · ${progress.stage}${attempt}。其他远端写入与口令变更已冻结。`;
              writeTestSetting.setDesc(this.writeTestDescription());
            });
            if (report.status === "passed" && !report.remoteArtifactsRemaining) {
              this.writeTestResult = `最近结果：通过。${report.steps.join("；")}；测试对象已全部清理。`;
              new Notice(`滴答写入合同测试通过：${report.steps.join("；")}`, 12_000);
            } else {
              const cleanup = report.remoteArtifactsRemaining
                ? `；远端可能有测试残留：${report.cleanupErrors.join("；")}`
                : "；测试对象已安全清理";
              this.writeTestResult = `最近结果：未通过。${report.failure ?? "未知错误"}${cleanup}`;
              new Notice(`滴答写入合同测试未通过：${report.failure ?? "未知错误"}${cleanup}`, 20_000);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeTestResult = `最近结果：无法运行。${message}`;
            new Notice(`无法运行写入合同测试：${message}`, 12_000);
          } finally {
            writeTestSetting.setDesc(this.writeTestDescription());
            scheduleModeSetting?.setDesc(this.scheduleModeDescription());
            button.buttonEl.removeClass("mod-warning");
            button.setDisabled(false).setButtonText("运行专用测试");
          }
        }),
      );

    scheduleModeSetting = new Setting(this.containerEl)
      .setName("任务时间能力")
      .setDesc(this.scheduleModeDescription());

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

  private writeTestDescription(): string {
    const scope = "只创建带唯一标记的两个临时清单及其中一个任务；每次删除前复读身份，绝不操作既有数据。";
    return this.writeTestResult ? `${scope} ${this.writeTestResult}` : scope;
  }

  private scheduleModeDescription(): string {
    const scheduleMode = this.plugin.service.snapshot().taskScheduleMode;
    return scheduleMode === "unknown"
      ? "尚未验证；运行写入合同测试后确定当前账号支持单点时间还是独立起止时间。"
      : scheduleMode === "point"
        ? "当前账号使用单点任务时间；已有独立时间段会保持原值。"
        : "当前账号支持独立设置开始时间和截止时间。";
  }
}
