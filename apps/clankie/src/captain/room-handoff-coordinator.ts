/** A room request owns a fresh execution. Only exact delivery retries share a promise. */
export class RoomHandoffCoordinator<T> {
  private readonly deliveries = new Map<
    string,
    { fingerprint: string; result: Promise<T>; settled: boolean }
  >();
  private readonly waiting = new Map<string, (() => void)[]>();
  private readonly roomOrder: string[] = [];
  private readonly roomActive = new Map<string, number>();
  private waitingCount = 0;
  private readonly running = new Set<Promise<void>>();
  private active = 0;
  private readonly signal: AbortSignal;
  private readonly limit: number;
  private readonly roomLimit: number;
  private readonly waitingLimit: number;

  public constructor(signal: AbortSignal, limit = 4, roomLimit = 2, waitingLimit = 32) {
    this.signal = signal;
    this.limit = limit;
    this.roomLimit = roomLimit;
    this.waitingLimit = waitingLimit;
    if ([limit, roomLimit, waitingLimit].some((value) => !Number.isInteger(value) || value < 1))
      throw new Error("Invalid room handoff limit");
    signal.addEventListener("abort", () => this.drain(), { once: true });
  }

  public submit(
    roomId: string,
    id: string,
    fingerprint: string,
    admit: () => void,
    execute: () => Promise<T>,
  ): Promise<T> {
    const existing = this.deliveries.get(id);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(new Error("room_handoff_delivery_conflict"));
      return existing.result;
    }
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    this.drain();
    const canStart = this.active < this.limit && (this.roomActive.get(roomId) ?? 0) < this.roomLimit;
    if (!canStart && this.waitingCount >= this.waitingLimit)
      return Promise.reject(new Error("room_handoff_queue_full"));
    // Durable pending records are created only after a bounded slot is reserved.
    admit();
    const result = new Promise<T>((resolve, reject) => {
      const room = this.waiting.get(roomId) ?? [];
      if (!this.waiting.has(roomId)) {
        this.waiting.set(roomId, room);
        this.roomOrder.push(roomId);
      }
      this.waitingCount += 1;
      room.push(() => {
        this.waitingCount -= 1;
        if (this.signal.aborted) {
          reject(this.signal.reason);
          return;
        }
        this.active += 1;
        this.roomActive.set(roomId, (this.roomActive.get(roomId) ?? 0) + 1);
        const run = Promise.resolve()
          .then(() => {
            this.signal.throwIfAborted();
            return execute();
          })
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            const remaining = (this.roomActive.get(roomId) ?? 1) - 1;
            if (remaining === 0) this.roomActive.delete(roomId);
            else this.roomActive.set(roomId, remaining);
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
    while (this.roomOrder.length > 0 && (this.signal.aborted || this.active < this.limit)) {
      // Rotate eligible rooms for fair progress; each room's own queue remains FIFO.
      const index = this.roomOrder.findIndex(
        (roomId) => this.signal.aborted || (this.roomActive.get(roomId) ?? 0) < this.roomLimit,
      );
      if (index < 0) break;
      const [roomId] = this.roomOrder.splice(index, 1);
      const queue = this.waiting.get(roomId!)!;
      const start = queue.shift()!;
      if (queue.length === 0) this.waiting.delete(roomId!);
      else this.roomOrder.push(roomId!);
      start();
    }
  }
}
