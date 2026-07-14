import { describe, expect, it, vi } from "vitest";
import { ClankieApiClient } from "../src/index.ts";

describe("ClankieApiClient runner surface", () => {
  it("authenticates and validates Discord presence phase events", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:4310/v1/discord/presence-session-events");
      expect(init?.headers).toMatchObject({ authorization: "Bearer captain-secret" });
      const event = JSON.parse(String(init?.body)) as { data: { session: unknown } };
      return Response.json({ accepted: true, session: event.data.session });
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      captainToken: "captain-secret",
    });
    const session = {
      schemaVersion: 1 as const,
      sessionId: "discord:bot:fixture",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot" as const,
      phase: "present" as const,
      gatewayConnected: true,
      voiceGuildIds: [],
      revision: 2,
      updatedAt: "2026-07-14T18:00:02.000Z",
    };
    await expect(
      client.recordDiscordPresencePhase({
        schemaVersion: 1,
        plane: "semantic",
        id: "phase-2",
        type: "discord.presence.session.phase_changed",
        occurredAt: "2026-07-14T18:00:02.000Z",
        correlationId: "discord:bot:fixture",
        sessionId: "discord:bot:fixture",
        data: {
          previousPhase: "connecting",
          phase: "present",
          reason: "gateway_ready",
          session,
        },
      }),
    ).resolves.toEqual({ accepted: true, session });
  });

  it("authenticates bounded Discord presence channel turns", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:4310/v1/captain/channel-turns");
      expect(init?.headers).toMatchObject({ authorization: "Bearer captain-secret" });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        deliveryId: "message-1",
        identity: { presenceSessionId: "discord:dm:dm-1" },
        trigger: { kind: "dm", body: "hello" },
      });
      return Response.json({
        state: "settled",
        captainSessionId: "eve-session-1",
        turnId: "turn-1",
        response: "Hi there.",
      });
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      captainToken: "captain-secret",
    });

    await expect(
      client.submitDiscordCaptainChannelTurn({
        schemaVersion: 1,
        deliveryId: "message-1",
        identity: {
          presenceSessionId: "discord:dm:dm-1",
          correlationId: "discord-message:message-1",
          profileHash: "profile-1",
          characterId: "clankie",
          credentialRef: "discord_bot",
          transportKind: "bot",
        },
        trigger: { kind: "dm", id: "message-1", channelId: "dm-1", actorId: "james", body: "hello" },
        contextMessages: [],
      }),
    ).resolves.toMatchObject({ state: "settled", response: "Hi there." });
  });

  it("authenticates presence actions with the bridge's live session claim", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:4310/v1/discord/presence-actions");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer captain-secret",
        "x-clankie-discord-presence-phase": "present",
        "x-clankie-discord-presence-revision": "2",
        "x-clankie-discord-presence-session": "discord:bot:fixture",
      });
      return Response.json({
        id: "message-1:reply",
        action: "discord.presence.reply",
        transportKind: "bot",
        channelId: "dm-1",
        messageId: "reply-1",
      });
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      captainToken: "captain-secret",
    });

    await expect(
      client.executeDiscordPresenceAction(
        {
          schemaVersion: 1,
          idempotencyKey: "message-1:reply",
          action: "discord.presence.reply",
          identity: {
            presenceSessionId: "discord:dm:dm-1",
            correlationId: "discord-message:message-1",
            profileHash: "profile-1",
            characterId: "clankie",
            credentialRef: "discord_bot",
            transportKind: "bot",
          },
          content: "Hi there.",
          payload: {
            kind: "reply",
            channelId: "dm-1",
            messageId: "message-1",
            content: "Hi there.",
          },
        },
        {
          schemaVersion: 1,
          sessionId: "discord:bot:fixture",
          phase: "present",
          revision: 2,
        },
      ),
    ).resolves.toMatchObject({ messageId: "reply-1" });
  });

  it("carries issue comments through the credential-free narrative route", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:4310/v1/tracker/narratives");
      expect(init?.headers).not.toHaveProperty("authorization");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        action: "tracker.comment.create",
        issueId: "issue-1",
        content: "Visible update.",
      });
      return Response.json({
        id: "comment-1",
        action: "tracker.comment.create",
        appUserId: "app-linear",
      });
    });
    const client = new ClankieApiClient({ baseUrl: "http://127.0.0.1:4310", fetchImpl });

    await expect(
      client.writeTrackerNarrative({
        schemaVersion: 1,
        idempotencyKey: "delivery:comment",
        action: "tracker.comment.create",
        identity: {
          missionId: "mission-linear",
          taskId: "task-linear",
          workerRunId: "worker-linear",
          correlationId: "linear-delivery:test",
          profileHash: "profile-linear",
          workspaceId: "workspace-linear",
          appUserId: "app-linear",
        },
        issueId: "issue-1",
        agentSessionId: "session-1",
        content: "Visible update.",
      }),
    ).resolves.toEqual({
      id: "comment-1",
      action: "tracker.comment.create",
      appUserId: "app-linear",
    });
  });

  it("authenticates and validates the operator approval surface", async () => {
    const approval = {
      id: "approval-1",
      missionId: "mission-1",
      action: "github.pr.merge",
      resource: { type: "pull_request", id: "example/repo#1" },
      rationale: {
        effect: "require_approval",
        reason: "Human approval is required.",
        matchedPolicyIds: ["invariant-floor:human-approval"],
        obligations: [],
      },
      requestedAt: "2026-07-11T21:00:00.000Z",
      status: "pending",
      correlationId: "correlation-1",
      profileHash: "profile-1",
    } as const;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer operator-secret" });
      if (String(input).includes("/decision")) {
        expect(init?.body).toBe(JSON.stringify({ decision: "approve", reason: "Reviewed evidence." }));
        return Response.json({
          ...approval,
          status: "approved",
          decidedAt: "2026-07-11T21:01:00.000Z",
          decidedBy: "operator-1",
          reason: "Reviewed evidence.",
        });
      }
      expect(String(input)).toContain("/v1/approvals?status=pending");
      return Response.json([approval]);
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      operatorToken: "operator-secret",
    });

    await expect(client.listApprovals()).resolves.toEqual([approval]);
    await expect(
      client.decideApproval("approval-1", { decision: "approve", reason: "Reviewed evidence." }),
    ).resolves.toMatchObject({ status: "approved", decidedBy: "operator-1" });
  });

  it("starts missions and authenticates runner claims", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/start")) {
        expect(init?.headers).toMatchObject({ authorization: "Bearer captain-secret" });
        return Response.json({ missionId: "mission-1" }, { status: 202 });
      }
      if (url.endsWith("/recovery")) {
        expect(init?.headers).toMatchObject({ authorization: "Bearer captain-secret" });
        return Response.json({ accepted: true }, { status: 202 });
      }
      if (url.endsWith("/v1/captain/presence")) {
        expect(init?.headers).toMatchObject({ authorization: "Bearer captain-secret" });
        return Response.json({ accepted: true });
      }
      expect(init?.headers).toMatchObject({
        authorization: "Bearer runner-secret",
        "x-clankie-runner-id": "runner-1",
      });
      return Response.json({
        assignment: {
          missionId: "mission-1",
          profileHash: "profile",
          workerRunId: "run-1",
          attempt: 1,
          task: {
            id: "implement",
            title: "Implement",
            objective: "Implement",
            kind: "implementation",
            role: "implementer",
            dependsOn: [],
            executionClass: "automatic",
            risk: "low",
            writeScope: ["src/**"],
            successCriteria: ["done"],
            evidenceRequirements: ["diff"],
            maxAttempts: 1,
            metadata: {},
          },
          worker: {
            id: "codex-implementer",
            displayName: "Codex implementer",
            harness: "codex",
            capabilities: {
              kinds: ["implementation"],
              canWrite: true,
              supportsStructuredEvents: true,
              supportsTerminal: true,
              supportsNativeSession: true,
            },
          },
        },
      });
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      runnerToken: "runner-secret",
      runnerId: "runner-1",
      captainToken: "captain-secret",
    });
    await expect(client.startMission("mission-1")).resolves.toMatchObject({ missionId: "mission-1" });
    await expect(
      client.addRecovery("mission-1", {
        commandId: "recover-1",
        failedTaskId: "verify",
        debugger: {
          id: "debug",
          title: "Debug",
          objective: "repair the failure",
          kind: "debugging",
          role: "debugger",
          dependsOn: ["implement"],
          executionClass: "automatic",
          risk: "low",
          writeScope: ["src/**"],
          successCriteria: ["fixed"],
          evidenceRequirements: ["diff"],
          maxAttempts: 1,
          metadata: {},
        },
        reverify: {
          id: "reverify",
          title: "Reverify",
          objective: "rerun unchanged checks",
          kind: "verification",
          role: "verifier",
          dependsOn: ["debug"],
          executionClass: "automatic",
          risk: "low",
          writeScope: [],
          successCriteria: ["passes"],
          evidenceRequirements: ["test report"],
          maxAttempts: 1,
          metadata: {},
        },
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      client.recordCaptainPresence({
        schemaVersion: 1,
        eventId: "heartbeat-1",
        leaseId: "lease-1",
        generationId: "generation-1",
        occurredAt: "2026-07-11T12:00:00.000Z",
        type: "captain.heartbeat",
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      client.claimTask("claim-1", [
        {
          id: "codex-implementer",
          displayName: "Codex implementer",
          harness: "codex",
          capabilities: {
            kinds: ["implementation"],
            canWrite: true,
            supportsStructuredEvents: true,
            supportsTerminal: true,
            supportsNativeSession: true,
          },
        },
      ]),
    ).resolves.toMatchObject({ workerRunId: "run-1" });
  });

  it("fails before a runner request when no token is configured", async () => {
    const client = new ClankieApiClient({ baseUrl: "http://127.0.0.1:4310", fetchImpl: vi.fn() });
    await expect(client.claimTask("claim-1", [])).rejects.toThrow("CLANKIE_RUNNER_TOKEN");
    await expect(client.startMission("mission-1")).rejects.toThrow("CLANKIE_CAPTAIN_TOKEN");
    await expect(
      client.addRecovery("mission-1", {
        commandId: "recover-1",
        failedTaskId: "verify",
        debugger: {} as never,
        reverify: {} as never,
      }),
    ).rejects.toThrow("CLANKIE_CAPTAIN_TOKEN");
    await expect(client.listApprovals()).rejects.toThrow("CLANKIE_OPERATOR_TOKEN");
    await expect(
      client.recordCaptainPresence({
        schemaVersion: 1,
        eventId: "heartbeat-1",
        leaseId: "lease-1",
        generationId: "generation-1",
        occurredAt: "2026-07-11T12:00:00.000Z",
        type: "captain.heartbeat",
      }),
    ).rejects.toThrow("CLANKIE_CAPTAIN_TOKEN");
  });

  it("renders the finite steering surface and rejects unclassified legacy Discord text", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer captain-secret" });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        schemaVersion: 1,
        intent: { type: "focus", target: "failing_test" },
      });
      return Response.json({ accepted: true, command: { status: "pending" } }, { status: 202 });
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      captainToken: "captain-secret",
    });

    await expect(
      client.steerWorker("run-1", { type: "focus", target: "failing_test" }),
    ).resolves.toMatchObject({ command: { status: "pending" } });
    await expect(client.steerWorker("run-1", "Check the edge case.")).rejects.toThrow(
      "Free-form worker steering is unsupported",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
