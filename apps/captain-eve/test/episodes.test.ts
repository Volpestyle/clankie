import { describe, expect, it } from "vitest";
import { CaptainEpisodeSchema } from "@clankie/protocol";
import { buildCaptainEpisode } from "../lib/episodes.ts";

const OCCURRED_AT = "2026-07-25T19:00:00.000Z";

function build(
  channel: { kind?: string; metadata?: Record<string, unknown> },
  note: { summary: string; visibility?: "shareable" | "operator_private" },
) {
  return buildCaptainEpisode({
    channel,
    sessionId: "session-1",
    characterId: "clankie",
    episodeId: "episode-1",
    note,
    occurredAt: OCCURRED_AT,
  });
}

describe("captain episode stamping", () => {
  it("takes the room from the channel, not from the note", () => {
    // The note is everything the model controls. If a lane could be argued for,
    // an injected Discord turn could file itself as an operator episode.
    const episode = build(
      { metadata: { captainLane: "discord_presence", captainTargetId: "guild-1:channel-9" } },
      { summary: "Talked about Fire Red." },
    );

    expect(episode.lane).toBe("discord_presence");
    expect(episode.targetId).toBe("guild-1:channel-9");
    expect(() => CaptainEpisodeSchema.parse(episode)).not.toThrow();
  });

  it("defaults an operator note closed and a Discord note open", () => {
    expect(
      build({ metadata: { captainLane: "operator", captainTargetId: "global-default" } }, { summary: "x" })
        .visibility,
    ).toBe("operator_private");

    for (const lane of ["discord_presence", "discord_voice", "gameplay"]) {
      expect(
        build({ metadata: { captainLane: lane, captainTargetId: "t" } }, { summary: "x" }).visibility,
      ).toBe("shareable");
    }
  });

  it("honours an explicit visibility over the default", () => {
    expect(
      build(
        { metadata: { captainLane: "operator", captainTargetId: "global-default" } },
        { summary: "Fixed the Discord bridge.", visibility: "shareable" },
      ).visibility,
    ).toBe("shareable");
    expect(
      build(
        { metadata: { captainLane: "discord_presence", captainTargetId: "t" } },
        { summary: "Something sensitive came up.", visibility: "operator_private" },
      ).visibility,
    ).toBe("operator_private");
  });

  it("falls back to the lane as its own target when the hook channel has none", () => {
    // Lifecycle-hook channels frequently omit `captainTargetId`; an episode is
    // still worth keeping without an exact room.
    expect(build({ kind: "channel:operator-conversations" }, { summary: "x" }).targetId).toBe("operator");
  });

  it("always marks provenance self-authored and transcript-free", () => {
    const episode = build({ metadata: { captainLane: "discord_voice", captainTargetId: "t" } }, {
      summary: "Chatted in voice.",
    });

    expect(episode.provenance).toEqual({
      characterId: "clankie",
      sessionId: "session-1",
      selfAuthored: true,
      rawTranscript: false,
    });
  });
});
