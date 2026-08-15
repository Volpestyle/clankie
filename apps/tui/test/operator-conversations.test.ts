import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintCaptainToken, type CredentialStore } from "@clankie/credential-broker";
import type {
  OperatorConversation,
  OperatorConversationRecovery,
  OperatorConversationStreamEvent,
} from "@clankie/protocol";
import {
  createCaptainOperatorConversationClient,
  createProductionOperatorConversationClient,
  OperatorConversationClientError,
  OperatorConversationPromptSession,
  OperatorConversationSelection,
  OperatorConversationSelectionStore,
  OperatorConversationSelectionStoreError,
  OperatorConversationTailStore,
  parseDirectConversation,
  resolveCaptainRouteToken,
  resolveInitialConversation,
  type OperatorConversationEventSink,
  type OperatorConversationClient,
} from "../src/session/operator-conversations.ts";
import {
  createOperatorConversationShellSink,
  operatorConversationBlockOptions,
  renderOperatorConversationEvent,
  renderOperatorConversationRecovery,
  type OperatorConversationBlockOptions,
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

function fakeCredentialStore(credential?: { type: "api"; key: string }): CredentialStore {
  return {
    get: async () => credential,
    set: async () => undefined,
    delete: async () => false,
    list: async () => ({}),
  };
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

  it.each([
    { captainToken: " repair4-secret ", authorization: "Bearer repair4-secret" },
    { captainToken: undefined, authorization: undefined },
  ])(
    "sends the configured captain bearer and preserves unconfigured loopback ($authorization)",
    async ({ captainToken, authorization }) => {
      const headers: Array<string | undefined> = [];
      const server = createServer((request, response) => {
        request.resume();
        request.once("end", () => {
          headers.push(request.headers.authorization);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ op: "list", schemaVersion: 1, conversations: [DEFAULT] }));
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing server address");
        const captain = createProductionOperatorConversationClient({
          host: `http://127.0.0.1:${address.port}`,
          ...(captainToken === undefined ? {} : { captainToken }),
        });
        expect(await captain.list()).toEqual([DEFAULT]);
        expect(headers).toEqual([authorization]);
      } finally {
        server.close();
        await once(server, "close");
      }
    },
  );

  it("resolves the captain bearer from the env override, then the brokered store", async () => {
    const stored = mintCaptainToken();
    const store = fakeCredentialStore({ type: "api", key: stored });
    expect(await resolveCaptainRouteToken({ env: { CLANKIE_CAPTAIN_TOKEN: "explicit" }, store })).toBe(
      "explicit",
    );
    expect(await resolveCaptainRouteToken({ env: {}, store })).toBe(stored);
  });

  it("degrades to no bearer when the store is empty, failing, or holds an invalid token", async () => {
    expect(await resolveCaptainRouteToken({ env: {}, store: fakeCredentialStore() })).toBeUndefined();
    const failing: CredentialStore = {
      ...fakeCredentialStore(),
      get: async () => {
        throw new Error("keychain unavailable");
      },
    };
    expect(await resolveCaptainRouteToken({ env: {}, store: failing })).toBeUndefined();
    expect(
      await resolveCaptainRouteToken({
        env: {},
        store: fakeCredentialStore({ type: "api", key: "not-a-captain-token" }),
      }),
    ).toBeUndefined();
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
    const session = new OperatorConversationPromptSession({
      client: routed,
      selection,
      tails: store,
    });
    await session.initialize();
    await session.prompt("to A", recordingSink().sink);
    await selection.select("workspace-1");
    await session.prompt("to B", recordingSink().sink);
    expect(sends).toEqual(["global-default", "workspace-1"]);
  });

  it("sends the herdr pane as his seat when the console is in herdr", async () => {
    const { store } = await tempTailStore();
    const selection = new OperatorConversationSelection(client([WORKSPACE]));
    await selection.select("global-default");
    const panes: Array<string | undefined> = [];
    const routed: OperatorConversationClient = {
      ...client([WORKSPACE]),
      send: async (turn) => {
        panes.push(turn.herdrPaneId);
        return {
          schemaVersion: 1,
          status: "accepted",
          conversationId: turn.conversationId,
          runId: "run-seat",
          revision: turn.expectedRevision + 1,
          safeCursor: "global-default:accepted",
        };
      },
      tail: async function* () {
        yield {
          kind: "event",
          event: streamEvent("global-default", "global-default:done", {
            type: "turn",
            runId: "run-seat",
            phase: "completed",
          }),
        };
      },
    };
    const session = new OperatorConversationPromptSession({
      client: routed,
      selection,
      tails: store,
      herdrPaneId: () => "w3:p2J",
    });
    await session.initialize();
    await session.prompt("what's in flight", recordingSink().sink);
    expect(panes).toEqual(["w3:p2J"]);
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

  it("renders conversation content and failures; healthy lifecycle events stay off the transcript", () => {
    const base = {
      schemaVersion: 1 as const,
      conversationId: "global-default",
      cursor: "global-default:event",
      revision: 1,
      occurredAt: "2026-07-12T00:00:00.000Z",
    };
    const events: OperatorConversationStreamEvent[] = [
      { ...base, type: "message", role: "captain", text: "hello", streaming: false },
      { ...base, type: "message", role: "operator", text: "typed elsewhere", streaming: false },
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
      { ...base, type: "worker_transcript", workerRunId: "worker", phase: "tail", summary: "done" },
      { ...base, type: "unsupported", kind: "future", summary: "Update required" },
    ];
    const rendered = events.map(renderOperatorConversationEvent).join("\n");
    expect(rendered).toContain("Clankie");
    expect(rendered).toContain("**You**\n\ntyped elsewhere");
    expect(rendered).toContain("Reasoning");
    expect(rendered).toContain("Worker tail");
    expect(rendered).not.toContain("privatePayload");
    expect(rendered).not.toContain("undefined");

    // Healthy lifecycle plumbing belongs on the status line, not the transcript.
    for (const phase of ["started", "waiting", "completed"] as const) {
      expect(renderOperatorConversationEvent({ ...base, type: "session", phase })).toBeUndefined();
    }
    for (const phase of ["accepted", "completed"] as const) {
      expect(renderOperatorConversationEvent({ ...base, type: "turn", runId: "run", phase })).toBeUndefined();
    }
    // Failures carry information the operator must see.
    expect(renderOperatorConversationEvent({ ...base, type: "session", phase: "failed" })).toContain(
      "failed",
    );
    expect(
      renderOperatorConversationEvent({
        ...base,
        type: "turn",
        runId: "run",
        phase: "failed",
        reasonCode: "execution_failed",
      }),
    ).toContain("failed · execution_failed");
  });

  it("suppresses exactly one durable echo of the locally echoed prompt", () => {
    const base = {
      schemaVersion: 1 as const,
      conversationId: "global-default",
      cursor: "global-default:event",
      revision: 1,
      occurredAt: "2026-07-12T00:00:00.000Z",
    };
    const inserted: string[] = [];
    const statuses: string[] = [];
    const sink = createOperatorConversationShellSink(
      {
        insertMarkdown: (markdown: string) => inserted.push(markdown),
        refreshStatus: (label: string) => statuses.push(label),
      },
      { localEchoText: "  hi  " },
    );
    const operatorMessage = (text: string): OperatorConversationStreamEvent => ({
      ...base,
      type: "message",
      role: "operator",
      text,
      streaming: false,
    });
    // Another surface's different message before ours still renders.
    sink.event(operatorMessage("from the phone"));
    // The durable echo of the locally echoed prompt is suppressed once…
    sink.event(operatorMessage("hi"));
    // …but a repeated identical prompt later is a real message again.
    sink.event(operatorMessage("hi"));
    sink.event({ ...base, type: "turn", runId: "run", phase: "accepted" });
    sink.event({ ...base, type: "message", role: "captain", text: "hello", streaming: false });
    expect(inserted).toEqual(["**You**\n\nfrom the phone", "**You**\n\nhi", "**Clankie**\n\nhello"]);
    // Turn lifecycle still drives the status line even when not rendered.
    expect(statuses).toEqual(["conversation turn accepted"]);
  });

  it("routes context snapshots to the status surface without transcript noise", () => {
    const inserted: string[] = [];
    const usages: { tokens: number | null; contextWindow: number }[] = [];
    const sink = createOperatorConversationShellSink(
      {
        insertMarkdown: (markdown: string) => inserted.push(markdown),
        refreshStatus: () => undefined,
      },
      { onContextUsage: (usage) => usages.push(usage) },
    );

    sink.event({
      schemaVersion: 1,
      conversationId: "global-default",
      cursor: "global-default:context",
      revision: 1,
      occurredAt: "2026-07-12T00:00:00.000Z",
      type: "context",
      usage: { tokens: 72_400, contextWindow: 200_000 },
    });

    expect(inserted).toEqual([]);
    expect(usages).toEqual([{ tokens: 72_400, contextWindow: 200_000 }]);
  });

  it("renders operator history as You when no local echo is pending (restore path)", () => {
    const inserted: string[] = [];
    const sink = createOperatorConversationShellSink({
      insertMarkdown: (markdown: string) => inserted.push(markdown),
      refreshStatus: () => undefined,
    });
    sink.event({
      schemaVersion: 1,
      conversationId: "global-default",
      cursor: "global-default:event",
      revision: 1,
      occurredAt: "2026-07-12T00:00:00.000Z",
      type: "message",
      role: "operator",
      text: "hi",
      streaming: false,
    });
    expect(inserted).toEqual(["**You**\n\nhi"]);
  });

  it("marks detail blocks click-toggleable, collapsing only bodies with hidden detail", () => {
    const base = {
      schemaVersion: 1 as const,
      conversationId: "global-default",
      cursor: "global-default:event",
      revision: 1,
      occurredAt: "2026-07-12T00:00:00.000Z",
    };
    const optionsFor = (
      event: OperatorConversationStreamEvent,
    ): OperatorConversationBlockOptions | undefined => {
      const markdown = renderOperatorConversationEvent(event);
      expect(markdown).toBeDefined();
      return operatorConversationBlockOptions(event, markdown ?? "");
    };
    const shortTool: OperatorConversationStreamEvent = {
      ...base,
      type: "tool",
      toolCallId: "call-1",
      name: "read_file",
      phase: "completed",
      summary: "docs/16-operator-conversations.md",
    };
    // A short body fits in place; collapsing it would hide the whole payload.
    expect(optionsFor(shortTool)).toEqual({ clickToggle: true, collapsed: false });
    expect(optionsFor({ ...shortTool, summary: `exit 0\n${"stdout line\n".repeat(6)}` })).toEqual({
      clickToggle: true,
      collapsed: true,
    });
    expect(optionsFor({ ...shortTool, summary: "x".repeat(400) })).toEqual({
      clickToggle: true,
      collapsed: true,
    });
    const detailedTool = { ...shortTool, phase: "started" as const, detail: '{\n  "path": "README.md"\n}' };
    expect(renderOperatorConversationEvent(detailedTool)).toContain("Arguments:\n\n```json");
    expect(optionsFor(detailedTool)).toEqual({ clickToggle: true, collapsed: true });
    expect(renderOperatorConversationEvent({ ...shortTool, detail: "line one\nline two" })).toContain(
      "Result:\n\n```\nline one\nline two\n```",
    );
    const skillTool: OperatorConversationStreamEvent = {
      ...shortTool,
      name: "read",
      skillName: "herdr-lead",
    };
    expect(renderOperatorConversationEvent({ ...skillTool, phase: "started" })).toBeUndefined();
    expect(renderOperatorConversationEvent(skillTool)).toBe("**Skill: herdr-lead - loaded**");
    expect(renderOperatorConversationEvent({ ...skillTool, phase: "failed" })).toBe(
      "**Skill: herdr-lead - failed to load**",
    );
    expect(optionsFor(skillTool)).toBeUndefined();
    expect(
      optionsFor({
        ...base,
        type: "worker_transcript",
        workerRunId: "worker-1",
        phase: "tail",
        summary: "line one\nline two\nline three",
      }),
    ).toEqual({ clickToggle: true, collapsed: true });
    // Conversation content always renders expanded and inert.
    expect(
      optionsFor({ ...base, type: "message", role: "captain", text: "hello", streaming: false }),
    ).toBeUndefined();

    // The sink forwards the options so the face can arm click-to-toggle.
    const inserted: [string, OperatorConversationBlockOptions | undefined][] = [];
    const sink = createOperatorConversationShellSink({
      insertMarkdown: (markdown: string, options?: OperatorConversationBlockOptions) =>
        inserted.push([markdown, options]),
      refreshStatus: () => undefined,
    });
    sink.event({ ...shortTool, summary: "a\nb" });
    expect(inserted).toEqual([
      ["**Tool: read_file - completed**\n\na\nb", { clickToggle: true, collapsed: true }],
    ]);
  });
});
