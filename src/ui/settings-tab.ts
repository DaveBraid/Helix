import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
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
import {
  DIDA_CONTRACT_TEST_AVAILABLE,
  DIDA_READ_AVAILABLE,
  DIDA_TASK_WRITE_AVAILABLE,
  PROJECT_DIDA_PROJECTION_AVAILABLE,
} from "../release-capabilities";
import { PROJECTION_COLUMN_NAME, PROJECTION_PROJECT_NAME } from "../domain/dida-project-projection";
import { DidaWriteContractConfirmationGate } from "./dida-write-contract-confirmation";

export class HelixSettingTab extends PluginSettingTab {
  private writeTestResult: string | null = null;
  private writeTestPreflight: string | null = null;
  private readonly clearCacheConfirmation = new DidaWriteContractConfirmationGate();
  constructor(app: App, private readonly plugin: HelixPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Helix 设置" });
    if (!DIDA_READ_AVAILABLE) {
      new Setting(this.containerEl)
        .setName("本地正式版")
        .setDesc("当前版本专注项目、阶段、本地任务与复盘；滴答同步将在后续稳定版本开放。已保存的 API 口令仍安全保留在 SecretStorage 中。")
        .setDisabled(true);
      this.renderTemplateSetting();
      return;
    }
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

    this.renderTemplateSetting();

    if (PROJECT_DIDA_PROJECTION_AVAILABLE) this.renderAutomaticProjectProjectionStatus();

    // 写入合同和能力探测只服务开发验证；默认折叠，不干扰日常授权、拉取与同步配置。
    // 原生 details/summary 自带键盘可达和展开状态；展开仅限本次设置页会话，不作持久化。
    if (DIDA_CONTRACT_TEST_AVAILABLE) this.renderContractTests();

    new Setting(this.containerEl)
      .setName("自动同步")
      .setDesc(DIDA_TASK_WRITE_AVAILABLE
        ? "默认关闭；开启后立即同步并按间隔执行。关闭时保存口令也不会自动联网，冲突只暂停对应对象。"
        : "默认关闭；开启后立即拉取并按间隔执行，不会消费或发送待处理写入。")
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

    new Setting(this.containerEl)
      .setName("清除滴答本地缓存")
      .setDesc("只移除 Helix 中可重新拉取的清单、任务、习惯与专注缓存；不会联网，不删除滴答数据，不清除 API 口令或历史统计。")
      .addButton((button) => button
        .setButtonText(this.clearCacheConfirmation.isArmed() ? "再次点击清除" : "清除缓存")
        .setWarning()
        .onClick(async () => {
          if (this.clearCacheConfirmation.request(() => this.display()) === "armed") {
            button.setButtonText("再次点击清除");
            return;
          }
          try {
            await this.plugin.service.clearDidaDisplayCache();
            new Notice("滴答本地展示缓存已清除；远端数据和 API 口令未改动");
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 10_000);
          }
        }));
  }

  private renderAutomaticProjectProjectionStatus(): void {
    const section = this.containerEl.createEl("details", {
      cls: "helix-settings-project-projection",
      attr: { "aria-label": "项目任务同步" },
    });
    section.createEl("summary", { text: "项目任务同步" });
    const content = section.createDiv();
    new Setting(content)
      .setName("自动目标")
      .setDesc(`开启“自动同步”后，Helix 自动准备“${PROJECTION_PROJECT_NAME}”清单及“${PROJECTION_COLUMN_NAME}”专用归属。阶段成为父任务，“计划行动”成为其子任务；不会更改该清单的列表／看板偏好。`)
      .setDisabled(true);
    void Promise.all([
      this.plugin.readProjectProjectionConfiguration(),
      this.plugin.readProjectProjectionWriteReadiness(),
    ]).then(([configuration, readiness]) => {
      const active = this.plugin.settings.autoSync && configuration.enabled && readiness.ready;
      new Setting(content)
        .setName("当前状态")
        .setDesc(active ? "后台自动同步已就绪" : "跟随下方“自动同步”开关；关闭时不会写入滴答")
        .setDisabled(true);
    }).catch(() => undefined);
  }

  private renderContractTests(): void {
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
    let writeTestButton: ButtonComponent | null = null;
    const writeTestSetting = new Setting(developmentContent)
      .setName("写入合同测试")
      .setDesc(this.writeTestDescription())
      .addButton((button) =>
        (writeTestButton = button).setButtonText(this.plugin.didaWriteContractSettingsConfirmation.isArmed() ? "再次点击开始" : "运行专用测试").onClick(async () => {
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
            const preflight = await this.plugin.service.didaWriteContractPreflight();
            this.writeTestPreflight = preflight.reason;
            writeTestSetting.setDesc(this.writeTestDescription());
            button.setDisabled(!preflight.ready).setButtonText("运行专用测试");
          }
        }),
      );

    void this.plugin.service.didaWriteContractPreflight().then((preflight) => {
      this.writeTestPreflight = preflight.reason;
      writeTestSetting.setDesc(this.writeTestDescription());
      writeTestButton?.setDisabled(!preflight.ready);
    });

    scheduleModeSetting = new Setting(developmentContent)
      .setName("任务时间能力")
      .setDesc(this.scheduleModeDescription());

  }

  private renderTemplateSetting(): void {
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
  }

  private writeTestDescription(): string {
    const scope = `${DIDA_WRITE_CONTRACT_VERSION_LABEL}。只创建带唯一标记的两个临时清单和按能力隔离的临时任务；逐项验证后按身份安全清理，绝不操作既有数据。`;
    const status = this.writeTestResult ?? (this.writeTestPreflight ? `启动条件：${this.writeTestPreflight}。` : null);
    return status ? `${scope} ${status}` : scope;
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
