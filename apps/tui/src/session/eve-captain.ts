import { Client, type HandleMessageStreamEvent, type SessionState } from "eve/client";
import type { ClankieFaceShell } from "../shell/shell.ts";
import { assertCaptainEndpoint, assertLoopbackCaptainHost } from "./captain-identity.ts";
import { EveFaceRenderer, formatTokenFlow } from "./eve-renderer.ts";
import {
  CaptainSessionCursorStore,
  emptyCaptainCursor,
  type CaptainSessionCursor,
} from "./session-cursor.ts";

export type CaptainConnectionState = "connecting" | "live" | "detached" | "unavailable" | "failed";

export interface EveCaptainOptions {
  readonly host: string;
  readonly cursorStore: CaptainSessionCursorStore;
  readonly client?: Client;
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
  private cursor: CaptainSessionCursor = emptyCaptainCursor();
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
  }

  public get connectionState(): CaptainConnectionState {
    return this.connection;
  }

  public get hasActiveTurn(): boolean {
    return this.cursor.active;
  }

  public get tokenStatus(): string {
    return formatTokenFlow(this.renderer?.lastUsage, this.contextWindowTokens);
  }

  public setContextWindowTokens(tokens: number | undefined): void {
    this.contextWindowTokens = tokens;
  }

  public async initialize(): Promise<void> {
    this.cursor = (await this.store.read()) ?? emptyCaptainCursor();
    try {
      assertCaptainEndpoint(await this.client.health(), await this.client.info());
      this.connection = "live";
    } catch {
      this.connection = "unavailable";
    }
  }

  public async attach(shell: ClankieFaceShell): Promise<void> {
    this.renderer ??= new EveFaceRenderer(shell);
    if (this.connection !== "live" || this.cursor.sessionId === undefined) return;
    this.renderer.resetSession();
    await this.consume(shell, 0, undefined, true);
  }

  public async prompt(prompt: string, shell: ClankieFaceShell, signal: AbortSignal): Promise<void> {
    this.renderer ??= new EveFaceRenderer(shell);
    if (this.connection !== "live") {
      try {
        assertCaptainEndpoint(await this.client.health(), await this.client.info());
        this.connection = "live";
      } catch {
        this.connection = "unavailable";
        throw new Error("Captain service is unavailable. Restart clankie or run the captain Eve service.");
      }
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
      version: 1,
      active: true,
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
    if (this.cursor.active) {
      throw new Error("The captain is still working. Wait for the active turn to settle before /new.");
    }
    this.generation += 1;
    this.cursor = emptyCaptainCursor();
    this.renderer?.resetSession();
    await this.store.clear();
  }

  private async consume(
    shell: ClankieFaceShell,
    startIndex: number,
    signal: AbortSignal | undefined,
    replay: boolean,
  ): Promise<void> {
    const sessionId = this.cursor.sessionId;
    if (sessionId === undefined) return;
    const generation = ++this.generation;
    const replayTarget = replay ? this.cursor.streamIndex : undefined;
    const replayedTurnWasActive = replay ? this.cursor.active : false;
    let nextIndex = startIndex;
    if (replay) this.renderer?.resetSession();
    try {
      const state: SessionState = {
        sessionId,
        streamIndex: startIndex,
        ...(this.cursor.continuationToken === undefined
          ? {}
          : { continuationToken: this.cursor.continuationToken }),
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
        this.cursor = reset
          ? emptyCaptainCursor()
          : {
              ...this.cursor,
              version: 1,
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
}
