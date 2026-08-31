import { describe, expect, it } from "vitest";
import type {
  OperatorConversationServiceRequest,
  OperatorConversationServiceResult,
  OperatorConversationTailItem,
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
  defaultOperatorAgentAppearance,
  OperatorAgentAppearanceSchema,
  OperatorAgentNameSchema,
  OperatorConversationRecoverySchema,
  OperatorConversationRevisionConflictSchema,
  OperatorConversationSchema,
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  OperatorConversationStreamEventSchema,
  OPERATOR_TERMINAL_INPUT_BASE64_MAX,
  OperatorTerminalControlRequestSchema,
  OperatorTerminalControlResultSchema,
  OperatorTerminalFrameSchema,
  OperatorTerminalInputRequestSchema,
  OperatorTerminalObservationResultSchema,
  OperatorTerminalTailItemSchema,
  TAKE_CONTROL_GRANTS,
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
        type: "activity",
        phase: "responding",
      }),
    ).toMatchObject({ type: "activity", phase: "responding" });
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

  it("only accepts real message submits", () => {
    expect(
      SubmitOperatorConversationTurnSchema.parse({
        schemaVersion: 1,
        kind: "message",
        conversationId: "global-default",
        surfaceClientId: "rn",
        expectedRevision: 3,
        message: "answer",
      }),
    ).toMatchObject({ kind: "message", message: "answer" });
    for (const kind of ["input_response", "worker_steer"]) {
      expect(() =>
        SubmitOperatorConversationTurnSchema.parse({
          schemaVersion: 1,
          kind,
          conversationId: "global-default",
          surfaceClientId: "rn",
          expectedRevision: 3,
        }),
      ).toThrow();
    }
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
        status: "seat_offline",
        conversationId: "seat-thread",
        seatId: "term-potato",
        currentRevision: 4,
        safeCursor: "event:9",
      }),
    ).toMatchObject({ status: "seat_offline", seatId: "term-potato" });
    expect(() =>
      SubmitOperatorConversationTurnResultSchema.parse({
        schemaVersion: 1,
        status: "unsupported",
        conversationId: "global-default",
      }),
    ).toThrow();
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
    // The callable request/result envelope is strict.
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
    expect(
      OperatorConversationServiceRequestSchema.parse({
        op: "close",
        schemaVersion: 1,
        conversationId: "conversation-global-default",
      }),
    ).toMatchObject({ op: "close" });
    expect(
      OperatorConversationServiceRequestSchema.parse({
        op: "autonomy",
        schemaVersion: 1,
        conversationId: "conversation-global-default",
        command: { action: "set_goal", objective: "Ship it", tokenBudget: 10_000 },
      }),
    ).toMatchObject({ op: "autonomy", command: { action: "set_goal" } });
    expect(() =>
      OperatorConversationServiceRequestSchema.parse({
        op: "autonomy",
        schemaVersion: 1,
        conversationId: "conversation-global-default",
        command: { action: "set_goal", objective: "Ship it", tokenBudget: 0 },
      }),
    ).toThrow();
    expect(OperatorConversationServiceRequestSchema.parse({ op: "roster", schemaVersion: 1 })).toMatchObject({
      op: "roster",
    });
    expect(
      OperatorConversationServiceRequestSchema.parse({
        op: "fleet",
        schemaVersion: 1,
        cursor: "fleet-instance:4",
        waitMs: 20_000,
      }),
    ).toMatchObject({ op: "fleet", cursor: "fleet-instance:4" });
    expect(
      OperatorConversationServiceRequestSchema.parse({
        op: "composer_catalog",
        schemaVersion: 1,
        conversationId: "conversation-global-default",
      }),
    ).toMatchObject({ op: "composer_catalog", conversationId: "conversation-global-default" });
    expect(
      OperatorConversationServiceResultSchema.parse({
        op: "composer_catalog",
        schemaVersion: 1,
        catalog: {
          schemaVersion: 1,
          commands: [],
          skills: [
            {
              name: "browser:control-in-app-browser",
              description: "Control the browser",
              source: "codex",
              invocation: "$browser:control-in-app-browser",
            },
          ],
        },
      }),
    ).toMatchObject({
      op: "composer_catalog",
      catalog: { skills: [{ name: "browser:control-in-app-browser" }] },
    });
    expect(
      OperatorConversationServiceResultSchema.parse({
        op: "roster",
        schemaVersion: 1,
        seats: [
          {
            seatId: "term_65a2015731452d",
            occupantId: "session-1",
            personaId: "agent-1",
            harness: "codex",
            status: "idle",
            title: "clankie",
          },
        ],
      }),
    ).toMatchObject({ op: "roster", seats: [{ seatId: "term_65a2015731452d" }] });
    expect(
      OperatorConversationServiceResultSchema.parse({
        op: "terminal_catalog",
        schemaVersion: 1,
        sessions: [
          {
            terminalId: "term_65a2015731452d",
            label: "clankie",
            workspace: { id: "w1", label: "clankie", number: 1 },
            tab: { id: "w1:t1", label: "main", number: 1 },
            pane: { id: "w1:p1" },
          },
        ],
      }),
    ).toMatchObject({ op: "terminal_catalog", sessions: [{ pane: { id: "w1:p1" } }] });
    expect(
      OperatorConversationServiceRequestSchema.parse({
        op: "close_seat",
        schemaVersion: 1,
        seatId: "term_65a2015731452d",
      }),
    ).toMatchObject({ op: "close_seat", seatId: "term_65a2015731452d" });
    expect(
      OperatorConversationServiceResultSchema.parse({
        op: "close_seat",
        schemaVersion: 1,
        seatId: "term_65a2015731452d",
        closed: true,
      }),
    ).toMatchObject({ op: "close_seat", closed: true });
    const terminalRequest = OperatorConversationServiceRequestSchema.parse({
      op: "terminal_tail",
      schemaVersion: 1,
      observation: {
        schemaVersion: 1,
        terminalId: "term_65a2015731452d",
        surfaceClientId: "native-ios",
        columns: 120,
        rows: 40,
      },
    });
    expect(terminalRequest).toMatchObject({ op: "terminal_tail", observation: { columns: 120, rows: 40 } });
    expect(
      OperatorConversationServiceRequestSchema.parse({
        op: "cancel",
        schemaVersion: 1,
        conversationId: "global-default",
        runId: "run-1f00",
      }),
    ).toMatchObject({ op: "cancel", runId: "run-1f00" });
    expect(
      OperatorConversationServiceResultSchema.parse({
        op: "cancel",
        schemaVersion: 1,
        conversationId: "global-default",
        runId: "run-1f00",
        cancelled: true,
      }),
    ).toMatchObject({ op: "cancel", cancelled: true });
    expect(OperatorConversationServiceRequestSchema.options).toHaveLength(
      OperatorConversationServiceResultSchema.options.length,
    );
    expect(typeof createOperatorConversationServiceClient).toBe("function");
  });

  it("models bounded native terminal frames and typed reset outcomes", () => {
    const frame = OperatorTerminalFrameSchema.parse({
      schemaVersion: 1,
      type: "terminal.frame",
      terminalId: "term_65a2015731452d",
      sequence: 1,
      encoding: "base64",
      data: "G1sySg==",
      columns: 120,
      rows: 40,
      full: true,
    });
    expect(
      OperatorTerminalTailItemSchema.parse({ kind: "frame", streamId: "stream-1", frame }),
    ).toMatchObject({
      kind: "frame",
      frame: { sequence: 1, full: true },
    });
    expect(
      OperatorTerminalObservationResultSchema.parse({
        schemaVersion: 1,
        status: "reset",
        terminalId: frame.terminalId,
        surfaceClientId: "native-ios",
        reason: "sequence_expired",
      }),
    ).toMatchObject({ status: "reset", reason: "sequence_expired" });
    expect(() => OperatorTerminalFrameSchema.parse({ ...frame, data: "not base64" })).toThrow();
    expect(() => OperatorTerminalFrameSchema.parse({ ...frame, full: false, data: "" })).toThrow();
    expect(
      OperatorTerminalFrameSchema.parse({
        ...frame,
        full: false,
        data: "",
        scrollback: { encoding: "base64", data: "b2xkIHJvdw0K", rows: 1 },
      }),
    ).toMatchObject({ scrollback: { rows: 1 } });
    expect(() =>
      OperatorTerminalObservationResultSchema.parse({
        schemaVersion: 1,
        status: "page",
        terminalId: "another-terminal",
        surfaceClientId: "native-ios",
        cursor: { streamId: "stream-1", sequence: 1 },
        frames: [frame],
        hasMore: false,
      }),
    ).toThrow();
  });

  it("models the terminal input lease and bounded raw-byte writes (ADR 0144)", () => {
    expect(
      OperatorTerminalControlResultSchema.parse({
        schemaVersion: 1,
        status: "granted",
        grant: {
          schemaVersion: 1,
          terminalId: "term_65a2015731452d",
          leaseToken: "lease-1",
          owner: { principalId: "command-center-mobile" },
          expiresAt: "2026-08-30T12:00:00.000Z",
        },
      }),
    ).toMatchObject({ status: "granted", grant: { leaseToken: "lease-1" } });
    expect(
      OperatorTerminalInputRequestSchema.parse({
        schemaVersion: 1,
        terminalId: "term_65a2015731452d",
        surfaceClientId: "command-center-mobile",
        leaseToken: "lease-1",
        dataBase64: "G1tB",
      }),
    ).toMatchObject({ dataBase64: "G1tB" });
    expect(() =>
      OperatorTerminalInputRequestSchema.parse({
        schemaVersion: 1,
        terminalId: "term_65a2015731452d",
        surfaceClientId: "command-center-mobile",
        leaseToken: "lease-1",
        dataBase64: "not base64",
      }),
    ).toThrow();
    expect(() =>
      OperatorTerminalInputRequestSchema.parse({
        schemaVersion: 1,
        terminalId: "term_65a2015731452d",
        surfaceClientId: "command-center-mobile",
        leaseToken: "lease-1",
        dataBase64: "QUFB".repeat(OPERATOR_TERMINAL_INPUT_BASE64_MAX / 4 + 1),
      }),
    ).toThrow();
    expect(
      OperatorTerminalControlRequestSchema.parse({
        schemaVersion: 1,
        action: "resize",
        terminalId: "term_65a2015731452d",
        surfaceClientId: "command-center-mobile",
        leaseToken: "lease-1",
        columns: 48,
        rows: 24,
      }),
    ).toMatchObject({ action: "resize", columns: 48, rows: 24 });
    expect(() =>
      OperatorTerminalControlRequestSchema.parse({
        schemaVersion: 1,
        action: "resize",
        terminalId: "term_65a2015731452d",
        surfaceClientId: "command-center-mobile",
        leaseToken: "lease-1",
        columns: 48,
      }),
    ).toThrow();
    expect(
      OperatorTerminalControlRequestSchema.parse({
        schemaVersion: 1,
        action: "scroll",
        terminalId: "term_65a2015731452d",
        surfaceClientId: "command-center-mobile",
        leaseToken: "lease-1",
        direction: "up",
        lines: 3,
        column: 10,
        row: 4,
      }),
    ).toMatchObject({ action: "scroll", direction: "up", lines: 3, column: 10, row: 4 });
    expect(() =>
      OperatorTerminalControlRequestSchema.parse({
        schemaVersion: 1,
        action: "scroll",
        terminalId: "term_65a2015731452d",
        surfaceClientId: "command-center-mobile",
        leaseToken: "lease-1",
        direction: "up",
      }),
    ).toThrow();
    expect(() =>
      OperatorTerminalControlRequestSchema.parse({
        schemaVersion: 1,
        action: "renew",
        terminalId: "term_65a2015731452d",
        surfaceClientId: "command-center-mobile",
        leaseToken: "lease-1",
        lines: 3,
      }),
    ).toThrow();
    expect(TAKE_CONTROL_GRANTS.terminalControl).toBe(true);
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
    const toolProgress = DiscordPresenceWriteSchema.parse({
      schemaVersion: 1,
      idempotencyKey: "k-tool-progress",
      action: "discord.presence.tool_progress",
      identity: write.identity,
      payload: {
        kind: "tool_progress",
        channelId: "ch",
        replyToMessageId: "m1",
        phase: "running",
        categories: ["browsing"],
        toolCalls: 1,
        activeToolCalls: 1,
        failedToolCalls: 0,
        elapsedSeconds: 2,
      },
    });
    expect(resolveDiscordPresenceLedgerContent(toolProgress)).toBe("tool_progress:running");
    expect(() =>
      DiscordPresenceWriteSchema.parse({
        ...toolProgress,
        payload: { ...toolProgress.payload, activeToolCalls: 2 },
      }),
    ).toThrow(/counts cannot exceed/u);
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
    expect(
      DiscordPresenceWriteSchema.parse({
        schemaVersion: 1,
        idempotencyKey: "ambient-thread",
        action: "discord.presence.create_thread",
        identity: ambientTurn.identity,
        payload: { kind: "create_thread", channelId: "dm1", messageId: "m1", name: "topic" },
      }).identity.presenceSessionId,
    ).toBe("discord:dm:dm1");
    // The activity surface serves the ambient embodiment plane too (ADR 0063):
    // asked play has no mission, so its launch write attributes to the
    // presence session it serves. The owning body still supplies the target.
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

  it("types get-not-found on the canonical service result", () => {
    const result: Extract<OperatorConversationServiceResult, { op: "get" }> = {
      op: "get",
      schemaVersion: 1,
    };
    expect(result.conversation).toBeUndefined();
  });

  it("closes through the canonical service client", async () => {
    const requests: OperatorConversationServiceRequest[] = [];
    const client = createOperatorConversationServiceClient(async (request) => {
      requests.push(request);
      return {
        op: "close",
        schemaVersion: 1,
        conversationId: "conversation-1",
        closed: true,
      };
    });

    await expect(client.close("conversation-1")).resolves.toBe(true);
    expect(requests).toEqual([{ op: "close", schemaVersion: 1, conversationId: "conversation-1" }]);
  });

  it("forks through the canonical service client", async () => {
    const client = createOperatorConversationServiceClient(async (request) => ({
      op: "fork",
      schemaVersion: 1,
      conversation: {
        schemaVersion: 1,
        conversationId: "side-1",
        parentConversationId: request.op === "fork" ? request.parentConversationId : "unexpected",
        scope: { kind: "global" },
        title: "BTW",
        isDefault: false,
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
        sessionState: "waiting",
        revision: 0,
      },
    }));

    await expect(client.fork("conversation-1")).resolves.toMatchObject({
      conversationId: "side-1",
      parentConversationId: "conversation-1",
    });
  });

  it("reads the fleet roster through the canonical service client", async () => {
    const client = createOperatorConversationServiceClient(async (request) => {
      expect(request).toEqual({ op: "roster", schemaVersion: 1 });
      return {
        op: "roster",
        schemaVersion: 1,
        seats: [
          {
            seatId: "term-potato",
            occupantId: "session-potato",
            personaId: "agent-potato",
            harness: "codex",
            status: "idle",
            title: "worker",
          },
        ],
      };
    });

    await expect(client.roster()).resolves.toEqual([
      {
        seatId: "term-potato",
        occupantId: "session-potato",
        personaId: "agent-potato",
        harness: "codex",
        status: "idle",
        title: "worker",
      },
    ]);
  });

  it("parks a coherent fleet snapshot behind its cursor", async () => {
    const client = createOperatorConversationServiceClient(
      async (request) => {
        expect(request).toEqual({
          op: "fleet",
          schemaVersion: 1,
          cursor: "fleet-instance:4",
          waitMs: 1_200,
        });
        return {
          op: "fleet",
          schemaVersion: 1,
          snapshot: {
            schemaVersion: 1,
            cursor: "fleet-instance:5",
            seats: [],
            personas: [],
            channels: [],
          },
        };
      },
      { fleetWaitMs: 1_200 },
    );

    await expect(client.fleet?.("fleet-instance:4")).resolves.toMatchObject({
      cursor: "fleet-instance:5",
      seats: [],
      personas: [],
      channels: [],
    });
  });

  it("reads the selected conversation's composer catalog through the canonical client", async () => {
    const client = createOperatorConversationServiceClient(async (request) => {
      expect(request).toEqual({
        op: "composer_catalog",
        schemaVersion: 1,
        conversationId: "conversation-worker",
      });
      return {
        op: "composer_catalog",
        schemaVersion: 1,
        catalog: {
          schemaVersion: 1,
          commands: [],
          skills: [
            {
              name: "review",
              description: "Review the current work",
              source: "codex",
              invocation: "$review",
            },
          ],
        },
      };
    });

    await expect(client.composerCatalog?.("conversation-worker")).resolves.toMatchObject({
      skills: [{ name: "review", invocation: "$review" }],
    });
  });

  it("models persona identity with more than the six non-operator tints", () => {
    expect(
      OperatorAgentAppearanceSchema.safeParse({
        variant: "gold",
        accessory: "none",
        shape: "circle",
      }).success,
    ).toBe(false);
    expect(OperatorAgentNameSchema.safeParse("Discord helper").success).toBe(false);
    const appearances = Array.from({ length: 12 }, (_, index) =>
      defaultOperatorAgentAppearance("codex", `agent-${String(index)}`),
    );
    expect(new Set(appearances.map((appearance) => JSON.stringify(appearance))).size).toBeGreaterThan(6);
    expect(appearances.some((appearance) => appearance.accessory !== "none")).toBe(true);
    expect(appearances.some((appearance) => appearance.shape !== "circle")).toBe(true);
  });

  it("reads Herdr's terminal hierarchy through the canonical service client", async () => {
    const client = createOperatorConversationServiceClient(async (request) => {
      expect(request).toEqual({ op: "terminal_catalog", schemaVersion: 1 });
      return {
        op: "terminal_catalog",
        schemaVersion: 1,
        sessions: [
          {
            terminalId: "term-potato",
            label: "worker",
            workspace: { id: "w1", label: "clankie", number: 1 },
            tab: { id: "w1:t1", label: "main", number: 1 },
            pane: { id: "w1:p1" },
          },
        ],
      };
    });

    await expect(client.terminalCatalog!()).resolves.toMatchObject([
      { terminalId: "term-potato", workspace: { label: "clankie" }, tab: { label: "main" } },
    ]);
  });

  it("closes a fleet seat through the canonical service client", async () => {
    const client = createOperatorConversationServiceClient(async (request) => {
      if (request.op !== "close_seat") throw new Error(`unexpected ${request.op}`);
      expect(request).toEqual({ op: "close_seat", schemaVersion: 1, seatId: "term-potato" });
      return { op: "close_seat", schemaVersion: 1, seatId: request.seatId, closed: true };
    });

    await expect(client.closeSeat("term-potato")).resolves.toBe(true);
  });

  it("yields the live draft, once per change, and takes it down when it settles", async () => {
    const pages = [
      { live: { sequence: 4, role: "captain" as const, text: "half a thou" }, events: [] },
      { live: { sequence: 4, role: "captain" as const, text: "half a thou" }, events: [] },
      { live: { sequence: 5, role: "captain" as const, text: "half a thought" }, events: [] },
      { events: [] },
    ];
    const seen: (number | undefined)[] = [];
    let index = 0;
    const dispatch = (
      request: OperatorConversationServiceRequest,
    ): Promise<OperatorConversationServiceResult> => {
      if (request.op !== "tail") throw new Error(`unexpected op ${request.op}`);
      seen.push(request.tail.liveSequence);
      const page = pages[Math.min(index++, pages.length - 1)]!;
      return Promise.resolve({
        op: "tail",
        schemaVersion: 1,
        result: {
          schemaVersion: 1,
          status: "page",
          conversationId: "c",
          surfaceClientId: "rn",
          events: page.events,
          retainedFromCursor: "000000000000",
          nextCursor: "000000000001",
          safeCursor: "000000000001",
          hasMore: false,
          ...(page.live === undefined ? {} : { live: page.live }),
        },
      });
    };
    // No idle sleep: this exercises the item stream, not the pacing.
    const client = createOperatorConversationServiceClient(dispatch, { tailIdleMs: 0 });
    const items: OperatorConversationTailItem[] = [];
    for await (const item of client.tail({
      schemaVersion: 1,
      conversationId: "c",
      surfaceClientId: "rn",
    })) {
      items.push(item);
      if (items.length >= 3) break;
    }

    // One item per change: the repeated draft is not re-yielded, and the page
    // that no longer carries one takes it down.
    expect(items.map((item) => (item.kind === "live" ? item.draft?.text : item.kind))).toEqual([
      "half a thou",
      "half a thought",
      undefined,
    ]);
    // Each request reports what this surface has already drawn.
    expect(seen.slice(0, 4)).toEqual([0, 4, 4, 5]);
  });

  it("asks the service to park the tail rather than fast-polling it", async () => {
    let waited: number | undefined;
    const dispatch = (
      request: OperatorConversationServiceRequest,
    ): Promise<OperatorConversationServiceResult> => {
      if (request.op !== "tail") throw new Error(`unexpected op ${request.op}`);
      waited = request.tail.waitMs;
      return Promise.resolve({
        op: "tail",
        schemaVersion: 1,
        result: {
          schemaVersion: 1,
          status: "recover",
          conversationId: "c",
          code: "cursor_reset",
          recoverable: true,
          resetCursor: "000000000001",
          message: "stop",
        },
      });
    };
    const client = createOperatorConversationServiceClient(dispatch, { tailWaitMs: 9_000 });
    for await (const item of client.tail({
      schemaVersion: 1,
      conversationId: "c",
      surfaceClientId: "rn",
    })) {
      expect(item.kind).toBe("recovery");
    }
    expect(waited).toBe(9_000);
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
