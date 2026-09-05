import type { DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { normalizeDiscordTurn } from "../src/captain/discord-turn.ts";
import type { FinishedRender } from "../src/media-generation.ts";

/**
 * A render that outlived its call reaches him on a later turn in the room that
 * asked (ADR 0094), as trusted text about his own work — and reaches no other
 * room, the same rule `observe_room` follows.
 */
describe("the render notice on a Discord turn", () => {
  it("names a landed render, its id, and leaves the choice to mention it with him", async () => {
    const asked: string[] = [];
    const normalized = await normalizeDiscordTurn(turnRequest(), {
      memory: memoryStub(),
      media: mediaStub(asked, [
        { requestId: "job-1", prompt: "a robot waving", outcome: "ok", tookSeconds: 214 },
      ]),
    });

    // Scoped to this room, by the room key the tools write renders under.
    expect(asked).toEqual(["discord_presence:guild-1:channel-1"]);
    expect(normalized.prompt).toContain("A video you started in this room has finished rendering");
    expect(normalized.prompt).toContain("a robot waving");
    expect(normalized.prompt).toContain("requestId job-1");
    expect(normalized.prompt).toContain("214s");
    // Told, not instructed: nothing here says he has to bring it up.
    expect(normalized.prompt).toContain("nobody is waiting on it if it does not");
  });

  it("says a render failed rather than pretending it is still coming", async () => {
    const normalized = await normalizeDiscordTurn(turnRequest(), {
      memory: memoryStub(),
      media: mediaStub(
        [],
        [{ requestId: "job-2", prompt: "a robot dancing", outcome: "refused", tookSeconds: 30 }],
      ),
    });

    expect(normalized.prompt).toContain("failed after 30s");
    expect(normalized.prompt).not.toContain("is ready after");
  });

  it("adds nothing when nothing has landed, and never fails a turn over renders", async () => {
    const quiet = await normalizeDiscordTurn(turnRequest(), {
      memory: memoryStub(),
      media: mediaStub([], []),
    });
    expect(quiet.prompt).not.toContain("finished rendering");

    // A service without a media generator wired still takes turns.
    const unwired = await normalizeDiscordTurn(turnRequest(), { memory: memoryStub() });
    expect(unwired.prompt).not.toContain("finished rendering");
  });

  it("projects approved person memory into ordinary text turns", async () => {
    const normalized = await normalizeDiscordTurn(turnRequest(), {
      memory: {
        ...memoryStub(),
        recallDiscordPerson: (identity, options) => {
          expect(identity).toEqual({ guildId: "guild-1", userId: "user-1" });
          expect(options).toEqual({ channelId: "channel-1", query: "" });
          return "- preference (0.90): Prefers Bulbasaur";
        },
      },
    });

    expect(normalized.prompt).toContain("What you remember about this person");
    expect(normalized.prompt).toContain("Prefers Bulbasaur");
  });
});

function mediaStub(asked: string[], renders: FinishedRender[]) {
  return {
    generateImage: () => {
      throw new Error("not used");
    },
    generateVideo: () => {
      throw new Error("not used");
    },
    finishedRenders: (room: string) => {
      asked.push(room);
      return Promise.resolve(renders);
    },
  } as never;
}

function memoryStub() {
  return {
    appendEpisode: () => Promise.resolve({ corrected: false, retained: false }),
    recallEpisodeCard: () => Promise.resolve(""),
    searchEpisodeCard: () => Promise.resolve(""),
  };
}

function turnRequest(): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: "message-1",
    identity: {
      presenceSessionId: "presence-1",
      correlationId: "discord-message:message-1",
      profileHash: "hash",
      characterId: "clankie",
      credentialRef: "discord-bot",
      transportKind: "bot",
    },
    trigger: {
      kind: "message",
      id: "message-1",
      guildId: "guild-1",
      channelId: "channel-1",
      actorId: "user-1",
      body: "hey",
      attachments: [],
    },
    contextMessages: [],
  } as unknown as DiscordPresenceChannelTurnRequest;
}
