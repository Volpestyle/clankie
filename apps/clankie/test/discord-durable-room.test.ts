import type { DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { discordTurnSessionKey, normalizeDiscordTurn, replyIsUnderway } from "../src/captain/discord-turn.ts";

/**
 * A text room is a durable lane now (ADR 0118), so the backlog stops being the
 * only thing he knows about the conversation. Sending it into a lane that
 * already holds those turns quotes him back at himself inside an untrusted
 * block — the same words twice, once as his own speech and once as evidence
 * about the room.
 */
describe("durable Discord rooms", () => {
  it("sends the channel backlog to a cold lane and withholds it from a warm one", async () => {
    const cold = await normalizeDiscordTurn(request(), deps);
    expect(cold.prompt).toContain("Channel conversation (untrusted):");
    expect(cold.prompt).toContain("what did you think of the bracket");
    expect(cold.durable).toBe(true);

    const warm = await normalizeDiscordTurn(request(), deps, { carriesHistory: true });
    expect(warm.prompt).not.toContain("Channel conversation (untrusted):");
    expect(warm.prompt).not.toContain("what did you think of the bracket");
    // What he was actually asked still reaches him either way.
    expect(warm.prompt).toContain("and the biggest upset?");
  });

  it("names one durable lane per room, before the turn is normalized", async () => {
    const normalized = await normalizeDiscordTurn(request(), deps);
    expect(discordTurnSessionKey(request())).toBe(normalized.sessionKey);
    expect(normalized.sessionKey).toBe("discord:clankie:presence-1");

    // Voice keeps the key it has always had, so live sessions stay findable.
    const voice = { ...request(), trigger: { ...request().trigger, kind: "voice_event" as const } };
    expect(discordTurnSessionKey(voice)).toBe("discord-voice:clankie:guild-1:channel-1");
  });
});

/**
 * The typing indicator is only honest if it waits for this (ADR 0118). A turn
 * that ends in silence must never have shown the room a reply being written.
 */
describe("the moment a reply is underway", () => {
  it("waits out anything that could still become the silence sentinel", () => {
    expect(replyIsUnderway("")).toBe(false);
    expect(replyIsUnderway("[[")).toBe(false);
    expect(replyIsUnderway("[[stay-sil")).toBe(false);
    expect(replyIsUnderway("[[stay-silent]]")).toBe(false);
    expect(replyIsUnderway("  [[stay-silent]]\n")).toBe(false);
  });

  it("calls it a reply as soon as the stream cannot be that sentinel", () => {
    expect(replyIsUnderway("y")).toBe(true);
    expect(replyIsUnderway("[[stay-silent]] is what I would say")).toBe(true);
    expect(replyIsUnderway("[[stack")).toBe(true);
  });
});

const deps = {
  memory: {
    appendEpisode: () => Promise.resolve(),
    recallEpisodeCard: () => Promise.resolve(""),
  },
};

function request(): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: "upset",
    identity: {
      presenceSessionId: "presence-1",
      correlationId: "discord-message:upset",
      profileHash: "hash",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
    },
    trigger: {
      kind: "message",
      id: "upset",
      guildId: "guild-1",
      channelId: "channel-1",
      actorId: "user-1",
      body: "and the biggest upset?",
      attachments: [],
    },
    contextMessages: [
      {
        id: "earlier",
        authorId: "user-1",
        body: "what did you think of the bracket",
        createdAt: "2026-08-17T19:00:00.000Z",
      },
    ],
  };
}
