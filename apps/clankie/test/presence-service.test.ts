import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import type { DiscordPresenceSessionRecord } from "@clankie/interactive-environment";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import * as census from "../src/captain/herdr-census.ts";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
it("serves live fleet and Discord sources through the strict operator operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-presence-"));
  roots.push(root);
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
  let voice: DiscordPresenceSessionRecord[] = [];
  let playing = false;
  const captain = createCaptain(
    {
      presence: { listSessions: async () => voice },
      embodiment: { getLiveSession: async () => undefined },
      hostedWorld: {
        inspect: () =>
          playing
            ? { outcome: "playing", grantedOperations: [], session: undefined }
            : { outcome: "not_playing" },
      },
    } as unknown as CaptainDeps,
    { repoRoot: root, stateDir: root, settings: new SettingsStore(join(root, "settings.json")) },
  );
  try {
    const first = await captain.serveOperatorConversation({ op: "presence", schemaVersion: 1 });
    expect(first).toMatchObject({ op: "presence", snapshot: { mood: "idle", activeSeats: 0, since: null } });
    expect(first).not.toHaveProperty("snapshot.activities");
    playing = true;
    expect(await captain.serveOperatorConversation({ op: "presence", schemaVersion: 1 })).toMatchObject({
      snapshot: { mood: "playing" },
    });
    voice = [{ gatewayConnected: true, voiceGuildIds: ["guild"] } as DiscordPresenceSessionRecord];
    expect(await captain.serveOperatorConversation({ op: "presence", schemaVersion: 1 })).toMatchObject({
      snapshot: { mood: "in_voice" },
    });
    expect(
      await captain.serveOperatorConversation({ op: "presence", schemaVersion: 1, includeActivities: true }),
    ).toMatchObject({
      snapshot: {
        activities: [
          { kind: "voice", label: "In a voice chat", since: null },
          { kind: "playing", label: "Playing", since: null },
        ],
      },
    });
    voice = [{ gatewayConnected: false, voiceGuildIds: ["guild"] } as DiscordPresenceSessionRecord];
    expect(await captain.serveOperatorConversation({ op: "presence", schemaVersion: 1 })).toMatchObject({
      snapshot: { mood: "playing" },
    });
  } finally {
    await captain.close();
  }
});
