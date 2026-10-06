import type {
  OperatorConversationServiceClient,
  OperatorFleetSeat,
  OperatorAgentPersona,
  WorkerReportSummary,
  OperatorConversation,
  FleetResourceSnapshot,
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
  readonly resources?: FleetResourceSnapshot;
  readonly liveAgents?: readonly LiveAgent[];
  readonly workerReports?: readonly WorkerReportSummary[];
  readonly roomHandoffs?: readonly OperatorConversation[];
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
  private workerReports: readonly WorkerReportSummary[] = [];
  private roomHandoffs: readonly OperatorConversation[] = [];
  private resources: FleetResourceSnapshot | undefined;
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
      ...(this.resources === undefined ? {} : { resources: this.resources }),
      liveAgents: this.liveAgents,
      workerReports: this.workerReports,
      roomHandoffs: this.roomHandoffs,
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
          const changedResources =
            JSON.stringify(resourceDisplay(this.resources)) !==
            JSON.stringify(resourceDisplay(fleet.resources));
          this.resources = fleet.resources;
          const changedReports =
            JSON.stringify(this.workerReports) !== JSON.stringify(fleet.workerReports ?? []);
          this.workerReports = fleet.workerReports ?? [];
          if (
            (await this.apply(
              () => Promise.resolve(fleet.seats),
              fleet.personas,
              fleet.roomHandoffs ?? [],
            )) ||
            changedReports ||
            changedResources
          )
            onChange();
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
    roomHandoffs: readonly OperatorConversation[] = [],
  ): Promise<boolean> {
    if (this.polling) return false;
    this.polling = true;
    const before = JSON.stringify([this.agents, this.liveAgents, this.roomHandoffs, this.error]);
    try {
      const [seats, terminals] = await Promise.all([
        readSeats(),
        this.client.terminalCatalog?.().catch(() => []) ?? [],
      ]);
      const panes = new Map(terminals.map((terminal) => [terminal.terminalId, terminal.pane.id]));
      if (personas) this.personas = personas;
      this.roomHandoffs = roomHandoffs.filter((conversation) => conversation.roomHandoff !== undefined);
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
      this.roomHandoffs = [];
      this.error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      this.polling = false;
    }
    return JSON.stringify([this.agents, this.liveAgents, this.roomHandoffs, this.error]) !== before;
  }
}

/** Pressure values are sampled independently; repaint for admission or holder changes. */
function resourceDisplay(resources: FleetResourceSnapshot | undefined) {
  return resources === undefined
    ? undefined
    : {
        policy: resources.policy,
        capacity: resources.capacity,
        healthy: resources.pressure.healthy,
        reason: resources.pressure.reason,
        leases: resources.leases,
        queue: resources.queue,
      };
}
