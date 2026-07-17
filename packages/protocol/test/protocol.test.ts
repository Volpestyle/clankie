import { readFile } from "node:fs/promises";
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
  ApprovalDecisionInputSchema,
  ApprovalEventSchema,
  ApprovalRequestRecordSchema,
  assertValidDag,
  CaptainPresenceEventSchema,
  CaptainPresenceReportSchema,
  CaptainLaneSchema,
  CaptainSessionLaneV2Schema,
  CharacterSnapshotSchema,
  DISCORD_PRESENCE_ACTION_RISK_CLASS,
  DiscordPresenceActionSchema,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteSchema,
  resolveDiscordPresenceLedgerContent,
  IntentCommandSchema,
  IntentContextSchema,
  MissionPlanSchema,
  MissionTriggerEventSchema,
  MissionTriggerSchema,
  createOperatorConversationServiceClient,
  OPERATOR_CONVERSATION_REF_MAX,
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
  TrackerNarrativeActionSchema,
  TrackerNarrativeWriteSchema,
  WorkerTranscriptAuthFailureSchema,
  WorkerTranscriptCursorExpiredSchema,
  WorkerTranscriptSnapshotSchema,
  WorkerTranscriptTailLineSchema,
  WorkerStatusEventSchema,
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

  it("validates the recorded garden worker transcript fixture and typed recovery envelopes", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/garden-worker-transcript.json", import.meta.url), "utf8"),
    );
    const snapshot = WorkerTranscriptSnapshotSchema.parse(fixture);
    expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
      "status",
      "narrative",
      "action",
      "artifact",
      "blocker",
      "completion",
    ]);
    expect(
      WorkerTranscriptTailLineSchema.parse({
        schemaVersion: 1,
        type: "worker_transcript.entry",
        entry: snapshot.entries[0],
        cursor: snapshot.nextCursor,
      }).entry.sequence,
    ).toBe(1);
    expect(
      WorkerTranscriptCursorExpiredSchema.parse({
        schemaVersion: 1,
        outcome: "cursor_expired",
        retainedFromSequence: 4,
        snapshotCursor: snapshot.nextCursor,
      }).outcome,
    ).toBe("cursor_expired");
    expect(
      WorkerTranscriptAuthFailureSchema.parse({
        schemaVersion: 1,
        outcome: "auth_failed",
        reason: "permission_denied",
      }).reason,
    ).toBe("permission_denied");
  });

  it("validates additive mission trigger records and semantic events", () => {
    const trigger = MissionTriggerSchema.parse({
      schemaVersion: 1,
      id: "daily-review",
      goal: "Review repository health",
      schedule: { kind: "cron", expression: "0 9 * * 1,2,3,4,5" },
      misfirePolicy: "run_once_late",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    });
    expect(
      MissionTriggerEventSchema.parse({
        id: "event-trigger-created",
        occurredAt: trigger.createdAt,
        missionId: "trigger:daily-review",
        correlationId: "trigger:daily-review",
        profileHash: "profile-trigger",
        type: "mission.trigger.created",
        data: { trigger },
      }),
    ).toMatchObject({ type: "mission.trigger.created", data: { trigger: { id: "daily-review" } } });
  });

  it("exposes exactly the five policy-classified tracker narrative actions", () => {
    expect(TrackerNarrativeActionSchema.options).toEqual([
      "tracker.comment.create",
      "tracker.agent-activity.thought.create",
      "tracker.agent-activity.response.create",
      "tracker.agent-activity.elicitation.create",
      "tracker.reaction.create",
    ]);
    expect(() =>
      TrackerNarrativeWriteSchema.parse({
        schemaVersion: 1,
        idempotencyKey: "delivery:escape",
        action: "tracker.priority.update",
        identity: {
          missionId: "mission-linear",
          taskId: "task-linear",
          workerRunId: "worker-linear",
          correlationId: "linear-delivery:test",
          profileHash: "profile-linear",
          workspaceId: "workspace-linear",
          appUserId: "app-linear",
        },
        issueId: "issue-linear",
        agentSessionId: "session-linear",
        content: "Must remain denied.",
      }),
    ).toThrow();
  });

  it("validates pending and decided approval records and semantic events", () => {
    const pending = ApprovalRequestRecordSchema.parse({
      id: "approval-1",
      missionId: "mission-1",
      taskId: "verify",
      workerRunId: "worker-1",
      action: "github.pr.merge",
      resource: { type: "pull_request", id: "example/repo#1" },
      rationale: {
        effect: "require_approval",
        reason: "Human approval is required.",
        matchedPolicyIds: ["invariant-floor:human-approval"],
      },
      requestedAt: "2026-07-11T21:00:00.000Z",
      status: "pending",
      correlationId: "correlation-1",
      profileHash: "profile-1",
    });
    expect(
      ApprovalEventSchema.parse({
        id: "event-1",
        occurredAt: pending.requestedAt,
        missionId: pending.missionId,
        taskId: pending.taskId,
        workerRunId: pending.workerRunId,
        correlationId: pending.correlationId,
        profileHash: pending.profileHash,
        type: "approval.requested",
        data: { approval: pending },
      }).data.approval,
    ).toEqual(pending);
    expect(() => ApprovalRequestRecordSchema.parse({ ...pending, status: "approved" })).toThrow();
    const approved = ApprovalRequestRecordSchema.parse({
      ...pending,
      status: "approved",
      decidedAt: "2026-07-11T21:01:00.000Z",
      decidedBy: "operator-james",
      reason: "Reviewed the evidence.",
    });
    expect(
      ApprovalEventSchema.parse({
        id: "event-2",
        occurredAt: "2026-07-11T21:02:00.000Z",
        missionId: approved.missionId,
        taskId: approved.taskId,
        workerRunId: approved.workerRunId,
        correlationId: approved.correlationId,
        profileHash: approved.profileHash,
        type: "approval.decided",
        data: {
          approval: approved,
          consumedAt: "2026-07-11T21:02:00.000Z",
          consumedBy: "worker-1",
        },
      }).data.approval.status,
    ).toBe("approved");
    expect(ApprovalDecisionInputSchema.parse({ decision: "deny", reason: " Unsafe " })).toEqual({
      decision: "deny",
      reason: "Unsafe",
    });
  });

  it("accepts a valid mission plan", () => {
    const plan = MissionPlanSchema.parse({
      missionId: "m1",
      goal: "Build the proof",
      rationale: "Exercise orchestration",
      profileHash: "hash",
      successCriteria: ["all checks pass"],
      tasks: [
        {
          id: "implement",
          title: "Implement",
          objective: "Write code",
          kind: "implementation",
          role: "implementer",
          successCriteria: ["file exists"],
          evidenceRequirements: ["A diff and passing unit test are attached."],
          estimatedDurationMinutes: 10,
          estimatedCostUsd: 0.25,
        },
        {
          id: "verify",
          title: "Verify",
          objective: "Run tests",
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          successCriteria: ["tests pass"],
          evidenceRequirements: ["The unchanged test command and exit code are recorded."],
        },
      ],
      plannedActions: [
        {
          id: "merge-change",
          taskId: "verify",
          action: "merge_pull_request",
          resource: { type: "pull_request", id: "example/repo#1" },
          rationale: "Integrate the independently verified change.",
        },
      ],
    });

    expect(() => assertValidDag(plan.tasks)).not.toThrow();
    expect(plan.tasks[0]).toMatchObject({
      role: "implementer",
      evidenceRequirements: ["A diff and passing unit test are attached."],
      estimatedDurationMinutes: 10,
      estimatedCostUsd: 0.25,
    });
    expect(plan.plannedActions[0]?.action).toBe("merge_pull_request");
  });

  it("rejects cycles", () => {
    expect(() =>
      assertValidDag([
        {
          id: "a",
          title: "A",
          objective: "A",
          kind: "implementation",
          role: "implementer",
          dependsOn: ["b"],
          executionClass: "automatic",
          risk: "low",
          writeScope: [],
          successCriteria: ["done"],
          evidenceRequirements: ["A diff is attached."],
          maxAttempts: 1,
          metadata: {},
        },
        {
          id: "b",
          title: "B",
          objective: "B",
          kind: "verification",
          role: "verifier",
          dependsOn: ["a"],
          executionClass: "automatic",
          risk: "low",
          writeScope: [],
          successCriteria: ["done"],
          evidenceRequirements: ["The test result is attached."],
          maxAttempts: 1,
          metadata: {},
        },
      ]),
    ).toThrow(/cycle/);
  });

  it("rejects tasks without an evidence contract", () => {
    expect(() =>
      MissionPlanSchema.parse({
        missionId: "m2",
        goal: "Build",
        rationale: "Prove the task contract",
        profileHash: "hash",
        successCriteria: ["done"],
        tasks: [
          {
            id: "implement",
            title: "Implement",
            objective: "Write code",
            kind: "implementation",
            role: "implementer",
            successCriteria: ["code exists"],
          },
        ],
      }),
    ).toThrow(/evidenceRequirements/);
  });

  it("rejects planned actions that reference unknown tasks", () => {
    expect(() =>
      MissionPlanSchema.parse({
        missionId: "m3",
        goal: "Build",
        rationale: "Prove action references",
        profileHash: "hash",
        successCriteria: ["done"],
        tasks: [
          {
            id: "implement",
            title: "Implement",
            objective: "Write code",
            kind: "implementation",
            role: "implementer",
            successCriteria: ["code exists"],
            evidenceRequirements: ["A diff is attached."],
          },
        ],
        plannedActions: [
          {
            id: "merge",
            taskId: "missing",
            action: "merge_pull_request",
            resource: { type: "pull_request", id: "example/repo#1" },
            rationale: "Integrate the change.",
          },
        ],
      }),
    ).toThrow(/unknown task/);
  });

  it("validates a versioned character snapshot and lane-bound intent", () => {
    expect(
      CharacterSnapshotSchema.parse({
        schemaVersion: 1,
        characterId: "clankie",
        goalVersion: 7,
        activeWorldId: "private-paper-world",
        activeEnvironmentSessionId: "minecraft-session-1",
        activeMissionId: "m-minecraft",
        goal: { kind: "collect", summary: "Collect oak logs" },
        activeActionId: "action-1",
        updatedAt: "2026-07-11T12:00:00.000Z",
      }),
    ).toMatchObject({ goalVersion: 7, sharedMemoryRefs: [] });

    expect(
      IntentCommandSchema.parse({
        schemaVersion: 1,
        intentId: "intent-8",
        characterId: "clankie",
        context: {
          sourceLane: "tui",
          authority: {
            principal: { kind: "human", id: "james" },
            tier: "authenticated",
          },
          correlationId: "corr-8",
          expectedGoalVersion: 7,
        },
        type: "set_goal",
        goal: { kind: "return", summary: "Return to spawn" },
        createdAt: "2026-07-11T12:00:01.000Z",
      }),
    ).toMatchObject({ type: "set_goal" });
  });

  it("rejects unknown captain lanes and intents without concurrency guards", () => {
    expect(() => CaptainLaneSchema.parse("global")).toThrow();
    expect(CaptainLaneSchema.options).toEqual(["tui", "discord_voice", "gameplay"]);
    expect(() => CaptainLaneSchema.parse("discord_presence")).toThrow();
    expect(() =>
      IntentCommandSchema.parse({
        schemaVersion: 1,
        intentId: "intent-unsafe",
        characterId: "clankie",
        context: {
          sourceLane: "gameplay",
          authority: {
            principal: { kind: "captain", id: "clankie" },
            tier: "autonomous",
          },
          correlationId: "corr-unsafe",
        },
        type: "steer",
        createdAt: "2026-07-11T12:00:01.000Z",
      }),
    ).toThrow(/expectedGoalVersion/);
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
  });

  it("binds missions and tasks to the same gameplay world contract", () => {
    const binding = {
      schemaVersion: 1 as const,
      environmentKind: "minecraft_java",
      characterId: "clankie",
      worldId: "private-paper-world",
      lane: "gameplay" as const,
    };
    const parsed = MissionPlanSchema.parse({
      missionId: "minecraft-mission",
      goal: "Play Minecraft",
      rationale: "Exercise an interactive environment",
      profileHash: "profile-hash",
      successCriteria: ["Paper verifies the outcome"],
      environmentBindings: [binding],
      tasks: [
        {
          id: "play",
          title: "Play",
          objective: "Complete the bounded goal",
          kind: "implementation",
          role: "implementer",
          successCriteria: ["goal complete"],
          evidenceRequirements: ["server-state proof"],
          environmentBinding: binding,
        },
      ],
    });

    expect(parsed.tasks[0]?.environmentBinding).toEqual(binding);
    expect(parsed.environmentBindings).toEqual([binding]);
  });

  it("rejects a task environment binding outside its mission world", () => {
    expect(() =>
      MissionPlanSchema.parse({
        missionId: "minecraft-mission",
        goal: "Play Minecraft",
        rationale: "Exercise an interactive environment",
        profileHash: "profile-hash",
        successCriteria: ["goal complete"],
        environmentBindings: [
          {
            schemaVersion: 1,
            environmentKind: "minecraft_java",
            characterId: "clankie",
            worldId: "allowed-world",
            lane: "gameplay",
          },
        ],
        tasks: [
          {
            id: "play",
            title: "Play",
            objective: "Complete the bounded goal",
            kind: "implementation",
            role: "implementer",
            successCriteria: ["goal complete"],
            evidenceRequirements: ["server-state proof"],
            environmentBinding: {
              schemaVersion: 1,
              environmentKind: "minecraft_java",
              characterId: "clankie",
              worldId: "other-world",
              lane: "gameplay",
            },
          },
        ],
      }),
    ).toThrow(/not declared by the mission/);
  });

  it("validates additive worker status events with provenance", () => {
    expect(
      WorkerStatusEventSchema.parse({
        id: "status-1",
        occurredAt: "2026-07-11T12:00:00.000Z",
        missionId: "mission-1",
        taskId: "task-1",
        workerRunId: "run-1",
        correlationId: "correlation-1",
        profileHash: "profile-1",
        type: "worker.waiting_user",
        data: {
          state: "waiting_user",
          source: "codex.app_server",
          tier: 0,
          confidence: 1,
          observedAt: "2026-07-11T12:00:00.000Z",
          questionSummary: "Approve the requested command?",
        },
      }),
    ).toMatchObject({ type: "worker.waiting_user", data: { tier: 0, confidence: 1 } });

    expect(() =>
      WorkerStatusEventSchema.parse({
        id: "status-2",
        occurredAt: "2026-07-11T12:00:00.000Z",
        missionId: "mission-1",
        taskId: "task-1",
        workerRunId: "run-1",
        correlationId: "correlation-1",
        profileHash: "profile-1",
        type: "worker.turn.settled",
        data: { state: "idle", source: "pi.rpc", tier: 0, confidence: 1 },
      }),
    ).toThrow(/observedAt/);
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
