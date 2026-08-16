import { describe, expect, it } from "vitest";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { captainTools } from "../src/captain/tools.ts";

describe("captain voice presence tools", () => {
  it("lets the captain decide while the host supplies identity", async () => {
    const calls: unknown[] = [];
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.reject(new Error("unused")),
        getLiveSession: () => Promise.reject(new Error("unused")),
      },
      discordVoicePresence: {
        join: (input: unknown) => {
          calls.push(input);
          return Promise.resolve({
            action: "joined" as const,
            channelId: "voice-1",
            actorAutoOptedIn: false,
          });
        },
      },
    } as unknown as CaptainDeps;
    const tools = captainTools(
      deps,
      { guildId: "guild-1", actorId: "user-1" },
      {} as LaneLog,
      "discord_presence",
    );
    const join = tools.find((tool) => tool.name === "voice_join");
    if (join === undefined) throw new Error("voice_join is missing");

    await join.execute("call-1", {}, undefined, undefined, {} as never);

    expect(calls).toEqual([{ guildId: "guild-1", actorId: "user-1" }]);
    expect(captainTools(deps, {}, {} as LaneLog, "operator").some((tool) => tool.name === "voice_join")).toBe(
      false,
    );
  });

  it("host-stamps the asker on play intents", async () => {
    const calls: unknown[] = [];
    const deps = {
      embodiment: {
        submitIntent: (input: unknown) => {
          calls.push(input);
          return Promise.resolve({ outcome: "refused" as const, reason: "policy" as const });
        },
        getSession: () => Promise.resolve(undefined),
        getLiveSession: () => Promise.resolve(undefined),
      },
    } as unknown as CaptainDeps;
    const start = captainTools(
      deps,
      { actorId: "user-1" },
      {} as LaneLog,
      "discord_presence",
    ).find((tool) => tool.name === "start_play");
    if (start === undefined) throw new Error("start_play is missing");

    await start.execute("call-1", { environmentId: "pokemon-firered" }, undefined, undefined, {} as never);

    expect(start.parameters).toMatchObject({ properties: { environmentId: expect.any(Object) } });
    expect(JSON.stringify(start.parameters)).not.toContain("requestedBy");
    expect(calls).toEqual([
      expect.objectContaining({ originLane: "discord_presence", requestedBy: "user-1" }),
    ]);
  });

  it("grounds social actions in the trigger message", async () => {
    const calls: unknown[] = [];
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.resolve(undefined),
        getLiveSession: () => Promise.resolve(undefined),
      },
      discordActions: {
        execute: (input: unknown) => {
          calls.push(input);
          return Promise.resolve({ ok: true, message: "I reacted." });
        },
      },
    } as unknown as CaptainDeps;
    const react = captainTools(
      deps,
      { actorId: "user-1", guildId: "guild-1", channelId: "channel-1", messageId: "message-1" },
      {} as LaneLog,
      "discord_presence",
    ).find((tool) => tool.name === "discord_react");
    if (react === undefined) throw new Error("discord_react is missing");

    await react.execute("call-1", { emoji: "👍" }, undefined, undefined, {} as never);

    expect(JSON.stringify(react.parameters)).not.toMatch(/actorId|guildId|channelId|messageId/u);
    expect(calls).toEqual([
      {
        action: "react",
        callId: "call-1",
        actorId: "user-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        emoji: "👍",
      },
    ]);
    const voiceToolNames = captainTools(
      deps,
      { actorId: "user-1", guildId: "guild-1", channelId: "voice-1", messageId: "utterance-1" },
      {} as LaneLog,
      "discord_voice",
    ).map((tool) => tool.name);
    expect(voiceToolNames).toContain("discord_watch_start");
    expect(voiceToolNames).not.toContain("discord_react");
  });
});
