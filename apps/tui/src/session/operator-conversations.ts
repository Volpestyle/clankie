import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveCaptainCredential, type CaptainCredentialOptions } from "@clankie/credential-broker";
import {
  createOperatorConversationServiceClient,
  HERDR_SOCKET_HEADER,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationCursorSchema,
  OperatorConversationIdSchema,
  OperatorConversationServiceResultSchema,
  OperatorSurfaceClientIdSchema,
  operatorAutonomyCommandRequiresOwner,
  parseProtocolResponse,
  type OperatorConversation,
  type OperatorConversationLiveDraft,
  type OperatorConversationRecovery,
  type OperatorConversationScope,
  type OperatorConversationServiceClient,
  type OperatorConversationServiceDispatch,
  type OperatorConversationStreamEvent,
  type SubmitOperatorConversationTurn,
} from "@clankie/protocol";

/**
 * The TUI's operator conversation client is the shared public
 * {@link OperatorConversationServiceClient}, so the TUI, RN, and macOS all call
 * one identical contract. The TUI carries it over the clankie service's
 * authenticated route; VUH-864 relays the same route to physical devices.
 */
export type OperatorConversationClient = OperatorConversationServiceClient;

/** Minimal authenticated fetch surface against the clankie service. */
export interface CaptainRouteFetcher {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/**
 * Resolves the bearer for the captain route the same way the launcher
 * provisions the captain's half: an explicit `CLANKIE_CAPTAIN_TOKEN` wins,
 * otherwise the brokered credential store supplies the shared secret. This is
 * what lets a shell-launched face authenticate against a launcher-started
 * captain with no exports. Resolution failure degrades to the token-less
 * loopback client rather than killing the console; a captain that does require
 * the bearer then answers 401, which surfaces in the conversation notice.
 */
export async function resolveCaptainRouteToken(
  options: CaptainCredentialOptions = {},
): Promise<string | undefined> {
  try {
    return (await resolveCaptainCredential(options))?.token;
  } catch {
    return undefined;
  }
}

/**
 * One authenticated fetcher for every console-side captain route — the
 * conversation dispatch and the lane listing both ride it. Plain `fetch`
 * against the single clankie service; no client library in between.
 */
export function createCaptainRouteClient(input: {
  readonly host: string;
  readonly captainToken?: string;
  readonly fetchImpl?: typeof fetch;
  readonly herdrSocketPath?: string;
}): CaptainRouteFetcher {
  const captainToken = input.captainToken?.trim();
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    fetch: (path, init) => {
      const headers = new Headers(init?.headers);
      if (input.herdrSocketPath) headers.set(HERDR_SOCKET_HEADER, input.herdrSocketPath);
      if (captainToken !== undefined && captainToken.length > 0) {
        headers.set("authorization", `Bearer ${captainToken}`);
      }
      return fetchImpl(new URL(path, input.host), { redirect: "error", ...init, headers });
    },
  };
}

/**
 * Builds a production client that reaches the captain-owned registry through the
 * authenticated dispatch route. This is a real cross-process consumer of the
 * server registry — not an env-only illusion.
 */
export function createCaptainOperatorConversationClient(
  fetcher: CaptainRouteFetcher,
  ownerFetcher?: CaptainRouteFetcher,
): OperatorConversationClient {
  const dispatch: OperatorConversationServiceDispatch = async (request, signal) => {
    const ownerError =
      request.op === "acknowledge_worker_report_history"
        ? "Owner authentication required to acknowledge report history."
        : "Owner authentication required to start, accept, resume, or enable autonomous goals.";
    const ownerRequired =
      request.op === "acknowledge_worker_report_history" ||
      (request.op === "autonomy" && operatorAutonomyCommandRequiresOwner(request.command));
    if (ownerRequired && ownerFetcher === undefined) {
      throw new OperatorConversationClientError(ownerError);
    }
    const transport =
      ownerFetcher &&
      (ownerRequired || ["send", "input_get", "input_answer", "input_cancel"].includes(request.op))
        ? ownerFetcher
        : fetcher;
    const response = await transport.fetch(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      // A parked tail is the one request that outlives the turn it observes;
      // an interrupt has to cancel it rather than wait out the server's window.
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      if (ownerRequired && response.status === 403) {
        throw new OperatorConversationClientError(ownerError);
      }
      if (response.status === 409) {
        const body: unknown = await response.json();
        if (
          typeof body === "object" &&
          body !== null &&
          "message" in body &&
          typeof body.message === "string"
        )
          throw new Error(body.message);
      }
      throw new Error(`Operator conversation dispatch failed with status ${response.status}`);
    }
    try {
      return parseProtocolResponse(OperatorConversationServiceResultSchema, await response.json());
    } catch (error) {
      throw new OperatorConversationClientError(
        "Clankie conversation response failed schema validation",
        error,
      );
    }
  };
  return createOperatorConversationServiceClient(dispatch);
}

/** A display-safe client error whose message never contains a response body. */
export class OperatorConversationClientError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "OperatorConversationClientError";
  }
}

/** Failed admission, distinct from an error observing an already accepted turn. */
export class OperatorConversationSendError extends OperatorConversationClientError {
  public readonly delivery: "not_sent" | "unconfirmed";

  public constructor(delivery: "not_sent" | "unconfirmed", cause: unknown) {
    super(
      delivery === "unconfirmed"
        ? `Delivery unconfirmed. Check the conversation before retrying; the message may have been received.${cause instanceof Error ? ` ${cause.message}` : ""}`
        : `Message not sent. ${cause instanceof TypeError ? "Clankie is unreachable. Retry when it reconnects." : cause instanceof Error ? cause.message : "Retry when the connection is ready."}`,
      cause,
    );
    this.delivery = delivery;
    this.name = "OperatorConversationSendError";
  }
}

export class OperatorConversationSelection {
  private readonly client: OperatorConversationClient;
  private selectedId: string | undefined;

  public constructor(client: OperatorConversationClient, initialConversationId?: string) {
    this.client = client;
    this.selectedId = initialConversationId;
  }

  public get conversationId(): string | undefined {
    return this.selectedId;
  }

  /** Every retained conversation is inspectable through the same switcher. */
  public async conversations(): Promise<readonly OperatorConversation[]> {
    return this.client.list();
  }

  public async select(conversationId: string): Promise<OperatorConversation> {
    const conversation = await this.client.get(conversationId);
    if (conversation === undefined) throw new Error(`Unknown operator conversation ${conversationId}`);
    this.selectedId = conversation.conversationId;
    return conversation;
  }

  public async selectDefault(): Promise<OperatorConversation> {
    const defaults = (await this.client.list({ kind: "global" })).filter((item) => item.isDefault);
    if (defaults.length !== 1)
      throw new Error("Operator registry must expose exactly one default global conversation");
    this.selectedId = defaults[0]?.conversationId;
    return defaults[0] as OperatorConversation;
  }

  public async create(input: {
    readonly scope: OperatorConversationScope;
    readonly title: string;
  }): Promise<OperatorConversation> {
    const conversation = await this.client.create(input);
    this.selectedId = conversation.conversationId;
    return conversation;
  }
}

/** Corrupt or unreadable local replay state is never silently ignored. */
class OperatorConversationStateStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OperatorConversationStateStoreError";
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Abort can flip during an await; keep it opaque to TypeScript's loop narrowing. */
const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

/**
 * The newest retained conversation rooted at a workspace directory, used by
 * `/cd`. Process startup selects the default global conversation.
 */
export async function resolveWorkspaceConversation(input: {
  readonly client: OperatorConversationClient;
  readonly workspace: string;
  readonly title?: string;
}): Promise<OperatorConversation> {
  const scope = { kind: "workspace", workspaceId: input.workspace } as const;
  const existing = await input.client.list(scope);
  const found = existing[0];
  if (found !== undefined) return found;
  return await input.client.create({
    scope,
    title: input.title ?? input.workspace.split("/").filter(Boolean).pop() ?? input.workspace,
  });
}

export function newConversationTitle(now = new Date()): string {
  return `New chat · ${now.toISOString().replace("T", " ")}`;
}

/** Startup resumes the default global room unless an explicit --chat selects another. */
export async function resolveInitialConversation(input: {
  readonly client: OperatorConversationClient;
  readonly directConversationId?: string;
}): Promise<OperatorConversation> {
  const selection = new OperatorConversationSelection(input.client);
  return input.directConversationId === undefined
    ? await selection.selectDefault()
    : await selection.select(input.directConversationId);
}

export function parseDirectConversation(args: readonly string[]): {
  readonly conversationId?: string;
  readonly remaining: readonly string[];
} {
  // A command after `--` owns its flags (for example `clankie heavy -- cmd --chat`).
  const separator = args.indexOf("--");
  const index = args.slice(0, separator < 0 ? args.length : separator).indexOf("--chat");
  if (index < 0) return { remaining: args };
  const conversationId = args[index + 1]?.trim();
  if (conversationId === undefined || conversationId.length === 0) {
    throw new Error("Usage: clankie --chat <conversationId>");
  }
  return {
    conversationId,
    remaining: [...args.slice(0, index), ...args.slice(index + 2)],
  };
}

interface StoredOperatorConversationTailState {
  readonly version: 1;
  readonly surfaceClientId: string;
  readonly cursors: readonly {
    readonly conversationId: string;
    readonly cursor: string;
  }[];
}

/**
 * Durable per-surface tail state. The stable surface id and one opaque cursor
 * per conversation make restart and conversation switching resume the exact
 * server-owned log boundary rather than any process-global session.
 */
export class OperatorConversationTailStore {
  private readonly path: string;
  private state: StoredOperatorConversationTailState | undefined;

  public constructor(path: string) {
    this.path = path;
  }

  public async initialize(): Promise<void> {
    if (this.state !== undefined) return;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw new OperatorConversationStateStoreError(
          `Operator conversation tail state is unreadable: ${isErrnoException(error) ? error.code : "error"}`,
        );
      }
      this.state = {
        version: 1,
        surfaceClientId: `tui-${randomUUID()}`,
        cursors: [],
      };
      await this.persist();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OperatorConversationStateStoreError("Operator conversation tail state is corrupt JSON");
    }
    if (!isStoredTailState(parsed)) {
      throw new OperatorConversationStateStoreError(
        "Operator conversation tail state has an invalid schema, version, id, or cursor",
      );
    }
    this.state = parsed;
  }

  public get surfaceClientId(): string {
    return this.requiredState().surfaceClientId;
  }

  public cursor(conversationId: string): string | undefined {
    return this.requiredState().cursors.find((item) => item.conversationId === conversationId)?.cursor;
  }

  public async writeCursor(conversationId: string, cursor: string): Promise<void> {
    if (
      !OperatorConversationIdSchema.safeParse(conversationId).success ||
      !OperatorConversationCursorSchema.safeParse(cursor).success
    ) {
      throw new OperatorConversationStateStoreError("Refusing to persist invalid tail state");
    }
    const current = this.requiredState();
    const cursors = current.cursors.filter((item) => item.conversationId !== conversationId).slice(-255);
    this.state = { ...current, cursors: [...cursors, { conversationId, cursor }] };
    await this.persist();
  }

  private requiredState(): StoredOperatorConversationTailState {
    if (this.state === undefined) {
      throw new OperatorConversationStateStoreError(
        "Operator conversation tail store must be initialized before use",
      );
    }
    return this.state;
  }

  private async persist(): Promise<void> {
    const state = this.requiredState();
    await ensurePrivateParent(this.path);
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

async function ensurePrivateParent(path: string): Promise<void> {
  const parent = dirname(path);
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
  } catch (error) {
    throw new OperatorConversationStateStoreError(
      `Operator conversation state parent cannot be secured: ${isErrnoException(error) ? error.code : "error"}`,
    );
  }
}

function isStoredTailState(input: unknown): input is StoredOperatorConversationTailState {
  if (typeof input !== "object" || input === null) return false;
  const value = input as Partial<StoredOperatorConversationTailState>;
  if (
    value.version !== 1 ||
    !OperatorSurfaceClientIdSchema.safeParse(value.surfaceClientId).success ||
    !Array.isArray(value.cursors) ||
    value.cursors.length > 256
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const item of value.cursors) {
    if (
      typeof item !== "object" ||
      item === null ||
      !OperatorConversationIdSchema.safeParse(item.conversationId).success ||
      !OperatorConversationCursorSchema.safeParse(item.cursor).success ||
      ids.has(item.conversationId)
    ) {
      return false;
    }
    ids.add(item.conversationId);
  }
  return true;
}

export interface PendingOperatorPrompt {
  readonly message: string;
  readonly delivery: "steer" | "queue";
}

export interface OperatorConversationEventSink {
  /** Commit a history page synchronously, separately from the live tail. */
  history?(events: readonly OperatorConversationStreamEvent[], position: "replace" | "prepend"): void;
  pending?(prompts: readonly PendingOperatorPrompt[]): void;
  event(event: OperatorConversationStreamEvent): void;
  recovery(recovery: OperatorConversationRecovery): void;
  /** A history restore showed only the newest turns; older ones remain retained. */
  olderHistory?(): void;
  /**
   * The message being typed changed, or `undefined` once it settles into a
   * durable `message` event. Volatile: nothing here is ever replayed.
   */
  live(draft: OperatorConversationLiveDraft | undefined): void;
}

/** Turns a freshly opened conversation shows before its live tail. */
const RECENT_HISTORY_TURNS = 20;

interface ObservedPromptRuns {
  readonly sink: OperatorConversationEventSink;
  readonly pending: Map<string, PendingOperatorPrompt>;
  readonly conversationId: string;
  readonly runIds: Set<string>;
  admissions: Promise<void>;
}

/**
 * Production prompt and observation adapter. One cursor follows the selected
 * conversation both while idle and while submitted turns are active; the face
 * hands observation between those two modes so only one tail owns it at once.
 * Aborting observation never cancels an already accepted turn.
 */
export class OperatorConversationPromptSession {
  private readonly client: OperatorConversationClient;
  private readonly selection: OperatorConversationSelection;
  private readonly tails: OperatorConversationTailStore;
  private readonly herdrPaneId: () => string | undefined;
  private readonly restores = new Map<string, Promise<boolean>>();
  private readonly history = new Map<
    string,
    {
      before: string;
      hasOlder: boolean;
      loading?: Promise<void>;
    }
  >();
  /** One tail observes the original turn and every input admitted alongside it. */
  private activeRun: ObservedPromptRuns | undefined;

  public constructor(input: {
    readonly client: OperatorConversationClient;
    readonly selection: OperatorConversationSelection;
    readonly tails: OperatorConversationTailStore;
    /** When the console is a herdr pane, that pane is Clankie's seat this turn. */
    readonly herdrPaneId?: () => string | undefined;
  }) {
    this.client = input.client;
    this.selection = input.selection;
    this.tails = input.tails;
    this.herdrPaneId = input.herdrPaneId ?? (() => undefined);
  }

  public async initialize(): Promise<void> {
    await this.tails.initialize();
  }

  /** Replays unread durable history, persisting each rendered page boundary. */
  public async restore(sink: OperatorConversationEventSink): Promise<boolean> {
    const conversationId = this.requiredConversationId();
    return await this.restoreConversation(conversationId, sink);
  }

  /** Open at the latest retained window, then tail precisely after that snapshot. */
  public async restoreHistory(sink: OperatorConversationEventSink): Promise<boolean> {
    const conversationId = this.requiredConversationId();
    const active = this.restores.get(conversationId);
    const run = Promise.resolve(active)
      .then(() => this.restoreLatest(conversationId, sink))
      .finally(() => {
        if (this.restores.get(conversationId) === run) this.restores.delete(conversationId);
      });
    this.restores.set(conversationId, run);
    return await run;
  }

  private async restoreLatest(conversationId: string, sink: OperatorConversationEventSink): Promise<boolean> {
    const page = await this.client.replay({
      schemaVersion: 1,
      conversationId,
      surfaceClientId: this.tails.surfaceClientId,
      direction: "backward",
      turnLimit: RECENT_HISTORY_TURNS,
      limit: 500,
    });
    if (page.status === "recover") {
      sink.recovery(page);
      return false;
    }
    if (this.selection.conversationId !== conversationId) return false;
    if (sink.history) sink.history(page.events, "replace");
    else for (const event of page.events) sink.event(event);
    sink.live(page.live);
    this.history.set(conversationId, {
      before: page.previousCursor ?? page.events[0]?.cursor ?? page.retainedFromCursor,
      hasOlder: page.hasOlder ?? false,
    });
    // Never use safeCursor here: a forward-compatible host can expose events
    // beyond the returned window. Only the rendered boundary belongs to us.
    await this.tails.writeCursor(conversationId, page.nextCursor);
    return true;
  }

  /** Older pages never move the forward cursor or replay a stale live draft. */
  public async loadOlderHistory(sink: OperatorConversationEventSink): Promise<void> {
    const conversationId = this.requiredConversationId();
    const history = this.history.get(conversationId);
    if (history === undefined || !history.hasOlder) return;
    if (history.loading) return await history.loading;
    history.loading = (async () => {
      const page = await this.client.replay({
        schemaVersion: 1,
        conversationId,
        surfaceClientId: this.tails.surfaceClientId,
        direction: "backward",
        cursor: history.before,
        turnLimit: RECENT_HISTORY_TURNS,
        limit: 500,
      });
      if (this.selection.conversationId !== conversationId || this.history.get(conversationId) !== history)
        return;
      if (page.status === "recover") {
        history.hasOlder = false;
        sink.recovery(page);
        return;
      }
      if (sink.history) sink.history(page.events, "prepend");
      else for (const event of page.events) sink.event(event);
      history.before = page.previousCursor ?? page.events[0]?.cursor ?? page.retainedFromCursor;
      history.hasOlder = page.hasOlder ?? false;
    })().finally(() => {
      delete history.loading;
    });
    await history.loading;
  }

  /** Keep the selected conversation live while the console is otherwise idle. */
  public async observe(sink: OperatorConversationEventSink, signal?: AbortSignal): Promise<void> {
    const conversationId = this.requiredConversationId();
    if (!(await this.restoreConversation(conversationId, sink))) return;
    await this.observeTail(conversationId, sink, signal);
  }

  private async restoreConversation(
    conversationId: string,
    sink: OperatorConversationEventSink,
  ): Promise<boolean> {
    const active = this.restores.get(conversationId);
    if (active !== undefined) return await active;
    const run = this.restoreConversationNow(conversationId, sink).finally(() => {
      if (this.restores.get(conversationId) === run) this.restores.delete(conversationId);
    });
    this.restores.set(conversationId, run);
    return await run;
  }

  private async restoreConversationNow(
    conversationId: string,
    sink: OperatorConversationEventSink,
  ): Promise<boolean> {
    let cursor = this.tails.cursor(conversationId);
    for (;;) {
      const page = await this.client.replay({
        schemaVersion: 1,
        conversationId,
        surfaceClientId: this.tails.surfaceClientId,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      });
      if (page.status === "recover") {
        sink.recovery(page);
        if (!page.recoverable) return false;
        cursor = page.resetCursor;
        await this.tails.writeCursor(conversationId, cursor);
        continue;
      }
      for (const event of page.events) {
        sink.event(event);
        cursor = event.cursor;
      }
      // One durable write per page: a crash re-renders at most this page.
      if (cursor !== undefined && page.events.length > 0)
        await this.tails.writeCursor(conversationId, cursor);
      if (!page.hasMore) return true;
      cursor = page.nextCursor;
    }
  }

  public async prompt(
    message: string,
    sink: OperatorConversationEventSink,
    signal?: AbortSignal,
    delivery: SubmitOperatorConversationTurn["delivery"] = "steer",
  ): Promise<void> {
    // Snapshot selection once. A concurrent /conversation switch affects only
    // the next prompt; it can never retarget an already submitted turn.
    const conversationId = this.requiredConversationId();
    const active: ObservedPromptRuns = {
      conversationId,
      runIds: new Set(),
      admissions: Promise.resolve(),
      sink,
      pending: new Map(),
    };
    this.activeRun = active;
    try {
      await this.admit(active, message, delivery, sink);
      await this.observeTail(conversationId, sink, signal, active);
    } finally {
      if (this.activeRun === active) this.activeRun = undefined;
      sink.pending?.([]);
    }
  }

  /** Admission only: the original prompt keeps the single tail and interrupt target. */
  public async submit(message: string, delivery: "steer" | "queue"): Promise<void> {
    const active = this.activeRun;
    if (active === undefined)
      throw new OperatorConversationClientError("No prompt is being observed; send a new prompt");
    await this.admit(active, message, delivery);
  }

  private admit(
    active: ObservedPromptRuns,
    message: string,
    delivery: SubmitOperatorConversationTurn["delivery"],
    sink?: OperatorConversationEventSink,
  ): Promise<void> {
    // Serialize revision reads and sends, including inputs typed during startup.
    const admission = active.admissions
      .then(async () => {
        if (this.activeRun !== active)
          throw new OperatorConversationClientError("The observed prompt ended; send a new prompt");
        if (sink !== undefined && !(await this.restoreConversation(active.conversationId, sink))) {
          throw new OperatorConversationClientError(
            "Conversation history requires an explicit recovery before sending",
          );
        }
        const runId = await this.send(active.conversationId, message, delivery);
        active.runIds.add(runId);
        if (sink === undefined) {
          active.pending.set(runId, { message, delivery: delivery ?? "steer" });
          active.sink.pending?.([...active.pending.values()]);
        }
      })
      .catch((error: unknown) => {
        throw error instanceof OperatorConversationSendError
          ? error
          : new OperatorConversationSendError("not_sent", error);
      });
    active.admissions = admission.catch(() => undefined);
    return admission;
  }

  private async send(
    conversationId: string,
    message: string,
    delivery: SubmitOperatorConversationTurn["delivery"],
  ): Promise<string> {
    const conversation = await this.client.get(conversationId);
    if (conversation === undefined) {
      throw new OperatorConversationClientError("Selected operator conversation no longer exists");
    }
    if (conversation.scope.kind === "room")
      throw new OperatorConversationClientError("Read-only Discord history. Send messages in Discord.");
    const herdrPaneId = this.herdrPaneId();
    const accepted = await this.client
      .send({
        schemaVersion: 1,
        kind: "message",
        conversationId,
        surfaceClientId: this.tails.surfaceClientId,
        expectedRevision: conversation.revision,
        message,
        ...(delivery === undefined ? {} : { delivery }),
        ...(herdrPaneId === undefined ? {} : { herdrPaneId }),
      })
      .catch((error: unknown) => {
        // The request may have committed before its acknowledgement was lost.
        throw new OperatorConversationSendError("unconfirmed", error);
      });
    if (accepted.status === "revision_conflict") {
      throw new OperatorConversationClientError("This conversation changed elsewhere; retry the prompt");
    }
    if (accepted.status === "seat_offline") {
      throw new OperatorConversationClientError("That agent is offline; retry when its pane is live");
    }
    if (accepted.status === "seat_delivery_unconfirmed") {
      throw new OperatorConversationSendError("unconfirmed", new Error(accepted.detail));
    }
    if (accepted.status === "seat_undelivered") {
      throw new OperatorConversationSendError("not_sent", new Error(accepted.detail));
    }
    return accepted.runId;
  }

  /**
   * Interrupt the run this console is currently observing: the service aborts
   * the live model turn and the tail settles on its `cancelled` event. False
   * when no run is active or the service could not cancel it (already settled,
   * or an older service without the cancel op) — the caller falls back to
   * detaching its observation.
   */
  public async interruptActive(): Promise<boolean> {
    const active = this.activeRun;
    if (active === undefined) return false;
    await active.admissions;
    const runId = active.runIds.values().next().value;
    if (runId === undefined) return false;
    try {
      return await this.client.cancel(active.conversationId, runId);
    } catch {
      return false;
    }
  }

  private async observeTail(
    conversationId: string,
    sink: OperatorConversationEventSink,
    signal?: AbortSignal,
    active?: ObservedPromptRuns,
  ): Promise<void> {
    tail: while (!isAborted(signal)) {
      const cursor = this.tails.cursor(conversationId);
      try {
        for await (const item of this.client.tail(
          {
            schemaVersion: 1,
            conversationId,
            surfaceClientId: this.tails.surfaceClientId,
            ...(cursor === undefined ? {} : { cursor }),
            limit: 100,
          },
          signal,
        )) {
          if (item.kind === "recovery") {
            sink.recovery(item.recovery);
            if (!item.recovery.recoverable) return;
            await this.tails.writeCursor(conversationId, item.recovery.resetCursor);
            continue tail;
          }
          if (item.kind === "live") {
            // A draft carries no cursor: it is a view of an unfinished message,
            // so it never moves this surface's durable position.
            sink.live(item.draft);
            continue;
          }
          sink.event(item.event);
          await this.tails.writeCursor(conversationId, item.event.cursor);
          if (
            active !== undefined &&
            item.event.type === "turn" &&
            ["completed", "failed", "cancelled"].includes(item.event.phase)
          ) {
            // A receipt can race this event; finish in-flight admissions before
            // deciding whether the whole group has settled.
            let admissions: Promise<void>;
            do {
              admissions = active.admissions;
              await admissions;
            } while (admissions !== active.admissions);
            active.runIds.delete(item.event.runId);
            active.pending.delete(item.event.runId);
            active.sink.pending?.([...active.pending.values()]);
            if (active.runIds.size === 0) return;
          }
        }
        return;
      } catch (error) {
        if (isAborted(signal)) return;
        // Fetch uses TypeError for a dropped connection. Re-open only the
        // idempotent durable tail; send and schema/HTTP failures stay terminal.
        if (!(error instanceof TypeError)) throw error;
        await sleep(250, undefined, signal === undefined ? undefined : { signal });
      }
    }
  }

  private requiredConversationId(): string {
    const conversationId = this.selection.conversationId;
    if (conversationId === undefined) {
      throw new OperatorConversationClientError(
        "No conversation is selected; use /conversation to choose one",
      );
    }
    return conversationId;
  }
}
