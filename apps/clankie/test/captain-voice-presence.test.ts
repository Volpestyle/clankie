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
});
