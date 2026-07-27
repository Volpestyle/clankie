import { describe, expect, it } from "vitest";
import type { CaptainLaneSnapshot } from "@clankie/captain-runtime";
import {
  captainSelfStateInstructions,
  projectCaptainSelfState,
  renderCaptainSelfState,
  type CaptainSelfStateInput,
} from "../lib/self-state.ts";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function lane(overrides: Partial<CaptainLaneSnapshot> & Pick<CaptainLaneSnapshot, "lane">) {
  return {
    key: JSON.stringify(["clankie", overrides.lane, overrides.targetId ?? "target"]),
    characterId: "clankie",
    targetId: "target",
    state: "waiting",
    revision: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  } as CaptainLaneSnapshot;
}

function input(overrides: Partial<CaptainSelfStateInput> = {}): CaptainSelfStateInput {
  return { conversations: [], lanes: [], now: NOW, ...overrides };
}

describe("captain self state", () => {
  it("reports a Discord room the operator lane is not in", () => {
    const state = projectCaptainSelfState(
      input({
        conversations: [
          { conversationId: "global-default", sessionState: "waiting", updatedAt: NOW.toISOString() },
        ],
        lanes: [lane({ lane: "discord_presence", targetId: "guild-1:channel-9" })],
        here: { lane: "operator", targetId: "global-default" },
      }),
    );

    expect(state.rooms).toEqual([
      {
        lane: "operator",
        targetId: "global-default",
        here: true,
        active: true,
        updatedAt: NOW.toISOString(),
      },
      {
        lane: "discord_presence",
        targetId: "guild-1:channel-9",
        here: false,
        active: true,
        updatedAt: NOW.toISOString(),
      },
    ]);
    expect(renderCaptainSelfState(state)).toContain("guild-1:channel-9");
  });

  it("puts the current room first even when another room is more recent", () => {
    const state = projectCaptainSelfState(
      input({
        lanes: [
          lane({ lane: "gameplay", targetId: "firered", updatedAt: NOW.toISOString() }),
          lane({ lane: "discord_voice", targetId: "guild-1:vc-2", updatedAt: "2026-07-25T11:59:00.000Z" }),
        ],
        here: { lane: "discord_voice", targetId: "guild-1:vc-2" },
      }),
    );

    expect(state.rooms.map((room) => room.targetId)).toEqual(["guild-1:vc-2", "firered"]);
    expect(state.rooms[0]?.here).toBe(true);
  });

  it("marks by lane alone when the hook channel carries no target id", () => {
    // Lifecycle-hook channels frequently omit `captainTargetId`; resolving the
    // full address would throw and take the turn down.
    const state = projectCaptainSelfState(
      input({
        lanes: [lane({ lane: "discord_voice", targetId: "guild-1:vc-2" })],
        here: { lane: "discord_voice", targetId: undefined },
      }),
    );

    expect(state.rooms[0]?.here).toBe(true);
  });

  it("drops rooms that settled outside the recent window but keeps active ones", () => {
    const state = projectCaptainSelfState(
      input({
        lanes: [
          lane({
            lane: "discord_voice",
            targetId: "stale",
            state: "completed",
            updatedAt: "2026-07-25T11:00:00.000Z",
          }),
          lane({
            lane: "discord_presence",
            targetId: "just-settled",
            state: "completed",
            updatedAt: "2026-07-25T11:59:00.000Z",
          }),
          lane({ lane: "gameplay", targetId: "live", state: "active" }),
        ],
      }),
    );

    expect(state.rooms.map((room) => room.targetId)).toEqual(["live", "just-settled"]);
    expect(state.rooms.find((room) => room.targetId === "just-settled")?.active).toBe(false);
    expect(renderCaptainSelfState(state)).toContain("(settled)");
  });

  it("does not double-count a legacy tui lane row against its operator conversation", () => {
    const state = projectCaptainSelfState(
      input({
        conversations: [
          { conversationId: "global-default", sessionState: "active", updatedAt: NOW.toISOString() },
        ],
        lanes: [lane({ lane: "tui", targetId: "global-default" })],
      }),
    );

    expect(state.rooms).toHaveLength(1);
    expect(state.rooms[0]?.lane).toBe("operator");
  });

  it("bounds the summary and says how much it withheld", () => {
    const state = projectCaptainSelfState(
      input({
        lanes: Array.from({ length: 30 }, (_unused, index) =>
          lane({ lane: "discord_presence", targetId: `guild-1:channel-${String(index)}`, state: "active" }),
        ),
      }),
    );

    expect(state.rooms).toHaveLength(24);
    expect(state.truncated).toBe(6);
    expect(renderCaptainSelfState(state)).toContain("and 6 more not shown");
  });

  it("carries no continuation token into the projection", () => {
    // The projection's only lane source is `CaptainLaneSnapshot`, which has no
    // token field at all — the fence is structural, not a filter that could be
    // forgotten. A resume state does carry one, so guard against it being
    // swapped in later.
    const resumeShaped = { ...lane({ lane: "discord_voice" }), continuationToken: "secret-token" };
    const state = projectCaptainSelfState(input({ lanes: [resumeShaped as CaptainLaneSnapshot], now: NOW }));

    const rendered = renderCaptainSelfState(state);
    expect(JSON.stringify(state)).not.toContain("secret-token");
    expect(rendered).not.toContain("secret-token");
  });

  it("says so plainly when this is the only room", () => {
    expect(renderCaptainSelfState(projectCaptainSelfState(input()))).toContain("only open room");
  });

  it("reports a live asked-play session as a gameplay room (ADR 0063)", () => {
    const state = projectCaptainSelfState(
      input({
        embodiment: {
          schemaVersion: 1,
          sessionId: "embodiment-1",
          environmentId: "pokemon-firered",
          state: "running",
          intentId: "intent-1",
          originLane: "discord_presence",
          requestedBy: "user-1",
          budget: { maxTurns: 40, maxDurationMs: 60_000 },
          requestedAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          runnerId: "runner-local",
        },
      }),
    );
    expect(state.rooms).toEqual([
      {
        lane: "gameplay",
        targetId: "pokemon-firered",
        here: false,
        active: true,
        updatedAt: NOW.toISOString(),
      },
    ]);
    expect(renderCaptainSelfState(state)).toContain("Gameplay · pokemon-firered");
  });

  it("reports a bridge-owned voice session as a Discord voice room without any lane row", () => {
    // The realtime voice agent joins VC without a captain turn ever flowing
    // (ADR 0056/0057), so no discord_voice lane row exists — the presence
    // session is the only source that can say his body is in a voice channel.
    const state = projectCaptainSelfState(
      input({
        presence: [
          {
            sessionId: "sess-1",
            phase: "voice_active",
            voiceGuildIds: ["guild-42"],
            updatedAt: NOW.toISOString(),
          },
        ],
      }),
    );

    expect(state.rooms).toEqual([
      {
        lane: "discord_voice",
        targetId: "guild-42",
        here: false,
        active: true,
        updatedAt: NOW.toISOString(),
      },
    ]);
    expect(renderCaptainSelfState(state)).toContain("Discord voice · guild-42");
  });

  it("reports gateway presence as Discord text and skips sessions that are not connected", () => {
    const state = projectCaptainSelfState(
      input({
        presence: [
          { sessionId: "sess-text", phase: "present", voiceGuildIds: [], updatedAt: NOW.toISOString() },
          { sessionId: "sess-off", phase: "off", voiceGuildIds: [], updatedAt: NOW.toISOString() },
          { sessionId: "sess-mid", phase: "connecting", voiceGuildIds: [], updatedAt: NOW.toISOString() },
          { sessionId: "sess-bad", phase: "degraded", voiceGuildIds: [], updatedAt: NOW.toISOString() },
          { sessionId: "sess-dead", phase: "failed", voiceGuildIds: [], updatedAt: NOW.toISOString() },
        ],
      }),
    );

    expect(state.rooms).toEqual([
      {
        lane: "discord_presence",
        targetId: "sess-text",
        here: false,
        active: true,
        updatedAt: NOW.toISOString(),
      },
    ]);
  });

  it("keeps a Go Live session a voice room, addressed by session id when no guild is listed", () => {
    const state = projectCaptainSelfState(
      input({
        presence: [
          {
            sessionId: "sess-live",
            phase: "go_live_active",
            voiceGuildIds: [],
            updatedAt: NOW.toISOString(),
          },
        ],
      }),
    );

    expect(state.rooms).toEqual([
      {
        lane: "discord_voice",
        targetId: "sess-live",
        here: false,
        active: true,
        updatedAt: NOW.toISOString(),
      },
    ]);
  });

  it("renders live rooms in the present tense so they cannot be read as history", () => {
    // Shown "last active <three minutes ago>" for a voice channel he was
    // sitting in, he answered "not in it now" — a live room must never render
    // as a bare timestamp.
    const state = projectCaptainSelfState(
      input({
        presence: [
          {
            sessionId: "sess-1",
            phase: "voice_active",
            voiceGuildIds: ["guild-42"],
            updatedAt: NOW.toISOString(),
          },
        ],
        lanes: [
          lane({
            lane: "discord_presence",
            targetId: "old-room",
            state: "completed",
            updatedAt: "2026-07-25T11:59:00.000Z",
          }),
        ],
      }),
    );

    const rendered = renderCaptainSelfState(state);
    expect(rendered).toMatch(/Discord voice · guild-42 · open right now/u);
    expect(rendered).not.toMatch(/Discord voice[^\n]*last active/u);
    expect(rendered).toMatch(/Discord text · old-room · last active [^\n]*\(settled\)/u);
    expect(rendered).toContain('"open right now"');
  });

  it("labels a voice room with its guild, channel, and occupants when names are published", () => {
    const state = projectCaptainSelfState(
      input({
        presence: [
          {
            sessionId: "sess-1",
            phase: "voice_active",
            voiceGuildIds: ["guild-42"],
            voiceRooms: [
              {
                guildId: "guild-42",
                guildName: "Vuhlp",
                channelId: "chan-7",
                channelName: "General",
                occupants: [
                  { userId: "u1", displayName: "James" },
                  { userId: "u2", displayName: "Sam" },
                ],
              },
            ],
            updatedAt: NOW.toISOString(),
          },
        ],
      }),
    );

    expect(state.rooms[0]?.label).toBe("Vuhlp — General (with James, Sam)");
    expect(state.rooms[0]?.targetId).toBe("guild-42");
    expect(renderCaptainSelfState(state)).toContain(
      "Discord voice · Vuhlp — General (with James, Sam) · open right now",
    );
  });

  it("falls back to the guild id and summarizes a crowd beyond the label cap", () => {
    const occupants = Array.from({ length: 8 }, (_unused, index) => ({
      userId: `u${String(index)}`,
      displayName: `Person${String(index)}`,
    }));
    const state = projectCaptainSelfState(
      input({
        presence: [
          {
            sessionId: "sess-1",
            phase: "voice_active",
            voiceGuildIds: ["guild-42"],
            voiceRooms: [{ guildId: "guild-42", occupants }],
            updatedAt: NOW.toISOString(),
          },
        ],
      }),
    );

    expect(state.rooms[0]?.label).toBe("guild-42 (with Person0, Person1, Person2, Person3, Person4 +3 more)");
  });

  it("reports a possessed body as a live gameplay room naming the driver (VUH-938)", () => {
    const state = projectCaptainSelfState(
      input({
        possession: { holderId: "gba-mcp:claude-code", acquiredAt: NOW.toISOString() },
      }),
    );

    expect(state.rooms).toEqual([
      {
        lane: "gameplay",
        targetId: "gba-body",
        label: "GBA body — driven by claude-code",
        here: false,
        active: true,
        updatedAt: NOW.toISOString(),
      },
    ]);
    expect(renderCaptainSelfState(state)).toContain(
      "Gameplay · GBA body — driven by claude-code · open right now",
    );
  });

  it("folds the runner's own asked-play hold into the embodiment room instead of double-reporting", () => {
    const state = projectCaptainSelfState(
      input({
        embodiment: {
          schemaVersion: 1,
          sessionId: "embodiment-1",
          environmentId: "pokemon-firered",
          state: "running",
          intentId: "intent-1",
          originLane: "discord_presence",
          requestedBy: "user-1",
          budget: {},
          requestedAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          runnerId: "runner-local",
        },
        possession: { holderId: "captain-play:embodiment-1", acquiredAt: NOW.toISOString() },
      }),
    );

    expect(state.rooms.filter((room) => room.lane === "gameplay")).toHaveLength(1);
    expect(state.rooms[0]?.targetId).toBe("pokemon-firered");
  });

  it("answers 'were you just in VC' from recent stays, past tense, with the company (VUH-940)", () => {
    const leftAt = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
    const state = projectCaptainSelfState(
      input({
        voiceHistory: [
          {
            guildId: "guild-42",
            guildName: "Vuhlp",
            channelName: "General",
            occupants: [{ userId: "u1", displayName: "James" }],
            leftAt,
          },
        ],
      }),
    );

    expect(state.recentVoice).toEqual([{ label: "Vuhlp — General (with James)", leftAt }]);
    const rendered = renderCaptainSelfState(state);
    expect(rendered).toContain(
      `Discord voice · Vuhlp — General (with James) · you left at ${leftAt} — not in it anymore`,
    );
  });

  it("keeps rejoined rooms and stale stays out of the recent-voice lines", () => {
    const state = projectCaptainSelfState(
      input({
        presence: [
          {
            sessionId: "sess-1",
            phase: "voice_active",
            voiceGuildIds: ["guild-42"],
            updatedAt: NOW.toISOString(),
          },
        ],
        voiceHistory: [
          {
            guildId: "guild-42",
            occupants: [],
            leftAt: new Date(NOW.getTime() - 2 * 60 * 1000).toISOString(),
          },
          {
            guildId: "guild-77",
            occupants: [],
            leftAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
          },
        ],
      }),
    );

    expect(state.recentVoice).toEqual([]);
  });

  it("carries no credential reference from a presence record into the projection", () => {
    // Production passes full DiscordPresenceSessionRecords; the projection's
    // presence input names only address-and-liveness fields, so the fence is
    // structural here too — guard against a wider shape being swapped in.
    const recordShaped = {
      sessionId: "sess-1",
      phase: "voice_active",
      voiceGuildIds: ["guild-42"],
      updatedAt: NOW.toISOString(),
      credentialRef: "secret-credential",
    };
    const state = projectCaptainSelfState(input({ presence: [recordShaped] }));

    expect(JSON.stringify(state)).not.toContain("secret-credential");
    expect(renderCaptainSelfState(state)).not.toContain("secret-credential");
  });
});

describe("captain self state instructions", () => {
  it("returns nothing rather than throwing when the projection fails", async () => {
    // An instruction hook that throws does not degrade the turn, it ends it.
    // An unrecognised channel kind must cost the "where you are" line, not the
    // whole reply.
    await expect(captainSelfStateInstructions({ kind: "channel:not-a-known-lane" })).resolves.toBe("");
  });
});
