export class SerializedRunner {
  private tail: Promise<void> = Promise.resolve();
  private running = 0;

  isBusy(): boolean {
    return this.running > 0;
  }

  run(operation: () => Promise<void>): Promise<void> {
    const next = this.tail.then(async () => {
      this.running += 1;
      try {
        await operation();
      } finally {
        this.running -= 1;
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface SelfWriteToken {
  path: string;
  id: number;
}

export class SelfWriteTracker {
  private readonly pending = new Map<
    string,
    Map<number, ReturnType<typeof setTimeout>>
  >();
  private nextId = 1;

  constructor(private readonly expiryMs = 5_000) {}

  mark(path: string): SelfWriteToken {
    const id = this.nextId++;
    const entries = this.pending.get(path) ?? new Map();
    const timer = globalThis.setTimeout(() => this.cancel({ path, id }), this.expiryMs);
    entries.set(id, timer);
    this.pending.set(path, entries);
    return { path, id };
  }

  consume(path: string): boolean {
    const entries = this.pending.get(path);
    if (!entries || entries.size === 0) return false;
    const [id, timer] = entries.entries().next().value as [
      number,
      ReturnType<typeof setTimeout>,
    ];
    globalThis.clearTimeout(timer);
    entries.delete(id);
    if (entries.size === 0) this.pending.delete(path);
    return true;
  }

  cancel(token: SelfWriteToken): void {
    const entries = this.pending.get(token.path);
    const timer = entries?.get(token.id);
    if (timer === undefined || !entries) return;
    globalThis.clearTimeout(timer);
    entries.delete(token.id);
    if (entries.size === 0) this.pending.delete(token.path);
  }

  dispose(): void {
    for (const entries of this.pending.values()) {
      for (const timer of entries.values()) globalThis.clearTimeout(timer);
    }
    this.pending.clear();
  }
}
