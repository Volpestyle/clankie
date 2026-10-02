import type { RealtimeTimers } from "../src/realtime-session.ts";

export class ManualTimers implements RealtimeTimers {
  public readonly scheduled: {
    handle: number;
    delayMs: number;
    handler: () => void;
    cleared: boolean;
    fired: boolean;
  }[] = [];
  private nextHandle = 1;

  public setTimeout(handler: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.scheduled.push({ handle, delayMs, handler, cleared: false, fired: false });
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    const entry = this.scheduled.find((candidate) => candidate.handle === handle);
    if (entry !== undefined) entry.cleared = true;
  }

  public pending(): { delayMs: number }[] {
    return this.scheduled.filter((candidate) => !candidate.cleared && !candidate.fired);
  }

  public fire(delayMs?: number): void {
    const entry = this.scheduled.find(
      (candidate) =>
        !candidate.cleared && !candidate.fired && (delayMs === undefined || candidate.delayMs === delayMs),
    );
    if (entry === undefined)
      throw new Error(
        delayMs === undefined ? "No armed timer to fire" : `No armed timer with delay ${delayMs.toString()}`,
      );
    entry.fired = true;
    entry.handler();
  }

  public fireLast(delayMs: number): void {
    const entry = this.scheduled.findLast(
      (candidate) => !candidate.cleared && !candidate.fired && candidate.delayMs === delayMs,
    );
    if (entry === undefined) throw new Error(`No armed timer with delay ${delayMs.toString()}`);
    entry.fired = true;
    entry.handler();
  }
}
