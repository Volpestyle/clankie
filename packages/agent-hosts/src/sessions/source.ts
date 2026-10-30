// Session sources (ADR 0301): the apps that hold the owner's agent sessions,
// behind one seam. Herdr is the first; any app that can list its sessions,
// read one, message one and open one in its own window can be another. The
// Claude connector talks to this layer, never to a session app directly;
// Clankie and the phone move onto it next.

/** One agent session in a session app, as a person would pick it out. */
export interface Session {
  /** `<source>:<id within the source>`; pass it back unchanged. */
  readonly id: string;
  readonly source: string;
  readonly name?: string;
  readonly harness?: string;
  /** The machine it runs on, as the source names it. */
  readonly machine: string;
  readonly project?: string;
  readonly workingDirectory?: string;
  readonly status?: string;
  readonly title?: string;
  /** What it last said it's doing. */
  readonly doing?: string;
  readonly canMessage: boolean;
}

export interface SessionList {
  readonly sessions: readonly Session[];
  readonly machines: readonly string[];
}

export interface SessionText {
  readonly id: string;
  /** Plain text, newest lines last. */
  readonly text: string;
}

export interface SessionSendResult {
  readonly id: string;
  /**
   * `delivered`: the agent took it. `queued`: it waits until the agent's current
   * work ends. `offline` and `not_delivered`: nothing was sent. `unconfirmed`:
   * it may have arrived; read the session before sending it again.
   */
  readonly status: "delivered" | "queued" | "offline" | "not_delivered" | "unconfirmed";
  readonly detail: string;
}

export interface SessionOpenResult {
  readonly id: string;
  readonly status: "opened" | "unavailable";
  readonly detail: string;
}

/** What a session app answers. Ids here are the source's own, unqualified. */
export interface SessionSource {
  readonly id: string;
  list(): Promise<Omit<SessionList, "machines"> & { readonly machines?: readonly string[] }>;
  read(id: string, lines: number): Promise<SessionText>;
  send(id: string, message: string): Promise<SessionSendResult>;
  /** Bring the session to the front in its own app on its machine. */
  open(id: string): Promise<SessionOpenResult>;
}

/** A refusal worded for the person or model that asked. */
export class SessionRefusal extends Error {}

/** Every configured source behind one set of qualified ids. */
export class SessionSources {
  private readonly sources: ReadonlyMap<string, SessionSource>;

  public constructor(sources: readonly SessionSource[]) {
    this.sources = new Map(sources.map((source) => [source.id, source]));
  }

  /** Every source's sessions; a source that fails is left out rather than failing the list. */
  public async list(machine?: string): Promise<SessionList> {
    const listed = await Promise.all(
      [...this.sources.values()].map(async (source) => {
        try {
          return { source, list: await source.list() };
        } catch (error) {
          if (this.sources.size === 1) throw error;
          return undefined;
        }
      }),
    );
    const sessions = listed.flatMap((entry) =>
      entry === undefined
        ? []
        : entry.list.sessions.map((session) => ({
            ...session,
            id: `${entry.source.id}:${session.id}`,
            source: entry.source.id,
          })),
    );
    const machines = [
      ...new Set(
        listed.flatMap((entry) => entry?.list.machines ?? entry?.list.sessions.map((s) => s.machine) ?? []),
      ),
    ];
    return {
      sessions: machine === undefined ? sessions : sessions.filter((session) => session.machine === machine),
      machines,
    };
  }

  public async read(id: string, lines: number): Promise<SessionText> {
    const [source, native] = this.resolve(id);
    return { ...(await source.read(native, lines)), id };
  }

  public async send(id: string, message: string): Promise<SessionSendResult> {
    const [source, native] = this.resolve(id);
    return { ...(await source.send(native, message)), id };
  }

  public async open(id: string): Promise<SessionOpenResult> {
    const [source, native] = this.resolve(id);
    return { ...(await source.open(native)), id };
  }

  private resolve(id: string): [SessionSource, string] {
    const separator = id.indexOf(":");
    const source = separator > 0 ? this.sources.get(id.slice(0, separator)) : undefined;
    if (source === undefined || separator === id.length - 1)
      throw new SessionRefusal(
        "That isn't a session id from the list. List the sessions and use one of those ids.",
      );
    return [source, id.slice(separator + 1)];
  }
}
