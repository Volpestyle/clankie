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
 * Connects the TUI to the captain route with the same optional bearer the
 * clankie service authenticates. An absent or blank token preserves local-dev
 * loopback authentication; a configured token is attached to every request.
 */
export function createProductionOperatorConversationClient(input: {
  readonly host: string;
  readonly captainToken?: string;
}): OperatorConversationClient {
  return createCaptainOperatorConversationClient(createCaptainRouteClient(input));
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
): OperatorConversationClient {
  const dispatch: OperatorConversationServiceDispatch = async (request, signal) => {
    const response = await fetcher.fetch(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      // A parked tail is the one request that outlives the turn it observes;
      // an interrupt has to cancel it rather than wait out the server's window.
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      if (request.op === "reset" && response.status === 409) {
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
      return OperatorConversationServiceResultSchema.parse(await response.json());
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
        ? "Delivery unconfirmed. Check the conversation before retrying; Clankie may have received this message."
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

  /**
   * The console switcher is his own session list, the way `/resume` is. Persona,
   * seat, and channel conversations belong to a counterpart who is not him
   * (ADR 0135) — the roster reads those, and `--chat <id>` still opens one
   * deliberately.
   */
  public async conversations(): Promise<readonly OperatorConversation[]> {
    return (await this.client.list()).filter(
      (conversation) => conversation.scope.kind === "global" || conversation.scope.kind === "workspace",
    );
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
  const index = args.indexOf("--chat");
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

export interface OperatorConversationEventSink {
  event(event: OperatorConversationStreamEvent): void;
  recovery(recovery: OperatorConversationRecovery): void;
  /**
   * The message being typed changed, or `undefined` once it settles into a
   * durable `message` event. Volatile: nothing here is ever replayed.
   */
  live(draft: OperatorConversationLiveDraft | undefined): void;
}

interface ObservedPromptRuns {
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

  /** Replays only unread durable history, persisting every rendered boundary. */
  public async restore(sink: OperatorConversationEventSink): Promise<boolean> {
    const conversationId = this.requiredConversationId();
    return await this.restoreConversation(conversationId, sink);
  }

  /** Rebuilds an empty transcript from the conversation's retained beginning. */
  public async restoreHistory(sink: OperatorConversationEventSink): Promise<boolean> {
    const conversationId = this.requiredConversationId();
    return await this.restoreConversation(conversationId, sink, true);
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
    fromBeginning = false,
  ): Promise<boolean> {
    const active = this.restores.get(conversationId);
    if (active !== undefined) return await active;
    const run = this.restoreConversationNow(conversationId, sink, fromBeginning).finally(() => {
      this.restores.delete(conversationId);
    });
    this.restores.set(conversationId, run);
    return await run;
  }

  private async restoreConversationNow(
    conversationId: string,
    sink: OperatorConversationEventSink,
    fromBeginning: boolean,
  ): Promise<boolean> {
    let cursor = fromBeginning ? undefined : this.tails.cursor(conversationId);
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
        await this.tails.writeCursor(conversationId, event.cursor);
      }
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
    const active: ObservedPromptRuns = { conversationId, runIds: new Set(), admissions: Promise.resolve() };
    this.activeRun = active;
    try {
      await this.admit(active, message, delivery, sink);
      await this.observeTail(conversationId, sink, signal, active);
    } finally {
      if (this.activeRun === active) this.activeRun = undefined;
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
