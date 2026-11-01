import { serviceInLoadout } from "@clankie/settings";
import { describe, expect, it } from "vitest";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { discordCaptainTools } from "../src/captain/discord-tools.ts";
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
  personaTools: discordCaptainTools,
  // The media extension running, as it does by default (ADR 0328).
  media: { generateImage: unused, generateVideo: unused, finishedRenders: unused },
};

function names(
  deps: Record<string, unknown>,
  lane: "operator" | "discord_presence" | "discord_voice",
): string[] {
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
    for (const lane of ["operator", "discord_presence", "discord_voice"] as const) {
      expect(names(withBody, lane)).toEqual(expect.arrayContaining(DISCORD_BODY_TOOLS));
    }
  });

  it("are left out of a loadout without one, such as a hosted body", () => {
    for (const lane of ["operator", "discord_presence", "discord_voice"] as const) {
      const offered = names({}, lane);
      expect(offered.filter((name) => DISCORD_BODY_TOOLS.includes(name))).toEqual([]);
      // The rest of his reach is untouched.
      expect(offered).toEqual(expect.arrayContaining(["generate_image", "get_self_state", "memory"]));
    }
  });

  it("leaves only the persona's tools out while the persona is off", () => {
    const withBody = {
      discordMusic: {},
      discordVoicePresence: {},
      discordActions: {},
      streamWatch: { current: unused },
    };
    for (const lane of ["operator", "discord_presence", "discord_voice"] as const) {
      const on = names(withBody, lane);
      const off = names({ ...withBody, personaTools: undefined }, lane);
      const missing = on.filter((name) => !off.includes(name));
      expect(off.every((name) => on.includes(name))).toBe(true);
      expect(missing.length).toBeGreaterThan(0);
      expect(missing).toEqual(
        expect.arrayContaining(DISCORD_BODY_TOOLS.filter((name) => name !== "observe_share")),
      );
      expect(
        missing.every((name) => /^(voice_|music_|youtube_|discord_|send_text_update$)/u.test(name)),
      ).toBe(true);
      expect(off).toContain("observe_share");
    }
  });

  it("follows the image's service loadout", () => {
    expect(serviceInLoadout("discord-bridge", {})).toBe(true);
    expect(serviceInLoadout("discord-bridge", { CLANKIE_SERVICES: "clankie,relay" })).toBe(false);
    expect(serviceInLoadout("relay", { CLANKIE_SERVICES: " clankie , relay " })).toBe(true);
  });
});
