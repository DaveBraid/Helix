import type { App } from "obsidian";

const DIDA_TOKEN_ID = "helix-productivity-dida-token";

export class HelixSecretStore {
  private mutationGuard: () => string | null = () => null;

  constructor(private readonly app: App) {}

  setMutationGuard(guard: () => string | null): void {
    this.mutationGuard = guard;
  }

  getDidaToken(): string | null {
    const value = this.app.secretStorage.getSecret(DIDA_TOKEN_ID);
    return value?.trim() || null;
  }

  setDidaToken(token: string): void {
    this.assertMutationAllowed();
    const normalized = token.trim();
    if (normalized.length < 10) throw new Error("API 口令长度异常");
    this.app.secretStorage.setSecret(DIDA_TOKEN_ID, normalized);
  }

  clearDidaToken(): void {
    this.assertMutationAllowed();
    this.app.secretStorage.setSecret(DIDA_TOKEN_ID, "");
  }

  private assertMutationAllowed(): void {
    const reason = this.mutationGuard();
    if (reason) throw new Error(reason);
  }
}
