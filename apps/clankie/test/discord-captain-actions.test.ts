import { describe, expect, it } from "vitest";
import { createDiscordCaptainActionClient } from "../src/discord-captain-actions.ts";

describe("createDiscordCaptainActionClient", () => {
  it("posts only host-grounded action context to the active body", async () => {
    const calls: unknown[] = [];
    const client = createDiscordCaptainActionClient(
      { DISCORD_ACTIVE_BODY: "bot", CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: "4313" },
      async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, message: "Reacted." }));
      },
    );
    await expect(
      client.execute({
        action: "react",
        callId: "call-1",
        actorId: "user-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        emoji: "👍",
      }),
    ).resolves.toEqual({ ok: true, message: "Reacted." });
    expect(calls).toEqual([
      expect.objectContaining({ actorId: "user-1", channelId: "channel-1", messageId: "message-1" }),
    ]);
  });
});
