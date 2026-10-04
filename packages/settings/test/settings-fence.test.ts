import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
import { SettingsStore, emptySettings } from "../src/index.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-settings-fence-"));
  return {
    store: new SettingsStore(join(root, "settings.json")),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

it("fences a default snapshot when its previously absent settings file is created", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.store.loadFenced();
    expect(snapshot.settings).toEqual(emptySettings());
    expect(snapshot.assertCurrent).not.toThrow();
    await f.store.update((value) => ({ ...value, fleet: { ...value.fleet, tools: "off" } }));
    expect(snapshot.assertCurrent).toThrow("settings_changed");
    expect((await f.store.loadFenced()).settings.fleet.tools).toBe("off");
  } finally {
    await f.close();
  }
});

it.each(["atomic-rename", "in-place", "removed"] as const)(
  "rejects a %s settings generation change",
  async (change) => {
    const f = await fixture();
    try {
      await f.store.update((value) => value);
      const snapshot = await f.store.loadFenced();
      expect(snapshot.settings).toEqual(await f.store.load());
      expect(snapshot.assertCurrent).not.toThrow();
      if (change === "atomic-rename") await f.store.update((value) => value);
      else if (change === "in-place")
        await writeFile(
          f.store.path,
          JSON.stringify({ ...snapshot.settings, fleet: { ...snapshot.settings.fleet, tools: "off" } }),
        );
      else await rm(f.store.path);
      expect(snapshot.assertCurrent).toThrow();
    } finally {
      await f.close();
    }
  },
);

it.each(["{", '{"fleet":{"tools":"invalid"}}'])(
  "rejects malformed settings %s with the shared parser",
  async (raw) => {
    const f = await fixture();
    try {
      await writeFile(f.store.path, raw);
      await expect(f.store.load()).rejects.toThrow();
      await expect(f.store.loadFenced()).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
);

it.each(["read", "close", "in-place-read"] as const)(
  "keeps the actual read descriptor generation across its %s await",
  async (stage) => {
    const fs = await import("node:fs/promises");
    const f = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    try {
      await f.store.update((value) => value);
      const file = await fs.open(f.store.path, "r");
      vi.spyOn(fs, "open").mockResolvedValueOnce(file);
      if (stage !== "close") {
        const read = file.readFile.bind(file);
        vi.spyOn(file, "readFile").mockImplementation(async (options) => {
          const result = await read(options);
          held = true;
          await barrier;
          return result;
        });
      } else {
        const close = file.close.bind(file);
        vi.spyOn(file, "close").mockImplementation(async () => {
          await close();
          held = true;
          await barrier;
        });
      }
      const pending = f.store.loadFenced();
      await vi.waitFor(() => expect(held).toBe(true));
      if (stage === "in-place-read") await writeFile(f.store.path, '{"fleet":{"tools":"off"}}');
      else await f.store.update((value) => ({ ...value, fleet: { ...value.fleet, tools: "off" } }));
      release();
      if (stage !== "close") {
        await expect(pending).rejects.toThrow("settings_changed");
        return;
      }
      const snapshot = await pending;
      expect(snapshot.settings.fleet.tools).toBe("connected");
      expect(snapshot.assertCurrent).toThrow("settings_changed");
    } finally {
      release();
      vi.restoreAllMocks();
      await f.close();
    }
  },
);
