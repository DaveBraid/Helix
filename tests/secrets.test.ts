import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { HelixSecretStore } from "../src/storage/secrets";

describe("HelixSecretStore mutation guard", () => {
  it("blocks both replacing and clearing credentials during a contract test", () => {
    const values = new Map<string, string>();
    const app = {
      secretStorage: {
        getSecret: (key: string) => values.get(key) ?? null,
        setSecret: (key: string, value: string) => values.set(key, value),
      },
    } as unknown as App;
    const secrets = new HelixSecretStore(app);
    secrets.setDidaToken("original-token");
    secrets.setMutationGuard(() => "合同测试运行中");

    expect(() => secrets.setDidaToken("replacement-token")).toThrow(/合同测试运行中/);
    expect(() => secrets.clearDidaToken()).toThrow(/合同测试运行中/);
    expect(secrets.getDidaToken()).toBe("original-token");

    secrets.setMutationGuard(() => null);
    secrets.clearDidaToken();
    expect(secrets.getDidaToken()).toBeNull();
  });
});
