import {
  isDiscordPresenceActionAvailable,
  resolveDiscordPresenceToolExposure,
  type DiscordPresencePhaseEvent,
} from "@clankie/interactive-environment";
import type { DiscordPresenceWrite } from "@clankie/protocol";
import { describe, expect, it, vi } from "vitest";
import { DiscordBotPresenceRuntime } from "../src/bot-presence-runtime.ts";
import { DiscordPresenceSession } from "../src/presence-session.ts";

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
          throw new Error("transient_disconnect_publish_failure");
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
          throw new Error("transient_initial_publish_failure");
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
