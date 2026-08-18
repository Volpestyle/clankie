import { describe, expect, it } from "vitest";
import { createDiscordVoicePresenceClient } from "../src/discord-voice-presence.ts";

describe("createDiscordVoicePresenceClient", () => {
  it("posts the host-stamped actor and guild to the active body", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const client = createDiscordVoicePresenceClient(
      { DISCORD_ACTIVE_BODY: "bot", CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: "4313" },
      async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({
            action: "joined",
            channelId: "voice-1",
            actorCanBeHeard: true,
            transcriptLoggingEnabled: true,
          }),
        );
      },
    );
    await expect(client.join({ guildId: "guild-1", actorId: "user-1" })).resolves.toEqual({
      action: "joined",
      channelId: "voice-1",
      actorCanBeHeard: true,
      transcriptLoggingEnabled: true,
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:4313/voice/join",
        body: { guildId: "guild-1", actorId: "user-1" },
      },
    ]);
  });

  it("posts an empty follow when the operator lane has no Discord turn context", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const client = createDiscordVoicePresenceClient(
      { DISCORD_ACTIVE_BODY: "bot", CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: "4313" },
      async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ action: "join_refused", reason: "not_in_voice" }));
      },
    );
    await expect(client.join({})).resolves.toEqual({
      action: "join_refused",
      reason: "not_in_voice",
    });
    expect(calls).toEqual([{ url: "http://127.0.0.1:4313/voice/join", body: {} }]);
  });
});
