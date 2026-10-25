import { createServer } from "node:http";
import { once } from "node:events";
import { runDiscordCommand } from "../../tui/src/command/discord.ts";
import { formatVoiceStayPipelines } from "../../tui/src/discord-room-view.ts";
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
import { defaultDiscordLiveReceiptPath, readVoiceCallHealth } from "../src/voice-receipt-activity.ts";
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
      endedAt: expect.any(String),
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

    // A later stay supersedes the old one. Scheduled lifetime rotations reconnect on their own:
    // they count, but a quiet room after one stays healthy (Sage, VUH-2728).
    await record("rotating", "joined", { daveProtocolVersion: 1 });
    await record("rotating", "transcription", {
      userId: "100000000000000003",
      deliveryId: "u2",
      outcome: "accepted",
      characters: 12,
      latencyMs: 900,
      addressed: true,
    });
    await lost("rotating", "transcription_session", { closeReason: "lifetime" });
    await lost("rotating", "conversation_session", { closeReason: "lifetime", closeCode: 1000 });
    await lost("deaf", "transcription_session", { closeReason: "socket" });
    const rotated = (await control.status()).pipelines;
    expect(rotated).toMatchObject({
      stayId: "rotating",
      hearing: {
        state: "working",
        losses: 1,
        lastLoss: { code: "voice_listener_lost", closeReason: "lifetime" },
      },
      answering: { state: "unproven", losses: 1, lastLoss: { closeReason: "lifetime", closeCode: 1000 } },
    });
    expect(rotated?.endedAt).toBeUndefined();
    await record("rotating", "model_response", { deliveryId: "u2", phase: "completed", outcome: "audio" });
    expect((await control.status()).pipelines?.answering.state).toBe("working");
  } finally {
    leases.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("hearing recovers only for that speaker's listener over the real receipt writer (VUH-2765)", async () => {
  const root = mkdtempSync(join(tmpdir(), "speaker-pipelines-"));
  const leases = new BodyLeaseStore(root);
  const path = join(root, "receipts.jsonl");
  const receipts = new DiscordBridgeReceiptStore({ path });
  const control = new DiscordRoomVoice(
    new BodyVoiceStays(leases, join(root, "stays.json")),
    leases,
    async () =>
      Response.json({
        active: false,
        outputMuted: false,
        activity: "idle",
        consentedParticipantCount: 2,
        activeCaptureCount: 0,
        handoffCount: 0,
      }),
    () => readVoiceCallHealth(path),
  );
  // The real headless command and protocol client read the production status projection over HTTP.
  const server = createServer(async (request, response) => {
    if (
      request.headers.authorization !== "Bearer test-operator" ||
      request.url !== "/v1/discord/room-voice"
    ) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(await control.status()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("No test listener");
  const commandOptions = {
    host: `http://127.0.0.1:${address.port}`,
    env: { CLANKIE_OPERATOR_TOKEN: "test-operator" },
  };
  const alice = "100000000000000003",
    bob = "100000000000000004";
  const record = (type: string, data = {}) =>
    receipts.append(`discord.voice.${type}` as DiscordBridgeReceiptType, {
      type,
      guildId: "100000000000000001",
      channelId: "100000000000000002",
      stayId: "two-speakers",
      ...data,
    });
  const lost = (userId?: string, closeReason = "socket") =>
    record("failed", {
      stage: "transcription_session",
      code: "voice_listener_lost",
      closeReason,
      ...(userId === undefined ? {} : { userId }),
    });
  const heard = (userId: string) =>
    record("transcription", {
      userId,
      deliveryId: randomUUID(),
      outcome: "accepted",
      characters: 12,
      latencyMs: 5,
      addressed: true,
    });
  try {
    await record("joined", { daveProtocolVersion: 1 });
    await heard(alice);
    await lost(alice);
    await heard(bob);
    expect((await control.status()).pipelines?.hearing).toMatchObject({
      state: "broken",
      losses: 1,
      brokenUserIds: [alice],
    });
    const command = await runDiscordCommand(["call"], commandOptions);
    expect(command).toMatchObject({ pipelines: { hearing: { state: "broken", brokenUserIds: [alice] } } });
    if (!("pipelines" in command) || command.pipelines === undefined) throw Error("Missing pipelines");
    expect(formatVoiceStayPipelines(command.pipelines)).toContain(`not heard: ${alice}`);
    await lost(bob);
    expect((await control.status()).pipelines?.hearing.brokenUserIds).toEqual([alice, bob]);
    await heard(alice);
    expect((await control.status()).pipelines?.hearing).toMatchObject({
      state: "broken",
      losses: 2,
      brokenUserIds: [bob],
    });
    await lost(bob, "lifetime");
    expect((await control.status()).pipelines?.hearing.state).toBe("broken");
    await heard(bob);
    expect((await control.status()).pipelines?.hearing).toMatchObject({ state: "working", losses: 3 });
    expect((await control.status()).pipelines?.hearing.brokenUserIds).toBeUndefined();
    await lost(alice, "lifetime");
    expect((await control.status()).pipelines?.hearing.state).toBe("working");
    await lost(alice);
    await record("consent", { userId: alice, consented: false, participantCount: 1 });
    // A late open failure after revocation must not put an ineligible speaker back on the report.
    await lost(alice);
    expect((await control.status()).pipelines?.hearing.state).toBe("working");
    await record("consent", { userId: alice, consented: true, participantCount: 2 });
    await lost(alice);
    await record("participant", { userId: alice, action: "left", humanCount: 1, deliveryId: randomUUID() });
    expect((await control.status()).pipelines?.hearing.state).toBe("working");
    // Old receipts cannot be attributed safely. Another speaker cannot clear an unknown listener.
    await lost();
    await heard(bob);
    expect((await control.status()).pipelines?.hearing.state).toBe("broken");
    expect((await control.status()).pipelines?.hearing.brokenUserIds).toBeUndefined();
    await record("joined", { stayId: "new-stay", daveProtocolVersion: 1 });
    expect((await control.status()).pipelines?.hearing).toEqual({ state: "unproven", losses: 0 });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    leases.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("a join the provider refused shows over the real receipt writer and headless command (VUH-2728)", async () => {
  const root = mkdtempSync(join(tmpdir(), "refused-join-"));
  const leases = new BodyLeaseStore(root);
  const path = join(root, "receipts.jsonl");
  const receipts = new DiscordBridgeReceiptStore({ path });
  const control = new DiscordRoomVoice(
    new BodyVoiceStays(leases, join(root, "stays.json")),
    leases,
    async () =>
      Response.json({
        active: false,
        outputMuted: false,
        activity: "idle",
        consentedParticipantCount: 0,
        activeCaptureCount: 0,
        handoffCount: 0,
      }),
    () => readVoiceCallHealth(path),
  );
  const server = createServer(async (request, response) => {
    if (
      request.headers.authorization !== "Bearer test-operator" ||
      request.url !== "/v1/discord/room-voice"
    ) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(await control.status()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("No test listener");
  const room = { guildId: "100000000000000001", channelId: "100000000000000002" };
  const record = (type: string, data: Record<string, unknown>) =>
    receipts.append(`discord.voice.${type}` as DiscordBridgeReceiptType, { type, ...room, ...data });
  try {
    await record("joined", { stayId: "worked", daveProtocolVersion: 1 });
    await record("left", { stayId: "worked", reason: "self_decided" });
    // Join's listener probe refused by an account with no credit: no stay begins.
    await record("failed", {
      stayId: "refused",
      stage: "transcription_session",
      code: "voice_provider_refused",
      providerCode: "credit_balance_exhausted",
    });
    const command = await runDiscordCommand(["call"], {
      host: `http://127.0.0.1:${address.port}`,
      env: { CLANKIE_OPERATOR_TOKEN: "test-operator" },
    });
    expect(command).toMatchObject({
      pipelines: { stayId: "worked" },
      joinRefusal: { code: "voice_provider_refused", providerCode: "credit_balance_exhausted" },
    });
    // A later stay that began supersedes the refusal.
    await record("joined", { stayId: "after", daveProtocolVersion: 1 });
    const status = await control.status();
    expect(status.joinRefusal).toBeUndefined();
    expect(status.pipelines?.stayId).toBe("after");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    leases.close();
    rmSync(root, { recursive: true, force: true });
  }
});
