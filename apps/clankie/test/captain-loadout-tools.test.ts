import { serviceInLoadout } from "@clankie/settings";
import { describe, expect, it } from "vitest";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { captainTools } from "../src/captain/tools.ts";

const DISCORD_BODY_TOOLS = [
  "voice_join",
  "voice_leave",
  "youtube_search",
  "music_play",
  "music_queue",
  "music_skip",
  "music_pause",
  "music_resume",
  "music_stop",
  "music_now",
  "observe_share",
];

const unused = () => Promise.reject(new Error("unused"));
const base = {
  embodiment: { submitIntent: unused, getSession: unused, getLiveSession: unused },
};

function names(deps: Record<string, unknown>, lane: "operator" | "discord_presence"): string[] {
  return captainTools({ ...base, ...deps } as unknown as CaptainDeps, {}, {} as LaneLog, lane).map(
    (tool) => tool.name,
  );
}

describe("tools that need a Discord body", () => {
  it("are offered when the install runs one", () => {
    const withBody = {
      discordMusic: {},
      discordVoicePresence: {},
      streamWatch: { current: unused },
    };
    for (const lane of ["operator", "discord_presence"] as const) {
      expect(names(withBody, lane)).toEqual(expect.arrayContaining(DISCORD_BODY_TOOLS));
    }
  });

  it("are left out of a loadout without one, such as a hosted body", () => {
    for (const lane of ["operator", "discord_presence"] as const) {
      const offered = names({}, lane);
      expect(offered.filter((name) => DISCORD_BODY_TOOLS.includes(name))).toEqual([]);
      // The rest of his reach is untouched.
      expect(offered).toEqual(
        expect.arrayContaining(["generate_image", "get_self_state", "remember_episode"]),
      );
    }
  });

  it("follows the image's service loadout", () => {
    expect(serviceInLoadout("discord-bridge", {})).toBe(true);
    expect(serviceInLoadout("discord-bridge", { CLANKIE_SERVICES: "clankie,relay" })).toBe(false);
    expect(serviceInLoadout("relay", { CLANKIE_SERVICES: " clankie , relay " })).toBe(true);
  });
});
