import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ClankieSettingsSchema, SettingsStore, emptySettings } from "../src/index.ts";

test("one pc machine preserves fleet IDs, transcript aliases, grants and binding through persistence", async () => {
  const dir = await mkdtemp("/tmp/clankie-machines-settings-");
  try {
    const path = join(dir, "settings.json");
    const initial = emptySettings();
    initial.agentHosts.connections = [{ id: "desktop", ssh: "pc", shell: "powershell" }];
    initial.execution.connections = [
      {
        id: "pc",
        kind: "herdr",
        ssh: { host: "pc", shell: "powershell" },
        session: "work",
        enabled: true,
        capabilities: ["code"],
        workspaces: [{ kind: "directory", path: "C:\\dev" }],
      },
    ];
    await writeFile(path, JSON.stringify(initial));
    const store = new SettingsStore(path);
    const settings = await store.load();
    expect(settings.machines).toEqual([{ id: "desktop", ssh: "pc", shell: "powershell", aliases: [] }]);
    expect(settings.execution.connections[0]).toMatchObject({
      ...initial.execution.connections[0],
      machine: "desktop",
    });
    await store.update((current) => current);
    const disk = JSON.parse(await readFile(path, "utf8"));
    expect(() => ClankieSettingsSchema.parse(disk)).not.toThrow();
    expect(disk.agentHosts).toBeUndefined();
    expect(disk.execution.connections[0].ssh).toBeUndefined();
    expect(await store.load()).toEqual(settings);
    expect((await store.load()).execution.connections[0]!.id + "/w2:p1J").toBe("pc/w2:p1J");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same transport merges records but keeps both transcript names and conflicting IDs separate", async () => {
  const dir = await mkdtemp("/tmp/clankie-machines-aliases-");
  try {
    const store = new SettingsStore(join(dir, "settings.json"));
    const settings = await store.update((current) => ({
      ...current,
      agentHosts: {
        connections: [
          { id: "pc", ssh: "host", shell: "posix" },
          { id: "desktop", ssh: "host", shell: "posix" },
        ],
      },
      execution: {
        connections: [
          {
            id: "pc",
            kind: "herdr",
            session: "work",
            ssh: { host: "other", shell: "posix" },
            enabled: true,
            capabilities: [],
          },
        ],
      },
    }));
    expect(settings.machines).toEqual([
      { id: "pc", ssh: "host", shell: "posix", aliases: ["desktop"] },
      { id: "pc-2", ssh: "other", shell: "posix", aliases: [] },
    ]);
    expect(settings.agentHosts.connections.map((host) => host.id)).toEqual(["pc", "desktop", "pc-2"]);
    expect(settings.execution.connections[0]).toMatchObject({
      id: "pc",
      machine: "pc-2",
      ssh: { host: "other" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
