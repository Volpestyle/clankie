/**
 * A linked fleet whose census transport just failed is skipped by later
 * censuses until a background probe answers, instead of each census waiting
 * out its transport deadline again (LOCAL-VUH-19 follow-up). A skip is only
 * "unknown": it never proves a seat absent or an occupant gone, and callers
 * see it as that census source failing.
 */
class FleetCensusSkipped extends Error {
  constructor(fleet: string, since: string) {
    super(`Fleet ${fleet} skipped: its census failed at ${since}; reprobing in the background`);
    this.name = "FleetCensusSkipped";
  }
}

interface FleetCensusBreakerOptions {
  readonly probeMinMs?: number;
  readonly probeMaxMs?: number;
  /** The census answered again; its seats can be read now. */
  readonly recovered?: (fleet: string) => void;
}

interface Down {
  readonly identity: string;
  readonly since: string;
  backoffMs: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
  probing: boolean;
}

export class FleetCensusBreaker {
  private readonly down = new Map<string, Down>();
  private closed = false;
  private readonly options: FleetCensusBreakerOptions;

  constructor(options: FleetCensusBreakerOptions = {}) {
    this.options = options;
  }

  /**
   * Run one census transport call for `fleet` at `identity` (its connection
   * definition). `probe` is the read that proves the fleet answers again.
   */
  async run<T>(
    fleet: string,
    identity: string,
    read: () => Promise<T>,
    probe: () => Promise<unknown>,
  ): Promise<T> {
    const known = this.down.get(fleet);
    if (known !== undefined) {
      // A changed connection definition is a new fleet: never skip it on the old one's failure.
      if (known.identity !== identity) this.clear(fleet);
      else throw new FleetCensusSkipped(fleet, known.since);
    }
    try {
      const value = await read();
      if (this.down.get(fleet)?.identity === identity) this.clear(fleet);
      return value;
    } catch (error) {
      if (!this.closed && !this.down.has(fleet)) {
        const entry: Down = {
          identity,
          since: new Date().toISOString(),
          backoffMs: this.options.probeMinMs ?? 5_000,
          probing: false,
        };
        this.down.set(fleet, entry);
        this.schedule(fleet, entry, probe);
      }
      throw error;
    }
  }

  /** Forget every failure, for a fleet connection change. */
  reset(fleet?: string): void {
    for (const id of fleet === undefined ? [...this.down.keys()] : [fleet]) this.clear(id);
  }

  close(): void {
    this.closed = true;
    this.reset();
  }

  private clear(fleet: string): void {
    const entry = this.down.get(fleet);
    if (entry?.timer !== undefined) clearTimeout(entry.timer);
    this.down.delete(fleet);
  }

  private schedule(fleet: string, entry: Down, probe: () => Promise<unknown>): void {
    entry.timer = setTimeout(async () => {
      entry.timer = undefined;
      if (this.down.get(fleet) !== entry || entry.probing) return;
      entry.probing = true;
      let answered = false;
      try {
        await probe();
        answered = true;
      } catch {
        // Still down: back off, bounded.
      } finally {
        entry.probing = false;
      }
      if (this.down.get(fleet) !== entry) return;
      if (answered) {
        this.clear(fleet);
        this.options.recovered?.(fleet);
        return;
      }
      entry.backoffMs = Math.min(entry.backoffMs * 2, this.options.probeMaxMs ?? 30_000);
      this.schedule(fleet, entry, probe);
    }, entry.backoffMs);
    entry.timer.unref?.();
  }
}
