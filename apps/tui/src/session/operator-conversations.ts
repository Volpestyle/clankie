import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  createOperatorConversationServiceClient,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationCursorSchema,
  OperatorConversationIdSchema,
  OperatorConversationServiceResultSchema,
  OperatorSurfaceClientIdSchema,
  type OperatorConversation,
  type OperatorConversationRecovery,
  type OperatorConversationScope,
  type OperatorConversationServiceClient,
  type OperatorConversationServiceDispatch,
  type OperatorConversationStreamEvent,
} from "@clankie/protocol";
import { Client } from "eve/client";

/**
 * The TUI's operator conversation client is the shared public
 * {@link OperatorConversationServiceClient}, so the TUI, RN, and macOS all call
 * one identical contract. The TUI carries it over the captain's authenticated
 * route via `Client.fetch`; VUH-864 relays the same route to physical devices.
 */
export type OperatorConversationClient = OperatorConversationServiceClient;

/** Minimal authenticated fetch surface — satisfied by eve's `Client.fetch`. */
export interface CaptainRouteFetcher {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/**
 * Connects the TUI to the captain route with the same optional bearer used by
 * the captain server. An absent or blank token preserves local-dev loopback
 * authentication; a configured token is attached by eve's Client to every
 * route request.
 */
export function createProductionOperatorConversationClient(input: {
  readonly host: string;
  readonly captainToken?: string;
}): OperatorConversationClient {
  const captainToken = input.captainToken?.trim();
  return createCaptainOperatorConversationClient(
    new Client({
      host: input.host,
      redirect: "error",
      ...(captainToken === undefined || captainToken.length === 0 ? {} : { auth: { bearer: captainToken } }),
    }),
  );
}

/**
 * Builds a production client that reaches the captain-owned registry through the
 * authenticated dispatch route. This is a real cross-process consumer of the
 * server registry — not an env-only illusion.
 */
export function createCaptainOperatorConversationClient(
  fetcher: CaptainRouteFetcher,
): OperatorConversationClient {
  const dispatch: OperatorConversationServiceDispatch = async (request) => {
    const response = await fetcher.fetch(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(`Operator conversation dispatch failed with status ${response.status}`);
    }
    try {
      return OperatorConversationServiceResultSchema.parse(await response.json());
    } catch (error) {
      throw new OperatorConversationClientError(
        "Captain conversation response failed schema validation",
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

  public async conversations(): Promise<readonly OperatorConversation[]> {
    return await this.client.list();
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

/** A corrupt or unreadable selection store — never silently ignored. */
export class OperatorConversationSelectionStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OperatorConversationSelectionStoreError";
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Persists the selected conversation so a surface reloads the same captain
 * target across restart/reconnect. Fail-closed: only a missing file (ENOENT) is
 * "no selection"; a corrupt, wrong-version, or invalid-id store raises rather
 * than silently attaching the operator to the wrong conversation. Writes are
 * atomic (temp file + rename) with a private 0700 parent and 0600 file.
 */
export class OperatorConversationSelectionStore {
  private readonly path: string;

  public constructor(path: string) {
    this.path = path;
  }

  public async read(): Promise<string | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return undefined;
      throw new OperatorConversationSelectionStoreError(
        `Operator conversation selection is unreadable: ${isErrnoException(error) ? error.code : "error"}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OperatorConversationSelectionStoreError("Operator conversation selection is corrupt JSON");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      !OperatorConversationIdSchema.safeParse((parsed as { conversationId?: unknown }).conversationId).success
    ) {
      throw new OperatorConversationSelectionStoreError(
        "Operator conversation selection has an invalid schema, version, or id",
      );
    }
    return (parsed as { conversationId: string }).conversationId;
  }

  public async write(conversationId: string): Promise<void> {
    if (!OperatorConversationIdSchema.safeParse(conversationId).success) {
      throw new OperatorConversationSelectionStoreError(`Refusing to persist invalid conversation id`);
    }
    await ensurePrivateParent(this.path);
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, conversationId })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  public async clear(): Promise<void> {
    try {
      await rm(this.path);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

/**
 * Resolves the initial conversation for a surface, confirming every candidate
 * against the server before use so a stale or attacker-supplied id can never
 * attach. A direct `--chat` id overrides the persisted selection only after
 * `get()` confirms it; the confirmed choice is then persisted. Falls back to the
 * default global conversation.
 */
export async function resolveInitialConversation(input: {
  readonly client: OperatorConversationClient;
  readonly store: OperatorConversationSelectionStore;
  readonly directConversationId?: string;
}): Promise<OperatorConversation> {
  const selection = new OperatorConversationSelection(input.client);
  if (input.directConversationId !== undefined) {
    const confirmed = await selection.select(input.directConversationId);
    await input.store.write(confirmed.conversationId);
    return confirmed;
  }
  const persisted = await input.store.read();
  if (persisted !== undefined) {
    const found = await input.client.get(persisted);
    if (found !== undefined) {
      await selection.select(found.conversationId);
      return found;
    }
    // The persisted conversation no longer exists on the server; drop it.
    await input.store.clear();
  }
  return await selection.selectDefault();
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
 * server-owned log boundary rather than a process-global Eve session.
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
        throw new OperatorConversationSelectionStoreError(
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
      throw new OperatorConversationSelectionStoreError("Operator conversation tail state is corrupt JSON");
    }
    if (!isStoredTailState(parsed)) {
      throw new OperatorConversationSelectionStoreError(
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
      throw new OperatorConversationSelectionStoreError("Refusing to persist invalid tail state");
    }
    const current = this.requiredState();
    const cursors = current.cursors.filter((item) => item.conversationId !== conversationId);
    this.state = { ...current, cursors: [...cursors, { conversationId, cursor }] };
    await this.persist();
  }

  private requiredState(): StoredOperatorConversationTailState {
    if (this.state === undefined) {
      throw new OperatorConversationSelectionStoreError(
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
    throw new OperatorConversationSelectionStoreError(
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
}

/**
 * Production plain-prompt adapter. It snapshots the selected conversation for
 * each prompt, catches up that surface's durable cursor, sends with the current
 * revision fence, then consumes the typed tail until this accepted run reaches
 * a terminal lifecycle event. No direct/default Eve session exists in this
 * path, and aborting observation never cancels the already accepted turn.
 */
export class OperatorConversationPromptSession {
  private readonly client: OperatorConversationClient;
  private readonly selection: OperatorConversationSelection;
  private readonly tails: OperatorConversationTailStore;
  private readonly restores = new Map<string, Promise<boolean>>();

  public constructor(input: {
    readonly client: OperatorConversationClient;
    readonly selection: OperatorConversationSelection;
    readonly tails: OperatorConversationTailStore;
  }) {
    this.client = input.client;
    this.selection = input.selection;
    this.tails = input.tails;
  }

  public async initialize(): Promise<void> {
    await this.tails.initialize();
  }

  /** Replays only unread durable history, persisting every rendered boundary. */
  public async restore(sink: OperatorConversationEventSink): Promise<boolean> {
    const conversationId = this.requiredConversationId();
    return await this.restoreConversation(conversationId, sink);
  }

  private async restoreConversation(
    conversationId: string,
    sink: OperatorConversationEventSink,
  ): Promise<boolean> {
    const active = this.restores.get(conversationId);
    if (active !== undefined) return await active;
    const run = this.restoreConversationNow(conversationId, sink).finally(() => {
      this.restores.delete(conversationId);
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
        return false;
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
  ): Promise<void> {
    // Snapshot selection once. A concurrent /conversation switch affects only
    // the next prompt; it can never retarget an already submitted turn.
    const conversationId = this.requiredConversationId();
    if (!(await this.restoreConversation(conversationId, sink))) {
      throw new OperatorConversationClientError(
        "Conversation history requires an explicit recovery before sending",
      );
    }
    const conversation = await this.client.get(conversationId);
    if (conversation === undefined) {
      throw new OperatorConversationClientError("Selected operator conversation no longer exists");
    }
    const accepted = await this.client.send({
      schemaVersion: 1,
      kind: "message",
      conversationId,
      surfaceClientId: this.tails.surfaceClientId,
      expectedRevision: conversation.revision,
      message,
    });
    if (accepted.status === "revision_conflict") {
      throw new OperatorConversationClientError(
        `Conversation changed at revision ${accepted.currentRevision}; retry the prompt`,
      );
    }
    if (accepted.status === "unsupported") {
      throw new OperatorConversationClientError("Captain does not support ordinary conversation messages");
    }

    const cursor = this.tails.cursor(conversationId);
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
        return;
      }
      sink.event(item.event);
      await this.tails.writeCursor(conversationId, item.event.cursor);
      if (
        item.event.type === "turn" &&
        item.event.runId === accepted.runId &&
        ["completed", "failed", "cancelled"].includes(item.event.phase)
      ) {
        return;
      }
    }
  }

  private requiredConversationId(): string {
    const conversationId = this.selection.conversationId;
    if (conversationId === undefined) {
      throw new OperatorConversationClientError(
        "No operator conversation is selected; use /conversation to choose one",
      );
    }
    return conversationId;
  }
}
