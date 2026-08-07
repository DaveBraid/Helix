import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type HelixPlugin from "../main";
import {
  DIDA_TOKEN_MENU_PATH,
  DIDA_WEB_URL,
  DIDA_WRITE_CONTRACT_VERSION_LABEL,
  DIDA_WRITE_CONTRACT_SAFE_FAILURE,
  didaWriteContractSafeSummary,
} from "./dida-settings-contract";
import { openInDefaultBrowser } from "./default-browser";
import {
  HELIX_DEVELOPMENT_TESTS_LABEL,
  HELIX_DEVELOPMENT_TESTS_WARNING,
} from "./settings-development-tests";

export class HelixSettingTab extends PluginSettingTab {
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
            this.plugin.refreshAutoSync(true);
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
      .setName("只读拉取测试")
      .setDesc("拉取并显示真实清单与任务；不会发送待处理写入，也不会修改远端。")
      .addButton((button) =>
        button.setButtonText("拉取真实数据").onClick(async () => {
          button.setDisabled(true).setButtonText("测试中…");
          try {
            await this.plugin.service.pullOnlySync();
            new Notice("真实清单与任务已拉取；本次测试未执行任何远端写入");
          } catch (error) {
            this.plugin.service.notifySyncError(error);
          } finally {
            button.setDisabled(false).setButtonText("拉取真实数据");
          }
        }),
      );

    let templateFolder = this.plugin.settings.templateFolder;
    new Setting(this.containerEl)
      .setName("Helix 模板目录")
      .setDesc("项目、阶段、日／周／月／年复盘只读取此目录下的 Helix 模板。默认 Template，文件位于 Template/Helix/；只补齐缺失文件，不覆盖你的模板。")
      .addText((text) => text.setValue(templateFolder).onChange((value) => { templateFolder = value; }))
      .addButton((button) => button.setButtonText("保存并补齐默认模板").onClick(async () => {
        button.setDisabled(true).setButtonText("处理中…");
        try {
          const created = await this.plugin.saveTemplateFolderAndEnsure(templateFolder);
          new Notice(created.length > 0 ? `已补齐 ${created.length} 份默认模板` : "默认模板已齐全，未覆盖既有文件");
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 8_000);
        } finally {
          button.setDisabled(false).setButtonText("保存并补齐默认模板");
        }
      }));

    // 写入合同和能力探测只服务开发验证；默认折叠，不干扰日常授权、拉取与同步配置。
    // 原生 details/summary 自带键盘可达和展开状态；展开仅限本次设置页会话，不作持久化。
    const developmentTests = this.containerEl.createEl("details", {
      cls: "helix-settings-development-tests",
      attr: { "aria-label": HELIX_DEVELOPMENT_TESTS_LABEL },
    });
    developmentTests.createEl("summary", { text: HELIX_DEVELOPMENT_TESTS_LABEL });
    developmentTests.createEl("p", {
      cls: "setting-item-description helix-settings-development-warning",
      text: HELIX_DEVELOPMENT_TESTS_WARNING,
    });
    const developmentContent = developmentTests.createDiv({
      cls: "helix-settings-development-content",
    });
    let scheduleModeSetting: Setting | null = null;
    const writeTestSetting = new Setting(developmentContent)
      .setName("写入合同测试")
      .setDesc(this.writeTestDescription())
      .addButton((button) =>
        button.setButtonText(this.plugin.didaWriteContractSettingsConfirmation.isArmed() ? "再次点击开始" : "运行专用测试").onClick(async () => {
          const confirmation = this.plugin.didaWriteContractSettingsConfirmation.request(() => {
            button.buttonEl.removeClass("mod-warning");
            button.setButtonText("运行专用测试");
            new Notice("写入合同测试的二次确认已超时失效。", 6_000);
          });
          if (confirmation === "armed") {
            button.setButtonText("再次点击开始").setWarning();
            new Notice("已武装：请在 15 秒内再次点击，才会创建并清理专用测试对象。", 8_000);
            return;
          }
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
            const summary = didaWriteContractSafeSummary(report);
            this.writeTestResult = `最近结果：${summary}`;
            new Notice(summary, report.status === "passed" ? 12_000 : 20_000);
          } catch (error) {
            this.writeTestResult = `最近结果：${DIDA_WRITE_CONTRACT_SAFE_FAILURE}`;
            new Notice(DIDA_WRITE_CONTRACT_SAFE_FAILURE, 12_000);
          } finally {
            writeTestSetting.setDesc(this.writeTestDescription());
            scheduleModeSetting?.setDesc(this.scheduleModeDescription());
            button.buttonEl.removeClass("mod-warning");
            button.setDisabled(false).setButtonText("运行专用测试");
          }
        }),
      );

    scheduleModeSetting = new Setting(developmentContent)
      .setName("任务时间能力")
      .setDesc(this.scheduleModeDescription());

    new Setting(this.containerEl)
      .setName("自动同步")
      .setDesc("桌面端定时执行；冲突只暂停对应对象。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings(value);
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
    const scope = `${DIDA_WRITE_CONTRACT_VERSION_LABEL}。只创建带唯一标记的两个临时清单和按能力隔离的临时任务；逐项验证后按身份安全清理，绝不操作既有数据。`;
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
