import type { App } from "obsidian";

const DIDA_TOKEN_ID = "helix-productivity-dida-token";

export class HelixSecretStore {
  constructor(private readonly app: App) {}

  getDidaToken(): string | null {
    const value = this.app.secretStorage.getSecret(DIDA_TOKEN_ID);
    return value?.trim() || null;
  }

  setDidaToken(token: string): void {
    const normalized = token.trim();
    if (normalized.length < 10) throw new Error("API 口令长度异常");
    this.app.secretStorage.setSecret(DIDA_TOKEN_ID, normalized);
  }

  clearDidaToken(): void {
    this.app.secretStorage.setSecret(DIDA_TOKEN_ID, "");
  }
}
