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
import {
  PROJECTION_COLUMN_NAME,
  type ProjectionActivationPreview,
  type ProjectionColumnCreationPreview,
} from "../domain/dida-project-projection";
import {
  ProjectionUiActionCoordinator,
  projectionActivationText,
  projectionCatalogChoices,
  projectionTargetText,
} from "./project-projection-presenter";

export class HelixSettingTab extends PluginSettingTab {
  private writeTestResult: string | null = null;
  private projectionRenderToken = 0;
  private armedProjection?: ProjectionActivationPreview;
  private armedColumnCreation?: ProjectionColumnCreationPreview;
  private preferredProjectionProjectId?: string;
  private preferredProjectionColumnId?: string;
  private readonly projectionUiActions = new ProjectionUiActionCoordinator();

  constructor(app: App, private readonly plugin: HelixPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.armedProjection = undefined;
    this.armedColumnCreation = undefined;
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

    const projectionHost = this.containerEl.createDiv({ cls: "helix-settings-projection" });
    projectionHost.createEl("h3", { text: "滴答项目同步" });
    projectionHost.createEl("p", {
      cls: "setting-item-description",
      text: "将 Helix 项目与已加入的计划行动同步到同一滴答看板分栏。默认关闭；显式启用后由项目与 Stage 变更自动触发。",
    });
    const projectionToken = ++this.projectionRenderToken;
    void this.renderProjectProjectionSettings(projectionHost, projectionToken);

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

  private async renderProjectProjectionSettings(host: HTMLElement, token: number): Promise<void> {
    const loading = host.createDiv({ cls: "setting-item-description", text: "正在精确读取清单与分栏…" });
    try {
      const [configuration, catalogs] = await Promise.all([
        this.plugin.readProjectProjectionConfiguration(),
        this.plugin.readProjectProjectionCatalog(),
      ]);
      if (token !== this.projectionRenderToken || !host.isConnected) return;
      loading.remove();
      const choices = projectionCatalogChoices(catalogs);
      let projectId = this.preferredProjectionProjectId ?? configuration.target?.targetProjectId ?? "";
      let columnId = this.preferredProjectionColumnId ?? configuration.target?.targetColumnId ?? "";
      const status = host.createDiv({ cls: "helix-projection-settings-status" });
      status.createEl("strong", { text: projectionTargetText(configuration) });
      const previewBox = host.createDiv({ cls: "helix-projection-preview", attr: { "aria-live": "polite" } });
      const setting = new Setting(host).setName("目标清单与已有分栏")
        .setDesc("名称与稳定 ID 同时显示；未选择时不会按名称猜测。")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "选择清单…");
          for (const choice of choices) dropdown.addOption(choice.projectId, choice.projectLabel);
          dropdown.setValue(projectId);
          dropdown.onChange((value) => {
            projectId = value;
            columnId = "";
            this.preferredProjectionProjectId = value || undefined;
            this.preferredProjectionColumnId = undefined;
            this.armedProjection = undefined;
            this.armedColumnCreation = undefined;
            this.renderProjectionColumnOptions(columnSelect, choices, projectId, columnId);
            action.setButtonText("预览并检查");
            action.buttonEl.removeClass("mod-cta");
            renderColumnCreation();
          });
        });
      let columnSelect!: HTMLSelectElement;
      setting.addDropdown((dropdown) => {
        columnSelect = dropdown.selectEl;
        this.renderProjectionColumnOptions(columnSelect, choices, projectId, columnId);
        dropdown.onChange((value) => {
          columnId = value;
          this.preferredProjectionColumnId = value || undefined;
          this.armedProjection = undefined;
          action.setButtonText("预览并检查");
          action.buttonEl.removeClass("mod-cta");
        });
      });
      const columnCreationHost = host.createDiv({ cls: "helix-projection-column-creation" });
      const renderColumnCreation = () => {
        columnCreationHost.empty();
        const choice = choices.find((candidate) => candidate.projectId === projectId);
        const catalog = catalogs.find((candidate) => candidate.projects[0]?.id === projectId);
        if (!choice || catalog?.columns.some((column) => column.name === PROJECTION_COLUMN_NAME)) return;
        const box = columnCreationHost.createDiv({ cls: "helix-projection-preview", attr: { "aria-live": "polite" } });
        const createSetting = new Setting(columnCreationHost)
          .setName(`创建“${PROJECTION_COLUMN_NAME}”分栏`)
          .setDesc("只在所选清单单发创建；不删除、改名或重排任何既有分栏。");
        createSetting.addButton((createButton) => createButton.setButtonText("预览创建").onClick(() => {
          void this.projectionUiActions.run(async () => {
            try {
              if (this.armedColumnCreation?.targetProjectId === projectId) {
                const created = await this.plugin.confirmProjectProjectionColumn(
                  this.armedColumnCreation,
                  this.armedColumnCreation.previewHash,
                );
                this.preferredProjectionProjectId = projectId;
                this.preferredProjectionColumnId = created.id;
                this.armedColumnCreation = undefined;
                new Notice("分栏已双源复读确认；请重新预览后再启用滴答项目同步");
                this.display();
                return;
              }
              const preview = await this.plugin.previewProjectProjectionColumn(projectId);
              box.empty();
              box.createEl("div", { text: `${preview.projectName} · ${preview.targetProjectId}` });
              box.createEl("div", {
                text: preview.baselineColumns.length === 0
                  ? "完整列基线：空"
                  : `完整列基线：${preview.baselineColumns.map((column) => `${column.name} · ${column.id}`).join("；")}`,
              });
              box.createEl("code", { text: `基线摘要 ${preview.baselineHash}` });
              box.createEl("div", {
                text: preview.blockers.length === 0
                  ? "能力、授权、队列与结果未知检查已通过"
                  : `阻塞：${preview.blockers.join("；")}`,
              });
              if (preview.blockers.length === 0) {
                this.armedColumnCreation = preview;
                createButton.setButtonText("再次点击确认创建").setCta();
              } else {
                this.armedColumnCreation = undefined;
                createButton.setButtonText("重新预览");
                createButton.buttonEl.removeClass("mod-cta");
              }
            } catch (error) {
              this.armedColumnCreation = undefined;
              const message = error instanceof Error ? error.message : String(error);
              if (message.includes("结果未知")) {
                new Notice(message, 10_000);
                this.display();
                return;
              }
              createButton.setButtonText("重新预览");
              createButton.buttonEl.removeClass("mod-cta");
              box.empty();
              box.createEl("div", { text: "创建条件或基线已经变化，必须重新预览。" });
              new Notice(message, 8_000);
            }
          }, (busy) => this.setProjectionSettingsBusy(host, busy), () => undefined);
        }));
      };
      renderColumnCreation();
      let action!: Parameters<Setting["addButton"]>[0] extends (button: infer B) => unknown ? B : never;
      setting.addButton((button) => {
        action = button;
        button.setButtonText("预览并检查").onClick(() => {
          if (!projectId || !columnId) {
            new Notice("请先明确选择清单与已有分栏");
            return;
          }
          void this.projectionUiActions.run(async () => {
            try {
              if (this.armedProjection?.target.targetProjectId === projectId &&
                this.armedProjection.target.targetColumnId === columnId) {
                await this.plugin.confirmProjectProjection(
                  this.armedProjection,
                  this.armedProjection.previewHash,
                );
                this.armedProjection = undefined;
                new Notice("滴答项目同步已启用；后续 Stage 与项目变更将自动排队");
                this.display();
                return;
              }
              const preview = await this.plugin.previewProjectProjection({
                targetProjectId: projectId,
                targetColumnId: columnId,
              });
              if (token !== this.projectionRenderToken) return;
              previewBox.empty();
              for (const line of projectionActivationText(preview)) previewBox.createEl("div", { text: line });
              if (preview.blockers.length === 0) {
                this.armedProjection = preview;
                button.setButtonText("再次点击确认启用").setCta();
              } else {
                this.armedProjection = undefined;
                button.setButtonText("重新预览");
                button.buttonEl.removeClass("mod-cta");
              }
            } catch (error) {
              this.armedProjection = undefined;
              button.setButtonText("重新预览");
              button.buttonEl.removeClass("mod-cta");
              previewBox.empty();
              previewBox.createEl("div", { text: "确认失败或状态已变化，必须重新预览后再确认。" });
              new Notice(error instanceof Error ? error.message : String(error), 8_000);
            }
          }, (busy) => this.setProjectionSettingsBusy(host, busy), () => undefined);
        });
      });
      if (configuration.enabled) {
        new Setting(host).setName("停用滴答项目同步")
          .setDesc("保留已验证身份与诊断；停用后后台同步立即停止。")
          .addButton((button) => button.setButtonText("显式禁用").setWarning().onClick(() => {
            void this.projectionUiActions.run(async () => {
              try {
                await this.plugin.disableProjectProjection();
                new Notice("滴答项目同步已禁用");
                this.display();
              } catch (error) {
                new Notice(error instanceof Error ? error.message : String(error), 8_000);
              }
            }, (busy) => this.setProjectionSettingsBusy(host, busy), () => undefined);
          }));
      }
      if (choices.length === 0 || choices.every((choice) => choice.columns.length === 0)) {
        host.createDiv({
          cls: "helix-projection-empty-column",
          text: projectId
            ? `所选清单没有可用分栏；可在上方预览并创建“${PROJECTION_COLUMN_NAME}”。`
            : "请选择清单以查看已有分栏或安全创建目标分栏。",
        });
      }
    } catch (error) {
      if (token !== this.projectionRenderToken || !host.isConnected) return;
      loading.setText(`无法读取滴答项目同步目录：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private setProjectionSettingsBusy(host: HTMLElement, busy: boolean): void {
    host.toggleClass("is-projection-action-busy", busy);
    for (const button of host.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
  }

  private renderProjectionColumnOptions(
    select: HTMLSelectElement,
    choices: ReturnType<typeof projectionCatalogChoices>,
    projectId: string,
    selected: string,
  ): void {
    select.empty();
    select.createEl("option", { value: "", text: projectId ? "选择已有分栏…" : "先选择清单" });
    for (const column of choices.find((choice) => choice.projectId === projectId)?.columns ?? []) {
      select.createEl("option", { value: column.id, text: column.label });
    }
    select.value = selected;
    select.disabled = !projectId;
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
