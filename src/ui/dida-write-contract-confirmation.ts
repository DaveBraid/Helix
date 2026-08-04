export const DIDA_WRITE_CONTRACT_CONFIRM_WINDOW_MS = 15_000;

export type DidaWriteContractConfirmation = "armed" | "confirmed";

/** 设置页与命令面板共用规则、各自独立实例的短时二次确认，不保存到磁盘。 */
export class DidaWriteContractConfirmationGate {
  private expiresAt = 0;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly delay: typeof globalThis.setTimeout = globalThis.setTimeout,
    private readonly cancel: typeof globalThis.clearTimeout = globalThis.clearTimeout,
  ) {}

  request(onExpired?: () => void): DidaWriteContractConfirmation {
    if (this.isArmed()) {
      this.disarm();
      return "confirmed";
    }
    this.disarm();
    this.expiresAt = this.now() + DIDA_WRITE_CONTRACT_CONFIRM_WINDOW_MS;
    const armedUntil = this.expiresAt;
    this.timer = this.delay(() => {
      if (this.expiresAt !== armedUntil) return;
      this.disarm();
      onExpired?.();
    }, DIDA_WRITE_CONTRACT_CONFIRM_WINDOW_MS);
    return "armed";
  }

  isArmed(): boolean {
    if (this.expiresAt <= this.now()) {
      this.disarm();
      return false;
    }
    return true;
  }

  disarm(): void {
    this.expiresAt = 0;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }
}
