import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOwnerFollowTarget, tryHandleVoicePresenceControlRequest } from "../src/voice-control.ts";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

describe("resolveOwnerFollowTarget", () => {
  it("follows a single current channel", () => {
    expect(resolveOwnerFollowTarget([{ guildId: "guild-1", channelId: "voice-1" }])).toEqual({
      outcome: "found",
      guildId: "guild-1",
      channelId: "voice-1",
    });
  });

  it("stays on the already-joined channel when the owner appears in more than one guild", () => {
    expect(
      resolveOwnerFollowTarget(
        [
          { guildId: "guild-1", channelId: "voice-1" },
          { guildId: "guild-2", channelId: "voice-2" },
        ],
        { active: true, guildId: "guild-2", channelId: "voice-2" },
      ),
    ).toEqual({ outcome: "found", guildId: "guild-2", channelId: "voice-2" });
  });

  it("refuses to guess when the owner is in two calls and we are in neither", () => {
    expect(
      resolveOwnerFollowTarget([
        { guildId: "guild-1", channelId: "voice-1" },
        { guildId: "guild-2", channelId: "voice-2" },
      ]),
    ).toEqual({ outcome: "ambiguous" });
    expect(resolveOwnerFollowTarget([])).toEqual({ outcome: "none" });
  });
});

describe("voice presence control", () => {
  it("accepts a follow with no guild or actor, and a Discord-stamped pair", async () => {
    const calls: unknown[] = [];
    const server = createServer((request, response) => {
      if (
        tryHandleVoicePresenceControlRequest(request, response, (action, input) => {
          calls.push({ action, input });
          return Promise.resolve({
            action: "joined",
            channelId: "voice-1",
            actorCanBeHeard: false,
          });
        })
      ) {
        return;
      }
      response.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server unavailable");
    const url = `http://127.0.0.1:${String(address.port)}/voice/join`;

    const follow = await fetch(url, { method: "POST", body: JSON.stringify({}) });
    const stamped = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ guildId: "guild-1", actorId: "user-1" }),
    });
    const invalid = await fetch(url, { method: "POST", body: JSON.stringify({ guildId: 1 }) });

    expect(follow.status).toBe(200);
    expect(stamped.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(calls).toEqual([
      { action: "join", input: {} },
      { action: "join", input: { guildId: "guild-1", actorId: "user-1" } },
    ]);
  });
});
