import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it.skipIf(process.env.NATIVE_CLAUDE_CACHE_FIXTURES !== "1")(
  "native Claude retains unchanged-version bytes and delivers the shipped worker through a new cache version",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "claude-worker-cache-")));
    const profile = join(root, "profile"),
      marketplace = join(root, "marketplace");
    const plugin = join(marketplace, "worker"),
      pluginId = "worker@clankie-version-fixture";
    const source = join(plugin, "cache-proof.txt");
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      CLAUDE_CONFIG_DIR: profile,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      NO_COLOR: "1",
    };
    const cli = (args: string[]) => exec("claude", args, { env, timeout: 30_000 });
    const shipped = JSON.parse(
      await readFile(
        new URL("../../../integrations/claude-plugin/worker/.claude-plugin/plugin.json", import.meta.url),
        "utf8",
      ),
    ).version as string;
    const manifest = (version: string) =>
      writeFile(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "worker", version }));
    const installed = async () => {
      const state = JSON.parse(await readFile(join(profile, "plugins", "installed_plugins.json"), "utf8"));
      return state.plugins[pluginId].find((entry: { scope: string }) => entry.scope === "user") as {
        installPath: string;
        version: string;
      };
    };
    try {
      await mkdir(profile);
      await mkdir(join(marketplace, ".claude-plugin"), { recursive: true });
      await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(marketplace, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "clankie-version-fixture",
          owner: { name: "Fixture" },
          plugins: [{ name: "worker", source: "./worker" }],
        }),
      );
      await manifest("0.6.7");
      await writeFile(source, "before PC catalog fix\n");
      await cli(["plugin", "marketplace", "add", marketplace]);
      await cli(["plugin", "install", pluginId, "--scope", "user"]);
      const old = await installed();
      expect(await readFile(join(old.installPath, "cache-proof.txt"), "utf8")).toBe(
        "before PC catalog fix\n",
      );
      await writeFile(source, "after PC catalog fix\n");
      await cli(["plugin", "marketplace", "update", "clankie-version-fixture"]);
      await cli(["plugin", "update", pluginId, "--scope", "user"]);
      expect(await readFile(join((await installed()).installPath, "cache-proof.txt"), "utf8")).toBe(
        "before PC catalog fix\n",
      );
      await manifest(shipped);
      await cli(["plugin", "marketplace", "update", "clankie-version-fixture"]);
      await cli(["plugin", "update", pluginId, "--scope", "user"]);
      const updated = await installed();
      expect(await readFile(join(updated.installPath, "cache-proof.txt"), "utf8")).toBe(
        "after PC catalog fix\n",
      );
      expect(updated.version).toBe(shipped);
      expect(updated.installPath).not.toBe(old.installPath);
      expect(shipped).not.toBe("0.6.7");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
