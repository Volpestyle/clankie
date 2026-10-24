import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { DiscordBridgeReceiptStore } from "@clankie/discord-presence-core";
import type { DiscordBridgeReceiptType } from "@clankie/discord-presence-core";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyVoiceStays } from "../src/body-voice-stays.ts";
import { DiscordRoomVoice } from "../src/discord-room-voice.ts";
import { defaultDiscordLiveReceiptPath } from "../src/voice-receipt-activity.ts";
it("only one exact host nonce controls an admitted audio stay and forged, repeated, or revoked commands have no effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "room-voice-"));
  const leases = new BodyLeaseStore(root);
  const stays = new BodyVoiceStays(leases, join(root, "stays.json"));
  const stay = {
    stayId: randomUUID(),
    generation: 1,
    target: {
      guildId: "guild",
      channelId: "room",
      actorId: "actor",
      presenceSessionId: "body",
      transportKind: "bot" as const,
    },
  };
  let source = true;
  let owner = true;
  let effects = 0;
  let revokeDuringPost = false;
  const claimed = await stays.claim(stay, {
    conversationId: "room",
    current: () => true,
    authorize: async () => source,
  });
  let control!: DiscordRoomVoice;
  let captured!: Parameters<DiscordRoomVoice["authorize"]>[0];
  control = new DiscordRoomVoice(stays, leases, async (path, body) => {
    if (path === "/voice/output") {
      captured = body as typeof captured;
      if (revokeDuringPost) source = false;
      await control.authorize(captured);
      effects++;
    }
    return Response.json({
      active: true,
      stayId: stay.stayId,
      guildId: "guild",
      channelId: "room",
      outputMuted: true,
      activity: "idle",
      consentedParticipantCount: 1,
      activeCaptureCount: 0,
      handoffCount: 0,
    });
  });
  const authority = {
    current: () => owner,
    guard: async () => {
      if (!owner) throw Error("revoked");
    },
  };
  try {
    await expect(
      control.authorize({ nonce: randomUUID(), stayId: stay.stayId, action: "mute_output" }),
    ).rejects.toThrow("unknown");
    await control.control("room", stay.stayId, "mute_output", authority);
    expect(effects).toBe(1);
    await expect(control.authorize(captured)).rejects.toThrow("unknown");
    await expect(control.control("other", stay.stayId, "mute_output", authority)).rejects.toThrow("stale");
    revokeDuringPost = true;
    await expect(control.control("room", stay.stayId, "unmute_output", authority)).rejects.toThrow("revoked");
    expect(effects).toBe(1);
    source = true;
    owner = false;
    await expect(control.control("room", stay.stayId, "mute_output", authority)).rejects.toThrow("revoked");
    expect(leases.status("voice")).toMatchObject({ state: "active", conversationId: "room" });
  } finally {
    if (claimed.outcome === "acquired" && claimed.incarnation) stays.finish(stay, claimed.incarnation);
    leases.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("empty, foreign or restarted body snapshots cannot erase a retained audio owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "voice-observe-"));
  const leases = new BodyLeaseStore(root);
  const path = join(root, "stays.json");
  const stays = new BodyVoiceStays(leases, path);
  const stay = {
    stayId: randomUUID(),
    generation: 1,
    target: {
      guildId: "guild",
      channelId: "room",
      actorId: "actor",
      presenceSessionId: "body",
      transportKind: "bot" as const,
    },
  };
  const claimed = await stays.claim(stay, {
    conversationId: "owner",
    current: () => true,
    authorize: async () => true,
  });
  let snapshot = {
    active: false,
    outputMuted: false,
    activity: "idle",
    consentedParticipantCount: 0,
    activeCaptureCount: 0,
    handoffCount: 0,
    stayId: stay.stayId,
    guildId: "guild",
    channelId: "room",
  };
  const post = async () => Response.json(snapshot);
  const control = new DiscordRoomVoice(stays, leases, post);
  try {
    expect(await control.status()).toMatchObject({ state: "unknown", conversationId: "owner" });
    snapshot = { ...snapshot, active: true, stayId: randomUUID() };
    expect(await control.status()).toMatchObject({ state: "unknown", conversationId: "owner" });
    snapshot = { ...snapshot, stayId: stay.stayId };
    expect(await control.status()).toMatchObject({ state: "active", conversationId: "owner" });
    const restarted = new DiscordRoomVoice(new BodyVoiceStays(leases, path), leases, post);
    expect(await restarted.status()).toMatchObject({ state: "unknown", conversationId: "owner" });
  } finally {
    if (claimed.outcome === "acquired" && claimed.incarnation) stays.finish(stay, claimed.incarnation);
    leases.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("a call whose provider hung up says he could not hear or answer, and how the session ended (VUH-2728)", async () => {
  const root = mkdtempSync(join(tmpdir(), "voice-pipelines-"));
  const leases = new BodyLeaseStore(root);
  const stays = new BodyVoiceStays(leases, join(root, "stays.json"));
  const control = new DiscordRoomVoice(stays, leases, async () =>
    Response.json({
      active: false,
      outputMuted: false,
      activity: "idle",
      consentedParticipantCount: 0,
      activeCaptureCount: 0,
      handoffCount: 0,
    }),
  );
  // The bridge's own writer, at the path the service reads by default.
  const receipts = new DiscordBridgeReceiptStore({ path: defaultDiscordLiveReceiptPath() });
  const room = { guildId: "100000000000000001", channelId: "100000000000000002" };
  const record = (stayId: string, type: string, data: Record<string, string | number | boolean> = {}) =>
    receipts.append(`discord.voice.${type}` as DiscordBridgeReceiptType, { type, ...room, stayId, ...data });
  const lost = (stayId: string, stage: "transcription_session" | "conversation_session", data = {}) =>
    record(stayId, "failed", {
      stage,
      code: stage === "transcription_session" ? "voice_listener_lost" : "voice_conversation_lost",
      ...data,
    });
  try {
    expect((await control.status()).pipelines).toBeUndefined();

    // The shape of the 2026-10-23 call: sockets open, then the provider hangs up on both legs.
    await record("deaf", "joined", { daveProtocolVersion: 1 });
    await record("deaf", "model_response", { deliveryId: "greeting", phase: "requested" });
    await lost("deaf", "conversation_session", {
      closeReason: "socket",
      closeCode: 1011,
      providerCode: "insufficient_quota",
    });
    await record("deaf", "utterance", { userId: "100000000000000003", deliveryId: "u1", durationMs: 6180 });
    await lost("deaf", "transcription_session", { closeReason: "socket", closeCode: 1008 });
    await lost("deaf", "transcription_session", {
      closeReason: "socket",
      closeCode: 1008,
      providerCode: "insufficient_quota",
    });
    await record("deaf", "left", { reason: "discord_gateway_left" });
    expect((await control.status()).pipelines).toEqual({
      stayId: "deaf",
      ended: true,
      hearing: {
        state: "broken",
        losses: 2,
        lastLoss: {
          at: expect.any(String),
          code: "voice_listener_lost",
          closeReason: "socket",
          closeCode: 1008,
          providerCode: "insufficient_quota",
        },
      },
      answering: {
        state: "broken",
        losses: 1,
        lastLoss: {
          at: expect.any(String),
          code: "voice_conversation_lost",
          closeReason: "socket",
          closeCode: 1011,
          providerCode: "insufficient_quota",
        },
      },
    });

    // A later stay that lost its listener once and recovered works; the old stay no longer counts.
    await record("recovered", "joined", { daveProtocolVersion: 1 });
    await lost("recovered", "transcription_session", { closeReason: "lifetime" });
    await lost("deaf", "transcription_session", { closeReason: "socket" });
    await record("recovered", "transcription", {
      userId: "100000000000000003",
      deliveryId: "u2",
      outcome: "accepted",
      characters: 12,
      latencyMs: 900,
      addressed: true,
    });
    expect((await control.status()).pipelines).toMatchObject({
      stayId: "recovered",
      ended: false,
      hearing: {
        state: "working",
        losses: 1,
        lastLoss: { code: "voice_listener_lost", closeReason: "lifetime" },
      },
      answering: { state: "unproven", losses: 0 },
    });
    await record("recovered", "model_response", { deliveryId: "u2", phase: "completed", outcome: "audio" });
    expect((await control.status()).pipelines?.answering).toEqual({ state: "working", losses: 0 });
  } finally {
    leases.close();
    rmSync(root, { recursive: true, force: true });
  }
});
