import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createOperatorConversationServiceClient,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationIdSchema,
  OperatorConversationServiceResultSchema,
  type OperatorConversation,
  type OperatorConversationScope,
  type OperatorConversationServiceClient,
  type OperatorConversationServiceDispatch,
} from "@clankie/protocol";

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
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  return createOperatorConversationServiceClient(dispatch);
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
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
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
