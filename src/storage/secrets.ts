import type { App } from "obsidian";

const DIDA_TOKEN_ID = "helix-productivity-dida-token";
const DIDA_REQUEST_LATCH_ID = "helix-productivity-dida-request-latch";

export interface DidaRequestEmergencyLatch {
  version: 1;
  authorizationBinding: string;
  reason: "rate-limit-persistence-failed" | "authorization-transition";
  createdAt: string;
  targetAuthorizationBinding?: string;
  stage?: "prepared";
}

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

  getDidaRequestEmergencyLatch(): DidaRequestEmergencyLatch | null {
    const raw = this.app.secretStorage.getSecret(DIDA_REQUEST_LATCH_ID);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (Object.keys(value).some((key) =>
        ![
          "version", "authorizationBinding", "reason", "createdAt",
          "targetAuthorizationBinding", "stage",
        ].includes(key)) ||
        value.version !== 1 ||
        typeof value.authorizationBinding !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.authorizationBinding) ||
        (value.reason !== "rate-limit-persistence-failed" &&
          value.reason !== "authorization-transition") ||
        typeof value.createdAt !== "string" ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        (value.reason === "rate-limit-persistence-failed" &&
          (value.targetAuthorizationBinding !== undefined || value.stage !== undefined)) ||
        (value.reason === "authorization-transition" &&
          (typeof value.targetAuthorizationBinding !== "string" ||
            !/^[a-f0-9]{64}$/u.test(value.targetAuthorizationBinding) ||
            value.stage !== "prepared"))) {
        throw new Error("invalid latch");
      }
      return value as unknown as DidaRequestEmergencyLatch;
    } catch {
      throw new Error("滴答紧急闭锁状态损坏，已停止远端访问");
    }
  }

  setDidaRequestEmergencyLatch(latch: DidaRequestEmergencyLatch): void {
    this.app.secretStorage.setSecret(DIDA_REQUEST_LATCH_ID, JSON.stringify(latch));
  }

  clearDidaRequestEmergencyLatch(): void {
    this.app.secretStorage.setSecret(DIDA_REQUEST_LATCH_ID, "");
  }

  private assertMutationAllowed(): void {
    const reason = this.mutationGuard();
    if (reason) throw new Error(reason);
  }
}
