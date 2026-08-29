import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  OperatorConversationTailStore,
  parseDirectConversation,
  resolveCaptainRouteToken,
  resolveInitialConversation,
  resolveWorkspaceConversation,
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
    roster: async () => [],
    get: async (id) => conversations.find((conversation) => conversation.conversationId === id),
    create: async (input) => ({ ...DEFAULT, ...input, conversationId: "created", isDefault: false }),
    close: async () => false,
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
    autonomy: async () => ({ enabled: true }),
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
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

  it("bounds durable replay checkpoints to the newest 256 conversations", async () => {
    const { store, path } = await tempTailStore();
    await store.initialize();
    for (let index = 0; index <= 256; index += 1) {
      await store.writeCursor(`conversation-${index}`, String(index));
    }
    const reopened = new OperatorConversationTailStore(path);
    await reopened.initialize();
    expect(reopened.cursor("conversation-0")).toBeUndefined();
    expect(reopened.cursor("conversation-256")).toBe("256");
  });

  it("starts fresh by default and resumes only an explicit --chat", async () => {
    const conversations: OperatorConversation[] = [DEFAULT, WORKSPACE];
    const created: OperatorConversation[] = [];
    const scoped: OperatorConversationClient = {
      ...client(),
      get: async (id) => conversations.find((conversation) => conversation.conversationId === id),
      create: async (input) => {
        const conversation: OperatorConversation = {
          ...DEFAULT,
          ...input,
          conversationId: `conv-${created.length + 1}`,
          isDefault: false,
        };
        created.push(conversation);
        conversations.push(conversation);
        return conversation;
      },
    };

    const first = await resolveInitialConversation({ client: scoped, workspace: "/repos/thing" });
    const second = await resolveInitialConversation({ client: scoped, workspace: "/repos/thing" });
    const global = await resolveInitialConversation({ client: scoped });
    expect(first.conversationId).not.toBe(second.conversationId);
    expect(first.scope).toEqual({ kind: "workspace", workspaceId: "/repos/thing" });
    expect(global.scope).toEqual({ kind: "global" });
    expect(created).toHaveLength(3);
    expect(created.every((conversation) => conversation.title.startsWith("New chat · "))).toBe(true);

    const confirmed = await resolveInitialConversation({
      client: scoped,
      directConversationId: "workspace-1",
    });
    expect(confirmed.conversationId).toBe("workspace-1");
    await expect(
      resolveInitialConversation({ client: scoped, directConversationId: "ghost" }),
    ).rejects.toThrow(/Unknown operator conversation/u);
  });

  it("reuses the newest workspace conversation only for an in-process /cd", async () => {
    const conversations: OperatorConversation[] = [DEFAULT];
    const created: string[] = [];
    const scoped: OperatorConversationClient = {
      ...client(),
      list: async (scope) =>
        conversations.filter(
          (conversation) =>
            scope === undefined ||
            (conversation.scope.kind === scope.kind &&
              (scope.kind !== "workspace" ||
                (conversation.scope.kind === "workspace" &&
                  conversation.scope.workspaceId === scope.workspaceId))),
        ),
      get: async (id) => conversations.find((conversation) => conversation.conversationId === id),
      create: async (input) => {
        created.push(input.title);
        const conversation: OperatorConversation = {
          ...DEFAULT,
          ...input,
          conversationId: `conv-${created.length}`,
          isDefault: false,
        };
        conversations.push(conversation);
        return conversation;
      },
    };

    const first = await resolveWorkspaceConversation({ client: scoped, workspace: "/repos/thing" });
    expect(created).toEqual(["thing"]);
    const reopened = await resolveWorkspaceConversation({ client: scoped, workspace: "/repos/thing" });
    expect(reopened.conversationId).toBe(first.conversationId);
    expect(created).toEqual(["thing"]);
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

  it("resumes an explicit selection at the exact per-surface tail cursor", async () => {
    const { store, path } = await tempTailStore();
    const firstSelection = new OperatorConversationSelection(client([WORKSPACE]));
    await firstSelection.select("workspace-1");
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
    await restartedSelection.select("workspace-1");
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

  it("reopens a dropped durable tail and replays through the accepted turn", async () => {
    const { store } = await tempTailStore();
    const selection = new OperatorConversationSelection(client());
    await selection.selectDefault();
    let tails = 0;
    const routed: OperatorConversationClient = {
      ...client(),
      tail: async function* (request) {
        tails += 1;
        if (tails === 1) throw new TypeError("fetch failed");
        yield {
          kind: "event",
          event: streamEvent(request.conversationId, "global-default:reply", {
            type: "message",
            role: "captain",
            text: "back after restart",
            streaming: false,
          }),
        };
        yield {
          kind: "event",
          event: streamEvent(request.conversationId, "global-default:done", {
            type: "turn",
            runId: "run:test",
            phase: "completed",
          }),
        };
      },
    };
    const recorded = recordingSink();
    const session = new OperatorConversationPromptSession({ client: routed, selection, tails: store });
    await session.initialize();
    await session.prompt("restart yourself", recorded.sink);

    expect(tails).toBe(2);
    expect(recorded.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "message", text: "back after restart" })]),
    );
  });

  it("resumes a recoverable retained boundary before sending", async () => {
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
    let replays = 0;
    const routed: OperatorConversationClient = {
      ...client(),
      replay: async (request) => {
        replays += 1;
        return replays === 1
          ? recovery
          : {
              schemaVersion: 1,
              status: "page",
              conversationId: request.conversationId,
              surfaceClientId: request.surfaceClientId,
              events: [],
              retainedFromCursor: recovery.resetCursor,
              nextCursor: recovery.resetCursor,
              safeCursor: recovery.resetCursor,
              hasMore: false,
            };
      },
      send: async (turn) => {
        sends += 1;
        return { ...(await client().send(turn)), runId: "run-recovered" };
      },
      tail: async function* () {
        yield {
          kind: "event",
          event: streamEvent("global-default", "global-default:done", {
            type: "turn",
            runId: "run-recovered",
            phase: "completed",
          }),
        };
      },
    };
    const recorded = recordingSink();
    const session = new OperatorConversationPromptSession({ client: routed, selection, tails: store });
    await session.initialize();
    await session.prompt("continue from retained history", recorded.sink);
    expect(recorded.recoveries).toEqual([recovery]);
    expect(sends).toBe(1);
    expect(renderOperatorConversationRecovery(recovery)).toContain("cursor_expired");
    expect(renderOperatorConversationRecovery(recovery)).toContain("resumed");
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
        insertMarkdown: (markdown: string) => {
          inserted.push(markdown);
          return { setMarkdown: () => undefined };
        },
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
        insertMarkdown: (markdown: string) => {
          inserted.push(markdown);
          return { setMarkdown: () => undefined };
        },
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
      insertMarkdown: (markdown: string) => {
        inserted.push(markdown);
        return { setMarkdown: () => undefined };
      },
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
      insertMarkdown: (markdown: string, options?: OperatorConversationBlockOptions) => {
        inserted.push([markdown, options]);
        return { setMarkdown: () => undefined };
      },
      refreshStatus: () => undefined,
    });
    sink.event({ ...shortTool, summary: "a\nb" });
    expect(inserted).toEqual([
      ["**Tool: read_file - completed**\n\na\nb", { clickToggle: true, collapsed: true }],
    ]);
  });

  it("replaces a started tool block with one completed block containing arguments and result", () => {
    const base = {
      schemaVersion: 1 as const,
      conversationId: "global-default",
      cursor: "global-default:event",
      revision: 1,
      occurredAt: "2026-07-12T00:00:00.000Z",
      type: "tool" as const,
      toolCallId: "call-1",
      name: "get_self_state",
    };
    const inserted: string[] = [];
    const updated: string[] = [];
    const sink = createOperatorConversationShellSink({
      insertMarkdown: (markdown: string) => {
        inserted.push(markdown);
        return { setMarkdown: (next) => updated.push(next) };
      },
      refreshStatus: () => undefined,
    });

    sink.event({ ...base, phase: "started", detail: '{\n  "includePresence": true\n}' });
    sink.event({ ...base, phase: "completed", detail: '{\n  "status": "idle"\n}' });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toContain("**Tool: get_self_state - started**");
    expect(updated).toEqual([
      [
        "**Tool: get_self_state - completed**",
        "",
        "Arguments:",
        "",
        "```json",
        '{\n  "includePresence": true\n}',
        "```",
        "",
        "Result:",
        "",
        "```",
        '{\n  "status": "idle"\n}',
        "```",
      ].join("\n"),
    ]);
  });

  it("updates the turn loader as activity and parallel tools change", () => {
    const base = {
      schemaVersion: 1 as const,
      conversationId: "global-default",
      cursor: "global-default:event",
      revision: 1,
      occurredAt: "2026-07-12T00:00:00.000Z",
    };
    const loaders: string[] = [];
    const sink = createOperatorConversationShellSink({
      insertMarkdown: () => ({ setMarkdown: () => undefined }),
      refreshStatus: () => undefined,
      setTurnLoaderMessage: (message) => loaders.push(message),
    });

    sink.event({ ...base, type: "turn", runId: "run", phase: "accepted" });
    sink.event({ ...base, type: "activity", phase: "thinking" });
    sink.event({ ...base, type: "activity", phase: "responding" });
    sink.event({ ...base, type: "activity", phase: "preparing_tool" });
    sink.event({ ...base, type: "tool", toolCallId: "call-1", name: "read", phase: "started" });
    sink.event({ ...base, type: "tool", toolCallId: "call-2", name: "bash", phase: "started" });
    sink.event({ ...base, type: "tool", toolCallId: "call-2", name: "bash", phase: "completed" });
    sink.event({ ...base, type: "tool", toolCallId: "call-1", name: "read", phase: "completed" });
    sink.event({ ...base, type: "activity", phase: "compacting" });
    sink.event({ ...base, type: "activity", phase: "retrying" });

    expect(loaders).toEqual([
      "Waiting for response...",
      "Thinking...",
      "Responding...",
      "Preparing tool call...",
      "Running read...",
      "Running bash...",
      "Running read...",
      "Waiting for response...",
      "Compacting...",
      "Retrying...",
    ]);
  });
});
