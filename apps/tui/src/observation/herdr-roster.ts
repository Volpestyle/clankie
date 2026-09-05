import type { OperatorConversationServiceClient } from "@clankie/protocol";

export interface HerdrRosterAgent {
  readonly paneId: string;
  readonly agent: string;
  readonly status: "working" | "idle" | "blocked" | "unknown";
  readonly title: string;
}

export interface HerdrRosterSnapshot {
  readonly agents: readonly HerdrRosterAgent[];
  readonly error?: string;
}

/** Every console observes the captain's fleet, including consoles outside Herdr. */
export class HerdrRoster {
  private agents: readonly HerdrRosterAgent[] = [];
  private error: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  private readonly client: Pick<OperatorConversationServiceClient, "roster" | "terminalCatalog">;
  constructor(client: Pick<OperatorConversationServiceClient, "roster" | "terminalCatalog">) {
    this.client = client;
  }

  public snapshot(): HerdrRosterSnapshot {
    return { agents: this.agents, ...(this.error === undefined ? {} : { error: this.error }) };
  }

  public start(onChange: () => void): void {
    if (this.timer !== undefined) return;
    const tick = (): void => {
      void this.poll().then((changed) => {
        if (changed) onChange();
      });
    };
    tick();
    this.timer = setInterval(tick, 5_000);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async poll(): Promise<boolean> {
    if (this.polling) return false;
    this.polling = true;
    const before = JSON.stringify([this.agents, this.error]);
    try {
      const [seats, terminals] = await Promise.all([
        this.client.roster(),
        this.client.terminalCatalog?.() ?? [],
      ]);
      const panes = new Map(terminals.map((terminal) => [terminal.terminalId, terminal.pane.id]));
      this.agents = seats
        .filter((seat) => seat.status !== "done")
        .map(
          (seat): HerdrRosterAgent => ({
            paneId: panes.get(seat.seatId) ?? seat.seatId,
            agent: seat.harness,
            status:
              seat.status === "working" || seat.status === "idle" || seat.status === "blocked"
                ? seat.status
                : "unknown",
            title: seat.title,
          }),
        )
        .sort((a, b) => a.paneId.localeCompare(b.paneId));
      this.error = undefined;
    } catch (caught) {
      this.agents = [];
      this.error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      this.polling = false;
    }
    return JSON.stringify([this.agents, this.error]) !== before;
  }
}
