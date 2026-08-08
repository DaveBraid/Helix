export interface ProjectRefreshBatchTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: ProjectRefreshBatchTimers = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 合并 Helix 自写事务及其延迟 Vault 事件；外部事件在静默窗外不拦截。 */
export class ProjectRefreshBatch {
  private depth = 0;
  private settling = false;
  private dirty = false;
  private timer: unknown;

  constructor(
    private readonly flush: () => void,
    private readonly quietMs = 300,
    private readonly timers: ProjectRefreshBatchTimers = DEFAULT_TIMERS,
  ) {}

  begin(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.settling = true;
    this.depth += 1;
  }

  /** true 表示事件已并入当前自写批次，调用方暂不扫描。 */
  recordEvent(): boolean {
    if (this.depth === 0 && !this.settling) return false;
    this.dirty = true;
    if (this.depth === 0) this.armQuietWindow();
    return true;
  }

  end(): void {
    if (this.depth <= 0) throw new Error("项目自写批次结束次数超过开始次数");
    this.depth -= 1;
    if (this.depth > 0) return;
    // 即使 Vault 没有及时发事件，也要在完整提交或失败后稳定重扫一次。
    this.dirty = true;
    this.settling = true;
    this.armQuietWindow();
  }

  dispose(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.depth = 0;
    this.settling = false;
    this.dirty = false;
  }

  private armQuietWindow(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      if (this.depth > 0) return;
      this.settling = false;
      if (!this.dirty) return;
      this.dirty = false;
      this.flush();
    }, this.quietMs);
  }
}
