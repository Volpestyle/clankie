import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import * as census from "../src/captain/herdr-census.ts";

it("carries the captain tool's expression through presence and reads changed owner quiet hours", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-desktop-service-"));
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
  const settings = new SettingsStore(join(root, "settings.json"));
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      presence: { listSessions: async () => [] },
      embodiment: { getLiveSession: async () => undefined },
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: { catalog: async () => [] },
    } as unknown as CaptainDeps,
    { repoRoot: root, stateDir: root, settings },
  );
  try {
    const bank = await captain.laneToolBank("operator", "global-default");
    const tool = bank.tools.find((entry) => entry.name === "desktop");
    expect(tool).toBeDefined();
    const published = await tool!.call({ kind: "say", text: "Hello from the desktop" });
    expect(published.isError).not.toBe(true);
    const first = await captain.serveOperatorConversation({ op: "presence", schemaVersion: 1 });
    expect(first).toMatchObject({
      snapshot: { mood: "idle", expression: { kind: "say", text: "Hello from the desktop" } },
    });
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === "hour")!.value);
    await settings.update((current) => ({
      ...current,
      desktop: {
        quietHours: {
          start: `${String(hour).padStart(2, "0")}:00`,
          end: `${String((hour + 1) % 24).padStart(2, "0")}:00`,
          timeZone: "UTC",
        },
      },
    }));
    const quiet = await captain.serveOperatorConversation({ op: "presence", schemaVersion: 1 });
    if (first.op !== "presence" || quiet.op !== "presence") throw Error("Wrong operation");
    expect(quiet.snapshot.expression).toBeUndefined();
    expect(quiet.snapshot.cursor).not.toBe(first.snapshot.cursor);
    expect(quiet.snapshot.mood).toBe("idle");
    const suppressed = await tool!.call({ kind: "emote", animation: "hop" });
    expect(suppressed.content).toContainEqual({ type: "text", text: '{"outcome":"quiet_hours"}' });
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
