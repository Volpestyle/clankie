import { describe, expect, it } from "vitest";
import { createDiscordMusicClient } from "../src/discord-music.ts";

describe("createDiscordMusicClient", () => {
  it("posts search to the lab body when it is the mouth", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const client = createDiscordMusicClient(
      {
        DISCORD_ACTIVE_BODY: "user_session",
        CLANKIE_USER_SESSION_CONTROL_PORT: "4312",
      },
      async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true, message: "I found these:\n1. Hit" }), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    await expect(client.search({ query: "migos", authorId: "u1" })).resolves.toEqual({
      ok: true,
      message: "I found these:\n1. Hit",
    });
    expect(calls).toEqual([
      { url: "http://127.0.0.1:4312/music/search", body: { query: "migos", authorId: "u1" } },
    ]);
  });

  it("posts play to the bot body when it is the mouth", async () => {
    const calls: string[] = [];
    const client = createDiscordMusicClient(
      { DISCORD_ACTIVE_BODY: "bot", CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: "4313" },
      async (url, init) => {
        calls.push(`${String(init?.method)} ${String(url)}`);
        return new Response(JSON.stringify({ ok: true, message: "Playing https://youtu.be/x" }), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    await expect(client.play({ index: 1, authorId: "u1" })).resolves.toEqual({
      ok: true,
      message: "Playing https://youtu.be/x",
    });
    expect(calls).toEqual(["POST http://127.0.0.1:4313/music/play"]);
  });

  it("returns a spoken refusal when the live body is unreachable", async () => {
    const client = createDiscordMusicClient({ DISCORD_ACTIVE_BODY: "bot" }, async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(client.search({ query: "migos", authorId: "u1" })).resolves.toEqual({
      ok: false,
      message: "I can't reach the live Discord body to play music. Get me in a voice channel and try again.",
    });
  });
});
