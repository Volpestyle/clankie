import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
import { SettingsStore } from "../src/store.ts";

it("caches unchanged generations, isolates copies and invalidates API writes and external edits", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "clankie-settings-cache-"));
  const store = new SettingsStore(join(root, "settings.json"));
  const connected = '{"schemaVersion":1,"fleet":{"tools":"connected"}}';
  try {
    await fs.writeFile(store.path, connected);
    const read = vi.spyOn(fs, "readFile");
    const first = await store.load();
    read.mockClear();
    first.fleet.tools = "off";
    first.agentHosts.connections.push({ id: "caller", ssh: "caller", shell: "posix" });
    const second = await store.load();
    expect(second.fleet.tools).toBe("connected");
    expect(second.agentHosts.connections).toEqual([]);
    expect(read).not.toHaveBeenCalled();

    await store.read();
    await store.update((settings) => ({ ...settings, fleet: { ...settings.fleet, tools: "off" } }));
    read.mockClear();
    expect((await store.load()).fleet.tools).toBe("off");
    expect(read).toHaveBeenCalledOnce();
    expect((await store.read()).fleet.tools).toBe("off");

    // Same size and mtime cannot conceal invalid external content (ctime changes).
    const before = await fs.stat(store.path);
    const raw = await fs.readFile(store.path, "utf8");
    await fs.writeFile(store.path, raw.replace('"off"', '"bad"'));
    await fs.utimes(store.path, before.atime, before.mtime);
    await expect(store.load()).rejects.toThrow();
    await fs.writeFile(join(root, "next"), connected);
    await fs.rename(join(root, "next"), store.path);
    expect((await store.load()).fleet.tools).toBe("connected");
    await fs.rm(store.path);
    expect((await store.load()).fleet.tools).toBe("connected");
    await fs.writeFile(store.path, '{"schemaVersion":1,"fleet":{"tools":"off"}}');
    expect((await store.load()).fleet.tools).toBe("off");
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
});
