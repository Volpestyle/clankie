import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { installHarnessBridges } from "../src/harness-install.ts";

it.each([
  "update",
  "disabled",
  "missing",
  "generated",
  "foreign-source",
  "undiscovered",
  "retarget",
  "changed-by-native",
])("updates only an eligible Claude profile settings alias: %s", async (kind) => {
  const home = await mkdtemp(join(tmpdir(), "clankie-alias-"));
  const primary = join(home, ".claude"),
    alias = join(home, ".claude-james"),
    market = join(home, "market");
  const source = join(primary, "settings.json"),
    target = join(alias, "settings.json");
  const commands: string[][] = [];
  try {
    for (const path of [primary, join(alias, "plugins"), market]) await mkdir(path, { recursive: true });
    const bytes = JSON.stringify({
      enabledPlugins: { "clankie-worker@clankie": kind !== "disabled" },
      ...(kind === "generated" ? { note: "Generated; do not edit" } : {}),
    });
    await writeFile(source, bytes);
    const other = join(home, "outside.json");
    await writeFile(other, bytes);
    await symlink(kind === "undiscovered" ? other : source, target);
    await writeFile(
      join(alias, "plugins/known_marketplaces.json"),
      JSON.stringify({
        clankie: { source: { source: "directory", path: kind === "foreign-source" ? primary : market } },
      }),
    );
    await writeFile(
      join(alias, "plugins/installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "clankie-worker@clankie": kind === "missing" ? [] : [{ scope: "user", installPath: "cache" }],
        },
      }),
    );
    let consents = 0;
    const result = await installHarnessBridges({
      repoRoot: home,
      marketplaceRoot: market,
      env: { HOME: home },
      consent: async () => {
        if (++consents === 1) return false;
        if (kind === "retarget") {
          await rm(target);
          await symlink(other, target);
        }
        return true;
      },
      execute: async (command, args, env) => {
        if (command !== "claude") throw new Error("absent");
        if (env?.CLAUDE_CONFIG_DIR === alias && args[0] !== "--version") {
          commands.push([...args]);
          if (kind === "changed-by-native") await writeFile(source, "{}");
        }
      },
    });
    const row = result.find((entry) => entry.profile === alias)!;
    if (["update", "changed-by-native"].includes(kind)) {
      expect(commands).toEqual(
        kind === "changed-by-native"
          ? [["plugin", "marketplace", "update", "clankie"]]
          : [
              ["plugin", "marketplace", "update", "clankie"],
              ["plugin", "update", "clankie-worker@clankie", "--scope", "user"],
            ],
      );
      expect(row.status).toBe(kind === "update" ? "updated" : "failed");
    } else {
      expect(commands).toEqual([]);
      expect(row.status).toBe(kind === "retarget" ? "failed" : "source-manager-required");
    }
    if (kind === "update") {
      expect(await realpath(target)).toBe(await realpath(source));
      expect(await readFile(source, "utf8")).toBe(bytes);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
