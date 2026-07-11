import { Client, type HandleMessageStreamEvent, type SessionState } from "eve/client";
import type { ClankieFaceShell } from "../shell/shell.ts";
import {
  assertCaptainEndpoint,
  assertLoopbackCaptainHost,
  captainInfoGeneration,
} from "./captain-identity.ts";
import { EveFaceRenderer, formatTokenFlow } from "./eve-renderer.ts";
import {
  CaptainSessionCursorStore,
  emptyCaptainCursor,
  type StoredCaptainSessionCursor,
} from "./session-cursor.ts";

export type CaptainConnectionState = "connecting" | "live" | "detached" | "unavailable" | "failed";

export interface EveCaptainOptions {
  readonly host: string;
  readonly cursorStore: CaptainSessionCursorStore;
  readonly client?: Client;
  readonly generation?: string;
}

function isBoundary(event: HandleMessageStreamEvent): boolean {
  return (
    event.type === "session.waiting" || event.type === "session.completed" || event.type === "session.failed"
  );
}

function resetsSession(event: HandleMessageStreamEvent): boolean {
  return event.type === "session.failed";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/iu.test(error.message));
}

export class EveCaptainSession {
  private readonly client: Client;
  private readonly store: CaptainSessionCursorStore;
  private readonly configuredGeneration: string | undefined;
  private cursor: StoredCaptainSessionCursor | undefined;
  private serviceGeneration: string | undefined;
  private incompatibleGeneration = false;
  private generationReset = false;
  private renderer: EveFaceRenderer | undefined;
  private connection: CaptainConnectionState = "connecting";
  private generation = 0;
  private contextWindowTokens: number | undefined;

  public constructor(options: EveCaptainOptions) {
    assertLoopbackCaptainHost(options.host);
    this.client =
      options.client ??
      new Client({
        host: options.host,
        maxReconnectAttempts: 5,
        preserveCompletedSessions: true,
        redirect: "error",
      });
    this.store = options.cursorStore;
    this.configuredGeneration = options.generation;
  }

  public get connectionState(): CaptainConnectionState {
    return this.connection;
  }

  public get hasActiveTurn(): boolean {
    return this.cursor?.active ?? false;
  }

  public get startupNotice(): string | undefined {
    if (this.incompatibleGeneration) {
      return "The captain changed while the previous turn may still be active. Check mission state, then use /new to explicitly abandon that conversation before sending another prompt.";
    }
    if (this.generationReset) {
      return "The captain build changed, so Clankie started a fresh conversation. Mission state is unchanged.";
    }
    return undefined;
  }

  public get tokenStatus(): string {
    return formatTokenFlow(this.renderer?.lastUsage, this.contextWindowTokens);
  }

  public setContextWindowTokens(tokens: number | undefined): void {
    this.contextWindowTokens = tokens;
  }

  public async initialize(): Promise<void> {
    this.cursor = await this.store.read();
    try {
      await this.connect();
      this.connection = "live";
    } catch {
      this.connection = "unavailable";
    }
  }

  public async attach(shell: ClankieFaceShell): Promise<void> {
    this.renderer ??= new EveFaceRenderer(shell);
    if (this.connection !== "live" || this.incompatibleGeneration || this.cursor?.sessionId === undefined)
      return;
    this.renderer.resetSession();
    await this.consume(shell, 0, undefined, true);
  }

  public async prompt(prompt: string, shell: ClankieFaceShell, signal: AbortSignal): Promise<void> {
    this.renderer ??= new EveFaceRenderer(shell);
    if (this.connection !== "live") {
      try {
        await this.connect();
        this.connection = "live";
      } catch {
        this.connection = "unavailable";
        throw new Error("Captain service is unavailable. Restart clankie or run the captain Eve service.");
      }
    }
    if (this.incompatibleGeneration) {
      throw new Error(
        "The prior captain turn belongs to a different build and may have produced mission side effects. Check mission state, then use /new to explicitly abandon it.",
      );
    }
    if (this.cursor === undefined || this.serviceGeneration === undefined) {
      throw new Error("Captain runtime identity is unavailable; refusing to create an unversioned session.");
    }
    if (this.cursor.active) {
      shell.setTurnLoaderMessage("Reattaching to the active captain turn...");
      await this.consume(shell, this.cursor.streamIndex, signal, false);
      if (signal.aborted || this.cursor.active) return;
    }

    this.renderer.expectSubmittedPrompt(prompt);
    const previous = this.cursor;
    const session = this.client.session(previous);
    const response = await session.send({ message: prompt });
    this.cursor = {
      version: 2,
      active: true,
      generation: this.serviceGeneration,
      sessionId: response.sessionId,
      streamIndex: previous.sessionId === response.sessionId ? previous.streamIndex : 0,
      ...(response.continuationToken === undefined
        ? previous.continuationToken === undefined
          ? {}
          : { continuationToken: previous.continuationToken }
        : { continuationToken: response.continuationToken }),
    };
    await this.store.write(this.cursor);
    await this.consume(shell, this.cursor.streamIndex, signal, false);
  }

  public async newSession(): Promise<void> {
    if (this.cursor?.active && !this.incompatibleGeneration) {
      throw new Error("The captain is still working. Wait for the active turn to settle before /new.");
    }
    this.generation += 1;
    if (this.serviceGeneration === undefined) {
      throw new Error("Captain runtime identity is unavailable; cannot start a versioned session.");
    }
    this.cursor = emptyCaptainCursor(this.serviceGeneration);
    this.incompatibleGeneration = false;
    this.generationReset = false;
    this.renderer?.resetSession();
    await this.store.clear();
  }

  private async consume(
    shell: ClankieFaceShell,
    startIndex: number,
    signal: AbortSignal | undefined,
    replay: boolean,
  ): Promise<void> {
    const cursor = this.cursor;
    if (cursor === undefined || cursor.sessionId === undefined) return;
    const sessionId = cursor.sessionId;
    const generation = ++this.generation;
    const replayTarget = replay ? cursor.streamIndex : undefined;
    const replayedTurnWasActive = replay ? cursor.active : false;
    let nextIndex = startIndex;
    if (replay) this.renderer?.resetSession();
    try {
      const state: SessionState = {
        sessionId,
        streamIndex: startIndex,
        ...(cursor.continuationToken === undefined ? {} : { continuationToken: cursor.continuationToken }),
      };
      for await (const event of this.client
        .session(state)
        .stream({ startIndex, ...(signal === undefined ? {} : { signal }) })) {
        if (generation !== this.generation) return;
        nextIndex += 1;
        this.renderer?.render(event);
        const boundary = isBoundary(event);
        const reset = resetsSession(event);
        const historical = replayTarget !== undefined && nextIndex <= replayTarget;
        this.connection = "live";
        if (historical) {
          const replayComplete = nextIndex === replayTarget;
          shell.refreshStatus(replayComplete && !replayedTurnWasActive ? "ready" : "replaying");
          if (replayComplete && !replayedTurnWasActive) return;
          continue;
        }
        const current = this.cursor;
        if (current === undefined) {
          throw new Error("Captain session cursor disappeared while consuming its event stream");
        }
        this.cursor = reset
          ? emptyCaptainCursor(this.requireServiceGeneration())
          : {
              ...current,
              version: 2,
              generation: this.requireServiceGeneration(),
              active: boundary ? false : true,
              sessionId,
              streamIndex: nextIndex,
            };
        if (reset) await this.store.clear();
        else await this.store.write(this.cursor);
        shell.refreshStatus(boundary ? "ready" : "streaming");
        if (boundary) return;
      }
    } catch (error) {
      if (signal?.aborted || isAbort(error)) {
        this.connection = "detached";
        shell.refreshStatus("detached — captain continues");
        return;
      }
      this.connection = "failed";
      throw error;
    }
  }

  private requireServiceGeneration(): string {
    if (this.serviceGeneration === undefined) {
      throw new Error("Captain runtime identity is unavailable");
    }
    return this.serviceGeneration;
  }

  private async connect(): Promise<void> {
    const [health, info] = await Promise.all([this.client.health(), this.client.info()]);
    assertCaptainEndpoint(health, info);
    const generation = this.configuredGeneration ?? captainInfoGeneration(info);
    if (generation === undefined) {
      throw new Error("The captain endpoint did not expose enough identity to version its session cursor");
    }
    this.serviceGeneration = generation;
    const saved = this.cursor;
    if (saved === undefined) {
      this.cursor = emptyCaptainCursor(generation);
      return;
    }
    if (saved.version === 2 && saved.generation === generation) return;
    if (saved.active) {
      this.incompatibleGeneration = true;
      return;
    }
    this.cursor = emptyCaptainCursor(generation);
    this.generationReset = true;
    await this.store.clear();
  }
}
