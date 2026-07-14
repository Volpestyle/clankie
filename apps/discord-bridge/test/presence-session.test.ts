import {
  isDiscordPresenceActionAvailable,
  resolveDiscordPresenceToolExposure,
  type DiscordPresencePhaseEvent,
} from "@clankie/interactive-environment";
import type { DiscordPresenceWrite } from "@clankie/protocol";
import { describe, expect, it, vi } from "vitest";
import { DiscordBotPresenceRuntime } from "../src/bot-presence-runtime.ts";
import {
  createAdvertisedDiscordPresencePort,
  DiscordPresenceActToolUnavailableError,
} from "../src/presence-action-advertiser.ts";
import {
  DiscordPresencePublicationError,
  DiscordPresencePublicationTerminalError,
  DiscordPresenceSession,
} from "../src/presence-session.ts";

describe("Discord presence gateway session", () => {
  it("removes act capability and emits degraded when the gateway disconnects mid-action", async () => {
    const events: DiscordPresencePhaseEvent[] = [];
    let finishAction: ((value: { id: string }) => void) | undefined;
    const post = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          finishAction = resolve;
        }),
    );
    const session = fixtureSession(events);
    await session.start();
    await session.gatewayReady();
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post, put: vi.fn(), delete: vi.fn(), patch: vi.fn() } as never,
    });

    const inFlight = runtime.execute(write("first"), session.record);
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    await session.gatewayDisconnected();
    expect(session.record.phase).toBe("degraded");
    expect(resolveDiscordPresenceToolExposure(session.record, "discord_presence").presenceTools).toEqual([]);
    finishAction?.({ id: "message-first" });
    await expect(inFlight).resolves.toMatchObject({ messageId: "message-first" });
    await expect(runtime.execute(write("second"), session.record)).rejects.toThrow(
      /discord_presence_action_unavailable_for_bot/,
    );
    expect(post).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({
      type: "discord.presence.session.phase_changed",
      data: { previousPhase: "present", phase: "degraded", reason: "gateway_disconnected" },
    });
  });

  it("derives voice_active, present, failed, and off from gateway and voice lifecycle", async () => {
    const events: DiscordPresencePhaseEvent[] = [];
    const session = fixtureSession(events);
    await session.start();
    await session.gatewayReady();
    await session.voiceStateChanged("guild-1", true);
    expect(session.record).toMatchObject({ phase: "voice_active", voiceGuildIds: ["guild-1"] });
    await session.voiceStateChanged("guild-1", false);
    expect(session.record.phase).toBe("present");
    await session.fail();
    expect(session.record.phase).toBe("failed");
    await session.stop();
    expect(session.record.phase).toBe("off");
    expect(events.map((event) => event.data.phase)).toEqual([
      "connecting",
      "present",
      "voice_active",
      "present",
      "failed",
      "off",
    ]);
  });

  it("fails closed and emits a semantic event when its lease is lost", async () => {
    const events: DiscordPresencePhaseEvent[] = [];
    const session = fixtureSession(events);
    await session.start();
    await session.gatewayReady();
    await session.leaseLost();

    expect(session.record.phase).toBe("degraded");
    expect(resolveDiscordPresenceToolExposure(session.record, "discord_presence").presenceTools).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      data: { previousPhase: "present", phase: "degraded", reason: "lease_lost" },
    });
  });

  it("fences advertised act tools and retries a failed disconnect publication to durability", async () => {
    let disconnectAttempts = 0;
    const failures: string[] = [];
    let durable: DiscordPresencePhaseEvent["data"]["session"] | undefined;
    let id = 0;
    let now = 0;
    const session = new DiscordPresenceSession({
      sessionId: "discord:bot:retry",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      emit: (event) => {
        if (event.data.reason === "gateway_disconnected" && disconnectAttempts++ === 0) {
          throw new DiscordPresencePublicationError("transient", "transient_disconnect_publish_failure");
        }
        durable = event.data.session;
        return durable;
      },
      retryDelayMs: 0,
      onPublicationFailure: (error) => failures.push(error instanceof Error ? error.message : String(error)),
      idFactory: () => `retry-phase-${String(++id)}`,
      clock: () => new Date(Date.UTC(2026, 6, 14, 18, 0, now++)),
    });
    const advertised = session.toolCatalog("discord_presence");
    await session.start();
    await session.gatewayReady();
    expect(advertised.current.presenceTools).toContain("discord_presence_act");

    const disconnect = session.gatewayDisconnected();
    // Synchronous revoke fence runs before publication's first await/retry.
    expect(advertised.current.presenceTools).not.toContain("discord_presence_act");
    await disconnect;

    expect(failures).toEqual(["transient_disconnect_publish_failure"]);
    expect(durable?.phase).toBe("degraded");
    expect(
      durable === undefined
        ? true
        : isDiscordPresenceActionAvailable({
            action: "discord.presence.send_message",
            session: durable,
          }),
    ).toBe(false);
  });

  it("retries the initial phase without advancing into a revision gap", async () => {
    const attempts: number[] = [];
    let failed = false;
    const session = new DiscordPresenceSession({
      sessionId: "discord:bot:initial-retry",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      emit: (event) => {
        attempts.push(event.data.session.revision);
        if (!failed) {
          failed = true;
          throw new DiscordPresencePublicationError("transient", "transient_initial_publish_failure");
        }
        return event.data.session;
      },
      retryDelayMs: 0,
      clock: () => new Date("2026-07-14T18:00:00.000Z"),
      idFactory: () => "initial-retry-phase",
    });

    await session.start();
    await session.gatewayReady();

    expect(attempts).toEqual([1, 1, 2]);
    expect(session.record).toMatchObject({ phase: "present", revision: 2 });
  });

  it("terminates a permanent publication rejection in one attempt with a typed failed event", async () => {
    let disconnectAttempts = 0;
    const terminal: Array<{
      error: DiscordPresencePublicationTerminalError;
      event: DiscordPresencePhaseEvent;
    }> = [];
    const session = new DiscordPresenceSession({
      sessionId: "discord:bot:permanent-rejection",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      emit: (event) => {
        if (event.data.reason === "gateway_disconnected") {
          disconnectAttempts += 1;
          throw new DiscordPresencePublicationError("permanent", "validation_rejected");
        }
        return event.data.session;
      },
      retryDelayMs: 0,
      maxPublicationAttempts: 5,
      onTerminalFailure: (error, event) => terminal.push({ error, event }),
      clock: () => new Date("2026-07-14T18:00:00.000Z"),
      idFactory: () => "permanent-rejection-phase",
    });
    await session.start();
    await session.gatewayReady();

    await expect(session.gatewayDisconnected()).rejects.toMatchObject({
      name: "DiscordPresencePublicationTerminalError",
      disposition: "permanent",
      attempts: 1,
    });

    expect(disconnectAttempts).toBe(1);
    expect(session.record).toMatchObject({ phase: "failed", gatewayConnected: false, revision: 3 });
    expect(session.toolCatalog("discord_presence").current.presenceTools).toEqual([]);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.event).toMatchObject({
      type: "discord.presence.session.phase_changed",
      data: { previousPhase: "present", phase: "failed", reason: "publication_failed" },
    });
    await expect(session.stop()).rejects.toBe(terminal[0]?.error);
    expect(disconnectAttempts).toBe(1);
  });

  it("fences a production advertised action before delayed loss publication completes", async () => {
    let releaseDisconnect: (() => void) | undefined;
    const execute = vi.fn(() =>
      Promise.resolve({
        id: "window-action",
        action: "discord.presence.send_message" as const,
        transportKind: "bot" as const,
        channelId: "channel-1",
        messageId: "message-1",
      }),
    );
    const session = new DiscordPresenceSession({
      sessionId: "discord:bot:loss-window",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      emit: async (event) => {
        if (event.data.reason === "gateway_disconnected") {
          await new Promise<void>((resolve) => {
            releaseDisconnect = resolve;
          });
        }
        return event.data.session;
      },
      clock: () => new Date("2026-07-14T18:00:00.000Z"),
      idFactory: () => "loss-window-phase",
    });
    const advertisedPort = createAdvertisedDiscordPresencePort(
      {
        getHealth: () => Promise.resolve({ profileHash: "profile-hash" }),
        submitDiscordCaptainChannelTurn: vi.fn(),
        executeDiscordPresenceAction: execute,
      },
      session,
    );
    await session.start();
    await session.gatewayReady();
    const beforeLoss = write("before-loss");
    await advertisedPort.executeDiscordPresenceAction(beforeLoss);
    expect(execute).toHaveBeenCalledWith(beforeLoss, {
      schemaVersion: 1,
      sessionId: "discord:bot:loss-window",
      phase: "present",
      revision: 2,
    });
    execute.mockClear();

    const disconnect = session.gatewayDisconnected();
    expect(session.record.phase).toBe("present");
    expect(session.liveRecord).toMatchObject({ phase: "degraded", revision: 3 });
    await expect(advertisedPort.executeDiscordPresenceAction(write("window"))).rejects.toBeInstanceOf(
      DiscordPresenceActToolUnavailableError,
    );
    expect(execute).not.toHaveBeenCalled();

    releaseDisconnect?.();
    await disconnect;
    expect(session.record.phase).toBe("degraded");
  });
});

function fixtureSession(events: DiscordPresencePhaseEvent[]) {
  let id = 0;
  let now = 0;
  return new DiscordPresenceSession({
    sessionId: "discord:bot:fixture",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot",
    emit: (event) => {
      events.push(event);
    },
    idFactory: () => `phase-${String(++id)}`,
    clock: () => new Date(Date.UTC(2026, 6, 14, 18, 0, now++)),
  });
}

function write(suffix: string): DiscordPresenceWrite {
  return {
    schemaVersion: 1,
    idempotencyKey: `write-${suffix}`,
    action: "discord.presence.send_message",
    identity: {
      missionId: "mission-1",
      correlationId: `correlation-${suffix}`,
      profileHash: "profile-1",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
    },
    payload: { kind: "send_message", channelId: "channel-1", content: suffix },
  };
}
