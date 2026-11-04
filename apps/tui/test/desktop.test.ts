import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { runDesktopCommand } from "../src/command/desktop.ts";

afterEach(() => void vi.useRealTimers());

it("persists owner quiet hours through CLI and removes them without touching other settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-desktop-"));
  try {
    const settings = new SettingsStore(join(directory, "settings.json"));
    const options = { settings };
    const initialGameplay = (await settings.load()).gameplay;
    expect((await runDesktopCommand([], options)).desktop).toEqual({});
    await runDesktopCommand(["quiet-hours", "22:00", "07:00", "America/Chicago"], options);
    expect((await settings.load()).desktop.quietHours?.timeZone).toBe("America/Chicago");
    await expect(runDesktopCommand(["quiet-hours", "bad", "07:00", "UTC"], options)).rejects.toThrow();
    expect((await settings.load()).desktop.quietHours?.start).toBe("22:00");
    await runDesktopCommand(["quiet-hours", "off"], options);
    expect((await settings.load()).desktop).toEqual({});
    expect((await settings.load()).gameplay).toEqual(initialGameplay);
    await expect(runDesktopCommand(["status", "extra"], options)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("says whether quiet hours are in effect and when they end", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-desktop-"));
  try {
    const options = { settings: new SettingsStore(join(directory, "settings.json")) };
    await runDesktopCommand(["quiet-hours", "22:00", "07:00", "UTC"], options);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-04T12:00:00.000Z") });
    expect(await runDesktopCommand(["status"], options)).toMatchObject({ quiet: false });
    expect(await runDesktopCommand(["status"], options)).not.toHaveProperty("quietUntil");
    vi.setSystemTime(new Date("2026-11-04T23:00:00.000Z"));
    expect(await runDesktopCommand(["status"], options)).toMatchObject({
      quiet: true,
      quietUntil: "2026-11-05T07:00:00.000Z",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
