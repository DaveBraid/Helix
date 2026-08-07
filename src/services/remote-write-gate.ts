export class RemoteWriteGate {
  private activeShared = 0;
  private exclusiveReason: string | null = null;

  constructor(private readonly onIdle?: () => void) {}

  enterShared(): () => void {
    if (this.exclusiveReason) {
      throw new Error(`${this.exclusiveReason}正在进行，其他远端访问已冻结`);
    }
    this.activeShared += 1;
    return once(() => {
      this.activeShared -= 1;
      if (this.isIdle()) this.onIdle?.();
    });
  }

  enterExclusive(reason = "滴答独占操作"): () => void {
    if (this.exclusiveReason) throw new Error(`${this.exclusiveReason}已经在运行`);
    if (this.activeShared > 0) {
      throw new Error(`已有滴答远端访问正在进行，请完成后再执行${reason}`);
    }
    this.exclusiveReason = reason;
    return once(() => {
      this.exclusiveReason = null;
      this.onIdle?.();
    });
  }

  isExclusive(): boolean {
    return this.exclusiveReason !== null;
  }

  isIdle(): boolean {
    return this.exclusiveReason === null && this.activeShared === 0;
  }
}

function once(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}
