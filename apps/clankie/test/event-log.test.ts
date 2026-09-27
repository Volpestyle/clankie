import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@clankie/protocol";
import {
  DISCORD_VOICE_HISTORY_LIMIT_MAX,
  DiscordPresenceSessionProjection,
  DiscordVoiceHistoryProjection,
} from "../src/discord-presence-session.ts";
import { RecentEvents, compactEventLog, loadEventLog } from "../src/event-log.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

let clock = Date.parse("2026-09-01T00:00:00.000Z");
const tick = () => new Date((clock += 1_000)).toISOString();

function phase(
  sessionId: string,
  revision: number,
  previousPhase: string,
  phaseName: string,
  reason: string,
  voiceGuildIds: string[],
  transportKind = "bot",
): DomainEvent {
  const occurredAt = tick();
  return {
    id: `${sessionId}:${revision}`,
    occurredAt,
    missionId: `discord-presence:${sessionId}`,
    streamKind: "discord_presence",
    correlationId: sessionId,
    profileHash: "test",
    type: "discord.presence.session.phase_changed",
    data: {
      previousPhase,
      phase: phaseName,
      reason,
      session: {
        schemaVersion: 1,
        sessionId,
        characterId: "clankie",
        credentialRef: `discord_${transportKind}`,
        transportKind,
        phase: phaseName,
        gatewayConnected: phaseName === "present" || phaseName === "voice_active",
        voiceGuildIds,
        voiceRooms: voiceGuildIds.map((guildId) => ({
          guildId,
          guildName: `Guild ${guildId}`,
          occupants: [],
        })),
        activityInstances: [],
        revision,
        updatedAt: occurredAt,
      },
    },
  } as DomainEvent;
}

/** One process lifetime: start, join a guild's voice, leave, stop. */
function session(sessionId: string, guildId: string, transportKind = "bot"): DomainEvent[] {
  return [
    phase(sessionId, 1, "off", "connecting", "process_start", [], transportKind),
    phase(sessionId, 2, "connecting", "present", "gateway_ready", [], transportKind),
    phase(sessionId, 3, "present", "voice_active", "voice_joined", [guildId], transportKind),
    phase(sessionId, 4, "voice_active", "present", "voice_left", [], transportKind),
    phase(sessionId, 5, "present", "off", "process_stopped", [], transportKind),
  ];
}

function other(type: string, id: string): DomainEvent {
  return {
    id,
    occurredAt: tick(),
    missionId: `device:${id}`,
    streamKind: "device",
    correlationId: id,
    profileHash: "test",
    type,
    data: { schemaVersion: 1, deviceId: id },
  } as DomainEvent;
}

describe("durable event log compaction", () => {
  it("forgets unfinished stays when a crashed binding starts a replacement session", () => {
    const history = new DiscordVoiceHistoryProjection();
    for (let index = 0; index < 100; index += 1) {
      for (const event of session(`crashed-${index}`, "guild").slice(0, 3)) history.apply(event);
    }
    // No fabricated departure, and only the currently live stay remains resident.
    expect(history.list(32)).toEqual([]);
    const retained = history as unknown as {
      openStays: Map<string, unknown>;
      guildsBySession: Map<string, unknown>;
    };
    expect(retained.openStays.size).toBe(1);
    expect(retained.guildsBySession.size).toBe(1);
    history.apply(phase("crashed-99", 4, "voice_active", "present", "voice_left", []));
    expect(history.list(32)).toHaveLength(1);
    expect(retained.openStays.size).toBe(0);
    expect(retained.guildsBySession.size).toBe(0);
  });

  it("drops ended presence sessions without changing anything replay builds", () => {
    const events: DomainEvent[] = [other("device.revoked", "revoked-early")];
    for (let index = 0; index < 40; index += 1) events.push(...session(`bot-${index}`, `g${index}`));
    events.push(other("pairing.offer.minted", "offer"));
    // A second binding whose only session never reached voice.
    events.push(...session("user-0", "g-user", "user_session").slice(0, 2));
    // The live bot session, still in voice (an open stay).
    events.push(...session("bot-live", "g-live").slice(0, 3));

    const compacted = compactEventLog(events);
    const sessionIds = new Set(
      compacted.flatMap((event) =>
        event.type === "discord.presence.session.phase_changed" ? [event.correlationId] : [],
      ),
    );
    // The newest 32 stays' sessions, and each binding's latest session.
    expect(sessionIds).toEqual(
      new Set([
        ...Array.from({ length: DISCORD_VOICE_HISTORY_LIMIT_MAX }, (_, index) => `bot-${index + 8}`),
        "user-0",
        "bot-live",
      ]),
    );
    expect(new DiscordPresenceSessionProjection(events).list()).toHaveLength(2);
    expect(compacted.map((event) => event.id)).toContain("revoked-early");
    expect(compacted.map((event) => event.id)).toContain("offer");

    expect(new DiscordPresenceSessionProjection(compacted).list()).toEqual(
      new DiscordPresenceSessionProjection(events).list(),
    );
    expect(new DiscordVoiceHistoryProjection(compacted).list(DISCORD_VOICE_HISTORY_LIMIT_MAX)).toEqual(
      new DiscordVoiceHistoryProjection(events).list(DISCORD_VOICE_HISTORY_LIMIT_MAX),
    );
    expect(new DiscordVoiceHistoryProjection(events).list(1)[0]?.guildId).toBe("g39");
  });

  it("rewrites the file once, skipping a torn tail, and leaves a compact log alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-event-log-"));
    roots.push(root);
    const path = join(root, "state", "events.jsonl");
    const events: DomainEvent[] = [];
    for (let index = 0; index < 40; index += 1) events.push(...session(`bot-${index}`, `g${index}`));
    loadEventLog(path); // creates the directory for a first boot
    await writeFile(path, events.map((event) => `${JSON.stringify(event)}\n`).join("") + '{"torn');

    const loaded = loadEventLog(path);
    expect(loaded).toEqual(compactEventLog(events));
    const written = await readFile(path, "utf8");
    expect(
      written
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as DomainEvent),
    ).toEqual(loaded);
    expect(loadEventLog(path)).toEqual(loaded);
    expect(await readFile(path, "utf8")).toBe(written);
  });
});

describe("recent durable events", () => {
  it("remembers a bounded window for redelivery checks", () => {
    const recent = new RecentEvents(
      Array.from({ length: 10 }, (_, index) => other("device.activated", `e${index}`)),
      4,
    );
    expect(recent.has("e5")).toBe(false);
    expect(recent.get("e9")?.id).toBe("e9");
    recent.add(other("device.activated", "e10"));
    expect(recent.has("e6")).toBe(false);
    expect(recent.has("e10")).toBe(true);
  });
});
