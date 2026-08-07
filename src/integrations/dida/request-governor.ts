import { DidaHttpError } from "./http-contract";

export type DidaInterfaceCategory = "project" | "task" | "habit" | "focus" | "other";

export interface DidaRequestControlState {
  authorizationBinding?: string;
  nextAllowedAt?: string;
  cooldownUntil?: string;
  queryLimitLevel: 0 | 1 | 2 | 3;
  cooldownProbeUsed: boolean;
  recoveryReadPending: boolean;
  requestCounts: Record<DidaInterfaceCategory, number>;
  rateLimitCount: number;
  lastRateLimitedAt?: string;
  lastRateLimitKind?: "retry-after" | "query-limit";
}

export interface DidaRequestControlPort {
  read(): Promise<DidaRequestControlState>;
  write(state: DidaRequestControlState): Promise<void>;
  onPersistenceFailure?(message: string): void | Promise<void>;
  readEmergencyLatch?(): Promise<{
    version: 1;
    authorizationBinding: string;
    reason: "rate-limit-persistence-failed" | "authorization-transition";
    createdAt: string;
    targetAuthorizationBinding?: string;
    stage?: "prepared";
  } | null>;
  writeEmergencyLatch?(latch: {
    version: 1;
    authorizationBinding: string;
    reason: "rate-limit-persistence-failed" | "authorization-transition";
    createdAt: string;
    targetAuthorizationBinding?: string;
    stage?: "prepared";
  }): Promise<void>;
}

export const EMPTY_DIDA_REQUEST_CONTROL: DidaRequestControlState = {
  queryLimitLevel: 0,
  cooldownProbeUsed: false,
  recoveryReadPending: false,
  requestCounts: { project: 0, task: 0, habit: 0, focus: 0, other: 0 },
  rateLimitCount: 0,
};

export const DIDA_RATE_LIMIT_PERSISTENCE_RECOVERY_ISSUE =
  "滴答限流状态无法持久化，已进入只读恢复模式";

const QUERY_BACKOFF_MS = [15, 30, 60].map((minutes) => minutes * 60_000);
const MAX_PERSISTED_SPACING_MS = 5_000;

export class DidaRequestGovernor {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private terminalFailure: DidaHttpError | undefined;
  private expectedAuthorizationBinding: string | undefined;

  constructor(
    private readonly port: DidaRequestControlPort,
    private readonly minIntervalMs = 1_000,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (milliseconds: number) => Promise<void> = delay,
  ) {}

  schedule<T>(
    category: DidaInterfaceCategory,
    readOnly: boolean,
    allowCooldownProbe: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = this.tail.then(() => this.execute(category, readOnly, allowCooldownProbe, operation));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  resetForAuthorization(authorizationBinding: string | undefined): void {
    this.terminalFailure = undefined;
    this.nextRequestAt = 0;
    this.expectedAuthorizationBinding = authorizationBinding;
  }

  async assertContractAllowed(): Promise<void> {
    const state = await this.readStateOrFailClosed();
    await this.assertEmergencyLatch(state.authorizationBinding);
    const remaining = remainingCooldown(state, this.now());
    if (remaining > 0) throw cooldownError(remaining);
  }

  private async execute<T>(
    category: DidaInterfaceCategory,
    readOnly: boolean,
    allowCooldownProbe: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.terminalFailure) throw this.terminalFailure;
    let state = await this.readStateOrFailClosed();
    if (this.expectedAuthorizationBinding &&
      state.authorizationBinding !== this.expectedAuthorizationBinding) {
      throw new DidaHttpError(
        "permanent",
        "滴答请求控制状态尚未完成新授权初始化",
        undefined,
        undefined,
        false,
        undefined,
        true,
      );
    }
    await this.assertEmergencyLatch(state.authorizationBinding);
    const before = this.now();
    const recoveryRead = readOnly && (Boolean(state.cooldownUntil) || state.recoveryReadPending);
    const remaining = remainingCooldown(state, before);
    if (remaining > 0) {
      if (!readOnly || !allowCooldownProbe || state.cooldownProbeUsed) throw cooldownError(remaining);
      state = { ...state, cooldownProbeUsed: true, recoveryReadPending: true };
      await this.writeStateBeforeTransport(state);
    } else if (state.cooldownUntil) {
      // 已自然到期的窗口不应继承上一个窗口已用掉的探针额度。
      state = {
        ...state,
        cooldownUntil: undefined,
        cooldownProbeUsed: false,
        recoveryReadPending: true,
      };
      await this.writeStateBeforeTransport(state);
    }
    const persistedNextAllowed = state.nextAllowedAt ? Date.parse(state.nextAllowedAt) : Number.NaN;
    const persistedWait = Number.isFinite(persistedNextAllowed) ? persistedNextAllowed - this.now() : 0;
    if (persistedWait > MAX_PERSISTED_SPACING_MS) {
      throw new DidaHttpError(
        "permanent",
        "滴答请求间隔状态异常，已停止远端访问",
        undefined,
        undefined,
        false,
        undefined,
        true,
      );
    }
    const wait = Math.max(
      0,
      this.nextRequestAt - this.now(),
      persistedWait,
    );
    if (wait > 0) await this.sleep(wait);
    const latest = await this.readStateOrFailClosed();
    if (latest.authorizationBinding !== state.authorizationBinding) {
      throw new DidaHttpError(
        "permanent",
        "滴答授权在请求排队期间发生变化，已取消旧请求",
        undefined,
        undefined,
        false,
        undefined,
        true,
      );
    }
    await this.assertEmergencyLatch(latest.authorizationBinding);
    state = latest;
    const sentAt = this.now();
    this.nextRequestAt = sentAt + this.minIntervalMs;
    state = {
      ...state,
      nextAllowedAt: new Date(this.nextRequestAt).toISOString(),
      requestCounts: {
        ...state.requestCounts,
        [category]: saturatingIncrement(state.requestCounts[category], "滴答接口请求计数"),
      },
    };
    await this.writeStateBeforeTransport(state);
    try {
      const result = await operation();
      if (recoveryRead) {
        await this.port.write({
          ...state,
          cooldownUntil: undefined,
          queryLimitLevel: 0,
          cooldownProbeUsed: false,
          recoveryReadPending: false,
        });
      }
      return result;
    } catch (error) {
      if (error instanceof DidaHttpError && error.category === "rate-limit") {
        await this.recordRateLimit(state, error);
      }
      throw error;
    }
  }

  private async recordRateLimit(
    state: DidaRequestControlState,
    error: DidaHttpError,
  ): Promise<void> {
    const now = this.now();
    const queryLimit = error.limitKind === "query-limit";
    const level = queryLimit
      ? Math.min(3, Math.max(1, state.queryLimitLevel + 1)) as 1 | 2 | 3
      : state.queryLimitLevel;
    const duration = queryLimit
      ? QUERY_BACKOFF_MS[level - 1]!
      : Math.max(1_000, error.retryAfterMs ?? 30_000);
    const failure = new DidaHttpError(
      "permanent",
      DIDA_RATE_LIMIT_PERSISTENCE_RECOVERY_ISSUE,
      undefined,
      undefined,
      false,
      undefined,
      true,
    );
    // 在持久化前先锁死当前实例，只有保存成功才解除。
    this.terminalFailure = failure;
    try {
      const nextState: DidaRequestControlState = {
        ...state,
        cooldownUntil: new Date(now + duration).toISOString(),
        queryLimitLevel: level,
        cooldownProbeUsed: state.cooldownProbeUsed,
        recoveryReadPending: false,
        rateLimitCount: saturatingIncrement(state.rateLimitCount, "滴答限流计数"),
        lastRateLimitedAt: new Date(now).toISOString(),
        lastRateLimitKind: queryLimit ? "query-limit" : "retry-after",
      };
      await this.port.write(nextState);
      this.terminalFailure = undefined;
    } catch {
      const binding = state.authorizationBinding;
      if (binding && this.port.writeEmergencyLatch) {
        try {
          await this.port.writeEmergencyLatch({
            version: 1,
            authorizationBinding: binding,
            reason: "rate-limit-persistence-failed",
            createdAt: new Date(now).toISOString(),
          });
        } catch {
          // 当前实例仍保持 terminal fail-closed；闭锁端口故障不会触发远端重试。
        }
      }
      try {
        await this.port.onPersistenceFailure?.(failure.message);
      } catch {
        // 恢复通知本身失败也不能解除当前实例的 fail-closed 状态。
      }
      return;
    }
  }

  private async assertEmergencyLatch(expectedBinding: string | undefined): Promise<void> {
    let latch: Awaited<ReturnType<NonNullable<DidaRequestControlPort["readEmergencyLatch"]>>>;
    try {
      latch = await this.port.readEmergencyLatch?.() ?? null;
    } catch {
      this.terminalFailure = new DidaHttpError(
        "permanent",
        "滴答紧急闭锁状态无法读取，已停止远端访问",
        undefined,
        undefined,
        false,
        undefined,
        true,
      );
      throw this.terminalFailure;
    }
    if (!latch) return;
    if (!expectedBinding || latch.authorizationBinding !== expectedBinding) {
      this.terminalFailure = new DidaHttpError(
        "permanent",
        "滴答紧急闭锁与当前授权不匹配，请重新初始化授权",
        undefined,
        undefined,
        false,
        undefined,
        true,
      );
      throw this.terminalFailure;
    }
    this.terminalFailure = new DidaHttpError(
      "permanent",
      "滴答请求处于紧急闭锁状态，请先重新初始化授权",
      undefined,
      undefined,
      false,
      undefined,
      true,
    );
    throw this.terminalFailure;
  }

  private async readStateOrFailClosed(): Promise<DidaRequestControlState> {
    try {
      return await this.port.read();
    } catch {
      this.terminalFailure = new DidaHttpError(
        "permanent",
        "滴答请求控制状态无法读取，已停止远端访问",
        undefined,
        undefined,
        false,
        undefined,
        true,
      );
      try {
        await this.port.onPersistenceFailure?.(this.terminalFailure.message);
      } catch {
        // 当前实例保持 terminal fail-closed。
      }
      throw this.terminalFailure;
    }
  }

  private async writeStateBeforeTransport(state: DidaRequestControlState): Promise<void> {
    try {
      await this.port.write(state);
    } catch {
      this.terminalFailure = new DidaHttpError(
        "permanent",
        "滴答请求控制状态无法持久化，已停止远端访问",
        undefined,
        undefined,
        false,
        undefined,
        true,
      );
      try {
        await this.port.onPersistenceFailure?.(this.terminalFailure.message);
      } catch {
        // 当前实例保持 terminal fail-closed。
      }
      throw this.terminalFailure;
    }
  }
}

export function didaInterfaceCategory(path: string): DidaInterfaceCategory {
  const segment = path.split(/[/?]/u).find(Boolean);
  return segment === "project" || segment === "task" || segment === "habit" || segment === "focus"
    ? segment
    : "other";
}

function remainingCooldown(state: DidaRequestControlState, now: number): number {
  const until = state.cooldownUntil ? Date.parse(state.cooldownUntil) : Number.NaN;
  return Number.isFinite(until) ? Math.max(0, until - now) : 0;
}

function cooldownError(remaining: number): DidaHttpError {
  return new DidaHttpError("rate-limit", "滴答请求仍在全局冷却期", 429, remaining, false, undefined, true);
}

function saturatingIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DidaHttpError(
      "permanent",
      `${label}异常，已停止远端访问`,
      undefined,
      undefined,
      false,
      undefined,
      true,
    );
  }
  return value === Number.MAX_SAFE_INTEGER ? value : value + 1;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
