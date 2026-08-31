import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { runHerdrCommand } from "../src/command/herdr.ts";
import { runWorkdirCommand } from "../src/command/workdir.ts";

async function tempStore(): Promise<SettingsStore> {
  const directory = await mkdtemp(join(tmpdir(), "clankie-herdr-cli-"));
  return new SettingsStore(join(directory, "settings.json"));
}

describe("clankie herdr", () => {
  it("reads the default binding and sets a named session", async () => {
    const settings = await tempStore();
    const status = await runHerdrCommand([], { settings });
    expect(status.herdr).toEqual({ session: "default" });
    expect(status.restart).toBe("clankie restart captain");

    const updated = await runHerdrCommand(["set", "--session", "clankies"], { settings });
    expect(updated.herdr).toEqual({ session: "clankies" });
    expect((await settings.load()).herdr.session).toBe("clankies");
  });

  it("rejects a name the schema refuses and bad argument shapes", async () => {
    const settings = await tempStore();
    await expect(runHerdrCommand(["set", "--session", "no spaces"], { settings })).rejects.toThrow();
    await expect(runHerdrCommand(["set"], { settings })).rejects.toThrow("Usage: clankie herdr");
  });
});

describe("clankie workdir", () => {
  it("defaults to the home directory and round-trips set/clear", async () => {
    const settings = await tempStore();
    const status = await runWorkdirCommand([], { settings });
    expect(status.workingDirectory).toBeNull();
    expect(status.effective).toBe(homedir());

    const set = await runWorkdirCommand(["set", "~/dev"], { settings });
    expect(set.workingDirectory).toBe(join(homedir(), "dev"));
    expect(set.effective).toBe(join(homedir(), "dev"));
    expect((await settings.load()).captain.workingDirectory).toBe(join(homedir(), "dev"));

    const cleared = await runWorkdirCommand(["clear"], { settings });
    expect(cleared.workingDirectory).toBeNull();
    expect(cleared.effective).toBe(homedir());
  });

  it("rejects bad argument shapes", async () => {
    const settings = await tempStore();
    await expect(runWorkdirCommand(["set"], { settings })).rejects.toThrow("Usage: clankie workdir");
    await expect(runWorkdirCommand(["wipe"], { settings })).rejects.toThrow("Usage: clankie workdir");
  });
});
