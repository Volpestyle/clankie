import {
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
