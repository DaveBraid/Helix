import { describe, expect, it } from "vitest";
import { configureTemplateSettings } from "../src/services/template-settings-coordinator";
import { SerializedRunner } from "../src/services/serialized-runner";

describe("template settings coordinator", () => {
  it("rejects recovery mode before any template or persistence operation", async () => {
    let configured = 0;
    let persisted = 0;
    await expect(configureTemplateSettings({
      recoveryMode: true,
      folder: "Next",
      manager: { async configure() { configured += 1; return []; } } as never,
      persist: async () => {
        persisted += 1;
        return { templateFolder: "Template", templateSetupCompleted: true };
      },
      publish: () => { throw new Error("must not publish"); },
    })).rejects.toThrow(/只读恢复模式/);
    expect({ configured, persisted }).toEqual({ configured: 0, persisted: 0 });
  });

  it("uses ensure, persist, publish order and only publishes after persistence", async () => {
    const calls: string[] = [];
    let runtime = { templateFolder: "Template", templateSetupCompleted: false, keep: "x" };
    const created = await configureTemplateSettings({
      recoveryMode: false,
      folder: "Next",
      manager: {
        async configure(
          folder: string,
          persist: (folder: string) => Promise<void>,
          publish: (folder: string) => void,
        ) {
          calls.push(`ensure:${folder}`);
          await persist(folder);
          calls.push("persisted");
          publish(folder);
          calls.push("published");
          return ["Next/Helix/Project.md"];
        },
      } as never,
      persist: async (folder) => {
        const next = { ...runtime, templateFolder: folder, templateSetupCompleted: true };
        calls.push(`persist:${next.templateFolder}:${next.templateSetupCompleted}`);
        return next;
      },
      publish: (next) => { runtime = next; },
    });
    expect(created).toEqual(["Next/Helix/Project.md"]);
    expect(calls).toEqual([
      "ensure:Next",
      "persist:Next:true",
      "persisted",
      "published",
    ]);
    expect(runtime).toEqual({ templateFolder: "Next", templateSetupCompleted: true, keep: "x" });
  });

  it("does not publish a new runtime directory when manager rolls back after failure", async () => {
    let runtime = { templateFolder: "Template", templateSetupCompleted: true };
    await expect(configureTemplateSettings({
      recoveryMode: false,
      folder: "Next",
      manager: { async configure() { throw new Error("补齐失败，已回滚"); } } as never,
      persist: async () => { throw new Error("must not persist"); },
      publish: (next) => { runtime = next; },
    })).rejects.toThrow(/补齐失败/);
    expect(runtime).toEqual({ templateFolder: "Template", templateSetupCompleted: true });
  });

  it("retains ordinary settings across two queued template switches", async () => {
    const templateRunner = new SerializedRunner();
    const settingsRunner = new SerializedRunner();
    let persisted = {
      templateFolder: "Template",
      templateSetupCompleted: false,
      autoSync: true,
      syncIntervalMinutes: 10,
      taskMatrixRules: { importantPriorityThreshold: 3, urgentWithinDays: 3 },
    };
    let runtime = { ...persisted, taskMatrixRules: { ...persisted.taskMatrixRules } };
    const manager = {
      configure: (folder: string, persistStep: (folder: string) => Promise<void>, publish: (folder: string) => void) =>
        templateRunner.run(async () => {
          await persistStep(folder);
          publish(folder);
          return [];
        }),
    };
    const saveTemplate = (folder: string) => configureTemplateSettings({
      recoveryMode: false,
      folder,
      manager: manager as never,
      persist: async (candidate) => {
        let committed!: typeof persisted;
        await settingsRunner.run(async () => {
          committed = {
            ...persisted,
            taskMatrixRules: { ...persisted.taskMatrixRules },
            templateFolder: candidate,
            templateSetupCompleted: true,
          };
          persisted = committed;
        });
        return committed;
      },
      publish: (next) => {
        runtime.templateFolder = next.templateFolder;
        runtime.templateSetupCompleted = next.templateSetupCompleted;
      },
    });
    const saveOrdinary = () => {
      runtime.autoSync = false;
      runtime.syncIntervalMinutes = 30;
      runtime.taskMatrixRules = { importantPriorityThreshold: 5, urgentWithinDays: 1 };
      return settingsRunner.run(async () => {
        persisted = {
          ...persisted,
          taskMatrixRules: { ...runtime.taskMatrixRules },
          autoSync: runtime.autoSync,
          syncIntervalMinutes: runtime.syncIntervalMinutes,
        };
      });
    };

    await Promise.all([saveTemplate("A"), saveOrdinary(), saveTemplate("B")]);

    expect(persisted).toEqual({
      templateFolder: "B",
      templateSetupCompleted: true,
      autoSync: false,
      syncIntervalMinutes: 30,
      taskMatrixRules: { importantPriorityThreshold: 5, urgentWithinDays: 1 },
    });
    expect(runtime).toEqual(persisted);
  });
});
