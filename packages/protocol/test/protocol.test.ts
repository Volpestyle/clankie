import { describe, expect, it } from "vitest";
import type {
  CreateOperatorConversationRequest,
  GetOperatorConversationRequest,
  GetOperatorConversationResponse,
  ListOperatorConversationsRequest,
  ListOperatorConversationsResponse,
  OperatorConversationCreateResult,
  OperatorConversationGetResult,
  OperatorConversationListResult,
  OperatorConversationReplayResult,
  OperatorConversationSendResult,
  OperatorConversationServiceRequest,
  OperatorConversationServiceResult,
  OperatorConversationTailItem,
  OperatorConversationTailResult,
  ReplayOperatorConversationRequest,
  ReplayOperatorConversationResult,
  SubmitOperatorConversationTurnResult,
} from "../src/index.ts";
import {
  CaptainPresenceEventSchema,
  CaptainPresenceReportSchema,
  CaptainLaneSchema,
  CaptainSessionLaneV2Schema,
  DISCORD_PRESENCE_ACTION_RISK_CLASS,
  isShareArtifactRef,
  isAttachableTurnMediaRef,
  DiscordPresenceActionSchema,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteSchema,
  resolveDiscordPresenceLedgerContent,
  IntentContextSchema,
  createOperatorConversationServiceClient,
  OPERATOR_CONVERSATION_REF_MAX,
  OPERATOR_CONVERSATION_TOOL_DETAIL_MAX,
  OperatorConversationAttachmentSchema,
  OperatorConversationInputResponseSchema,
  OperatorConversationRecoverySchema,
  OperatorConversationRevisionConflictSchema,
  OperatorConversationSchema,
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  OperatorConversationStreamEventSchema,
  ReplayOperatorConversationResultSchema,
  SubmitOperatorConversationTurnResultSchema,
  SubmitOperatorConversationTurnSchema,
} from "../src/index.ts";

describe("protocol", () => {
  it("exports provider-neutral operator conversation fixtures", () => {
    expect(CaptainLaneSchema.options).toEqual(["tui", "discord_voice", "gameplay"]);
    expect(CaptainSessionLaneV2Schema.options).toEqual([
      "operator",
      "discord_voice",
      "discord_presence",
      "gameplay",
    ]);
    const conversation = OperatorConversationSchema.parse({
      schemaVersion: 1,
      conversationId: "conversation-global-default",
      scope: { kind: "global" },
      title: "Clankie",
      isDefault: true,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      sessionState: "active",
      revision: 7,
      contextUsage: { tokens: 72_400, contextWindow: 200_000 },
    });
    expect(
      OperatorConversationAttachmentSchema.parse({
        schemaVersion: 1,
        conversationId: conversation.conversationId,
        surfaceClientId: "mac-window-1",
        cursor: "event:12",
      }),
    ).toMatchObject({ surfaceClientId: "mac-window-1", cursor: "event:12" });
    expect(
      SubmitOperatorConversationTurnSchema.parse({
        schemaVersion: 1,
        kind: "message",
        conversationId: conversation.conversationId,
        surfaceClientId: "rn-scene-1",
        expectedRevision: 7,
        message: "Continue the mission",
      }),
    ).toMatchObject({ kind: "message", expectedRevision: 7 });
    expect(
      SubmitOperatorConversationTurnSchema.parse({
        schemaVersion: 1,
        kind: "message",
        conversationId: conversation.conversationId,
        surfaceClientId: "tui-1",
        expectedRevision: 7,
        message: "what's in flight",
        herdrPaneId: "w3:p2J",
      }),
    ).toMatchObject({ herdrPaneId: "w3:p2J" });
    expect(() =>
      SubmitOperatorConversationTurnSchema.parse({
        schemaVersion: 1,
        kind: "message",
        conversationId: conversation.conversationId,
        surfaceClientId: "tui-1",
        expectedRevision: 7,
        message: "what's in flight",
        herdrPaneId: "not a pane",
      }),
    ).toThrow();
    expect(
      OperatorConversationRevisionConflictSchema.parse({
        schemaVersion: 1,
        status: "revision_conflict",
        conversationId: conversation.conversationId,
        expectedRevision: 6,
        currentRevision: 7,
        safeCursor: "event:12",
      }),
    ).toMatchObject({ status: "revision_conflict", currentRevision: 7 });
    expect(JSON.stringify(conversation)).not.toMatch(/provider|continuation|credential/iu);
    expect(conversation.contextUsage).toEqual({ tokens: 72_400, contextWindow: 200_000 });
  });

  it("rejects private-capability fields, unknown keys, and unbounded payloads at the public boundary", () => {
    // The record is strict: private-capability fields are rejected, not stripped.
    for (const hostile of [
      { continuationToken: "secret-continuation" },
      { provider: "openai-codex" },
      { credential: "sk-live-DEADBEEF" },
      { apiKey: "AKIA-XXXX" },
    ]) {
      expect(() =>
        OperatorConversationSchema.parse({
          schemaVersion: 1,
          conversationId: "global-default",
          scope: { kind: "global" },
          title: "Clankie",
          isDefault: true,
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
          sessionState: "active",
          revision: 1,
          ...hostile,
        }),
      ).toThrow();
    }
    // The event union rejects an opaque provider/credential/unbounded escape payload.
    const base = {
      schemaVersion: 1,
      conversationId: "global-default",
      cursor: "event:1",
      revision: 1,
      occurredAt: "2026-07-12T00:00:00.000Z",
    };
    expect(() =>
      OperatorConversationStreamEventSchema.parse({
        ...base,
        type: "provider.private-capability",
        data: { continuationToken: "secret", credential: "sk-live" },
      }),
    ).toThrow();
    expect(
      OperatorConversationStreamEventSchema.parse({
        ...base,
        type: "tool",
        toolCallId: "call-1",
        name: "read",
        phase: "started",
        skillName: "herdr-lead",
        detail: '{\n  "path": "README.md"\n}',
      }),
    ).toMatchObject({ type: "tool", skillName: "herdr-lead", detail: expect.stringContaining("README.md") });
    expect(
      OperatorConversationStreamEventSchema.parse({
        ...base,
        type: "context",
        usage: { tokens: null, contextWindow: 200_000 },
      }),
    ).toMatchObject({ type: "context", usage: { tokens: null, contextWindow: 200_000 } });
    expect(() =>
      OperatorConversationStreamEventSchema.parse({
        ...base,
        type: "context",
        usage: { tokens: -1, contextWindow: 0 },
      }),
    ).toThrow();
    expect(() =>
      OperatorConversationStreamEventSchema.parse({
        ...base,
        type: "tool",
        toolCallId: "call-1",
        name: "read",
        phase: "completed",
        detail: "x".repeat(OPERATOR_CONVERSATION_TOOL_DETAIL_MAX + 1),
      }),
    ).toThrow();
    expect(() =>
      OperatorConversationStreamEventSchema.parse({
        ...base,
        type: "message",
        role: "captain",
        text: "x".repeat(20_000),
        streaming: false,
      }),
    ).toThrow();
    expect(() =>
      OperatorConversationStreamEventSchema.parse({
        ...base,
        type: "message",
        role: "captain",
        text: "ok",
        streaming: false,
        continuationToken: "secret",
      }),
    ).toThrow();
    expect(() =>
      OperatorConversationStreamEventSchema.parse({
        ...base,
        type: "worker_transcript",
        workerRunId: "w".repeat(OPERATOR_CONVERSATION_REF_MAX + 1),
        phase: "tail",
        summary: "bounded summary",
      }),
    ).toThrow();
    expect(() =>
      SubmitOperatorConversationTurnSchema.parse({
        schemaVersion: 1,
        kind: "worker_steer",
        conversationId: "global-default",
        surfaceClientId: "rn",
        expectedRevision: 1,
        workerRunId: "w".repeat(OPERATOR_CONVERSATION_REF_MAX + 1),
        intent: { type: "focus", target: "failing_test" },
      }),
    ).toThrow();
    // A message event validates and carries no provider/credential surface.
    expect(
      OperatorConversationStreamEventSchema.parse({
        ...base,
        type: "message",
        role: "captain",
        text: "hello",
        streaming: false,
      }),
    ).toMatchObject({ type: "message", role: "captain" });
  });

  it("never lets the conversation lane authorize an approval, and defers unwired submits", () => {
    // The conversation lane cannot widen approval authority (ADR 0032): approval
    // is not an accepted input response kind.
    expect(() =>
      OperatorConversationInputResponseSchema.parse({ inputKind: "approval", approve: true }),
    ).toThrow();
    expect(
      OperatorConversationInputResponseSchema.parse({ inputKind: "text", text: "answer" }),
    ).toMatchObject({
      inputKind: "text",
    });
    // Typed input-response and worker-steer submits parse (shape is defined)…
    expect(
      SubmitOperatorConversationTurnSchema.parse({
        schemaVersion: 1,
        kind: "worker_steer",
        conversationId: "global-default",
        surfaceClientId: "rn",
        expectedRevision: 3,
        workerRunId: "worker-1",
        intent: { type: "focus", target: "failing_test" },
      }),
    ).toMatchObject({ kind: "worker_steer" });
    // …but an approval decision can never be encoded as a submit input response.
    expect(() =>
      SubmitOperatorConversationTurnSchema.parse({
        schemaVersion: 1,
        kind: "input_response",
        conversationId: "global-default",
        surfaceClientId: "rn",
        expectedRevision: 3,
        requestId: "req-1",
        response: { inputKind: "approval", approve: true },
      }),
    ).toThrow();
    // The accepted result carries a durable run identity; unsupported is a typed status.
    expect(
      SubmitOperatorConversationTurnResultSchema.parse({
        schemaVersion: 1,
        status: "accepted",
        conversationId: "global-default",
        runId: "run:1",
        revision: 4,
        safeCursor: "event:9",
      }),
    ).toMatchObject({ status: "accepted", runId: "run:1" });
    expect(
      SubmitOperatorConversationTurnResultSchema.parse({
        schemaVersion: 1,
        status: "unsupported",
        conversationId: "global-default",
        submitKind: "worker_steer",
        reason: "Deferred until captain wiring lands.",
      }),
    ).toMatchObject({ status: "unsupported" });
  });

  it("models bounded replay recovery and the callable service envelope", () => {
    expect(
      ReplayOperatorConversationResultSchema.parse({
        schemaVersion: 1,
        status: "page",
        conversationId: "global-default",
        surfaceClientId: "rn",
        events: [],
        retainedFromCursor: "event:0",
        nextCursor: "event:0",
        safeCursor: "event:0",
        hasMore: false,
      }),
    ).toMatchObject({ status: "page", hasMore: false });
    for (const code of [
      "cursor_invalid",
      "cursor_expired",
      "cursor_reset",
      "run_conflict",
      "unknown_conversation",
    ]) {
      expect(
        OperatorConversationRecoverySchema.parse({
          schemaVersion: 1,
          status: "recover",
          conversationId: "global-default",
          code,
          recoverable: code !== "unknown_conversation",
          resetCursor: "event:0",
          message: "reset and replay",
        }),
      ).toMatchObject({ status: "recover", code });
    }
    // The callable request/result envelope (list/get/create/replay/tail/send) is strict.
    expect(
      OperatorConversationServiceRequestSchema.parse({
        op: "replay",
        schemaVersion: 1,
        replay: { schemaVersion: 1, conversationId: "global-default", surfaceClientId: "rn", limit: 50 },
      }),
    ).toMatchObject({ op: "replay" });
    expect(() =>
      OperatorConversationServiceRequestSchema.parse({
        op: "replay",
        schemaVersion: 1,
        replay: { schemaVersion: 1, conversationId: "global-default", surfaceClientId: "rn" },
        provider: "openai-codex",
      }),
    ).toThrow();
    expect(OperatorConversationServiceResultSchema.options).toHaveLength(6);
    expect(typeof createOperatorConversationServiceClient).toBe("function");
  });

  it("dual-reads discord_presence while freezing it out of v1 and freezes presence write bot transport", () => {
    expect(CaptainSessionLaneV2Schema.parse("discord_presence")).toBe("discord_presence");
    expect(() => CaptainLaneSchema.parse("discord_presence")).toThrow();
    expect(
      IntentContextSchema.parse({
        sourceLane: "discord_presence",
        authority: { principal: { kind: "human", id: "friend" }, tier: "ambient" },
        correlationId: "corr-presence",
        expectedGoalVersion: 0,
      }),
    ).toMatchObject({ sourceLane: "discord_presence" });
    expect(DiscordPresenceActionSchema.options).toContain("discord.presence.go_live_start");
    const shareRef = `sha256:${"a".repeat(64)}:shares/frame.jpg`;
    expect(isShareArtifactRef(shareRef)).toBe(true);
    expect(isAttachableTurnMediaRef(shareRef)).toBe(true);
    expect(isAttachableTurnMediaRef(`sha256:${"a".repeat(64)}:tmp/frame.jpg`)).toBe(false);
    expect(DISCORD_PRESENCE_ACTION_RISK_CLASS["discord.presence.react"]).toBe("narrative-write");
    const write = DiscordPresenceWriteSchema.parse({
      schemaVersion: 1,
      idempotencyKey: "k1",
      action: "discord.presence.send_message",
      identity: {
        missionId: "m1",
        correlationId: "c1",
        profileHash: "p1",
        characterId: "clankie",
        credentialRef: "broker:discord_bot:lab",
        transportKind: "bot",
      },
      content: "hi",
      payload: { kind: "send_message", channelId: "ch", content: "hi" },
    });
    expect(write.identity.transportKind).toBe("bot");
    const react = DiscordPresenceWriteSchema.parse({
      schemaVersion: 1,
      idempotencyKey: "k-react",
      action: "discord.presence.react",
      identity: write.identity,
      payload: { kind: "react", channelId: "ch", messageId: "m1", emoji: "👍" },
    });
    expect(react.content).toBeUndefined();
    expect(resolveDiscordPresenceLedgerContent(react)).toBe("👍");
    expect(resolveDiscordPresenceLedgerContent({ payload: { kind: "typing_start", channelId: "c" } })).toBe(
      "typing",
    );
    const ambientTurn = DiscordPresenceChannelTurnRequestSchema.parse({
      schemaVersion: 1,
      deliveryId: "d1",
      identity: {
        presenceSessionId: "discord:dm:dm1",
        correlationId: "c1",
        profileHash: "p1",
        characterId: "clankie",
        credentialRef: "broker:discord_bot:lab",
        transportKind: "bot",
      },
      trigger: { kind: "dm", id: "m1", channelId: "dm1", actorId: "u1", body: "hey" },
    });
    expect(ambientTurn.trigger.kind).toBe("dm");
    expect(
      DiscordPresenceWriteSchema.parse({
        schemaVersion: 1,
        idempotencyKey: "ambient-reply",
        action: "discord.presence.reply",
        identity: ambientTurn.identity,
        payload: { kind: "reply", channelId: "dm1", messageId: "m1", content: "hello" },
      }).identity.presenceSessionId,
    ).toBe("discord:dm:dm1");
    expect(() =>
      DiscordPresenceWriteSchema.parse({
        schemaVersion: 1,
        idempotencyKey: "ambient-thread",
        action: "discord.presence.create_thread",
        identity: ambientTurn.identity,
        payload: { kind: "create_thread", channelId: "dm1", messageId: "m1", name: "nope" },
      }),
    ).toThrow(/mission attribution/);
    // The activity surface serves the ambient embodiment plane too (ADR 0063):
    // asked play has no mission, so its launch write attributes to the
    // presence session it serves. Authority is unchanged — publish-external
    // still routes through the operator approval gate.
    expect(
      DiscordPresenceWriteSchema.parse({
        schemaVersion: 1,
        idempotencyKey: "ambient-activity",
        action: "discord.presence.activity_start",
        identity: ambientTurn.identity,
        payload: { kind: "activity_start", guildId: "g1", channelId: "vc1", surface: "gba_emulator" },
      }).identity.presenceSessionId,
    ).toBe("discord:dm:dm1");
  });

  it("carries a content-free bridge voice presence note on Discord turn triggers", () => {
    const base = {
      schemaVersion: 1,
      deliveryId: "d-note",
      identity: {
        presenceSessionId: "discord:guild-1:channel-1",
        correlationId: "c-note",
        profileHash: "p1",
        characterId: "clankie",
        credentialRef: "broker:discord_bot:lab",
        transportKind: "bot",
      },
    };
    const trigger = {
      kind: "mention",
      id: "m-note",
      guildId: "guild-1",
      channelId: "channel-1",
      actorId: "u1",
      body: "clankie hop in vc",
    };
    const joined = DiscordPresenceChannelTurnRequestSchema.parse({
      ...base,
      trigger: { ...trigger, voicePresenceNote: { action: "joined", channelId: "voice-1" } },
    });
    expect(joined.trigger.voicePresenceNote).toEqual({ action: "joined", channelId: "voice-1" });
    const refused = DiscordPresenceChannelTurnRequestSchema.parse({
      ...base,
      trigger: { ...trigger, voicePresenceNote: { action: "join_refused", reason: "authority" } },
    });
    expect(refused.trigger.voicePresenceNote?.reason).toBe("authority");
    // Content-free discipline: enums and ids only, never a free-text side channel.
    expect(() =>
      DiscordPresenceChannelTurnRequestSchema.parse({
        ...base,
        trigger: { ...trigger, voicePresenceNote: { action: "joined", note: "free text" } },
      }),
    ).toThrow();
    expect(() =>
      DiscordPresenceChannelTurnRequestSchema.parse({
        ...base,
        trigger: {
          ...trigger,
          voicePresenceNote: { action: "join_refused", reason: "because I said so" },
        },
      }),
    ).toThrow();
  });

  it("validates additive captain-domain presence and lifecycle events", () => {
    const base = {
      id: "captain-status-1",
      occurredAt: "2026-07-11T12:00:00.000Z",
      missionId: "captain-presence",
      correlationId: "captain-generation-1",
      profileHash: "profile-1",
    };
    expect(
      CaptainPresenceEventSchema.parse({
        ...base,
        type: "captain.turn.started",
        data: {
          schemaVersion: 1,
          subjectId: "captain",
          captainId: "captain-eve",
          leaseId: "lease-1",
          generationId: "generation-1",
          sessionId: "session-1",
          turnId: "turn-1",
          state: "working",
          tier: 0,
          source: "eve.lifecycle",
          confidence: 1,
          observedAt: "2026-07-11T12:00:00.000Z",
        },
      }),
    ).toMatchObject({ type: "captain.turn.started", data: { state: "working", tier: 0 } });

    expect(
      CaptainPresenceReportSchema.parse({
        schemaVersion: 1,
        eventId: "input-1",
        leaseId: "lease-1",
        generationId: "generation-1",
        occurredAt: "2026-07-11T12:00:01.000Z",
        type: "captain.turn.settled",
        sessionId: "session-1",
        turnId: "turn-1",
        state: "waiting_user",
        questionSummary: "Approve the requested action?",
      }),
    ).toMatchObject({ type: "captain.turn.settled", state: "waiting_user" });

    expect(() =>
      CaptainPresenceReportSchema.parse({
        schemaVersion: 1,
        eventId: "forged-offline",
        leaseId: "lease-1",
        generationId: "generation-1",
        occurredAt: "2026-07-11T12:00:02.000Z",
        type: "captain.presence.offline",
      }),
    ).toThrow();
  });

  it("exposes a coherent named public type surface with typed get-not-found", () => {
    // Compile fixture: every public request/result name resolves as a named type
    // (RN never infers aliases from the union). A missing conversation is typed.
    const getResult: OperatorConversationGetResult = { op: "get", schemaVersion: 1 };
    expect(getResult.conversation).toBeUndefined();
    const getResponse: GetOperatorConversationResponse = { schemaVersion: 1 };
    expect(getResponse.conversation).toBeUndefined();
    const names:
      | [
          ListOperatorConversationsRequest,
          ListOperatorConversationsResponse,
          GetOperatorConversationRequest,
          CreateOperatorConversationRequest,
          ReplayOperatorConversationRequest,
          ReplayOperatorConversationResult,
          SubmitOperatorConversationTurnResult,
          OperatorConversationServiceRequest,
          OperatorConversationServiceResult,
          OperatorConversationListResult,
          OperatorConversationCreateResult,
          OperatorConversationReplayResult,
          OperatorConversationTailResult,
          OperatorConversationSendResult,
        ]
      | undefined = undefined;
    expect(names).toBeUndefined();
  });

  it("surfaces typed tail recovery and stops instead of silently resyncing", async () => {
    const dispatch = (
      request: OperatorConversationServiceRequest,
    ): Promise<OperatorConversationServiceResult> => {
      if (request.op !== "tail") throw new Error(`unexpected op ${request.op}`);
      return Promise.resolve({
        op: "tail",
        schemaVersion: 1,
        result: {
          schemaVersion: 1,
          status: "recover",
          conversationId: "c",
          code: "cursor_invalid",
          recoverable: true,
          resetCursor: "event:0:abcdefghijkl",
          message: "reset and replay",
        },
      });
    };
    const client = createOperatorConversationServiceClient(dispatch);
    const items: OperatorConversationTailItem[] = [];
    for await (const item of client.tail({
      schemaVersion: 1,
      conversationId: "c",
      surfaceClientId: "rn",
      cursor: "not-a-cursor",
    })) {
      items.push(item);
      if (items.length > 5) break;
    }
    // Exactly one typed recovery item, then the iterable stops (no auto-resync).
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("recovery");
    if (items[0]?.kind === "recovery") expect(items[0].recovery.code).toBe("cursor_invalid");
  });
});
