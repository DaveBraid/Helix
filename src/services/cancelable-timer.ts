export class CancelableTimer {
  private id: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  schedule(callback: () => void, delayMs: number): void {
    if (this.id !== null) globalThis.clearTimeout(this.id);
    if (this.disposed) return;
    this.id = globalThis.setTimeout(() => {
      this.id = null;
      if (!this.disposed) callback();
    }, delayMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.id !== null) globalThis.clearTimeout(this.id);
    this.id = null;
  }
}
