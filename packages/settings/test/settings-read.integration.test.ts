import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "../src/store.ts";

it("isolates repeated settings reads and observes replacement, corruption and deletion immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-settings-read-"));
  const store = new SettingsStore(join(root, "settings.json"));
  const connected = '{"schemaVersion":1,"fleet":{"tools":"connected"}}';
  const disabled = '{"schemaVersion":1,"fleet":{"tools":"off"}}';
  try {
    await writeFile(store.path, connected);
    (await store.load()).fleet.tools = "off";
    expect((await store.load()).fleet.tools).toBe("connected");
    const fenced = await store.loadFenced();
    fenced.settings.fleet.tools = "off";
    expect((await store.load()).fleet.tools).toBe("connected");
    expect(fenced.assertCurrent).not.toThrow();
    // Different file generation with identical bytes still invalidates a fence.
    await writeFile(join(root, "next"), connected);
    await rename(join(root, "next"), store.path);
    expect(fenced.assertCurrent).toThrow("settings_changed");
    expect((await store.loadFenced()).settings.fleet.tools).toBe("connected");
    await writeFile(store.path, disabled);
    expect((await store.load()).fleet.tools).toBe("off");
    expect((await store.loadFenced()).settings.fleet.tools).toBe("off");
    for (const invalid of ["{", '{"fleet":{"tools":"invalid"}}']) {
      await writeFile(store.path, invalid);
      await expect(store.load()).rejects.toThrow();
      await expect(store.loadFenced()).rejects.toThrow();
    }
    await rm(store.path);
    expect((await store.load()).fleet.tools).toBe("connected");
    await writeFile(store.path, disabled);
    expect((await store.loadFenced()).settings.fleet.tools).toBe("off");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
