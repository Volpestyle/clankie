import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OperatorConversation,
  OperatorConversationRecovery,
  OperatorConversationStreamEvent,
} from "@clankie/protocol";
import {
  createCaptainOperatorConversationClient,
  OperatorConversationClientError,
  OperatorConversationPromptSession,
  OperatorConversationSelection,
  OperatorConversationSelectionStore,
  OperatorConversationSelectionStoreError,
  OperatorConversationTailStore,
  parseDirectConversation,
  resolveInitialConversation,
  type OperatorConversationEventSink,
  type OperatorConversationClient,
} from "../src/session/operator-conversations.ts";
import {
  renderOperatorConversationEvent,
  renderOperatorConversationRecovery,
} from "../src/session/operator-conversation-renderer.ts";

const DEFAULT: OperatorConversation = {
  schemaVersion: 1,
  conversationId: "global-default",
  scope: { kind: "global" },
  title: "Clankie",
  isDefault: true,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
  sessionState: "active",
  revision: 2,
};
const WORKSPACE: OperatorConversation = {
  ...DEFAULT,
  conversationId: "workspace-1",
  title: "Workspace",
  isDefault: false,
  scope: { kind: "workspace", workspaceId: "w1" },
};

function client(extra: OperatorConversation[] = []): OperatorConversationClient {
  const conversations = [DEFAULT, ...extra];
  return {
    list: async () => conversations,
    get: async (id) => conversations.find((conversation) => conversation.conversationId === id),
    create: async (input) => ({ ...DEFAULT, ...input, conversationId: "created", isDefault: false }),
    replay: async (input) => ({
      schemaVersion: 1,
      status: "page",
      conversationId: input.conversationId,
      surfaceClientId: input.surfaceClientId,
      events: [],
      retainedFromCursor: "event:0",
      nextCursor: input.cursor ?? "event:0",
      safeCursor: "event:0",
      hasMore: false,
    }),
    tail: async function* () {},
    send: async (input) => ({
      schemaVersion: 1,
      status: "accepted",
      conversationId: input.conversationId,
      runId: "run:test",
      revision: input.expectedRevision + 1,
      safeCursor: "event:1",
    }),
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempStore(): Promise<OperatorConversationSelectionStore> {
  const root = await mkdtemp(join(tmpdir(), "operator-selection-"));
  roots.push(root);
  return new OperatorConversationSelectionStore(join(root, "nested", "operator-conversation.json"));
}

async function tempTailStore(): Promise<{ store: OperatorConversationTailStore; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "operator-tail-"));
  roots.push(root);
  const path = join(root, "nested", "operator-conversation-tail.json");
  return { store: new OperatorConversationTailStore(path), path };
}

function streamEvent(
  conversationId: string,
  cursor: string,
  body:
    | { readonly type: "message"; readonly role: "captain"; readonly text: string; readonly streaming: false }
    | { readonly type: "turn"; readonly runId: string; readonly phase: "completed" },
): OperatorConversationStreamEvent {
  return {
    ...body,
    schemaVersion: 1,
    conversationId,
    cursor,
    revision: 3,
    occurredAt: "2026-07-12T00:00:00.000Z",
  };
}

function recordingSink(): {
  readonly sink: OperatorConversationEventSink;
  readonly events: OperatorConversationStreamEvent[];
  readonly recoveries: OperatorConversationRecovery[];
} {
  const events: OperatorConversationStreamEvent[] = [];
  const recoveries: OperatorConversationRecovery[] = [];
  return {
    events,
    recoveries,
    sink: {
      event: (event) => events.push(event),
      recovery: (recovery) => recoveries.push(recovery),
    },
  };
}

describe("TUI operator conversation selection", () => {
  it("enumerates and selects the server-owned default across restart", async () => {
    const first = new OperatorConversationSelection(client());
    expect((await first.selectDefault()).conversationId).toBe("global-default");
    const restarted = new OperatorConversationSelection(client(), first.conversationId);
    expect((await restarted.select(restarted.conversationId as string)).conversationId).toBe(
      "global-default",
    );
  });

  it("supports the stable direct --chat form without inventing a conversation", () => {
    expect(parseDirectConversation(["--chat", "workspace-chat"])).toEqual({
      conversationId: "workspace-chat",
      remaining: [],
    });
    expect(() => parseDirectConversation(["--chat"])).toThrow(/--chat <conversationId>/u);
  });

  it("persists and reloads the selected conversation atomically across restart", async () => {
    const store = await tempStore();
    expect(await store.read()).toBeUndefined(); // ENOENT -> no selection
    await store.write("workspace-1");
    expect(await store.read()).toBe("workspace-1");
    // A fresh process (new store instance, same path) reloads it.
    const reopened = new OperatorConversationSelectionStore((store as unknown as { path: string }).path);
    expect(await reopened.read()).toBe("workspace-1");
  });

  it("hardens an existing selection-store parent to mode 0700", async () => {
    const store = await tempStore();
    const path = (store as unknown as { path: string }).path;
    await store.write("global-default");
    await chmod(dirname(path), 0o755);
    await store.write("workspace-1");
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  it("fails closed on a corrupt or wrong-version selection store", async () => {
    const store = await tempStore();
    const path = (store as unknown as { path: string }).path;
    await store.write("global-default"); // creates the parent dir
    await writeFile(path, "{ not json", "utf8");
    await expect(store.read()).rejects.toBeInstanceOf(OperatorConversationSelectionStoreError);
    await writeFile(path, JSON.stringify({ version: 2, conversationId: "x" }), "utf8");
    await expect(store.read()).rejects.toBeInstanceOf(OperatorConversationSelectionStoreError);
    await store.write("bad".repeat(1)); // valid id write still works
    expect(await store.read()).toBe("bad");
  });

  it("confirms --chat and persisted selections against the server before attaching", async () => {
    const store = await tempStore();
    // --chat confirmed via get(), then persisted.
    const confirmed = await resolveInitialConversation({
      client: client([WORKSPACE]),
      store,
      directConversationId: "workspace-1",
    });
    expect(confirmed.conversationId).toBe("workspace-1");
    expect(await store.read()).toBe("workspace-1");
    // Restart: persisted selection reloads and is confirmed.
    const reloaded = await resolveInitialConversation({ client: client([WORKSPACE]), store });
    expect(reloaded.conversationId).toBe("workspace-1");
    // A --chat for an unknown id is rejected, never silently attached.
    await expect(
      resolveInitialConversation({ client: client([WORKSPACE]), store, directConversationId: "ghost" }),
    ).rejects.toThrow(/Unknown operator conversation/u);
    // A persisted id the server no longer knows is dropped, falling back to default.
    const stale = await resolveInitialConversation({ client: client(), store });
    expect(stale.conversationId).toBe("global-default");
    expect(await store.read()).toBeUndefined();
  });

  it("builds a production client over an authenticated Client.fetch transport", async () => {
    const captain = createCaptainOperatorConversationClient({
      fetch: async (path, init) => {
        expect(path).toBe("/operator/v1/dispatch");
        const request = JSON.parse(String(init?.body)) as { op: string };
        if (request.op === "list") {
          return new Response(JSON.stringify({ op: "list", schemaVersion: 1, conversations: [DEFAULT] }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ op: "get", schemaVersion: 1, conversation: DEFAULT }), {
          status: 200,
        });
      },
    });
    expect((await captain.list()).some((conversation) => conversation.isDefault)).toBe(true);
    expect((await captain.get("global-default"))?.conversationId).toBe("global-default");
  });

  it("fails schema-invalid transport responses closed without leaking their payload", async () => {
    const captain = createCaptainOperatorConversationClient({
      fetch: async () =>
        new Response(JSON.stringify({ secret: "sk-private-response", op: "list" }), { status: 200 }),
    });
    const error = await captain.list().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperatorConversationClientError);
    expect(String(error)).toContain("schema validation");
    expect(String(error)).not.toContain("sk-private-response");
  });
});

describe("TUI selected-conversation prompt path", () => {
  it("routes the next prompt to A, then the switched selection B, with no default-session fallback", async () => {
    const { store } = await tempTailStore();
    const selection = new OperatorConversationSelection(client([WORKSPACE]));
    await selection.select("global-default");
    const sends: string[] = [];
    const routed: OperatorConversationClient = {
      ...client([WORKSPACE]),
      send: async (turn) => {
        sends.push(turn.conversationId);
        return {
          schemaVersion: 1,
          status: "accepted",
          conversationId: turn.conversationId,
          runId: `run-${turn.conversationId}`,
          revision: turn.expectedRevision + 1,
          safeCursor: `${turn.conversationId}:accepted`,
        };
      },
      tail: async function* (request) {
        yield {
          kind: "event",
          event: streamEvent(request.conversationId, `${request.conversationId}:done`, {
            type: "turn",
            runId: `run-${request.conversationId}`,
            phase: "completed",
          }),
        };
      },
    };
    const session = new OperatorConversationPromptSession({ client: routed, selection, tails: store });
    await session.initialize();
    await session.prompt("to A", recordingSink().sink);
    await selection.select("workspace-1");
    await session.prompt("to B", recordingSink().sink);
    expect(sends).toEqual(["global-default", "workspace-1"]);
  });

  it("resumes the persisted selection and exact per-surface tail cursor after restart", async () => {
    const selectionStore = await tempStore();
    await selectionStore.write("workspace-1");
    const { store, path } = await tempTailStore();
    const firstSelection = new OperatorConversationSelection(client([WORKSPACE]));
    await firstSelection.select((await selectionStore.read()) as string);
    let run = 0;
    const tailStarts: Array<string | undefined> = [];
    const routed: OperatorConversationClient = {
      ...client([WORKSPACE]),
      send: async (turn) => ({
        schemaVersion: 1,
        status: "accepted",
        conversationId: turn.conversationId,
        runId: `run-${++run}`,
        revision: turn.expectedRevision + 1,
        safeCursor: `workspace-1:accepted-${run}`,
      }),
      tail: async function* (request) {
        tailStarts.push(request.cursor);
        yield {
          kind: "event",
          event: streamEvent("workspace-1", `workspace-1:done-${run}`, {
            type: "turn",
            runId: `run-${run}`,
            phase: "completed",
          }),
        };
      },
    };
    const first = new OperatorConversationPromptSession({
      client: routed,
      selection: firstSelection,
      tails: store,
    });
    await first.initialize();
    await first.prompt("one", recordingSink().sink);

    const restartedSelection = new OperatorConversationSelection(client([WORKSPACE]));
    await restartedSelection.select((await selectionStore.read()) as string);
    const reopened = new OperatorConversationPromptSession({
      client: routed,
      selection: restartedSelection,
      tails: new OperatorConversationTailStore(path),
    });
    await reopened.initialize();
    await reopened.prompt("two", recordingSink().sink);
    expect(restartedSelection.conversationId).toBe("workspace-1");
    expect(tailStarts).toEqual([undefined, "workspace-1:done-1"]);
  });

  it("receives the durable accepted acknowledgement before consuming execution events", async () => {
    const { store } = await tempTailStore();
    const selection = new OperatorConversationSelection(client());
    await selection.selectDefault();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const routed: OperatorConversationClient = {
      ...client(),
      send: async (turn) => {
        order.push("accepted");
        return {
          schemaVersion: 1,
          status: "accepted",
          conversationId: turn.conversationId,
          runId: "run-gated",
          revision: turn.expectedRevision + 1,
          safeCursor: "global-default:accepted",
        };
      },
      tail: async function* () {
        order.push("execution-tail");
        await gate;
        yield {
          kind: "event",
          event: streamEvent("global-default", "global-default:done", {
            type: "turn",
            runId: "run-gated",
            phase: "completed",
          }),
        };
      },
    };
    const session = new OperatorConversationPromptSession({ client: routed, selection, tails: store });
    await session.initialize();
    const prompt = session.prompt("hello", recordingSink().sink);
    await vi.waitFor(() => expect(order).toEqual(["accepted", "execution-tail"]));
    release();
    await prompt;
  });

  it("surfaces typed recovery exactly once and stops before sending or crossing the reset", async () => {
    const { store } = await tempTailStore();
    const selection = new OperatorConversationSelection(client());
    await selection.selectDefault();
    let sends = 0;
    const recovery: OperatorConversationRecovery = {
      schemaVersion: 1,
      status: "recover",
      conversationId: "global-default",
      code: "cursor_expired",
      recoverable: true,
      resetCursor: "global-default:reset",
      message: "server text must not be displayed",
    };
    const routed: OperatorConversationClient = {
      ...client(),
      replay: async () => recovery,
      send: async (turn) => {
        sends += 1;
        return await client().send(turn);
      },
    };
    const recorded = recordingSink();
    const session = new OperatorConversationPromptSession({ client: routed, selection, tails: store });
    await session.initialize();
    await expect(session.prompt("must not send", recorded.sink)).rejects.toThrow(/explicit recovery/u);
    expect(recorded.recoveries).toEqual([recovery]);
    expect(sends).toBe(0);
    expect(renderOperatorConversationRecovery(recovery)).toContain("cursor_expired");
    expect(renderOperatorConversationRecovery(recovery)).not.toContain(recovery.message);
  });

  it("renders every strict event variant without accepting a raw payload escape hatch", () => {
    const base = {
      schemaVersion: 1 as const,
      conversationId: "global-default",
      cursor: "global-default:event",
      revision: 1,
      occurredAt: "2026-07-12T00:00:00.000Z",
    };
    const events: OperatorConversationStreamEvent[] = [
      { ...base, type: "message", role: "captain", text: "hello", streaming: false },
      { ...base, type: "reasoning", text: "bounded thought", streaming: false },
      { ...base, type: "tool", toolCallId: "call", name: "tracker", phase: "started" },
      {
        ...base,
        type: "input_requested",
        requestId: "req",
        prompt: "Choose",
        inputKind: "choice",
        options: ["A"],
      },
      { ...base, type: "input_resolved", requestId: "req", outcome: "submitted" },
      { ...base, type: "auth", phase: "required", summary: "GitHub" },
      { ...base, type: "session", phase: "waiting" },
      { ...base, type: "turn", runId: "run", phase: "completed" },
      { ...base, type: "worker_transcript", workerRunId: "worker", phase: "tail", summary: "done" },
      { ...base, type: "unsupported", kind: "future", summary: "Update required" },
    ];
    const rendered = events.map(renderOperatorConversationEvent).join("\n");
    expect(rendered).toContain("Captain");
    expect(rendered).toContain("Reasoning");
    expect(rendered).toContain("Worker tail");
    expect(rendered).not.toContain("privatePayload");
  });
});
