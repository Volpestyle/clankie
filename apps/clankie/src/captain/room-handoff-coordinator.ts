/** A room request owns a fresh execution. Only exact delivery retries share a promise. */
export class RoomHandoffCoordinator<T> {
  private readonly deliveries = new Map<
    string,
    { fingerprint: string; result: Promise<T>; settled: boolean }
  >();
  private readonly waiting: (() => void)[] = [];
  private readonly running = new Set<Promise<void>>();
  private active = 0;
  private readonly signal: AbortSignal;
  private readonly limit: number;

  public constructor(signal: AbortSignal, limit = 4) {
    this.signal = signal;
    this.limit = limit;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid room handoff limit");
    signal.addEventListener("abort", () => this.drain(), { once: true });
  }

  public submit(id: string, fingerprint: string, execute: () => Promise<T>): Promise<T> {
    const existing = this.deliveries.get(id);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(new Error("room_handoff_delivery_conflict"));
      return existing.result;
    }
    const result = new Promise<T>((resolve, reject) => {
      this.waiting.push(() => {
        if (this.signal.aborted) {
          reject(this.signal.reason);
          return;
        }
        this.active += 1;
        const run = Promise.resolve()
          .then(() => {
            this.signal.throwIfAborted();
            return execute();
          })
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.running.delete(run);
            this.drain();
          });
        this.running.add(run);
      });
    });
    this.deliveries.set(id, { fingerprint, result, settled: false });
    void result.then(
      () => this.settled(id),
      () => this.settled(id),
    );
    this.drain();
    return result;
  }

  public async close(): Promise<void> {
    await Promise.allSettled(this.running);
  }

  private settled(id: string): void {
    const delivery = this.deliveries.get(id);
    if (delivery !== undefined) delivery.settled = true;
    const retained = [...this.deliveries.entries()].filter(([, entry]) => entry.settled);
    for (const [key] of retained.slice(0, Math.max(0, retained.length - 4_096))) this.deliveries.delete(key);
  }

  private drain(): void {
    while (this.waiting.length > 0 && (this.signal.aborted || this.active < this.limit))
      this.waiting.shift()!();
  }
}
