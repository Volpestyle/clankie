import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HandleMessageStreamEvent } from "eve/client";
import { OperatorConversationStreamEventSchema, type OperatorConversationEventBody } from "@clankie/protocol";
import {
  CaptainAdmissionController,
  LocalOperatorConversationService,
  openOperatorConversationRegistry,
  type CaptainIdentity,
} from "@clankie/captain-runtime";
import { routeAuth } from "eve/channels/auth";
import { captainLaneAddress, captainLaneInstructions } from "../lib/lanes/context.ts";
import { redactEveStreamEvent } from "../lib/lanes/transcript.ts";
import { runCaptainConversationTurn, type CaptainConversationClient } from "../lib/lanes/runtime.ts";
import {
  captainRouteAuth,
  handleOperatorConversationDispatch,
} from "../agent/channels/operator-conversations.ts";

const identity: CaptainIdentity = {
  agentDefinitionId: "captain-eve:v1",
  soulId: "clankie",
  providerId: "openai-codex",
  characterId: "clankie",
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function* arrayEvents(
  events: readonly HandleMessageStreamEvent[],
): AsyncIterable<HandleMessageStreamEvent> {
  for (const event of events) yield event;
}

/**
 * A per-conversation fake driver. `stores` holds each conversation's cumulative
 * session events; `events(startIndex)` slices from there (proving no-duplicate
 * resume). `sends` records the (conversationId, message) each call received
 * (proving isolation — no cross-conversation leakage).
 */
function fakeDriver(
  stores: Map<string, { sessionId: string; continuationToken?: string; events: HandleMessageStreamEvent[] }>,
  sends: { conversationId: string; message: string }[] = [],
): CaptainConversationClient {
  return {
    send: ({ conversationId, message }) => {
      sends.push({ conversationId, message });
      const store = stores.get(conversationId);
      if (store === undefined) throw new Error(`no store for ${conversationId}`);
      return Promise.resolve({
        sessionId: store.sessionId,
        continuationToken: store.continuationToken,
        events: (startIndex: number) => arrayEvents(store.events.slice(startIndex)),
      });
    },
  };
}

describe("Eve captain lane context", () => {
  it("maps HTTP to the default conversation-scoped operator lane", () => {
    expect(captainLaneAddress({ kind: "http", continuationToken: "private" }, "clankie")).toEqual({
      characterId: "clankie",
      lane: "operator",
      targetId: "global-default",
    });
  });

  it("requires explicit durable targets for voice, presence, and gameplay channel contracts", () => {
    expect(
      captainLaneAddress(
        {
          kind: "discord-voice",
          metadata: { captainLane: "discord_voice", captainTargetId: "guild-1:voice-1" },
        },
        "clankie",
      ),
    ).toEqual({ characterId: "clankie", lane: "discord_voice", targetId: "guild-1:voice-1" });
    expect(
      captainLaneAddress(
        {
          kind: "discord-text",
          metadata: { captainLane: "discord_presence", captainTargetId: "guild-1:channel-1" },
        },
        "clankie",
      ),
    ).toEqual({ characterId: "clankie", lane: "discord_presence", targetId: "guild-1:channel-1" });
    expect(
      captainLaneAddress(
        {
          kind: "schedule",
          metadata: { captainLane: "gameplay", captainTargetId: "world-1" },
        },
        "clankie",
      ),
    ).toEqual({ characterId: "clankie", lane: "gameplay", targetId: "world-1" });
    expect(() => captainLaneAddress({ kind: "discord-voice" }, "clankie")).toThrow(/captainTargetId/);
    expect(() =>
      captainLaneAddress({ kind: "discord-text", metadata: { captainLane: "discord_presence" } }, "clankie"),
    ).toThrow(/captainTargetId/);
  });

  it("adds lane-local instructions without including continuation authority", () => {
    for (const [lane, kind, targetId, ambientCue] of [
      ["operator", "http", "global-default", "authenticated operator conversation"],
      ["discord_voice", "discord-voice", "guild-1:voice-1", "ambient Discord voice lane"],
      ["discord_presence", "discord-text", "guild-1:channel-1", "ambient Discord text/presence lane"],
      ["gameplay", "schedule", "world-1", "cancellable gameplay-autonomy lane"],
    ] as const) {
      const markdown = captainLaneInstructions({
        kind,
        metadata: { captainLane: lane, captainTargetId: targetId },
        continuationToken: `secret-${lane}`,
      });
      expect(markdown).toContain("same Clankie");
      expect(markdown).toContain("one agent definition, soul, provider identity, and character ID");
      expect(markdown).toContain(ambientCue);
      expect(markdown).not.toContain(`secret-${lane}`);
      expect(markdown).not.toContain("continuationToken");
    }
  });

  it("resolves the unscoped operator lane to the default conversation with no env coupling", () => {
    // No process-global CLANKIE_CONVERSATION_ID: the direct operator channel is
    // always the default; per-conversation targeting rides the authored channel.
    delete process.env.CLANKIE_CONVERSATION_ID;
    expect(captainLaneAddress({ kind: "http" }, "clankie").targetId).toBe("global-default");
    process.env.CLANKIE_CONVERSATION_ID = "workspace-chat-7";
    expect(captainLaneAddress({ kind: "http" }, "clankie").targetId).toBe("global-default");
    delete process.env.CLANKIE_CONVERSATION_ID;
  });

  it("keeps implicit discord kinds on discord_voice and requires explicit metadata for presence", () => {
    // laneFromKind is unchanged: kind.includes("discord") still maps to voice.
    expect(
      captainLaneAddress(
        { kind: "discord-text", metadata: { captainTargetId: "guild-1:channel-1" } },
        "clankie",
      ),
    ).toEqual({ characterId: "clankie", lane: "discord_voice", targetId: "guild-1:channel-1" });
    const presence = captainLaneInstructions({
      kind: "discord-text",
      metadata: { captainLane: "discord_presence", captainTargetId: "guild-1:channel-1" },
      continuationToken: "must-not-leak",
    });
    expect(presence).toContain("concise social responses");
    expect(presence).toContain("never treat chat as a privileged approval surface");
    expect(presence).not.toContain("must-not-leak");
  });
});

describe("Eve captain transcript redaction", () => {
  afterEach(() => {
    delete process.env.CLANKIE_CONVERSATION_ID;
  });

  const stamp = (body: Record<string, unknown>) =>
    OperatorConversationStreamEventSchema.parse({
      ...body,
      schemaVersion: 1,
      conversationId: "global-default",
      cursor: "event:1",
      revision: 0,
      occurredAt: "2026-07-12T00:00:00.000Z",
    });

  it("projects completed message and reasoning blocks, truncated to the public bound", () => {
    expect(
      redactEveStreamEvent({
        type: "message.completed",
        data: { finishReason: "stop", message: "Done.", sequence: 1, stepIndex: 0, turnId: "t1" },
      } as HandleMessageStreamEvent),
    ).toEqual([{ type: "message", role: "captain", text: "Done.", streaming: false }]);
    expect(
      redactEveStreamEvent({
        type: "reasoning.completed",
        data: { reasoning: "thinking", sequence: 1, stepIndex: 0, turnId: "t1" },
      } as HandleMessageStreamEvent),
    ).toEqual([{ type: "reasoning", text: "thinking", streaming: false }]);
    const [huge] = redactEveStreamEvent({
      type: "message.completed",
      data: { finishReason: "stop", message: "x".repeat(50_000), sequence: 1, stepIndex: 0, turnId: "t1" },
    } as HandleMessageStreamEvent);
    expect((huge as { text: string }).text.length).toBe(16_384);
    // A null/empty message projects nothing.
    expect(
      redactEveStreamEvent({
        type: "message.completed",
        data: { finishReason: "stop", message: null, sequence: 1, stepIndex: 0, turnId: "t1" },
      } as HandleMessageStreamEvent),
    ).toEqual([]);
  });

  it("projects tool lifecycle by call id and name only, never raw arguments or results", () => {
    const started = redactEveStreamEvent({
      type: "actions.requested",
      data: {
        actions: [{ callId: "call-1", kind: "tool-call", toolName: "bash", input: { secret: "sk-live" } }],
        sequence: 1,
        stepIndex: 0,
        turnId: "t1",
      },
    } as HandleMessageStreamEvent);
    expect(started).toEqual([{ type: "tool", toolCallId: "call-1", name: "bash", phase: "started" }]);
    expect(JSON.stringify(started)).not.toContain("sk-live");
    const failed = redactEveStreamEvent({
      type: "action.result",
      data: {
        result: { callId: "call-1", kind: "tool-result", toolName: "bash", output: { token: "secret" } },
        status: "failed",
        sequence: 2,
        stepIndex: 0,
        turnId: "t1",
      },
    } as HandleMessageStreamEvent);
    expect(failed).toEqual([{ type: "tool", toolCallId: "call-1", name: "bash", phase: "failed" }]);
    expect(JSON.stringify(failed)).not.toContain("secret");
  });

  it("projects typed input requests, sessions, and auth without credential data", () => {
    const [input] = redactEveStreamEvent({
      type: "input.requested",
      data: {
        requests: [
          {
            requestId: "req-1",
            prompt: "Pick one",
            display: "select",
            options: [
              { id: "a", label: "Alpha" },
              { id: "b", label: "Beta" },
            ],
            action: { callId: "c1", kind: "tool-call", toolName: "ask", input: {} },
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "t1",
      },
    } as HandleMessageStreamEvent);
    expect(input).toMatchObject({
      type: "input_requested",
      requestId: "req-1",
      inputKind: "choice",
      options: ["Alpha", "Beta"],
    });
    expect(
      redactEveStreamEvent({
        type: "authorization.required",
        data: { name: "github", description: "Authorize GitHub", sequence: 1, stepIndex: 0, turnId: "t1" },
      } as HandleMessageStreamEvent),
    ).toEqual([{ type: "auth", phase: "required", summary: "github" }]);
    expect(redactEveStreamEvent({ type: "session.completed" } as HandleMessageStreamEvent)).toEqual([
      { type: "session", phase: "completed" },
    ]);
    // Streaming deltas and model-turn envelopes are not projected into the durable log.
    expect(
      redactEveStreamEvent({
        type: "message.appended",
        data: { messageDelta: "d", messageSoFar: "d", sequence: 1, stepIndex: 0, turnId: "t1" },
      } as HandleMessageStreamEvent),
    ).toEqual([]);
  });

  it("produces bodies that validate against the strict public event schema", () => {
    const bodies = [
      ...redactEveStreamEvent({
        type: "message.completed",
        data: { finishReason: "stop", message: "hi", sequence: 1, stepIndex: 0, turnId: "t1" },
      } as HandleMessageStreamEvent),
      ...redactEveStreamEvent({ type: "session.waiting" } as HandleMessageStreamEvent),
    ];
    for (const body of bodies) expect(() => stamp(body)).not.toThrow();
  });
});

describe("Eve captain operator conversation execution", () => {
  const message = (text: string): HandleMessageStreamEvent =>
    ({
      type: "message.completed",
      data: { finishReason: "stop", message: text, sequence: 1, stepIndex: 0, turnId: "t" },
    }) as HandleMessageStreamEvent;
  const completed = { type: "session.completed" } as HandleMessageStreamEvent;

  it("runs an accepted turn against the conversation session, publishing transcript and binding privately", async () => {
    const root = await mkdtemp(join(tmpdir(), "captain-exec-"));
    roots.push(root);
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), { identity });
    const published: OperatorConversationEventBody[] = [];
    const stores = new Map([
      [
        "global-default",
        { sessionId: "sess-1", continuationToken: "cont-1", events: [message("hello"), completed] },
      ],
    ]);
    await runCaptainConversationTurn({
      registry,
      client: fakeDriver(stores),
      conversationId: "global-default",
      message: "hi",
      publish: (body) => published.push(body),
    });
    expect(published.map((body) => body.type)).toContain("message");
    expect(registry.privateSession("global-default")).toEqual({
      sessionId: "sess-1",
      continuationToken: "cont-1",
    });
    expect(registry.get("global-default")?.sessionState).toBe("completed");
    expect(registry.eveStreamIndex("global-default")).toBe(2);
    registry.close();
  });

  it("throws on a failed captain turn and marks the conversation session failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "captain-exec-fail-"));
    roots.push(root);
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), { identity });
    const stores = new Map([
      [
        "global-default",
        { sessionId: "sess-2", events: [{ type: "session.failed" } as HandleMessageStreamEvent] },
      ],
    ]);
    await expect(
      runCaptainConversationTurn({
        registry,
        client: fakeDriver(stores),
        conversationId: "global-default",
        message: "hi",
        publish: () => undefined,
      }),
    ).rejects.toThrow(/failed/);
    expect(registry.get("global-default")?.sessionState).toBe("failed");
    registry.close();
  });

  it("isolates two concurrent conversations to their own sessions and transcripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "captain-iso-"));
    roots.push(root);
    let id = 0;
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), {
      identity,
      idFactory: () => `conversation-${++id}`,
    });
    const other = registry.create({ scope: { kind: "global" }, title: "Other" });
    const stores = new Map([
      ["global-default", { sessionId: "sess-A", events: [message("alpha"), completed] }],
      [other.conversationId, { sessionId: "sess-B", events: [message("beta"), completed] }],
    ]);
    const sends: { conversationId: string; message: string }[] = [];
    const client = fakeDriver(stores, sends);
    const publishedA: OperatorConversationEventBody[] = [];
    const publishedB: OperatorConversationEventBody[] = [];
    await Promise.all([
      runCaptainConversationTurn({
        registry,
        client,
        conversationId: "global-default",
        message: "toA",
        publish: (b) => publishedA.push(b),
      }),
      runCaptainConversationTurn({
        registry,
        client,
        conversationId: other.conversationId,
        message: "toB",
        publish: (b) => publishedB.push(b),
      }),
    ]);
    // Each conversation bound its own session; no cross-conversation leakage.
    expect(registry.privateSession("global-default").sessionId).toBe("sess-A");
    expect(registry.privateSession(other.conversationId).sessionId).toBe("sess-B");
    expect(sends).toContainEqual({ conversationId: "global-default", message: "toA" });
    expect(sends).toContainEqual({ conversationId: other.conversationId, message: "toB" });
    const textA = publishedA.flatMap((b) => (b.type === "message" ? [b.text] : []));
    const textB = publishedB.flatMap((b) => (b.type === "message" ? [b.text] : []));
    expect(textA).toEqual(["alpha"]);
    expect(textB).toEqual(["beta"]);
    registry.close();
  });

  it("resumes a session without re-projecting already-projected transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "captain-resume-"));
    roots.push(root);
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), { identity });
    const store = { sessionId: "sess-R", events: [message("first"), completed] };
    const stores = new Map([["global-default", store]]);
    const client = fakeDriver(stores);
    const firstRun: OperatorConversationEventBody[] = [];
    await runCaptainConversationTurn({
      registry,
      client,
      conversationId: "global-default",
      message: "one",
      publish: (b) => firstRun.push(b),
    });
    expect(firstRun.flatMap((b) => (b.type === "message" ? [b.text] : []))).toEqual(["first"]);
    expect(registry.eveStreamIndex("global-default")).toBe(2);
    // A second turn appends events; getEventStream(startIndex) yields only the new ones.
    store.events.push(message("second"), completed);
    const secondRun: OperatorConversationEventBody[] = [];
    await runCaptainConversationTurn({
      registry,
      client,
      conversationId: "global-default",
      message: "two",
      publish: (b) => secondRun.push(b),
    });
    expect(secondRun.flatMap((b) => (b.type === "message" ? [b.text] : []))).toEqual(["second"]);
    expect(registry.eveStreamIndex("global-default")).toBe(4);
    registry.close();
  });

  it("fails the dispatch route closed for non-loopback callers and accepts loopback", async () => {
    const loopback = await routeAuth(
      new Request("http://127.0.0.1/operator/v1/dispatch", { method: "POST" }),
      captainRouteAuth(),
    );
    expect(loopback instanceof Response).toBe(false);
    const remote = await routeAuth(
      new Request("http://evil.example.com/operator/v1/dispatch", { method: "POST" }),
      captainRouteAuth(),
    );
    expect(remote instanceof Response).toBe(true);
    if (remote instanceof Response) expect(remote.status).toBe(401);
  });

  it("dispatches operator conversation requests through the authenticated route", async () => {
    const root = await mkdtemp(join(tmpdir(), "captain-route-"));
    roots.push(root);
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), { identity });
    const service = new LocalOperatorConversationService(
      registry,
      new CaptainAdmissionController({ capacity: 1 }),
      () => Promise.resolve(),
    );
    const ok = await handleOperatorConversationDispatch(
      new Request("http://127.0.0.1/operator/v1/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "list", schemaVersion: 1 }),
      }),
      service,
    );
    expect(ok.status).toBe(200);
    const result = (await ok.json()) as { op: string; conversations: { isDefault: boolean }[] };
    expect(result.op).toBe("list");
    expect(result.conversations.some((conversation) => conversation.isDefault)).toBe(true);
    const bad = await handleOperatorConversationDispatch(
      new Request("http://127.0.0.1/operator/v1/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "nope" }),
      }),
      service,
    );
    expect(bad.status).toBe(400);
    registry.close();
  });
});
