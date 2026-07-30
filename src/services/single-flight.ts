export class SingleFlight {
  private running: Promise<void> | null = null;
  private rerunRequested = false;

  run(operation: () => Promise<void>): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    const execute = async () => {
      do {
        this.rerunRequested = false;
        await operation();
      } while (this.rerunRequested);
    };
    const current = execute().finally(() => {
      if (this.running === current) this.running = null;
    });
    this.running = current;
    return current;
  }
}
