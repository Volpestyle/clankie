import { describe, expect, it } from "vitest";
import { DISCORD_PRESENCE_ACTION_RISK_CLASS } from "@clankie/protocol";
import {
  DISCORD_ACTIVITY_INSTANCE_MAX,
  DISCORD_PRESENCE_CATALOG,
  DiscordActivityInstanceSchema,
  DiscordPresenceActionRequestSchema,
  DiscordPresenceSessionRecordSchema,
  DiscordPresenceToolExposureSchema,
  DiscordPresenceTransportBindingSchema,
  EnvironmentActionResultSchema,
  EnvironmentEventSchema,
  EnvironmentLeaseSchema,
  discordPresencePhaseFromEnvironment,
  environmentPhaseFromDiscordPresence,
  isDiscordPresenceActionAvailable,
  resolveDiscordPresenceToolExposure,
} from "../src/index.ts";
import { actionResultFixtures, validEnvironmentLease } from "./fixtures.ts";

describe("interactive environment protocol", () => {
  it("validates every frozen action-result fixture", () => {
    for (const result of Object.values(actionResultFixtures)) {
      expect(EnvironmentActionResultSchema.parse(result)).toEqual(result);
    }
  });

  it("keeps credentials out of strict lease contracts", () => {
    expect(EnvironmentLeaseSchema.parse(validEnvironmentLease)).toEqual(validEnvironmentLease);
    expect(() => EnvironmentLeaseSchema.parse({ ...validEnvironmentLease, accessToken: "secret" })).toThrow();
  });

  it("keeps high-volume telemetry out of semantic events", () => {
    expect(
      EnvironmentEventSchema.parse({
        schemaVersion: 1,
        plane: "semantic",
        id: "event-1",
        type: "environment.action.completed",
        occurredAt: "2026-07-11T12:00:02.000Z",
        correlationId: "corr-environment-1",
        sessionId: "environment-session-1",
        data: { actionId: "environment-action-1" },
      }),
    ).toMatchObject({ plane: "semantic" });
    expect(() =>
      EnvironmentEventSchema.parse({
        schemaVersion: 1,
        plane: "semantic",
        id: "event-raw-payload",
        type: "environment.action.completed",
        occurredAt: "2026-07-11T12:00:02.000Z",
        correlationId: "corr-environment-1",
        sessionId: "environment-session-1",
        data: {
          ticks: [{ x: 1, y: 2, z: 3 }],
          chunks: ["raw-chunk"],
          packets: ["raw-packet"],
          audio: "raw-audio",
          video: "raw-video",
        },
      }),
    ).toThrow();
    expect(() =>
      EnvironmentEventSchema.parse({
        schemaVersion: 1,
        plane: "semantic",
        id: "event-ticks",
        type: "environment.ticks",
        occurredAt: "2026-07-11T12:00:02.000Z",
        correlationId: "corr-environment-1",
        data: { ticks: [] },
      }),
    ).toThrow();
    expect(
      EnvironmentEventSchema.parse({
        schemaVersion: 1,
        plane: "artifact_reference",
        id: "artifact-event-1",
        telemetryKind: "ticks",
        sessionId: "environment-session-1",
        correlationId: "corr-environment-1",
        artifactId: "artifact-1",
        uri: "artifact://environment/ticks/1",
        summary: "Bounded movement trace",
        capturedAt: "2026-07-11T12:00:02.000Z",
      }),
    ).toMatchObject({ telemetryKind: "ticks" });
  });
});

describe("Discord presence profile", () => {
  it("runs idempotent activity control on bot transport while voice is active", () => {
    const voiceBot = presenceSession("voice_active", "bot");

    // ADR 0047: the activity plane needs no user session, unlike Go Live.
    expect(
      isDiscordPresenceActionAvailable({ action: "discord.presence.activity_start", session: voiceBot }),
    ).toBe(true);
    // ...but the surface still belongs to a voice channel.
    expect(
      isDiscordPresenceActionAvailable({
        action: "discord.presence.activity_start",
        session: presenceSession("present", "bot"),
      }),
    ).toBe(false);

    // Stop is safe even when already stopped; live invite state belongs to the
    // runtime and is not guessed from a stale session facet.
    expect(
      isDiscordPresenceActionAvailable({ action: "discord.presence.activity_stop", session: voiceBot }),
    ).toBe(true);
    const running = presenceSession("voice_active", "bot", [activityInstance()]);
    expect(
      isDiscordPresenceActionAvailable({ action: "discord.presence.activity_stop", session: running }),
    ).toBe(true);

    // Activity and Go Live stay orthogonal: a running activity confers no Go Live.
    expect(
      isDiscordPresenceActionAvailable({ action: "discord.presence.go_live_start", session: running }),
    ).toBe(false);

    // Publishing a rendered surface carries the same risk class as an attachment.
    expect(DISCORD_PRESENCE_ACTION_RISK_CLASS["discord.presence.activity_start"]).toBe("publish-external");
    expect(DISCORD_PRESENCE_ACTION_RISK_CLASS["discord.presence.activity_stop"]).toBe("publish-external");

    // A surface outside the frozen catalog fails closed.
    expect(() =>
      DiscordActivityInstanceSchema.parse({ ...activityInstance(), surface: "arbitrary_application" }),
    ).toThrow();

    // Instances cannot outlive the gateway connection.
    expect(() =>
      DiscordPresenceSessionRecordSchema.parse({
        ...voiceBot,
        phase: "failed",
        gatewayConnected: false,
        voiceGuildIds: [],
        activityInstances: [activityInstance()],
      }),
    ).toThrow(/activity instances cannot outlive/);

    // Start replaces old launch links, so stale facet capacity cannot block it.
    const saturated = presenceSession(
      "voice_active",
      "bot",
      Array.from({ length: DISCORD_ACTIVITY_INSTANCE_MAX }, () => activityInstance()),
    );
    expect(
      isDiscordPresenceActionAvailable({ action: "discord.presence.activity_start", session: saturated }),
    ).toBe(true);
  });

  it("keeps Discord presence actions transport-agnostic and gates Go Live to user_session", () => {
    expect(
      DiscordPresenceActionRequestSchema.parse({
        kind: "reply",
        channelId: "channel-1",
        messageId: "message-1",
        content: "hello from the catalog",
      }),
    ).toMatchObject({ kind: "reply" });
    expect(
      DiscordPresenceTransportBindingSchema.parse({
        schemaVersion: 1,
        kind: "user_session",
        credentialRef: "broker:discord_user_session:lab",
        resourceScope: { dmPolicy: "owner_only" },
      }),
    ).toMatchObject({ kind: "user_session" });
    expect(
      isDiscordPresenceActionAvailable({
        action: "discord.presence.go_live_start",
        session: presenceSession("voice_active", "user_session"),
      }),
    ).toBe(true);
    expect(
      isDiscordPresenceActionAvailable({
        action: "discord.presence.go_live_stop",
        session: presenceSession("voice_active", "user_session"),
      }),
    ).toBe(true);
    expect(
      isDiscordPresenceActionAvailable({
        action: "discord.presence.go_live_start",
        session: presenceSession("voice_active", "bot"),
      }),
    ).toBe(false);
    expect(DISCORD_PRESENCE_CATALOG.length).toBeGreaterThan(0);
    expect(
      resolveDiscordPresenceToolExposure(presenceSession("present"), "discord_presence").presenceTools,
    ).toContain("discord_presence_act");
    expect(resolveDiscordPresenceToolExposure(presenceSession("present"), "tui").presenceTools).toEqual([]);
    expect(
      resolveDiscordPresenceToolExposure(presenceSession("degraded"), "discord_presence").presenceTools,
    ).toEqual([]);
    expect(
      isDiscordPresenceActionAvailable({
        action: "discord.presence.reply",
        session: presenceSession("degraded"),
      }),
    ).toBe(false);
    expect(discordPresencePhaseFromEnvironment("active")).toBe("present");
    expect(environmentPhaseFromDiscordPresence("voice_active")).toBe("active");
    expect(DISCORD_PRESENCE_ACTION_RISK_CLASS["discord.presence.go_live_start"]).toBe("publish-external");
    expect(() =>
      DiscordPresenceToolExposureSchema.parse({
        schemaVersion: 2,
        phase: "present",
        lane: "operator",
        lifecycleTools: ["discord_presence_status", "discord_presence_disconnect"],
        presenceTools: ["discord_presence_act"],
      }),
    ).toThrow(/invalid presence tool exposure/);
  });

  it("single-writes v2 Discord presence lanes while dual-reading legacy TUI supervision", () => {
    expect(resolveDiscordPresenceToolExposure(presenceSession("present"), "discord_presence")).toMatchObject({
      schemaVersion: 2,
      lane: "discord_presence",
    });
    expect(resolveDiscordPresenceToolExposure(presenceSession("present"), "tui")).toMatchObject({
      schemaVersion: 2,
      lane: "operator",
      presenceTools: [],
    });
  });
});

function presenceSession(
  phase: Parameters<typeof environmentPhaseFromDiscordPresence>[0],
  transportKind: "bot" | "user_session" = "bot",
  activityInstances: unknown[] = [],
) {
  return DiscordPresenceSessionRecordSchema.parse({
    schemaVersion: 1,
    sessionId: `discord:${transportKind}:fixture`,
    characterId: "clankie",
    credentialRef: transportKind === "bot" ? "discord_bot" : "discord_user_session",
    transportKind,
    phase,
    gatewayConnected: !["off", "connecting", "degraded", "failed"].includes(phase),
    voiceGuildIds: phase === "voice_active" ? ["guild-1"] : [],
    activityInstances,
    revision: 1,
    updatedAt: "2026-07-14T18:00:00.000Z",
  });
}

function activityInstance() {
  return {
    schemaVersion: 1,
    guildId: "guild-1",
    channelId: "voice-1",
    surface: "gba_emulator",
    startedAt: "2026-07-25T18:00:00.000Z",
  };
}
