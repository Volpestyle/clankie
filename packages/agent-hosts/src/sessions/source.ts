// Session sources (ADR 0301): the apps that hold the owner's agent sessions,
// behind one seam. Herdr is the first; any app that can list its sessions,
// read one, message one and open one in its own window can be another, and
// one that can answer the prompt open in a session says so with `answer`. The
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
  /**
   * Who started it, as Clankie records it (ADR 0321): "the owner", "Clankie",
   * a connected app's device name, or the agent that started it. Says who asked,
   * never who may act.
   */
  readonly startedBy?: string;
  readonly canMessage: boolean;
}

export interface SessionList {
  readonly sessions: readonly Session[];
  readonly machines: readonly string[];
  /** What a person should know about a machine, such as one not answering. */
  readonly notices?: readonly string[];
}

export interface SessionText {
  readonly id: string;
  /** Plain text, newest lines last. */
  readonly text: string;
  /** Why some of the screen was left out, when it was. */
  readonly note?: string;
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

/** An image sent with a message, as the agent's own workspace file (ADR 0315). */
export interface SessionImage {
  readonly filename: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly bytes: Uint8Array;
  /** Hex SHA-256 of the bytes; the upload is refused when they don't match. */
  readonly sha256: string;
}

/** One image read back from a session's own workspace. */
export interface SessionImageRead {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: SessionImage["mediaType"];
  readonly dataBase64: string;
}

export interface SessionOpenResult {
  readonly id: string;
  readonly status: "opened" | "unavailable";
  readonly detail: string;
}

/** One step at a prompt in a session: a named key, or one line of text typed as it is. */
export type SessionPromptStep =
  | { readonly key: "enter" | "esc" | "tab" | "up" | "down" | "left" | "right" | "space" | "backspace" }
  | { readonly text: string };

export interface SessionPromptAnswer {
  /** Text the caller saw on the prompt, such as the option it picks; it must still be showing. */
  readonly expect: string;
  readonly steps: readonly SessionPromptStep[];
}

/**
 * `answered`: the steps went in. `refused` and `unavailable`: nothing went in, and
 * `detail` says why. `uncertain`: part may have gone in; read the session first.
 */
export interface SessionAnswerResult {
  readonly id: string;
  readonly status: "answered" | "refused" | "unavailable" | "uncertain";
  readonly detail: string;
}

/** Where a new session may start: a known project's checkout on one machine. */
export interface SessionPlace {
  readonly machine: string;
  readonly project: string;
  readonly workingDirectory: string;
}

export interface SessionStartRequest {
  readonly machine?: string;
  readonly workingDirectory?: string;
  readonly harness?: "claude" | "codex";
  /** The first thing the new agent is asked. */
  readonly prompt?: string;
}

/**
 * `places`: nothing started; these are where one can. `started`: the new
 * session's id. `refused`: nothing started, and `detail` says why.
 */
export interface SessionStartResult {
  readonly status: "places" | "started" | "refused";
  readonly id?: string;
  readonly places: readonly SessionPlace[];
  readonly detail?: string;
}

/** What a session app answers. Ids here are the source's own, unqualified. */
export interface SessionSource {
  readonly id: string;
  list(): Promise<Omit<SessionList, "machines"> & { readonly machines?: readonly string[] }>;
  read(id: string, lines: number): Promise<SessionText>;
  send(id: string, message: string, images?: readonly SessionImage[]): Promise<SessionSendResult>;
  /** Read one image file the session saved in its workspace; a source that can't leaves this out. */
  image?(id: string, path: string): Promise<SessionImageRead>;
  /** Bring the session to the front in its own app on its machine. */
  open(id: string): Promise<SessionOpenResult>;
  /** Start a new session in a known place; a source that can't start any leaves this out. */
  start?(request: SessionStartRequest): Promise<SessionStartResult>;
  /** Answer the prompt open in a session (a menu, a permission prompt); a source that can't leaves this out. */
  answer?(id: string, answer: SessionPromptAnswer): Promise<SessionAnswerResult>;
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
    const notices = listed.flatMap((entry) => entry?.list.notices ?? []);
    return {
      sessions: machine === undefined ? sessions : sessions.filter((session) => session.machine === machine),
      machines,
      ...(notices.length === 0 ? {} : { notices }),
    };
  }

  public async read(id: string, lines: number): Promise<SessionText> {
    const [source, native] = this.resolve(id);
    return { ...(await source.read(native, lines)), id };
  }

  public async send(
    id: string,
    message: string,
    images?: readonly SessionImage[],
  ): Promise<SessionSendResult> {
    const [source, native] = this.resolve(id);
    return { ...(await source.send(native, message, images)), id };
  }

  public async image(id: string, path: string): Promise<SessionImageRead> {
    const [source, native] = this.resolve(id);
    if (source.image === undefined)
      throw new SessionRefusal("That session's app can't share images from here.");
    return { ...(await source.image(native, path)), id };
  }

  public async answer(id: string, answer: SessionPromptAnswer): Promise<SessionAnswerResult> {
    const [source, native] = this.resolve(id);
    if (source.answer === undefined)
      throw new SessionRefusal("That session's app can't answer prompts from here.");
    return { ...(await source.answer(native, answer)), id };
  }

  public async open(id: string): Promise<SessionOpenResult> {
    const [source, native] = this.resolve(id);
    return { ...(await source.open(native)), id };
  }

  /** Start a session through the named source, or the first that can start one. */
  public async start(request: SessionStartRequest, sourceId?: string): Promise<SessionStartResult> {
    const source =
      sourceId === undefined
        ? [...this.sources.values()].find((candidate) => candidate.start !== undefined)
        : this.sources.get(sourceId);
    if (source?.start === undefined) throw new SessionRefusal("No connected session app can start agents.");
    const started = await source.start(request);
    return started.id === undefined ? started : { ...started, id: `${source.id}:${started.id}` };
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
