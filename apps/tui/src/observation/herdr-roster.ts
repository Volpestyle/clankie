import type {
  OperatorConversationServiceClient,
  OperatorFleetSeat,
  OperatorAgentPersona,
} from "@clankie/protocol";

export interface HerdrRosterAgent {
  readonly paneId: string;
  readonly agent: string;
  readonly status: "working" | "idle" | "blocked" | "unknown";
  readonly title: string;
}

export interface LiveAgent {
  readonly seat: OperatorFleetSeat;
  readonly name: string;
}

export interface HerdrRosterSnapshot {
  readonly liveAgents?: readonly LiveAgent[];
  readonly agents: readonly HerdrRosterAgent[];
  readonly error?: string;
}

/** The older five-second read, kept only while the fleet cursor is unavailable (ADR 0150). */
const FALLBACK_POLL_MS = 5_000;

/** Every console observes the captain's fleet, including consoles outside Herdr. */
export class HerdrRoster {
  private agents: readonly HerdrRosterAgent[] = [];
  private error: string | undefined;
  private liveAgents: readonly LiveAgent[] = [];
  private personas: readonly OperatorAgentPersona[] = [];
  private following: AbortController | undefined;
  private polling = false;

  private readonly client: Pick<OperatorConversationServiceClient, "roster" | "terminalCatalog" | "fleet">;
  constructor(client: Pick<OperatorConversationServiceClient, "roster" | "terminalCatalog" | "fleet">) {
    this.client = client;
  }

  public snapshot(): HerdrRosterSnapshot {
    return {
      agents: this.agents,
      liveAgents: this.liveAgents,
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  /** Follow the fleet cursor; a change in Herdr repaints at once instead of on the next tick. */
  public start(onChange: () => void): void {
    if (this.following !== undefined) return;
    const following = new AbortController();
    this.following = following;
    void this.follow(onChange, following.signal);
  }

  public stop(): void {
    this.following?.abort();
    this.following = undefined;
  }

  private async follow(onChange: () => void, signal: AbortSignal): Promise<void> {
    let cursor: string | undefined;
    while (!signal.aborted) {
      if (this.client.fleet !== undefined) {
        try {
          const fleet = await this.client.fleet(cursor, signal);
          if (signal.aborted) return;
          cursor = fleet.cursor;
          if (await this.apply(() => Promise.resolve(fleet.seats), fleet.personas)) onChange();
          continue;
        } catch {
          if (signal.aborted) return;
          // A host without the cursor, or a failed wait: read once, then retry the cursor.
          cursor = undefined;
        }
      }
      if (await this.poll()) onChange();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FALLBACK_POLL_MS);
        timer.unref();
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  public async poll(): Promise<boolean> {
    return this.apply(() => this.client.roster());
  }

  private async apply(
    readSeats: () => Promise<readonly OperatorFleetSeat[]>,
    personas?: readonly OperatorAgentPersona[],
  ): Promise<boolean> {
    if (this.polling) return false;
    this.polling = true;
    const before = JSON.stringify([this.agents, this.liveAgents, this.error]);
    try {
      const [seats, terminals] = await Promise.all([
        readSeats(),
        this.client.terminalCatalog?.().catch(() => []) ?? [],
      ]);
      const panes = new Map(terminals.map((terminal) => [terminal.terminalId, terminal.pane.id]));
      if (personas) this.personas = personas;
      this.liveAgents = seats
        .map((seat) => ({
          seat,
          name: this.personas.find((persona) => persona.personaId === seat.personaId)?.name ?? seat.personaId,
        }))
        .sort((a, b) => a.seat.seatId.localeCompare(b.seat.seatId));
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
      this.liveAgents = [];
      this.error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      this.polling = false;
    }
    return JSON.stringify([this.agents, this.liveAgents, this.error]) !== before;
  }
}
