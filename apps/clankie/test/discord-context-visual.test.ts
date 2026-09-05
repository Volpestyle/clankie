import type { DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import type { ResolvedAttachment } from "../src/captain/deps.ts";
import { normalizeDiscordTurn } from "../src/captain/discord-turn.ts";

describe("Discord context visuals", () => {
  it("shows the newest context image after the trigger images and names its source", async () => {
    const request: DiscordPresenceChannelTurnRequest = {
      schemaVersion: 1,
      deliveryId: "wake",
      identity: {
        presenceSessionId: "presence-1",
        correlationId: "discord-message:wake",
        profileHash: "hash",
        characterId: "clankie",
        credentialRef: "discord_bot",
        transportKind: "bot",
      },
      trigger: {
        kind: "message",
        id: "wake",
        guildId: "guild-1",
        channelId: "channel-1",
        actorId: "user-1",
        body: "clankie",
        attachments: [image("trigger")],
      },
      contextMessages: [
        {
          id: "gif-message",
          authorId: "user-1",
          body: "https://klipy.com/gifs/greetings-PSr",
          createdAt: "2026-08-15T22:45:25.729Z",
        },
      ],
      contextVisual: {
        sourceMessageId: "gif-message",
        attachment: {
          ...image("gif-preview"),
          motionUrl: "https://images-ext-1.discordapp.net/external/gif-preview.mp4",
        },
      },
    };

    const normalized = await normalizeDiscordTurn(request, {
      memory: {
        appendEpisode: () => Promise.resolve({ corrected: false, retained: false }),
        recallEpisodeCard: () => Promise.resolve(""),
        searchEpisodeCard: () => Promise.resolve(""),
      },
      resolveDiscordAttachments: (attachments): Promise<readonly ResolvedAttachment[]> => {
        const resolved: ResolvedAttachment[] = [];
        for (const attachment of attachments) {
          if (attachment.motionUrl === undefined) {
            resolved.push({
              id: attachment.id,
              mediaType: attachment.mediaType,
              dataUrl: `data:${attachment.mediaType};base64,cGl4ZWxz`,
            });
            continue;
          }
          resolved.push(
            ...[1, 2].map((frameIndex) => ({
              id: attachment.id,
              mediaType: "image/png",
              frameIndex,
              frameCount: 2,
              dataUrl: "data:image/png;base64,cGl4ZWxz",
            })),
          );
        }
        return Promise.resolve(resolved);
      },
    });

    expect(normalized.images.map((attachment) => attachment.id)).toEqual([
      "trigger",
      "gif-preview",
      "gif-preview",
    ]);
    expect(normalized.prompt).toContain("chronological samples from early to late");
    expect(normalized.prompt).toContain("final 2 image parts");
    expect(normalized.prompt).toContain("earlier context message gif-message");
    expect(normalized.prompt).toContain("[newest context visual]");
  });
});

function image(id: string) {
  return {
    id,
    url: `https://cdn.discordapp.com/${id}.webp`,
    mediaType: "image/webp" as const,
    byteSize: 1_024,
  };
}
