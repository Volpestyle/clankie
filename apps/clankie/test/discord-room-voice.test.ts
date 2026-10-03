import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyVoiceStays } from "../src/body-voice-stays.ts";
import { DiscordRoomVoice } from "../src/discord-room-voice.ts";
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
