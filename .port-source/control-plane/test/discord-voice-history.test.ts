import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import type { DiscordPresencePhaseEvent, DiscordVoiceRoom } from "@clankie/interactive-environment";
import type { DomainEvent } from "@clankie/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane, type TrustedCaptainIdentity } from "../src/app.ts";
import { deriveDiscordVoiceHistory, discordPresenceDomainEvent } from "../src/discord-presence-session.ts";

let doctrine: ReturnType<typeof compileDoctrine>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

const captain = (request: Request): Promise<TrustedCaptainIdentity | undefined> =>
  Promise.resolve(
    request.headers.get("authorization") === "Bearer captain" ? { captainId: "captain-clankie" } : undefined,
  );

const SESSION_ID = "discord:bot:app:session-1";
const ROOM: DiscordVoiceRoom = {
  guildId: "guild-42",
  guildName: "Vuhlp",
  channelId: "chan-7",
  channelName: "General",
  occupants: [{ userId: "u1", displayName: "James" }],
};

/** A schema-valid phase transition; the caller supplies only what changes. */
function phaseEvent(input: {
  readonly id: string;
  readonly occurredAt: string;
  readonly previousPhase: DiscordPresencePhaseEvent["data"]["previousPhase"];
  readonly phase: DiscordPresencePhaseEvent["data"]["phase"];
  readonly reason: DiscordPresencePhaseEvent["data"]["reason"];
  readonly revision: number;
  readonly voiceGuildIds?: readonly string[];
  readonly voiceRooms?: readonly DiscordVoiceRoom[];
}): DomainEvent {
  const connected = ["present", "voice_active", "go_live_active"].includes(input.phase);
  return discordPresenceDomainEvent(
    {
      schemaVersion: 1,
      plane: "semantic",
      id: input.id,
      type: "discord.presence.session.phase_changed",
      occurredAt: input.occurredAt,
      correlationId: SESSION_ID,
      sessionId: SESSION_ID,
      data: {
        previousPhase: input.previousPhase,
        phase: input.phase,
        reason: input.reason,
        session: {
          schemaVersion: 1,
          sessionId: SESSION_ID,
          characterId: "clankie",
          credentialRef: "discord_bot",
          transportKind: "bot",
          phase: input.phase,
          gatewayConnected: connected,
          voiceGuildIds: [...(input.voiceGuildIds ?? [])],
          ...(input.voiceRooms === undefined ? {} : { voiceRooms: [...input.voiceRooms] }),
          activityInstances: [],
          revision: input.revision,
          updatedAt: input.occurredAt,
        },
      },
    },
    doctrine.profileHash,
  );
}

function lifecycle(): DomainEvent[] {
  return [
    phaseEvent({
      id: "e1",
      occurredAt: "2026-07-27T03:00:00.000Z",
      previousPhase: "off",
      phase: "connecting",
      reason: "process_start",
      revision: 1,
    }),
    phaseEvent({
      id: "e2",
      occurredAt: "2026-07-27T03:00:01.000Z",
      previousPhase: "connecting",
      phase: "present",
      reason: "gateway_ready",
      revision: 2,
    }),
    phaseEvent({
      id: "e3",
      occurredAt: "2026-07-27T03:05:00.000Z",
      previousPhase: "present",
      phase: "voice_active",
      reason: "voice_joined",
      revision: 3,
      voiceGuildIds: ["guild-42"],
      voiceRooms: [ROOM],
    }),
    phaseEvent({
      id: "e4",
      occurredAt: "2026-07-27T03:25:00.000Z",
      previousPhase: "voice_active",
      phase: "present",
      reason: "voice_left",
      revision: 4,
    }),
  ];
}

describe("deriveDiscordVoiceHistory", () => {
  it("closes a stay on voice_left with the room context captured at join", () => {
    const stays = deriveDiscordVoiceHistory(lifecycle(), 5);
    expect(stays).toEqual([
      {
        guildId: "guild-42",
        guildName: "Vuhlp",
        channelId: "chan-7",
        channelName: "General",
        occupants: [{ userId: "u1", displayName: "James" }],
        joinedAt: "2026-07-27T03:05:00.000Z",
        leftAt: "2026-07-27T03:25:00.000Z",
      },
    ]);
  });

  it("closes a stay when the session stops without an explicit leave", () => {
    const events = lifecycle().slice(0, 3);
    events.push(
      phaseEvent({
        id: "e4-stop",
        occurredAt: "2026-07-27T03:30:00.000Z",
        previousPhase: "voice_active",
        phase: "off",
        reason: "process_stopped",
        revision: 4,
      }),
    );
    const stays = deriveDiscordVoiceHistory(events, 5);
    expect(stays).toHaveLength(1);
    expect(stays[0]?.leftAt).toBe("2026-07-27T03:30:00.000Z");
  });

  it("never reports a stay that has not ended, and ignores foreign event types", () => {
    const events = lifecycle().slice(0, 3);
    events.push({
      id: "noise",
      occurredAt: "2026-07-27T03:31:00.000Z",
      missionId: "mission-1",
      streamKind: "mission",
      correlationId: "noise",
      profileHash: doctrine.profileHash,
      type: "mission.drafted",
      data: {},
    } as DomainEvent);
    expect(deriveDiscordVoiceHistory(events, 5)).toEqual([]);
  });
});

describe("voice history and possession routes", () => {
  async function harness(options: { possessed?: boolean } = {}) {
    const root = await mkdtemp(join(tmpdir(), "clankie-voice-history-"));
    const eventStore = new SqliteEventStore(join(root, "events.db"));
    for (const event of lifecycle()) await eventStore.append(event);
    const app = await createControlPlane({
      doctrine,
      eventStore,
      authenticateCaptain: captain,
      ...(options.possessed
        ? {
            bodyPossession: () => ({
              schemaVersion: 1 as const,
              holderId: "gba-mcp:claude-code",
              acquiredAt: "2026-07-27T03:00:00.000Z",
            }),
          }
        : {}),
    });
    return { app, close: () => eventStore.close() };
  }

  const authed = { authorization: "Bearer captain" };

  it("serves completed stays to the captain and refuses anonymous readers", async () => {
    const { app, close } = await harness();
    const denied = await app.request("/v1/discord/voice-history");
    expect(denied.status).toBe(401);

    const response = await app.request("/v1/discord/voice-history", { headers: authed });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stays: { guildName?: string; leftAt: string }[] };
    expect(body.stays).toHaveLength(1);
    expect(body.stays[0]?.guildName).toBe("Vuhlp");

    const badLimit = await app.request("/v1/discord/voice-history?limit=99", { headers: authed });
    expect(badLimit.status).toBe(400);
    close();
  });

  it("reports the live body holder, and nobody when the observer is unwired", async () => {
    const possessed = await harness({ possessed: true });
    const denied = await possessed.app.request("/v1/embodiment/possession");
    expect(denied.status).toBe(401);
    const held = await possessed.app.request("/v1/embodiment/possession", { headers: authed });
    expect(await held.json()).toEqual({
      schemaVersion: 1,
      possession: {
        schemaVersion: 1,
        holderId: "gba-mcp:claude-code",
        acquiredAt: "2026-07-27T03:00:00.000Z",
      },
    });
    possessed.close();

    const unwired = await harness();
    const empty = await unwired.app.request("/v1/embodiment/possession", { headers: authed });
    expect(await empty.json()).toEqual({ schemaVersion: 1, possession: null });
    unwired.close();
  });
});
